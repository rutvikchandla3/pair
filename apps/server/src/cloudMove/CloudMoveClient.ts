import {
  CLOUD_MOVE_ROUTE_PREFIX,
  CLOUD_MOVE_SEED_HEADERS,
  CLOUD_SEED_MAX_BYTES,
  CloudMoveCheckInput,
  CloudMoveCheckResult,
  CloudMoveContinuedInput,
  CloudMoveContinuedResult,
  CloudMoveFailure,
  CloudMoveLaunchInput,
  CloudMoveLaunchResult,
  CloudMoveSeedHeaders,
  type CloudStagingKey,
  type EnvironmentId,
  OrchestrationV2ContextExport,
  type PeerLinkError,
  type ProjectId,
  type ThreadId,
  ThreadMoveError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../peer/PeerLinks.ts";

export const SEED_FAILED_MESSAGE =
  "Couldn't package this thread's changes for the move. Try again.";
const TOO_LARGE_MESSAGE =
  "The download would be over 512 MB. Fetch origin on this computer, then try again.";

const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(CloudMoveFailure));
const decodeExport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextExport),
);
const decodeContinued = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudMoveContinuedResult));
const decodeSeedHeaders = Schema.decodeUnknownEffect(CloudMoveSeedHeaders);
const encodeContinuedInput = Schema.encodeSync(Schema.fromJsonString(CloudMoveContinuedInput));
const encodeCheckInput = Schema.encodeSync(Schema.fromJsonString(CloudMoveCheckInput));
const decodeCheckResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudMoveCheckResult));
const encodeLaunchInput = Schema.encodeSync(Schema.fromJsonString(CloudMoveLaunchInput));
const decodeLaunchResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudMoveLaunchResult));
const encodeExport = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2ContextExport));

/** The headers of a seed, with branch, base and origin decoded. */
export interface CloudMoveSeedFacts {
  readonly mode: "move" | "copy";
  readonly branch: string;
  readonly baseRef: string | null;
  readonly origin: string;
  readonly head: string;
  readonly snapshot: string | null;
}

/**
 * The laptop's calls to a Pair Cloud's cloud-move routes over its agent link. Pair Cloud never
 * calls back: every byte of a move travels on a request this server starts.
 */
export class CloudMoveClient extends Context.Service<
  CloudMoveClient,
  {
    readonly contextExport: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ContextExport, ThreadMoveError>;
    /** Writes the bundle to `file` once `check` accepts its facts; `written: false` when empty. */
    readonly downloadSeed: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly haves: ReadonlyArray<string>;
      readonly file: string;
      readonly check: (facts: CloudMoveSeedFacts) => Effect.Effect<void, ThreadMoveError>;
    }) => Effect.Effect<
      { readonly facts: CloudMoveSeedFacts; readonly written: boolean },
      ThreadMoveError
    >;
    readonly reportContinued: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly body: CloudMoveContinuedInput;
    }) => Effect.Effect<CloudMoveContinuedResult, ThreadMoveError>;
    /** Asked before anything uploads; a refusal carries Pair Cloud's words. */
    readonly check: (
      link: PeerLinks.ResolvedPeerLink,
      body: CloudMoveCheckInput,
    ) => Effect.Effect<CloudMoveCheckResult, ThreadMoveError>;
    /** `claimed`: a launch already took this key. */
    readonly putSeed: (
      link: PeerLinks.ResolvedPeerLink,
      input: {
        readonly key: CloudStagingKey;
        readonly projectId: ProjectId;
        readonly file: string;
      },
    ) => Effect.Effect<"stored" | "claimed" | "missing-prerequisite", ThreadMoveError>;
    readonly putContextExport: (
      link: PeerLinks.ResolvedPeerLink,
      input: {
        readonly key: CloudStagingKey;
        readonly projectId: ProjectId;
        readonly value: OrchestrationV2ContextExport;
      },
    ) => Effect.Effect<
      { readonly outcome: "stored" | "claimed"; readonly bytes: number },
      ThreadMoveError
    >;
    /** `branch-not-pushed`: a seedless launch's branch is gone from origin. */
    readonly launch: (
      link: PeerLinks.ResolvedPeerLink,
      input: { readonly key: CloudStagingKey; readonly body: CloudMoveLaunchInput },
    ) => Effect.Effect<CloudMoveLaunchResult | "branch-not-pushed", ThreadMoveError>;
  }
>()("t3/cloudMove/CloudMoveClient") {}

const moveError = (reason: ThreadMoveError["reason"], message: string) =>
  new ThreadMoveError({ reason, message });

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  const labelOf = (environmentId: EnvironmentId) =>
    links.get(environmentId).pipe(
      Effect.map(Option.match({ onNone: () => "Pair Cloud", onSome: (link) => link.label })),
      Effect.orElseSucceed(() => "Pair Cloud"),
    );

  const linkError = (environmentId: EnvironmentId) => (error: PeerLinkError) =>
    error.reason === "unknown_link" || error.reason === "expired"
      ? labelOf(environmentId).pipe(
          Effect.map((label) =>
            moveError("not-linked", `Link this computer to ${label} in Settings → Environments.`),
          ),
        )
      : Effect.succeed(moveError("failed", error.message));

  /** One request over a resolved link. A refusal is returned, not failed, so callers can read it. */
  const exchange = Effect.fn("CloudMoveClient.exchange")(function* (
    resolved: PeerLinks.ResolvedPeerLink,
    build: (url: string) => HttpClientRequest.HttpClientRequest,
  ) {
    const environmentId = resolved.link.environmentId;
    const label = resolved.link.label;
    const response = yield* httpClient
      .execute(
        build(`${resolved.url}${CLOUD_MOVE_ROUTE_PREFIX}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${resolved.token}`),
        ),
      )
      .pipe(
        Effect.tapError((error) => links.recordOutcome(environmentId, { error: error.message })),
        Effect.mapError(() => moveError("failed", `${label} stopped answering. Try again.`)),
      );
    if (response.status === 401) {
      const message = `${label} no longer accepts this computer's link. Link it again in Settings → Environments.`;
      yield* links.recordOutcome(environmentId, { error: message });
      return yield* moveError("not-linked", message);
    }
    // A refusal is still an answer: the link works, so only this move fails.
    yield* links.recordOutcome(environmentId, { error: null });
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const failure = Option.getOrNull(decodeFailure(body));
      return {
        response,
        label,
        refusal: {
          status: response.status,
          reason: failure?.reason ?? null,
          message: failure?.message ?? `${label} refused the move (HTTP ${response.status}).`,
        },
      };
    }
    return { response, label, refusal: null };
  });

  /** Resolves the link, then one request; non-2xx answers become a ThreadMoveError. */
  const send = Effect.fn("CloudMoveClient.send")(function* (
    environmentId: EnvironmentId,
    build: (url: string) => HttpClientRequest.HttpClientRequest,
  ) {
    const resolved = yield* links
      .resolve(environmentId)
      .pipe(Effect.catch((error) => Effect.flip(linkError(environmentId)(error))));
    if (resolved.capabilities.cloudImport !== true) {
      return yield* moveError(
        "unsupported",
        `${resolved.link.label} needs an update to move threads. Ask an admin.`,
      );
    }
    const { response, label, refusal } = yield* exchange(resolved, build);
    if (refusal !== null) return yield* moveError("refused", refusal.message);
    return { response, label };
  });

  const unexpected = (label: string) => () =>
    moveError("failed", `${label} answered in a shape this version can't read. Update both.`);

  const threadPath = (threadId: ThreadId, route: string) =>
    `/threads/${encodeURIComponent(threadId)}/${route}`;

  const contextExport: CloudMoveClient["Service"]["contextExport"] = Effect.fn(
    "CloudMoveClient.contextExport",
  )(function* ({ environmentId, threadId }) {
    const { response, label } = yield* send(environmentId, (base) =>
      HttpClientRequest.get(`${base}${threadPath(threadId, "context-export")}`),
    );
    const text = yield* response.text.pipe(Effect.mapError(unexpected(label)));
    return yield* decodeExport(text).pipe(Effect.mapError(unexpected(label)));
  });

  const readFacts = (response: HttpClientResponse.HttpClientResponse, label: string) =>
    decodeSeedHeaders(response.headers).pipe(
      Effect.map((headers): CloudMoveSeedFacts => {
        const base = headers[CLOUD_MOVE_SEED_HEADERS.base];
        return {
          mode: headers[CLOUD_MOVE_SEED_HEADERS.mode],
          branch: decodeURIComponent(headers[CLOUD_MOVE_SEED_HEADERS.branch]),
          baseRef: base === undefined ? null : decodeURIComponent(base),
          origin: decodeURIComponent(headers[CLOUD_MOVE_SEED_HEADERS.origin]),
          head: headers[CLOUD_MOVE_SEED_HEADERS.head],
          snapshot: headers[CLOUD_MOVE_SEED_HEADERS.snapshot] ?? null,
        };
      }),
      Effect.mapError(unexpected(label)),
    );

  const downloadSeed: CloudMoveClient["Service"]["downloadSeed"] = Effect.fn(
    "CloudMoveClient.downloadSeed",
  )(function* ({ environmentId, threadId, haves, file, check }) {
    const { response, label } = yield* send(environmentId, (base) =>
      HttpClientRequest.get(`${base}${threadPath(threadId, "seed")}`).pipe(
        HttpClientRequest.appendUrlParams(haves.map((oid) => ["have", oid] as const)),
      ),
    );
    const facts = yield* readFacts(response, label);
    // Checked before a byte of the body is read.
    yield* check(facts);
    if (response.status === 204) return { facts, written: false };
    const length = Number(response.headers["content-length"] ?? 0);
    if (length > CLOUD_SEED_MAX_BYTES) return yield* moveError("refused", TOO_LARGE_MESSAGE);
    let received = 0;
    yield* response.stream.pipe(
      Stream.mapError(() => moveError("failed", `${label} stopped answering. Try again.`)),
      Stream.mapEffect((chunk) => {
        received += chunk.length;
        return received > CLOUD_SEED_MAX_BYTES
          ? Effect.fail(moveError("refused", TOO_LARGE_MESSAGE))
          : Effect.succeed(chunk);
      }),
      Stream.run(fs.sink(file)),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(moveError("failed", `Couldn't save the download: ${error.message}`)),
      }),
    );
    return { facts, written: true };
  });

  const reportContinued: CloudMoveClient["Service"]["reportContinued"] = Effect.fn(
    "CloudMoveClient.reportContinued",
  )(function* ({ environmentId, threadId, body }) {
    const { response, label } = yield* send(environmentId, (base) =>
      HttpClientRequest.post(`${base}${threadPath(threadId, "continued")}`).pipe(
        HttpClientRequest.setBody(HttpBody.text(encodeContinuedInput(body), "application/json")),
      ),
    );
    const text = yield* response.text.pipe(Effect.mapError(unexpected(label)));
    return yield* decodeContinued(text).pipe(Effect.mapError(unexpected(label)));
  });

  const readJson = <A>(
    response: HttpClientResponse.HttpClientResponse,
    label: string,
    decode: (text: string) => Effect.Effect<A, unknown>,
  ) => response.text.pipe(Effect.flatMap(decode), Effect.mapError(unexpected(label)));

  const json = (text: string) => HttpBody.text(text, "application/json");

  const stagedPath = (key: CloudStagingKey, route: string) =>
    `/staged/${encodeURIComponent(key)}/${route}`;

  const check: CloudMoveClient["Service"]["check"] = Effect.fn("CloudMoveClient.check")(
    function* (link, body) {
      const { response, label, refusal } = yield* exchange(link, (base) =>
        HttpClientRequest.post(`${base}/check`).pipe(
          HttpClientRequest.setBody(json(encodeCheckInput(body))),
        ),
      );
      if (refusal !== null) return yield* moveError("refused", refusal.message);
      return yield* readJson(response, label, decodeCheckResult);
    },
  );

  const putSeed: CloudMoveClient["Service"]["putSeed"] = Effect.fn("CloudMoveClient.putSeed")(
    function* (link, { key, projectId, file }) {
      // bodyFile sets content-length, which the route needs before it reads a byte.
      const request = yield* HttpClientRequest.put(
        `${link.url}${CLOUD_MOVE_ROUTE_PREFIX}${stagedPath(key, "seed")}`,
      ).pipe(
        HttpClientRequest.setUrlParam("projectId", projectId),
        HttpClientRequest.bodyFile(file, { contentType: "application/x-git-bundle" }),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => moveError("seed-failed", SEED_FAILED_MESSAGE)),
      );
      const { refusal } = yield* exchange(link, () => request);
      if (refusal === null) return "stored" as const;
      if (refusal.reason === "claimed" || refusal.reason === "missing-prerequisite") {
        return refusal.reason;
      }
      if (refusal.status === 413) return yield* moveError("seed-too-large", refusal.message);
      return yield* moveError("upload-failed", refusal.message);
    },
  );

  const putContextExport: CloudMoveClient["Service"]["putContextExport"] = Effect.fn(
    "CloudMoveClient.putContextExport",
  )(function* (link, { key, projectId, value }) {
    const text = yield* encodeExport(value).pipe(
      Effect.mapError(() =>
        moveError("failed", "Couldn't package this thread's conversation for the move."),
      ),
    );
    const { refusal } = yield* exchange(link, (base) =>
      HttpClientRequest.put(`${base}${stagedPath(key, "context-export")}`).pipe(
        HttpClientRequest.setUrlParam("projectId", projectId),
        HttpClientRequest.setBody(json(text)),
      ),
    );
    const bytes = new TextEncoder().encode(text).byteLength;
    if (refusal === null) return { outcome: "stored" as const, bytes };
    if (refusal.reason === "claimed") return { outcome: "claimed" as const, bytes };
    return yield* moveError("upload-failed", refusal.message);
  });

  const launch: CloudMoveClient["Service"]["launch"] = Effect.fn("CloudMoveClient.launch")(
    function* (link, { key, body }) {
      const { response, label, refusal } = yield* exchange(link, (base) =>
        HttpClientRequest.post(`${base}${stagedPath(key, "launch")}`).pipe(
          HttpClientRequest.setBody(json(encodeLaunchInput(body))),
        ),
      );
      if (refusal?.reason === "branch-not-pushed") return "branch-not-pushed" as const;
      if (refusal !== null) return yield* moveError("refused", refusal.message);
      return yield* readJson(response, label, decodeLaunchResult);
    },
  );

  return CloudMoveClient.of({
    contextExport,
    downloadSeed,
    reportContinued,
    check,
    putSeed,
    putContextExport,
    launch,
  });
});

export const layer = Layer.effect(CloudMoveClient, make);
