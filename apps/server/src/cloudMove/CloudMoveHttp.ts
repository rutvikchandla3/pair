import {
  CLOUD_MOVE_ROUTE_PREFIX,
  CLOUD_SEED_MAX_BYTES,
  type CloudMoveFailure,
  CONTEXT_EXPORT_MAX_BYTES,
  CloudMoveFailureReason,
  CloudStagingKey,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import { makeByteBudget } from "../sandbox/runnerHub/ByteBudget.ts";
import * as StagedCloudImports from "./StagedCloudImports.ts";

/** Every cloud-move transfer through one layer shares this rate, as runner downloads do (2.59). */
const TRANSFER_BYTES_PER_SECOND = 32 * 1024 * 1024;
/** A typical seed fits, so it never waits. */
const TRANSFER_BURST_BYTES = 16 * 1024 * 1024;

const FAILURE_MESSAGES: Record<CloudMoveFailureReason, string> = {
  unauthenticated:
    "The link to Pair Cloud isn't signed in. Link it again in Settings → Environments.",
  forbidden: "This link can't move threads to Pair Cloud. Link it again with more access.",
  "bad-request": "Pair Cloud couldn't read the upload. Try again.",
  "unknown-project": "This project isn't on Pair Cloud.",
  "too-large":
    "The upload is over Pair Cloud's limit: 512 MB for a branch, 2 MB for a conversation.",
  "invalid-seed": "Pair Cloud couldn't read the uploaded branch. Try again.",
  "invalid-export": "Pair Cloud couldn't read the uploaded conversation. Try again.",
  "missing-prerequisite":
    "Pair Cloud is missing earlier commits on this branch. Send its full history.",
  claimed: "This move already started on Pair Cloud.",
  "key-in-use": "Pair Cloud has a different move under this id. Try again.",
  internal: "Pair Cloud couldn't take the upload. Try again.",
};

class CloudMoveRefusal extends Schema.TaggedError<CloudMoveRefusal>()("CloudMoveRefusal", {
  status: Schema.Int,
  reason: CloudMoveFailureReason,
  cause: Schema.optional(Schema.Defect()),
}) {}

const refuse = (status: number, reason: CloudMoveFailureReason) => (cause?: unknown) =>
  new CloudMoveRefusal({ status, reason, ...(cause === undefined ? {} : { cause }) });

const STAGE_REFUSALS: Record<
  StagedCloudImports.StagedCloudImportError["reason"],
  readonly [number, CloudMoveFailureReason]
> = {
  "unknown-project": [404, "unknown-project"],
  "too-large": [413, "too-large"],
  "invalid-seed": [422, "invalid-seed"],
  "invalid-export": [422, "invalid-export"],
  "missing-prerequisite": [409, "missing-prerequisite"],
  claimed: [409, "claimed"],
  "key-in-use": [409, "key-in-use"],
  "upload-failed": [400, "bad-request"],
  "not-found": [500, "internal"],
  failed: [500, "internal"],
};

const respond = (refusal: CloudMoveRefusal) =>
  (refusal.status === 500
    ? Effect.logError("cloud move route failed", { cause: refusal.cause })
    : Effect.void
  ).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        {
          reason: refusal.reason,
          message: FAILURE_MESSAGES[refusal.reason],
        } satisfies CloudMoveFailure,
        { status: refusal.status },
      ),
    ),
  );

/**
 * A linked environment's `mcp-client` session with operate access. The member is the one who
 * approved the link's pairing code; nothing in the request names it.
 */
const authenticateLinkMember = Effect.fn("CloudMoveHttp.authenticateLinkMember")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const client = yield* auth
    .authenticateMcpClient(request)
    .pipe(
      Effect.mapError((error) =>
        EnvironmentAuth.isServerAuthInternalError(error)
          ? refuse(500, "internal")(error)
          : refuse(401, "unauthenticated")(),
      ),
    );
  // API tokens are mcp-client sessions too, issued with peerLink false.
  if (!client.peerLink || client.access === "read-only") return yield* refuse(403, "forbidden")();
  return {
    memberId: client.memberId,
    sessionId: client.sessionId,
    label: client.label,
    access: client.access,
  };
});

const decodeKey = Schema.decodeUnknownOption(CloudStagingKey);
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/**
 * Every cloud-move route (07 §8): on a cloud-only server only, behind a linked environment's
 * session, and sharing one byte budget. They take bytes, never commands; nothing rides `/ws`.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { cloudOnly } = yield* ServerConfig.ServerConfig;
    const budget = makeByteBudget(TRANSFER_BYTES_PER_SECOND, TRANSFER_BURST_BYTES);

    const stagedUpload = (kind: StagedCloudImports.StagedCloudImportKind, maxBytes: number) =>
      HttpRouter.add(
        "PUT",
        `${CLOUD_MOVE_ROUTE_PREFIX}/staged/:key/${kind}`,
        Effect.gen(function* () {
          if (!cloudOnly) return HttpServerResponse.empty({ status: 404 });
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { memberId } = yield* authenticateLinkMember(request);
          const key = decodeKey((yield* HttpRouter.params).key);
          const projectId = requestUrl(request).pipe(
            Option.flatMap((url) => decodeProjectId(url.searchParams.get("projectId"))),
          );
          if (Option.isNone(key) || Option.isNone(projectId)) {
            return yield* refuse(400, "bad-request")();
          }
          const length = request.headers["content-length"];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
            return yield* refuse(413, "too-large")();
          }

          // Keep the request stream in the route scope until the response is sent.
          const bodyPull = yield* Stream.toPull(request.stream);
          const staged = yield* StagedCloudImports.StagedCloudImports;
          yield* staged
            .stage({
              key: key.value,
              kind,
              projectId: projectId.value,
              memberId,
              body: Stream.fromPull(Effect.succeed(bodyPull)).pipe(
                Stream.tap((chunk) => budget.take(chunk.length)),
              ),
            })
            .pipe(
              Effect.mapError((error) => {
                const [status, reason] = STAGE_REFUSALS[error.reason];
                return refuse(status, reason)(error);
              }),
            );
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(Effect.catchTags({ CloudMoveRefusal: respond })),
      );

    return Layer.mergeAll(
      stagedUpload("seed", CLOUD_SEED_MAX_BYTES),
      stagedUpload("context-export", CONTEXT_EXPORT_MAX_BYTES),
    );
  }),
);
