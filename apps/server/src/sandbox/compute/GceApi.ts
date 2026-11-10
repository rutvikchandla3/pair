import type { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { ComputeDriverError } from "./ComputeDriver.ts";
import type { GceMetadata } from "./GceMetadata.ts";

const COMPUTE_ORIGIN = "https://compute.googleapis.com/compute/v1";

/**
 * A Compute Engine call that failed. It never carries a cause, a message or a request: request
 * bodies hold the bootstrap's enrollment secret, and responses can quote it back.
 */
export class GceApiError extends Schema.TaggedError<GceApiError>()("GceApiError", {
  /** The call template, e.g. `POST /zones/{zone}/instances`. */
  endpoint: Schema.String,
  failure: Schema.Literals(["status", "transport", "response", "operation"]),
  /** The HTTP status, or a failed operation's `httpErrorStatusCode`. */
  status: Schema.optionalKey(Schema.Number),
  /** `error.errors[0].reason` of a response, or `error.errors[0].code` of an operation. */
  reason: Schema.optionalKey(Schema.String),
  /** From a `Retry-After` header in seconds. */
  retryAfterMs: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    const detail = [this.status, this.reason].filter((part) => part !== undefined).join(" ");
    return `Compute Engine ${this.endpoint} failed (${this.failure}${detail === "" ? "" : `: ${detail}`}).`;
  }
}

const CAPACITY_CODES = new Set([
  "ZONE_RESOURCE_POOL_EXHAUSTED",
  "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
]);
const QUOTA_CODES = new Set(["QUOTA_EXCEEDED", "quotaExceeded"]);
const RATE_CODES = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const QUOTA_HINT =
  "Google Cloud refused: a Compute Engine quota in this region is used up. Raise it, or lower Machines at once.";
const AUTH_HINT =
  "This server's service account lacks a Compute Engine permission. Apply the kit again, then check Settings → Cloud.";

/** Turns a Compute Engine failure into the driver's reasons (the table in m5-byoc.md, 5.11). */
export const mapGceError = (
  error: GceApiError,
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
  const code = error.reason ?? "";
  if (error.failure === "transport") return make("unavailable", true);
  if (error.failure === "response") return make("unavailable", false);
  // A refused 503 may still have landed, so the driver tries another zone only on a stockout.
  if (CAPACITY_CODES.has(code) || error.status === 503) {
    return make("capacity", true, { retryAfterMs: 60_000 });
  }
  if (QUOTA_CODES.has(code)) return make("quota", false, { setupHint: QUOTA_HINT });
  const status = error.status;
  if (status === 429 || (status === 403 && RATE_CODES.has(code))) {
    return make("rate-limited", true, { retryAfterMs: error.retryAfterMs ?? 5_000 });
  }
  if (status === undefined) return make("unavailable", false);
  if (status === 404) return make("not-found", false);
  if (status === 409) return make("conflict", false);
  // A stale fingerprint: the caller reads again.
  if (status === 412) return make("conflict", true);
  if (status === 401 || status === 403) return make("auth", false, { setupHint: AUTH_HINT });
  if (status >= 500) return make("unavailable", true);
  return make("invalid-request", false);
};

const Labels = Schema.Record(Schema.String, Schema.String);

const MetadataItem = Schema.Struct({
  key: Schema.String,
  value: Schema.optionalKey(Schema.String),
});
export type GceMetadataItem = typeof MetadataItem.Type;

const Instance = Schema.Struct({
  name: Schema.String,
  /** PROVISIONING, STAGING, RUNNING, STOPPING, STOPPED, SUSPENDING, SUSPENDED, REPAIRING, TERMINATED. */
  status: Schema.String,
  creationTimestamp: Schema.optionalKey(Schema.String),
  machineType: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Labels),
  labelFingerprint: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(
    Schema.Struct({
      fingerprint: Schema.optionalKey(Schema.String),
      items: Schema.optionalKey(Schema.Array(MetadataItem)),
    }),
  ),
  disks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        source: Schema.optionalKey(Schema.String),
        boot: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export type GceInstance = typeof Instance.Type;

const Operation = Schema.Struct({
  name: Schema.String,
  /** PENDING, RUNNING or DONE. */
  status: Schema.String,
  httpErrorStatusCode: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(
    Schema.Struct({
      errors: Schema.optionalKey(
        Schema.Array(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});
export type GceOperation = typeof Operation.Type;

const Image = Schema.Struct({
  /** A uint64, as a string. */
  id: Schema.String,
  name: Schema.String,
  /** PENDING, READY, FAILED or DELETING. */
  status: Schema.String,
  selfLink: Schema.String,
  labels: Schema.optionalKey(Labels),
  description: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  /** An int64, as a string. */
  archiveSizeBytes: Schema.optionalKey(Schema.String),
  creationTimestamp: Schema.optionalKey(Schema.String),
});
export type GceImage = typeof Image.Type;

const Snapshot = Schema.Struct({
  name: Schema.String,
  /** CREATING, UPLOADING, READY, FAILED or DELETING. */
  status: Schema.String,
  selfLink: Schema.String,
  labels: Schema.optionalKey(Labels),
});
export type GceSnapshot = typeof Snapshot.Type;

const listOf = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    items: Schema.optionalKey(Schema.Array(item)),
    nextPageToken: Schema.optionalKey(Schema.String),
  });

const GuestAttributes = Schema.Struct({
  queryValue: Schema.optionalKey(
    Schema.Struct({
      items: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            namespace: Schema.optionalKey(Schema.String),
            key: Schema.optionalKey(Schema.String),
            value: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});

const SerialPortOutput = Schema.Struct({ contents: Schema.optionalKey(Schema.String) });

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.optionalKey(
      Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })),
    ),
  }),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** The body `instances.insert` takes; only the fields the driver sets. */
export interface GceInstanceInsert {
  readonly name: string;
  readonly machineType: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly tags?: { readonly items: ReadonlyArray<string> };
  readonly disks: ReadonlyArray<{
    readonly boot: true;
    readonly autoDelete: true;
    readonly type: "PERSISTENT";
    readonly initializeParams: {
      readonly sourceImage?: string;
      readonly sourceSnapshot?: string;
      readonly diskSizeGb: string;
      readonly diskType: string;
      readonly labels: Readonly<Record<string, string>>;
    };
    readonly diskEncryptionKey?: { readonly kmsKeyName: string };
  }>;
  readonly networkInterfaces: ReadonlyArray<
    { readonly subnetwork: string } | { readonly network: string }
  >;
  readonly serviceAccounts: readonly [];
  readonly metadata: { readonly items: ReadonlyArray<GceMetadataItem> };
  readonly shieldedInstanceConfig: {
    readonly enableVtpm: true;
    readonly enableIntegrityMonitoring: true;
  };
  readonly scheduling: {
    readonly automaticRestart: false;
    readonly onHostMaintenance: "MIGRATE";
  };
  readonly canIpForward: false;
  readonly deletionProtection: false;
}

export interface GceImageInsert {
  readonly name: string;
  /** `zones/<zone>/disks/<disk>` or a self link; the disk must be detached or its instance stopped. */
  readonly sourceDisk: string;
  readonly family: string;
  readonly description?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly storageLocations: ReadonlyArray<string>;
  readonly imageEncryptionKey?: { readonly kmsKeyName: string };
}

export interface GceSnapshotInsert {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly storageLocations: ReadonlyArray<string>;
  readonly snapshotEncryptionKey?: { readonly kmsKeyName: string };
}

export interface GceListOptions {
  /** Compute Engine's list filter, e.g. `(labels.pair-install = "x") (labels.pair-sandbox:*)`. */
  readonly filter?: string;
  readonly maxResults?: number;
  readonly pageToken?: string;
}

export interface GcePage<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextPageToken: string | null;
}

type Call<A> = Effect.Effect<A, GceApiError>;

/**
 * The calls the gce driver makes. A get answers null for 404; every write answers its operation,
 * which `waitZoneOperation` or `waitGlobalOperation` follows. Images take an optional project, so
 * a base image can live in a public image project.
 */
export interface GceApi {
  readonly instances: {
    readonly insert: (zone: string, body: GceInstanceInsert) => Call<GceOperation>;
    readonly get: (zone: string, name: string) => Call<GceInstance | null>;
    readonly list: (zone: string, options: GceListOptions) => Call<GcePage<GceInstance>>;
    readonly start: (zone: string, name: string) => Call<GceOperation>;
    readonly stop: (zone: string, name: string) => Call<GceOperation>;
    readonly delete: (zone: string, name: string) => Call<GceOperation>;
    /** Replaces every item; `fingerprint` is the one the last read returned. */
    readonly setMetadata: (
      zone: string,
      name: string,
      metadata: { readonly fingerprint: string; readonly items: ReadonlyArray<GceMetadataItem> },
    ) => Call<GceOperation>;
    /** Replaces every label; `labelFingerprint` is the one the last read returned. */
    readonly setLabels: (
      zone: string,
      name: string,
      body: {
        readonly labels: Readonly<Record<string, string>>;
        readonly labelFingerprint: string;
      },
    ) => Call<GceOperation>;
    /** The values under `queryPath` (`<namespace>/`), empty when none is set. */
    readonly getGuestAttributes: (
      zone: string,
      name: string,
      queryPath: string,
    ) => Call<
      ReadonlyArray<{ readonly namespace?: string; readonly key?: string; readonly value?: string }>
    >;
    readonly getSerialPortOutput: (zone: string, name: string) => Call<string>;
  };
  readonly disks: {
    readonly createSnapshot: (
      zone: string,
      disk: string,
      body: GceSnapshotInsert,
    ) => Call<GceOperation>;
  };
  readonly snapshots: {
    readonly get: (name: string) => Call<GceSnapshot | null>;
    readonly delete: (name: string) => Call<GceOperation>;
  };
  readonly images: {
    readonly get: (name: string, project?: string) => Call<GceImage | null>;
    /** The newest image of the family that is not deprecated; null when it has none. */
    readonly getFromFamily: (family: string, project?: string) => Call<GceImage | null>;
    readonly list: (options: GceListOptions) => Call<GcePage<GceImage>>;
    readonly insert: (body: GceImageInsert) => Call<GceOperation>;
    readonly delete: (name: string) => Call<GceOperation>;
  };
  /** One `wait` call: it answers when the operation is done or after up to two minutes. */
  readonly waitZoneOperation: (zone: string, operation: string) => Call<GceOperation>;
  readonly waitGlobalOperation: (operation: string) => Call<GceOperation>;
}

/** A finished operation's failure, or null when it succeeded or is still running. */
export const operationError = (endpoint: string, operation: GceOperation): GceApiError | null => {
  if (operation.status !== "DONE" || operation.error === undefined) return null;
  const code = operation.error.errors?.[0]?.code;
  return new GceApiError({
    endpoint,
    failure: "operation",
    ...(operation.httpErrorStatusCode === undefined
      ? {}
      : { status: operation.httpErrorStatusCode }),
    ...(code === undefined ? {} : { reason: code }),
  });
};

interface ApiCall {
  readonly method: "GET" | "POST" | "DELETE";
  /** For errors and spans: a template without names or query values. */
  readonly endpoint: string;
  /** Under `projects/<project>`. */
  readonly path: string;
  readonly project?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  /** Answer null for 404 instead of failing. */
  readonly missingIsNull?: boolean;
}

const retryAfterMsOf = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
  const seconds = Number(response.headers["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

const id = encodeURIComponent;

/** A typed client over `HttpClient`; the bearer token comes from `metadata` on every call. */
export const makeGceApi = (
  client: HttpClient.HttpClient,
  metadata: Pick<GceMetadata, "accessToken">,
  project: Effect.Effect<string, GceApiError>,
): GceApi => {
  /** The response's JSON; null for a 404 the call allows. */
  const send = Effect.fn("GceApi.request")(function* (call: ApiCall) {
    const endpoint = `${call.method} ${call.endpoint}`;
    yield* Effect.annotateCurrentSpan({ endpoint });
    const token = yield* metadata.accessToken;
    const projectId = call.project ?? (yield* project);
    let request = HttpClientRequest.make(call.method)(
      `${COMPUTE_ORIGIN}/projects/${id(projectId)}/${call.path}`,
      { urlParams: call.query ?? {} },
    ).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.acceptJson);
    if (call.json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, call.json);
    // The client's error holds the request, and so the body: only its kind is kept.
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new GceApiError({ endpoint, failure: "transport" })));
    if (call.missingIsNull === true && response.status === 404) return null;
    const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    if (response.status >= 200 && response.status < 300) {
      if (body === undefined) return yield* new GceApiError({ endpoint, failure: "response" });
      return body;
    }
    const decoded = decodeErrorBody(body);
    const reason = decoded._tag === "Some" ? decoded.value.error.errors?.[0]?.reason : undefined;
    const retryAfterMs = retryAfterMsOf(response);
    return yield* new GceApiError({
      endpoint,
      failure: "status",
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  });

  // A decode error can quote the response, which may hold metadata values: none is kept.
  const decode =
    <A>(schema: Schema.Decoder<A>, endpoint: string) =>
    (body: unknown): Call<A> =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => new GceApiError({ endpoint: `${endpoint}`, failure: "response" })),
      );
  const get = <A>(call: Omit<ApiCall, "method" | "missingIsNull">, schema: Schema.Decoder<A>) =>
    send({ ...call, method: "GET", missingIsNull: true }).pipe(
      Effect.flatMap((body) =>
        body === null ? Effect.succeed(null) : decode(schema, `GET ${call.endpoint}`)(body),
      ),
    );
  const must = <A>(call: ApiCall, schema: Schema.Decoder<A>) =>
    send(call).pipe(Effect.flatMap(decode(schema, `${call.method} ${call.endpoint}`)));
  const page = <A>(list: {
    readonly items?: ReadonlyArray<A>;
    readonly nextPageToken?: string;
  }) => ({
    items: list.items ?? [],
    nextPageToken: list.nextPageToken ?? null,
  });
  const listQuery = (options: GceListOptions) => ({
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.maxResults === undefined ? {} : { maxResults: String(options.maxResults) }),
    ...(options.pageToken === undefined ? {} : { pageToken: options.pageToken }),
  });
  const instance = (zone: string, name: string) => `zones/${id(zone)}/instances/${id(name)}`;
  const instanceAction = (endpoint: string, json?: unknown) => (zone: string, name: string) =>
    must(
      {
        method: "POST",
        endpoint: `/zones/{zone}/instances/{name}/${endpoint}`,
        path: `${instance(zone, name)}/${endpoint}`,
        ...(json === undefined ? {} : { json }),
      },
      Operation,
    );

  return {
    instances: {
      insert: (zone, body) =>
        must(
          {
            method: "POST",
            endpoint: "/zones/{zone}/instances",
            path: `zones/${id(zone)}/instances`,
            json: body,
          },
          Operation,
        ),
      get: (zone, name) =>
        get({ endpoint: "/zones/{zone}/instances/{name}", path: instance(zone, name) }, Instance),
      list: (zone, options) =>
        must(
          {
            method: "GET",
            endpoint: "/zones/{zone}/instances",
            path: `zones/${id(zone)}/instances`,
            query: listQuery(options),
          },
          listOf(Instance),
        ).pipe(Effect.map(page)),
      start: instanceAction("start"),
      stop: instanceAction("stop"),
      delete: (zone, name) =>
        must(
          {
            method: "DELETE",
            endpoint: "/zones/{zone}/instances/{name}",
            path: instance(zone, name),
          },
          Operation,
        ),
      setMetadata: (zone, name, body) => instanceAction("setMetadata", body)(zone, name),
      setLabels: (zone, name, body) => instanceAction("setLabels", body)(zone, name),
      getGuestAttributes: (zone, name, queryPath) =>
        get(
          {
            endpoint: "/zones/{zone}/instances/{name}/getGuestAttributes",
            path: `${instance(zone, name)}/getGuestAttributes`,
            query: { queryPath },
          },
          GuestAttributes,
        ).pipe(Effect.map((attributes) => attributes?.queryValue?.items ?? [])),
      getSerialPortOutput: (zone, name) =>
        must(
          {
            method: "GET",
            endpoint: "/zones/{zone}/instances/{name}/serialPort",
            path: `${instance(zone, name)}/serialPort`,
            query: { port: "1" },
          },
          SerialPortOutput,
        ).pipe(Effect.map((output) => output.contents ?? "")),
    },
    disks: {
      createSnapshot: (zone, disk, body) =>
        must(
          {
            method: "POST",
            endpoint: "/zones/{zone}/disks/{disk}/createSnapshot",
            path: `zones/${id(zone)}/disks/${id(disk)}/createSnapshot`,
            json: body,
          },
          Operation,
        ),
    },
    snapshots: {
      get: (name) =>
        get(
          { endpoint: "/global/snapshots/{name}", path: `global/snapshots/${id(name)}` },
          Snapshot,
        ),
      delete: (name) =>
        must(
          {
            method: "DELETE",
            endpoint: "/global/snapshots/{name}",
            path: `global/snapshots/${id(name)}`,
          },
          Operation,
        ),
    },
    images: {
      get: (name, imageProject) =>
        get(
          {
            endpoint: "/global/images/{name}",
            path: `global/images/${id(name)}`,
            ...(imageProject === undefined ? {} : { project: imageProject }),
          },
          Image,
        ),
      getFromFamily: (family, imageProject) =>
        get(
          {
            endpoint: "/global/images/family/{family}",
            path: `global/images/family/${id(family)}`,
            ...(imageProject === undefined ? {} : { project: imageProject }),
          },
          Image,
        ),
      list: (options) =>
        must(
          {
            method: "GET",
            endpoint: "/global/images",
            path: "global/images",
            query: listQuery(options),
          },
          listOf(Image),
        ).pipe(Effect.map(page)),
      insert: (body) =>
        must(
          { method: "POST", endpoint: "/global/images", path: "global/images", json: body },
          Operation,
        ),
      delete: (name) =>
        must(
          {
            method: "DELETE",
            endpoint: "/global/images/{name}",
            path: `global/images/${id(name)}`,
          },
          Operation,
        ),
    },
    waitZoneOperation: (zone, operation) =>
      must(
        {
          method: "POST",
          endpoint: "/zones/{zone}/operations/{operation}/wait",
          path: `zones/${id(zone)}/operations/${id(operation)}/wait`,
        },
        Operation,
      ),
    waitGlobalOperation: (operation) =>
      must(
        {
          method: "POST",
          endpoint: "/global/operations/{operation}/wait",
          path: `global/operations/${id(operation)}/wait`,
        },
        Operation,
      ),
  };
};
