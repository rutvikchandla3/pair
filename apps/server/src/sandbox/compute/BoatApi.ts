import type { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { ComputeDriverError, wakeFailure } from "./ComputeDriver.ts";

export const BOAT_ORIGIN = "https://boat.dev/api/v1";

/**
 * A boat call that failed. It never carries a cause, a body or a message: request bodies and
 * files hold the bootstrap's enrollment secret, and responses can quote it back.
 */
export class BoatApiError extends Schema.TaggedError<BoatApiError>()("BoatApiError", {
  /** The call template, e.g. `POST /sandboxes/{id}/resume`. */
  endpoint: Schema.String,
  /** `credential`: the API key could not be read from the secret store or its provider. */
  failure: Schema.Literals(["status", "transport", "response", "credential"]),
  status: Schema.optionalKey(Schema.Number),
  /** boat's error `code`, e.g. `snapshot_data_expired`. */
  code: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  /** From `Retry-After`, or a 503's `retryAfterSeconds`. */
  retryAfterMs: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    const detail = [this.status, this.code].filter((part) => part !== undefined).join(" ");
    return `boat ${this.endpoint} failed (${this.failure}${detail === "" ? "" : `: ${detail}`}).`;
  }
}

const isBoatApiError = Schema.is(BoatApiError);

const REPLAY_MS = 5_000;
const QUOTA_RETRY_MS = 60_000;

const KEY_HINT =
  "boat refused the API key, or it lacks an action Pair needs. Create a key with the actions in Pair Cloud's guide and paste it in Settings → Cloud.";
const KEY_EXPIRED_HINT =
  "The boat API key expired. Create one with --ttl never and paste it in Settings → Cloud.";
const KEY_UNREADABLE_HINT =
  "Pair could not read the boat API key from its secret store or secret provider. Check it in Settings → Cloud.";
const WALLET_HINT =
  "boat's included time is used and its wallet is empty. Add money to the boat wallet.";
const PLAN_HINT =
  "This boat account is on its trial or a plan without this size. Start a paid plan (xlarge needs $100 a month).";
const LIMIT_HINT =
  "boat's plan is running as many sandboxes as it allows. Lower Machines at once, or raise the boat plan.";

const WALLET_CODES = new Set([
  "billing_required",
  "credit_required",
  "team_member_cap_reached",
  "trial_compute_limit_reached",
]);
const PLAN_CODES = new Set([
  "trial_auto_stop_required",
  "trial_machine_class_not_allowed",
  "machine_class_plan_required",
]);

/**
 * Turns a boat failure into the driver's reasons (m8-boat.md §8). On `start` and `stop`, only
 * `not-found` is final, so account trouble never lets the reconciler delete a disk.
 */
export const mapBoatError = (
  error: BoatApiError,
  context: {
    readonly driverId: ComputeDriverId;
    readonly operation: ComputeDriverError["operation"];
  },
): ComputeDriverError => {
  const make = (
    reason: ComputeDriverError["reason"],
    retryable: boolean,
    extra: { readonly retryAfterMs?: number; readonly setupHint?: string } = {},
  ) =>
    new ComputeDriverError({
      ...context,
      reason,
      retryable,
      ...extra,
      ...(error.status === undefined ? {} : { backendStatus: error.status }),
    });
  const mapped = (() => {
    const code = error.code ?? "";
    const status = error.status ?? 0;
    const retryAfterMs = error.retryAfterMs ?? REPLAY_MS;
    if (error.failure === "transport")
      return make("unavailable", true, { retryAfterMs: REPLAY_MS });
    if (error.failure === "response") return make("unavailable", false);
    if (error.failure === "credential")
      return make("auth", false, { setupHint: KEY_UNREADABLE_HINT });
    if (WALLET_CODES.has(code) || status === 402) {
      return make("quota", false, { setupHint: WALLET_HINT });
    }
    if (PLAN_CODES.has(code)) return make("quota", false, { setupHint: PLAN_HINT });
    if (status === 404) return make("not-found", false);
    if (status === 409) {
      if (code === "snapshot_data_expired") return make("not-found", false);
      if (code === "idempotency_key_reused") return make("conflict", false);
      return make("unavailable", true, { retryAfterMs });
    }
    if (status === 429) {
      if (code === "limit_reached" || code === "member_limit_reached") {
        return make("quota", true, { retryAfterMs: QUOTA_RETRY_MS, setupHint: LIMIT_HINT });
      }
      return make("rate-limited", true, { retryAfterMs });
    }
    if (status === 403 && code === "api_key_expired") {
      return make("auth", false, { setupHint: KEY_EXPIRED_HINT });
    }
    if (status === 401 || status === 403) return make("auth", false, { setupHint: KEY_HINT });
    if (status === 503) return make("capacity", true, { retryAfterMs });
    if (status >= 500) return make("unavailable", true, { retryAfterMs: REPLAY_MS });
    return make("invalid-request", false);
  })();
  return context.operation === "start" || context.operation === "stop"
    ? wakeFailure(mapped)
    : mapped;
};

const Labels = Schema.Record(Schema.String, Schema.String);
const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));

const Sandbox = Schema.Struct({
  id: Schema.String,
  name: NullableString,
  /** init, provisioning, provisioned, cloning, ready, idle, running, archiving, archived, error, cancelled. */
  state: Schema.String,
  labels: Schema.optionalKey(Schema.NullOr(Labels)),
  /** `ok`, or `degraded` when something in the machine blocks boat's agent. */
  health: NullableString,
  /** Set once boat deleted a stopped disk's data, after at least 14 days. */
  dataExpiredAt: NullableString,
  /** The create-time `setupScript`: pending, running, done or failed. */
  setupStatus: NullableString,
  createdAt: NullableString,
});
export type BoatSandbox = typeof Sandbox.Type;

const SandboxEnvelope = Schema.Struct({ sandbox: Sandbox });
const SandboxPage = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.optionalKey(
    Schema.Struct({ nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});

const CommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
});
export type BoatCommandResult = typeof CommandResult.Type;

const FileRead = Schema.Struct({ content: Schema.String });

const SavedSnapshot = Schema.Struct({
  name: Schema.String,
  /** saving, ready or failed. */
  status: Schema.String,
  sourceSandboxId: Schema.String,
  snapshotId: Schema.optionalKey(Schema.String),
  sizeBytes: Schema.optionalKey(Schema.Number),
  createdAt: Schema.String,
});
export type BoatSavedSnapshot = typeof SavedSnapshot.Type;

const SavedSnapshotEnvelope = Schema.Struct({ snapshot: SavedSnapshot });
const SavedSnapshotList = Schema.Struct({ snapshots: Schema.Array(SavedSnapshot) });

const Limits = Schema.Struct({
  machineTypes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, available: Schema.Boolean })),
  ),
});
export type BoatLimits = typeof Limits.Type;

const ErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
  requestId: Schema.optionalKey(Schema.String),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  retryAfter: Schema.optionalKey(Schema.Number),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export type BoatSandboxType = "small" | "default" | "large" | "xlarge";

/** The body `POST /sandboxes` takes; only the fields the driver sets. */
export interface BoatSandboxCreate {
  readonly name: string;
  readonly type: BoatSandboxType;
  readonly from?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly ttlSeconds: number | null;
  readonly noEnv: true;
  readonly monitoring: false;
  readonly snapshots: true;
  readonly visibility?: "private";
  readonly files?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly setupScript?: string;
}

/** Every state but `cancelled`: boat's default list may leave out stopped sandboxes. */
const BOAT_LIST_STATES =
  "init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error";

export interface BoatPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}

type Call<A> = Effect.Effect<A, BoatApiError>;

/** The calls the boat driver makes. A get answers null for 404. */
export interface BoatApi {
  readonly sandboxes: {
    readonly create: (body: BoatSandboxCreate, idempotencyKey: string) => Call<BoatSandbox>;
    /** Null for 404 and for `cancelled`. */
    readonly get: (id: string) => Call<BoatSandbox | null>;
    readonly list: (options: {
      readonly name?: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly cursor?: string;
    }) => Call<BoatPage<BoatSandbox>>;
    /** Never `force`: a forced stop drops work since the last snapshot. */
    readonly stop: (id: string) => Call<void>;
    /** An empty body: a `type` would force a cold machine, and `ttlSeconds` is kept. */
    readonly resume: (id: string) => Call<void>;
    /** A missing sandbox succeeds. */
    readonly delete: (id: string) => Call<void>;
  };
  readonly files: {
    readonly write: (id: string, path: string, content: string) => Call<void>;
    readonly read: (id: string, path: string) => Call<string | null>;
  };
  readonly commands: {
    /** Synchronous, and never retried here: a 502 may still have run it. */
    readonly run: (id: string, command: string, timeoutSeconds: number) => Call<BoatCommandResult>;
  };
  readonly savedSnapshots: {
    readonly get: (name: string) => Call<BoatSavedSnapshot | null>;
    readonly list: (namePrefix: string) => Call<ReadonlyArray<BoatSavedSnapshot>>;
    /** A save already running under the name succeeds. */
    readonly save: (sandboxId: string, name: string) => Call<void>;
    /** A missing one succeeds. */
    readonly delete: (name: string) => Call<void>;
  };
  readonly snapshots: {
    /** Null when the snapshot does not hold the file, a stock image file included. */
    readonly readFile: (snapshotId: string, path: string) => Call<Uint8Array | null>;
  };
  readonly limits: Call<BoatLimits>;
}

interface ApiCall {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** For errors and spans: a template without ids or query values. */
  readonly endpoint: string;
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const retryAfterMsOf = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof ErrorBody.Type | undefined,
): number | undefined => {
  const seconds = Number(
    response.headers["retry-after"] ?? body?.retryAfterSeconds ?? body?.retryAfter,
  );
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

const id = encodeURIComponent;

/**
 * A typed client over `HttpClient`. `apiKey(true)` reads the key again; a 401 does that once, so
 * a rotated secret-provider value takes effect without a settings edit.
 */
export const makeBoatApi = (
  client: HttpClient.HttpClient,
  options: {
    readonly apiKey: (refresh: boolean) => Effect.Effect<string, BoatApiError>;
    readonly organization?: string;
  },
): BoatApi => {
  let key: string | undefined;
  const currentKey = (refresh: boolean) =>
    key !== undefined && !refresh
      ? Effect.succeed(key)
      : options.apiKey(refresh).pipe(Effect.tap((next) => Effect.sync(() => (key = next))));

  const execute = (call: ApiCall, endpoint: string, apiKey: string) => {
    let request = HttpClientRequest.make(call.method)(`${BOAT_ORIGIN}${call.path}`, {
      urlParams: call.query ?? [],
    }).pipe(HttpClientRequest.bearerToken(apiKey), HttpClientRequest.acceptJson);
    if (options.organization !== undefined) {
      request = HttpClientRequest.setHeader(request, "X-Boat-Org", options.organization);
    }
    for (const [name, value] of Object.entries(call.headers ?? {})) {
      request = HttpClientRequest.setHeader(request, name, value);
    }
    if (call.json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, call.json);
    // The client's error holds the request, and so the body: only its kind is kept.
    return client
      .execute(request)
      .pipe(Effect.mapError(() => new BoatApiError({ endpoint, failure: "transport" })));
  };

  /** The response, once it is 2xx; a 401 reads the key again and tries once more. */
  const send = Effect.fn("BoatApi.request")(function* (call: ApiCall) {
    const endpoint = `${call.method} ${call.endpoint}`;
    yield* Effect.annotateCurrentSpan({ endpoint });
    const apiKey = yield* currentKey(false);
    if (apiKey === "") return yield* new BoatApiError({ endpoint, failure: "credential" });
    let response = yield* execute(call, endpoint, apiKey);
    if (response.status === 401) {
      const fresh = yield* currentKey(true);
      if (fresh !== apiKey && fresh !== "") response = yield* execute(call, endpoint, fresh);
    }
    if (response.status >= 200 && response.status < 300) return response;
    const raw: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    const decoded = decodeErrorBody(raw);
    const body = decoded._tag === "Some" ? decoded.value : undefined;
    const code = body?.code ?? body?.error?.code;
    const retryAfterMs = retryAfterMsOf(response, body);
    return yield* new BoatApiError({
      endpoint,
      failure: "status",
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(body?.requestId === undefined ? {} : { requestId: body.requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  });

  const unreadable = (call: ApiCall) => (error: unknown) =>
    isBoatApiError(error)
      ? error
      : new BoatApiError({ endpoint: `${call.method} ${call.endpoint}`, failure: "response" });
  // A decode error can quote the response, which may hold file contents: none is kept.
  const decode =
    <A>(schema: Schema.Decoder<A>) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body);
  const decoded = <A>(call: ApiCall, schema: Schema.Decoder<A>) =>
    send(call).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decode(schema)),
      Effect.mapError(unreadable(call)),
    );
  const done = (call: ApiCall) => send(call).pipe(Effect.asVoid);
  const isStatus =
    (...statuses: ReadonlyArray<number>) =>
    (error: BoatApiError) =>
      error.failure === "status" && statuses.includes(error.status ?? 0);
  const orNull = <A>(effect: Call<A>, when = isStatus(404)) =>
    effect.pipe(Effect.catchIf(when, () => Effect.succeed(null)));

  const sandbox = (sandboxId: string) => `/sandboxes/${id(sandboxId)}`;

  return {
    sandboxes: {
      create: (body, idempotencyKey) =>
        decoded(
          {
            method: "POST",
            endpoint: "/sandboxes",
            path: "/sandboxes",
            json: body,
            headers: { "Idempotency-Key": idempotencyKey },
          },
          SandboxEnvelope,
        ).pipe(Effect.map((envelope) => envelope.sandbox)),
      get: (sandboxId) =>
        orNull(
          decoded(
            { method: "GET", endpoint: "/sandboxes/{id}", path: sandbox(sandboxId) },
            SandboxEnvelope,
          ),
        ).pipe(
          Effect.map((envelope) =>
            envelope === null || envelope.sandbox.state === "cancelled" ? null : envelope.sandbox,
          ),
        ),
      list: (listOptions) =>
        decoded(
          {
            method: "GET",
            endpoint: "/sandboxes",
            path: "/sandboxes",
            query: [
              ["state", BOAT_LIST_STATES],
              ...Object.entries(listOptions.labels).map(
                ([name, value]) => ["label", `${name}=${value}`] as const,
              ),
              ...(listOptions.name === undefined ? [] : [["name", listOptions.name] as const]),
              ["limit", "100"],
              ...(listOptions.cursor === undefined
                ? []
                : [["cursor", listOptions.cursor] as const]),
            ],
          },
          SandboxPage,
        ).pipe(
          Effect.map((page) => ({
            items: page.sandboxes.filter((entry) => entry.state !== "cancelled"),
            nextCursor: page.pageInfo?.nextCursor ?? null,
          })),
        ),
      stop: (sandboxId) =>
        done({
          method: "POST",
          endpoint: "/sandboxes/{id}/stop",
          path: `${sandbox(sandboxId)}/stop`,
          json: {},
        }),
      resume: (sandboxId) =>
        done({
          method: "POST",
          endpoint: "/sandboxes/{id}/resume",
          path: `${sandbox(sandboxId)}/resume`,
          json: {},
        }),
      delete: (sandboxId) =>
        done({
          method: "DELETE",
          endpoint: "/sandboxes/{id}",
          path: sandbox(sandboxId),
          headers: { "X-Ascii-Confirm-Delete": sandboxId },
        }).pipe(Effect.catchIf(isStatus(404), () => Effect.void)),
    },
    files: {
      write: (sandboxId, path, content) =>
        done({
          method: "PUT",
          endpoint: "/sandboxes/{id}/files",
          path: `${sandbox(sandboxId)}/files`,
          json: { path, content, encoding: "utf8" },
        }),
      read: (sandboxId, path) =>
        orNull(
          decoded(
            {
              method: "GET",
              endpoint: "/sandboxes/{id}/files",
              path: `${sandbox(sandboxId)}/files`,
              query: [["path", path]],
            },
            FileRead,
          ),
        ).pipe(Effect.map((file) => file?.content ?? null)),
    },
    commands: {
      run: (sandboxId, command, timeoutSeconds) =>
        decoded(
          {
            method: "POST",
            endpoint: "/sandboxes/{id}/commands",
            path: `${sandbox(sandboxId)}/commands`,
            json: { command, timeoutSeconds },
          },
          CommandResult,
        ),
    },
    savedSnapshots: {
      get: (name) =>
        orNull(
          decoded(
            {
              method: "GET",
              endpoint: "/saved-snapshots/{name}",
              path: `/saved-snapshots/${id(name)}`,
            },
            SavedSnapshotEnvelope,
          ),
        ).pipe(Effect.map((envelope) => envelope?.snapshot ?? null)),
      list: (namePrefix) =>
        decoded(
          {
            method: "GET",
            endpoint: "/saved-snapshots",
            path: "/saved-snapshots",
            query: [["namePrefix", namePrefix]],
          },
          SavedSnapshotList,
        ).pipe(Effect.map((list) => list.snapshots)),
      save: (sandboxId, name) =>
        done({
          method: "POST",
          endpoint: "/saved-snapshots",
          path: "/saved-snapshots",
          json: { sandboxId, name },
        }).pipe(
          Effect.catchIf(
            (error) => isStatus(409)(error) && error.code === "save_in_progress",
            () => Effect.void,
          ),
        ),
      delete: (name) =>
        done({
          method: "DELETE",
          endpoint: "/saved-snapshots/{name}",
          path: `/saved-snapshots/${id(name)}`,
        }).pipe(Effect.catchIf(isStatus(404), () => Effect.void)),
    },
    snapshots: {
      readFile: (snapshotId, path) =>
        orNull(
          Effect.suspend(() => {
            const call: ApiCall = {
              method: "GET",
              endpoint: "/snapshots/{id}/files",
              path: `/snapshots/${id(snapshotId)}/files`,
              query: [["path", path]],
            };
            return send(call).pipe(
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.mapError(unreadable(call)),
            );
          }),
          (error) =>
            isStatus(404)(error) || (isStatus(409)(error) && error.code === "base_image_file"),
        ),
    },
    limits: decoded({ method: "GET", endpoint: "/limits", path: "/limits" }, Limits),
  };
};
