import {
  CLOUD_MOVE_MAX_HAVES,
  CLOUD_MOVE_ROUTE_PREFIX,
  CLOUD_MOVE_SEED_HEADERS,
  CLOUD_SEED_MAX_BYTES,
  CloudMoveCheckInput,
  CloudMoveCheckResult,
  CloudMoveContinuedInput,
  CloudMoveContinuedResult,
  type CloudMoveFailure,
  CloudMoveLaunchInput,
  CloudMoveLaunchResult,
  CloudMoveGitOid,
  CONTEXT_EXPORT_MAX_BYTES,
  CloudMoveFailureReason,
  CloudStagingKey,
  OrchestrationV2ContextExport,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import { makeByteBudget } from "../sandbox/runnerHub/ByteBudget.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as CloudMoveLaunch from "./CloudMoveLaunch.ts";
import * as CloudMoveSource from "./CloudMoveSource.ts";
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
  // A move out answers with CloudMoveSource's own words; these are for an error without them.
  "not-found": "This cloud thread no longer exists.",
  "not-movable": "This thread can't continue locally.",
  "run-active": "A turn is running or waiting for an answer. Continue locally once it ends.",
  "snapshot-missing":
    "Pair Cloud has no saved copy of this thread's uncommitted changes. Wake the machine, then try again.",
  "snapshot-failed": "Couldn't save the machine's uncommitted changes. Try again in a moment.",
  // A launch refusal answers with CloudMoveLaunch's own words.
  refused: "Pair Cloud won't start this thread.",
  "branch-not-pushed": "This branch is no longer on origin.",
};

class CloudMoveRefusal extends Schema.TaggedError<CloudMoveRefusal>()("CloudMoveRefusal", {
  status: Schema.Int,
  reason: CloudMoveFailureReason,
  /** Fixed text from the service that refused; never git output. */
  text: Schema.optional(Schema.String),
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

const SOURCE_REFUSALS: Record<
  CloudMoveSource.CloudMoveSourceError["reason"],
  readonly [number, CloudMoveFailureReason]
> = {
  "not-found": [404, "not-found"],
  "not-movable": [409, "not-movable"],
  "run-active": [409, "run-active"],
  "snapshot-missing": [409, "snapshot-missing"],
  "snapshot-failed": [503, "snapshot-failed"],
  "too-large": [413, "too-large"],
  failed: [500, "internal"],
};

const LAUNCH_REFUSALS: Record<
  CloudMoveLaunch.CloudMoveLaunchError["reason"],
  readonly [number, CloudMoveFailureReason]
> = {
  "unknown-project": [409, "unknown-project"],
  refused: [409, "refused"],
  "branch-not-pushed": [409, "branch-not-pushed"],
  failed: [500, "internal"],
};

const refuseLaunch = (error: CloudMoveLaunch.CloudMoveLaunchError) => {
  const [status, reason] = LAUNCH_REFUSALS[error.reason];
  return new CloudMoveRefusal({
    status,
    reason,
    ...(status === 500 ? {} : { text: error.message }),
    cause: error,
  });
};

const refuseSource = (error: CloudMoveSource.CloudMoveSourceError) => {
  const [status, reason] = SOURCE_REFUSALS[error.reason];
  return new CloudMoveRefusal({ status, reason, text: error.message, cause: error });
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
          message: refusal.text ?? FAILURE_MESSAGES[refusal.reason],
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
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const isGitOid = Schema.is(CloudMoveGitOid);
const decodeContinued = Schema.decodeUnknownOption(Schema.fromJsonString(CloudMoveContinuedInput));
const encodeContextExport = Schema.encodeEffect(OrchestrationV2ContextExport);
const encodeContinued = Schema.encodeEffect(CloudMoveContinuedResult);
const decodeCheck = Schema.decodeUnknownOption(Schema.fromJsonString(CloudMoveCheckInput));
const encodeCheck = Schema.encodeEffect(CloudMoveCheckResult);
const decodeLaunch = Schema.decodeUnknownOption(Schema.fromJsonString(CloudMoveLaunchInput));
const encodeLaunch = Schema.encodeEffect(CloudMoveLaunchResult);

/** The checks every move-out route makes, in order: cloud-only (else an empty 404), member, thread. */
const threadRoute = <R>(
  cloudOnly: boolean,
  method: "GET" | "POST",
  route: string,
  handle: (input: {
    readonly request: HttpServerRequest.HttpServerRequest;
    readonly memberId: Effect.Success<ReturnType<typeof authenticateLinkMember>>["memberId"];
    readonly threadId: ThreadId;
  }) => Effect.Effect<HttpServerResponse.HttpServerResponse, CloudMoveRefusal, R>,
) =>
  HttpRouter.add(
    method,
    `${CLOUD_MOVE_ROUTE_PREFIX}/threads/:threadId/${route}`,
    Effect.gen(function* () {
      if (!cloudOnly) return HttpServerResponse.empty({ status: 404 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { memberId } = yield* authenticateLinkMember(request);
      const threadId = decodeThreadId((yield* HttpRouter.params).threadId);
      if (Option.isNone(threadId)) return yield* refuse(400, "bad-request")();
      const access = yield* ThreadAccess.ThreadAccess;
      // A thread the member cannot open reads as one that is gone (11 §4).
      yield* access.assertThread(memberId, threadId.value).pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectionStoreThreadNotFoundError"
            ? refuseSource(
                new CloudMoveSource.CloudMoveSourceError({
                  threadId: threadId.value,
                  reason: "not-found",
                  message: CloudMoveSource.CLOUD_MOVE_SOURCE_MESSAGES["not-found"],
                }),
              )
            : refuse(500, "internal")(error),
        ),
      );
      return yield* handle({ request, memberId, threadId: threadId.value });
    }).pipe(Effect.catchTags({ CloudMoveRefusal: respond })),
  );

/**
 * Every cloud-move route (07 §8): on a cloud-only server only, behind a linked environment's
 * session, and sharing one byte budget. They take bytes, never commands; nothing rides `/ws`.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { cloudOnly } = yield* ServerConfig.ServerConfig;
    const moves = yield* CloudMoveLaunch.CloudMoveLaunch;
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

    const contextExport = threadRoute(
      cloudOnly,
      "GET",
      "context-export",
      ({ memberId, threadId }) =>
        Effect.gen(function* () {
          const source = yield* CloudMoveSource.CloudMoveSource;
          const value = yield* source
            .contextExport({ threadId, memberId })
            .pipe(Effect.mapError(refuseSource));
          const encoded = yield* encodeContextExport(value).pipe(
            Effect.mapError(refuse(500, "internal")),
          );
          return HttpServerResponse.jsonUnsafe(encoded);
        }),
    );

    const seed = threadRoute(cloudOnly, "GET", "seed", ({ request, memberId, threadId }) =>
      Effect.gen(function* () {
        const haves = Option.getOrElse(
          Option.map(requestUrl(request), (url) => url.searchParams.getAll("have")),
          () => [],
        );
        if (haves.length > CLOUD_MOVE_MAX_HAVES || !haves.every(isGitOid)) {
          return yield* refuse(400, "bad-request")();
        }
        const source = yield* CloudMoveSource.CloudMoveSource;
        const fs = yield* FileSystem.FileSystem;
        // The bundle must outlive this handler: Node sends the body after it returns.
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const seed = yield* source
            .seed({ threadId, memberId, haves })
            .pipe(Scope.provide(scope), Effect.mapError(refuseSource));
          const headers: Record<string, string> = {
            [CLOUD_MOVE_SEED_HEADERS.mode]: seed.mode,
            [CLOUD_MOVE_SEED_HEADERS.branch]: encodeURIComponent(seed.branch),
            [CLOUD_MOVE_SEED_HEADERS.origin]: encodeURIComponent(seed.origin),
            [CLOUD_MOVE_SEED_HEADERS.head]: seed.head,
            ...(seed.baseRef === null
              ? {}
              : { [CLOUD_MOVE_SEED_HEADERS.base]: encodeURIComponent(seed.baseRef) }),
            ...(seed.snapshot === null
              ? {}
              : {
                  [CLOUD_MOVE_SEED_HEADERS.snapshot]: seed.snapshot.oid,
                  [CLOUD_MOVE_SEED_HEADERS.snapshotAt]: DateTime.formatIso(seed.snapshot.takenAt),
                }),
          };
          if (seed.file === null) {
            yield* Scope.close(scope, Exit.void);
            return HttpServerResponse.empty({ status: 204, headers });
          }
          const { size } = yield* fs.stat(seed.file).pipe(Effect.mapError(refuse(500, "internal")));
          return HttpServerResponse.stream(
            fs.stream(seed.file).pipe(
              Stream.tap((chunk) => budget.take(chunk.length)),
              Stream.ensuring(Scope.close(scope, Exit.void)),
            ),
            {
              headers,
              contentType: "application/x-git-bundle",
              contentLength: Number(size),
            },
          );
        }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
      }),
    );

    const continued = threadRoute(
      cloudOnly,
      "POST",
      "continued",
      ({ request, memberId, threadId }) =>
        Effect.gen(function* () {
          const input = decodeContinued(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
          if (Option.isNone(input)) return yield* refuse(400, "bad-request")();
          const source = yield* CloudMoveSource.CloudMoveSource;
          const result = yield* source
            .continued({ threadId, memberId, input: input.value })
            .pipe(Effect.mapError(refuseSource));
          return HttpServerResponse.jsonUnsafe(
            yield* encodeContinued(result).pipe(Effect.mapError(refuse(500, "internal"))),
          );
        }),
    );

    /** Continue in cloud: one route asks, the other launches; both on the member's link. */
    const launchRoute = <R>(
      route: string,
      handle: (input: {
        readonly request: HttpServerRequest.HttpServerRequest;
        readonly session: Effect.Success<ReturnType<typeof authenticateLinkMember>>;
      }) => Effect.Effect<HttpServerResponse.HttpServerResponse, CloudMoveRefusal, R>,
    ) =>
      HttpRouter.add(
        "POST",
        `${CLOUD_MOVE_ROUTE_PREFIX}${route}`,
        Effect.gen(function* () {
          if (!cloudOnly) return HttpServerResponse.empty({ status: 404 });
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* authenticateLinkMember(request);
          return yield* handle({ request, session });
        }).pipe(Effect.catchTags({ CloudMoveRefusal: respond })),
      );

    const check = launchRoute("/check", ({ request, session }) =>
      Effect.gen(function* () {
        const input = decodeCheck(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
        if (Option.isNone(input)) return yield* refuse(400, "bad-request")();
        const result = yield* moves
          .check({ memberId: session.memberId, input: input.value })
          .pipe(Effect.mapError(refuseLaunch));
        return HttpServerResponse.jsonUnsafe(
          yield* encodeCheck(result).pipe(Effect.mapError(refuse(500, "internal"))),
        );
      }),
    );

    const launch = launchRoute("/staged/:key/launch", ({ request, session }) =>
      Effect.gen(function* () {
        const key = decodeKey((yield* HttpRouter.params).key);
        const input = decodeLaunch(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
        if (Option.isNone(key) || Option.isNone(input)) return yield* refuse(400, "bad-request")();
        const result = yield* moves
          .launch({ key: key.value, session, input: input.value })
          .pipe(Effect.mapError(refuseLaunch));
        return HttpServerResponse.jsonUnsafe(
          yield* encodeLaunch(result).pipe(Effect.mapError(refuse(500, "internal"))),
        );
      }),
    );

    return Layer.mergeAll(
      check,
      launch,
      stagedUpload("seed", CLOUD_SEED_MAX_BYTES),
      stagedUpload("context-export", CONTEXT_EXPORT_MAX_BYTES),
      contextExport,
      seed,
      continued,
    );
  }),
);
