import type { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { ComputeDriverError, wakeFailure } from "./ComputeDriver.ts";

/** The Sandbox API. Exec is also served here, so every call shares one host and one envelope. */
export const AGENT37_ORIGIN = "https://api.agent37.com/v1";

/**
 * An Agent37 call that failed. It never carries a cause, a body or a message: exec commands hold
 * the bootstrap's enrollment secret, and a response can quote a request back.
 */
export class Agent37ApiError extends Schema.TaggedError<Agent37ApiError>()("Agent37ApiError", {
  /** The call template, e.g. `POST /instances/{id}/start`. */
  endpoint: Schema.String,
  /** `credential`: the API key could not be read from the secret store or its provider. */
  failure: Schema.Literals(["status", "transport", "response", "credential"]),
  status: Schema.optionalKey(Schema.Number),
  /** Agent37's error `code`, e.g. `instance_limit_reached`. */
  code: Schema.optionalKey(Schema.String),
  retryAfterMs: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    const detail = [this.status, this.code].filter((part) => part !== undefined).join(" ");
    return `Agent37 ${this.endpoint} failed (${this.failure}${detail === "" ? "" : `: ${detail}`}).`;
  }
}

const isAgent37ApiError = Schema.is(Agent37ApiError);

const REPLAY_MS = 5_000;
const QUOTA_RETRY_MS = 60_000;

const KEY_HINT =
  "Agent37 refused the API key. Create a key in Agent37's dashboard and paste it in Settings → Cloud.";
const IP_HINT =
  "The Agent37 API key's IP allowlist leaves out this server's address. Add it in Agent37's dashboard, or clear the list.";
const KEY_UNREADABLE_HINT =
  "Pair could not read the Agent37 API key from its secret store or secret provider. Check it in Settings → Cloud.";
const WALLET_HINT =
  "The Agent37 wallet holds less than a day of this machine's compute, or is past due. Top it up in Agent37's billing dashboard.";
const LIMIT_HINT =
  "The Agent37 workspace is running as much memory as its limit allows. Lower Machines at once, or top up the wallet to raise the limit.";

/**
 * Turns an Agent37 failure into the driver's reasons (m9-agent37.md §6). On `start` and `stop`,
 * only `not-found` is final, so account trouble never lets the reconciler delete a disk.
 */
export const mapAgent37Error = (
  error: Agent37ApiError,
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
    if (status === 402) return make("quota", false, { setupHint: WALLET_HINT });
    if (code === "instance_limit_reached") {
      return make("quota", true, { retryAfterMs: QUOTA_RETRY_MS, setupHint: LIMIT_HINT });
    }
    if (code === "no_capacity" || code === "capacity_unavailable") {
      return make("capacity", true, { retryAfterMs });
    }
    if (status === 404) return make("not-found", false);
    if (status === 409) {
      if (code === "template_conflict") return make("conflict", false);
      return make("unavailable", true, { retryAfterMs });
    }
    if (status === 429) return make("rate-limited", true, { retryAfterMs });
    if (code === "ip_not_allowed") return make("auth", false, { setupHint: IP_HINT });
    if (status === 401 || code === "invalid_api_key") {
      return make("auth", false, { setupHint: KEY_HINT });
    }
    if (code === "tier_limit") return make("quota", false);
    if (status >= 500) return make("unavailable", true, { retryAfterMs });
    return make("invalid-request", false);
  })();
  return context.operation === "start" || context.operation === "stop"
    ? wakeFailure(mapped)
    : mapped;
};

const Resources = Schema.Struct({
  cpu: Schema.Number,
  memory: Schema.Number,
  disk: Schema.Number,
});
export type Agent37Resources = typeof Resources.Type;

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));

const Instance = Schema.Struct({
  id: Schema.String,
  /**
   * provisioning, running, stopping, stopped, starting, restarting, updating, sleeping, waking,
   * failed, deleting or deleted.
   */
  status: Schema.String,
  name: NullableString,
  /** Ours are string values; another client's may not be, so nothing narrower decodes. */
  metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  template: NullableString,
  type: NullableString,
  region: NullableString,
  resources: Schema.optionalKey(Schema.NullOr(Resources)),
  past_due: Schema.optionalKey(Schema.Boolean),
  /** Epoch seconds. */
  created: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type Agent37Instance = typeof Instance.Type;

const InstanceList = Schema.Struct({ data: Schema.Array(Instance) });
const Ack = Schema.Struct({ id: Schema.optionalKey(Schema.String), status: Schema.String });

const Template = Schema.Struct({
  name: Schema.String,
  scope: NullableString,
  image_ref: NullableString,
  /** Set once the image is copied into Agent37's private storage. */
  image_digest: NullableString,
  entrypoint: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
export type Agent37Template = typeof Template.Type;

const TemplateList = Schema.Struct({ data: Schema.Array(Template) });

const ExecResult = Schema.Struct({
  exit_code: Schema.Number,
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
});
export type Agent37ExecResult = typeof ExecResult.Type;

const Billing = Schema.Struct({
  balance_usd: Schema.Number,
  past_due: Schema.optionalKey(Schema.Boolean),
  memory_limit_gb: Schema.optionalKey(Schema.Number),
});
export type Agent37Billing = typeof Billing.Type;

const ErrorBody = Schema.Struct({
  error: Schema.Union([
    Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
    // A transport rejection is a flat string.
    Schema.String,
  ]),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export type Agent37InstanceType = "default" | "vm";
export type Agent37Region = "us" | "eu" | "ap-south";

/** The body `POST /instances` takes; only the fields the driver sets. */
export interface Agent37InstanceCreate {
  readonly template: string;
  readonly type: Agent37InstanceType;
  readonly region: Agent37Region;
  readonly resources: Agent37Resources;
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly mount_path: string;
  readonly auto_sleep: false;
}

/** The body `POST /instances/{id}/fork` takes; the rest is the source's. */
export interface Agent37InstanceFork {
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly resources?: Agent37Resources;
}

export interface Agent37TemplateCreate {
  readonly name: string;
  readonly image_ref: string;
  readonly description: string;
  readonly entrypoint: ReadonlyArray<string>;
}

type Call<A> = Effect.Effect<A, Agent37ApiError>;

/** The calls the Agent37 driver makes. A get answers null for 404. */
export interface Agent37Api {
  readonly instances: {
    /** Answers once the instance runs; there is no idempotency key, so callers look first. */
    readonly create: (body: Agent37InstanceCreate) => Call<Agent37Instance>;
    /** Null for 404 and for `deleted`. */
    readonly get: (id: string) => Call<Agent37Instance | null>;
    /** The whole workspace, newest first, without `deleting` or `deleted` ones. */
    readonly list: Call<ReadonlyArray<Agent37Instance>>;
    readonly fork: (id: string, body: Agent37InstanceFork) => Call<Agent37Instance>;
    /** The status it acknowledges. */
    readonly stop: (id: string) => Call<string>;
    readonly start: (id: string) => Call<string>;
    /** A missing instance succeeds. */
    readonly delete: (id: string) => Call<void>;
    /** As root, and never retried here: a dropped answer may still have run it. */
    readonly exec: (id: string, command: string) => Call<Agent37ExecResult>;
  };
  readonly templates: {
    readonly get: (name: string) => Call<Agent37Template | null>;
    readonly list: Call<ReadonlyArray<Agent37Template>>;
    /** Synchronous: it answers once the image is copied, minutes for a large one. */
    readonly create: (body: Agent37TemplateCreate) => Call<Agent37Template>;
    /** A missing one succeeds. */
    readonly delete: (name: string) => Call<void>;
  };
  readonly billing: Call<Agent37Billing>;
}

interface ApiCall {
  readonly method: "GET" | "POST" | "DELETE";
  /** For errors and spans: a template without ids. */
  readonly endpoint: string;
  readonly path: string;
  readonly json?: unknown;
}

const retryAfterMsOf = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
  const seconds = Number(response.headers["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

const id = encodeURIComponent;

/**
 * A typed client over `HttpClient`. `apiKey(true)` reads the key again; a 401 does that once, so
 * a rotated secret-provider value takes effect without a settings edit.
 */
export const makeAgent37Api = (
  client: HttpClient.HttpClient,
  options: { readonly apiKey: (refresh: boolean) => Effect.Effect<string, Agent37ApiError> },
): Agent37Api => {
  let key: string | undefined;
  const currentKey = (refresh: boolean) =>
    key !== undefined && !refresh
      ? Effect.succeed(key)
      : options.apiKey(refresh).pipe(Effect.tap((next) => Effect.sync(() => (key = next))));

  const execute = (call: ApiCall, endpoint: string, apiKey: string) => {
    let request = HttpClientRequest.make(call.method)(`${AGENT37_ORIGIN}${call.path}`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.acceptJson,
    );
    if (call.json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, call.json);
    // The client's error holds the request, and so the body: only its kind is kept.
    return client
      .execute(request)
      .pipe(Effect.mapError(() => new Agent37ApiError({ endpoint, failure: "transport" })));
  };

  /** The response, once it is 2xx; a 401 reads the key again and tries once more. */
  const send = Effect.fn("Agent37Api.request")(function* (call: ApiCall) {
    const endpoint = `${call.method} ${call.endpoint}`;
    yield* Effect.annotateCurrentSpan({ endpoint });
    const apiKey = yield* currentKey(false);
    if (apiKey === "") return yield* new Agent37ApiError({ endpoint, failure: "credential" });
    let response = yield* execute(call, endpoint, apiKey);
    if (response.status === 401) {
      const fresh = yield* currentKey(true);
      if (fresh !== apiKey && fresh !== "") response = yield* execute(call, endpoint, fresh);
    }
    if (response.status >= 200 && response.status < 300) return response;
    const raw: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    const decoded = decodeErrorBody(raw);
    const error = decoded._tag === "Some" ? decoded.value.error : undefined;
    const code = typeof error === "string" ? error : error?.code;
    const retryAfterMs = retryAfterMsOf(response);
    return yield* new Agent37ApiError({
      endpoint,
      failure: "status",
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  });

  const unreadable = (call: ApiCall) => (error: unknown) =>
    isAgent37ApiError(error)
      ? error
      : new Agent37ApiError({ endpoint: `${call.method} ${call.endpoint}`, failure: "response" });
  // A decode error can quote the response, which may hold command output: none is kept.
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
  const isNotFound = (error: Agent37ApiError) => error.failure === "status" && error.status === 404;
  const orNull = <A>(effect: Call<A>) =>
    effect.pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null)));
  const gone = (status: string) => status === "deleting" || status === "deleted";

  const instance = (instanceId: string) => `/instances/${id(instanceId)}`;
  const lifecycle = (action: "stop" | "start") => (instanceId: string) =>
    decoded(
      {
        method: "POST",
        endpoint: `/instances/{id}/${action}`,
        path: `${instance(instanceId)}/${action}`,
      },
      Ack,
    ).pipe(Effect.map((ack) => ack.status));

  return {
    instances: {
      create: (body) =>
        decoded(
          { method: "POST", endpoint: "/instances", path: "/instances", json: body },
          Instance,
        ),
      get: (instanceId) =>
        orNull(
          decoded(
            { method: "GET", endpoint: "/instances/{id}", path: instance(instanceId) },
            Instance,
          ),
        ).pipe(Effect.map((found) => (found === null || gone(found.status) ? null : found))),
      list: decoded(
        { method: "GET", endpoint: "/instances", path: "/instances" },
        InstanceList,
      ).pipe(Effect.map((list) => list.data.filter((entry) => !gone(entry.status)))),
      fork: (instanceId, body) =>
        decoded(
          {
            method: "POST",
            endpoint: "/instances/{id}/fork",
            path: `${instance(instanceId)}/fork`,
            json: body,
          },
          Instance,
        ),
      stop: lifecycle("stop"),
      start: lifecycle("start"),
      delete: (instanceId) =>
        send({ method: "DELETE", endpoint: "/instances/{id}", path: instance(instanceId) }).pipe(
          Effect.asVoid,
          Effect.catchIf(isNotFound, () => Effect.void),
        ),
      exec: (instanceId, command) =>
        decoded(
          {
            method: "POST",
            endpoint: "/instances/{id}/exec",
            path: `${instance(instanceId)}/exec`,
            json: { command, user: "root" },
          },
          ExecResult,
        ),
    },
    templates: {
      get: (name) =>
        orNull(
          decoded(
            { method: "GET", endpoint: "/templates/{name}", path: `/templates/${id(name)}` },
            Template,
          ),
        ),
      list: decoded(
        { method: "GET", endpoint: "/templates", path: "/templates" },
        TemplateList,
      ).pipe(Effect.map((list) => list.data)),
      create: (body) =>
        decoded(
          { method: "POST", endpoint: "/templates", path: "/templates", json: body },
          Template,
        ),
      delete: (name) =>
        send({
          method: "DELETE",
          endpoint: "/templates/{name}",
          path: `/templates/${id(name)}`,
        }).pipe(
          Effect.asVoid,
          Effect.catchIf(isNotFound, () => Effect.void),
        ),
    },
    billing: decoded({ method: "GET", endpoint: "/billing", path: "/billing" }, Billing),
  };
};
