import type { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { ComputeDriverError } from "./ComputeDriver.ts";

/** Docker 20.10+; newer daemons keep serving older API versions. */
const API_VERSION = "v1.41";

export class DockerEngineError extends Schema.TaggedError<DockerEngineError>()(
  "DockerEngineError",
  {
    /** The endpoint template, e.g. `POST /containers/{id}/stop`. */
    endpoint: Schema.String,
    failure: Schema.Literals(["status", "transport", "response"]),
    status: Schema.optionalKey(Schema.Number),
    /** The socket error code of a transport failure, e.g. `ECONNREFUSED`. */
    socketCode: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `Docker Engine ${this.endpoint} failed (${this.failure}).`
      : `Docker Engine ${this.endpoint} failed with HTTP ${this.status}.`;
  }
}

export type DockerHost =
  /** The first socket that exists; the last one is used when none does. */
  | { readonly _tag: "Unix"; readonly socketPaths: ReadonlyArray<string> }
  | {
      readonly _tag: "Tcp";
      readonly origin: string;
      readonly tls: { readonly certPath: string } | null;
    }
  | { readonly _tag: "Unsupported"; readonly scheme: string };

export interface DockerHostEnvironment {
  readonly DOCKER_HOST?: string | undefined;
  readonly DOCKER_TLS_VERIFY?: string | undefined;
  readonly DOCKER_CERT_PATH?: string | undefined;
  readonly XDG_RUNTIME_DIR?: string | undefined;
}

/** Docker contexts are not read; `ssh://` is unsupported (forward the socket instead). */
export const parseDockerHost = (
  value: string | undefined,
  env: DockerHostEnvironment,
  homeDirectory: string,
): DockerHost => {
  const host = value ?? env.DOCKER_HOST;
  if (host === undefined || host === "") {
    return {
      _tag: "Unix",
      socketPaths: [
        ...(env.XDG_RUNTIME_DIR ? [`${env.XDG_RUNTIME_DIR}/docker.sock`] : []),
        `${homeDirectory}/.docker/run/docker.sock`,
        "/var/run/docker.sock",
      ],
    };
  }
  if (host.startsWith("unix://")) {
    return { _tag: "Unix", socketPaths: [host.slice("unix://".length)] };
  }
  if (host.startsWith("tcp://")) {
    const tls = env.DOCKER_TLS_VERIFY !== undefined && env.DOCKER_TLS_VERIFY !== "";
    const url = URL.parse(`${tls ? "https" : "http"}://${host.slice("tcp://".length)}`);
    if (url === null || url.hostname === "") return { _tag: "Unsupported", scheme: "tcp" };
    const port = url.port === "" ? (tls ? "2376" : "2375") : url.port;
    return {
      _tag: "Tcp",
      origin: `${url.protocol}//${url.hostname}:${port}`,
      tls: tls ? { certPath: env.DOCKER_CERT_PATH || `${homeDirectory}/.docker` } : null,
    };
  }
  return { _tag: "Unsupported", scheme: host.split(":")[0] ?? host };
};

const socketCodeOf = (cause: unknown): string | undefined => {
  for (let current = cause, depth = 0; current instanceof Object && depth < 5; depth++) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

/** Normalizes an Engine failure into the driver's reasons; 304 and 404 meaning success is per call. */
export const mapEngineError = (
  error: DockerEngineError,
  context: {
    readonly driverId: ComputeDriverId;
    readonly operation: ComputeDriverError["operation"];
  },
): ComputeDriverError => {
  const make = (reason: ComputeDriverError["reason"], retryable: boolean) =>
    new ComputeDriverError({
      ...context,
      reason,
      retryable,
      ...(error.status === undefined ? {} : { backendStatus: error.status }),
      cause: error,
    });
  switch (error.failure) {
    case "transport":
      return error.socketCode === "EACCES" || error.socketCode === "EPERM"
        ? make("auth", false)
        : make("unavailable", true);
    case "response":
      return make("unavailable", false);
    case "status": {
      const status = error.status ?? 500;
      if (status === 404) return make("not-found", false);
      if (status === 409) return make("conflict", false);
      if (status === 401 || status === 403) return make("auth", false);
      if (status < 500) return make("invalid-request", false);
      const message = error.cause instanceof Error ? error.cause.message : "";
      return /no space left/i.test(message) ? make("capacity", false) : make("unavailable", true);
    }
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TarEntry {
  /** Relative to the archive root, without a leading slash. */
  readonly name: string;
  readonly mode: number;
  /** Absent for a directory. */
  readonly content?: Uint8Array;
}

const writeField = (header: Uint8Array, offset: number, length: number, value: string) => {
  header.set(encoder.encode(value).subarray(0, length), offset);
};
const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0");

/** A minimal ustar writer for the archive endpoint: root-owned entries, names under 100 bytes. */
export const ustar = (entries: ReadonlyArray<TarEntry>): Uint8Array => {
  const blocks: Array<Uint8Array> = [];
  for (const entry of entries) {
    const directory = entry.content === undefined;
    const name = directory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    if (encoder.encode(name).length > 100) throw new Error(`Tar entry name too long: ${name}`);
    const size = entry.content?.length ?? 0;
    const header = new Uint8Array(512);
    writeField(header, 0, 100, name);
    writeField(header, 100, 8, octal(entry.mode, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(size, 12));
    writeField(header, 136, 12, octal(0, 12));
    writeField(header, 148, 8, "        ");
    writeField(header, 156, 1, directory ? "5" : "0");
    writeField(header, 257, 6, "ustar");
    writeField(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeField(header, 148, 8, `${octal(checksum, 7)}\0`);
    blocks.push(header);
    if (entry.content !== undefined) {
      const padded = new Uint8Array(Math.ceil(size / 512) * 512);
      padded.set(entry.content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
};

/** The first regular file's content, skipping pax headers; null when there is none. */
export const readFirstTarFile = (archive: Uint8Array): Uint8Array | null => {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const sizeText = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (type === "0" || type === "\0") return archive.slice(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
};

const EngineInfo = Schema.Struct({
  NCPU: Schema.Number,
  MemTotal: Schema.Number,
  Runtimes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  SecurityOptions: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
export type EngineInfo = typeof EngineInfo.Type;

const Labels = Schema.NullOr(Schema.Record(Schema.String, Schema.String));

const EngineImage = Schema.Struct({
  Id: Schema.String,
  RepoDigests: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  Config: Schema.optionalKey(Schema.NullOr(Schema.Struct({ Labels: Schema.optionalKey(Labels) }))),
});
export type EngineImage = typeof EngineImage.Type;

const EngineNetwork = Schema.Struct({
  Id: Schema.String,
  IPAM: Schema.Struct({
    Config: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          Subnet: Schema.optionalKey(Schema.String),
          Gateway: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  }),
});
export type EngineNetwork = typeof EngineNetwork.Type;

const EngineVolume = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.optionalKey(Labels),
  CreatedAt: Schema.optionalKey(Schema.String),
});
export type EngineVolume = typeof EngineVolume.Type;
const EngineVolumeList = Schema.Struct({ Volumes: Schema.NullOr(Schema.Array(EngineVolume)) });

const EngineContainer = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Created: Schema.String,
  State: Schema.Struct({ Status: Schema.String }),
  Config: Schema.Struct({ Labels: Schema.optionalKey(Labels) }),
});
export type EngineContainer = typeof EngineContainer.Type;

const EngineContainerSummary = Schema.Struct({
  Id: Schema.String,
  Names: Schema.Array(Schema.String),
  /** Unix seconds. */
  Created: Schema.Number,
  State: Schema.String,
  Labels: Schema.optionalKey(Labels),
});
export type EngineContainerSummary = typeof EngineContainerSummary.Type;

const EngineWait = Schema.Struct({ StatusCode: Schema.Number });

interface EngineCall {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** For errors and spans: a template without ids or query values. */
  readonly endpoint: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly tar?: Uint8Array;
  /** Statuses that are not failures for this call. */
  readonly ok: ReadonlyArray<number>;
}

const labelFilters = (labels: Readonly<Record<string, string>>, present: ReadonlyArray<string>) =>
  JSON.stringify({
    label: [...Object.entries(labels).map(([key, value]) => `${key}=${value}`), ...present],
  });

/**
 * A thin client for the endpoints the Docker driver uses. Each method's 304/404/409 handling is
 * its own: a missing image is `null` for an inspect but success for a delete.
 */
export const makeDockerEngine = (client: HttpClient.HttpClient, origin: string) => {
  const send = Effect.fn("DockerEngine.request")(function* (call: EngineCall) {
    const endpoint = `${call.method} ${call.endpoint}`;
    yield* Effect.annotateCurrentSpan({ endpoint });
    let request = HttpClientRequest.make(call.method)(`${origin}/${API_VERSION}${call.path}`, {
      urlParams: call.query ?? {},
    });
    if (call.json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, call.json);
    if (call.tar !== undefined) {
      request = HttpClientRequest.bodyUint8Array(request, call.tar, "application/x-tar");
    }
    const response = yield* client.execute(request).pipe(
      Effect.catchTags({
        HttpClientError: (cause) => {
          const socketCode = socketCodeOf(cause.reason);
          return Effect.fail(
            new DockerEngineError({
              endpoint,
              failure: "transport",
              ...(socketCode === undefined ? {} : { socketCode }),
              cause,
            }),
          );
        },
      }),
    );
    if (call.ok.includes(response.status)) return response;
    const message = yield* response.json.pipe(
      Effect.map((body) => {
        const text = (body as { readonly message?: unknown } | null)?.message;
        return typeof text === "string" ? text : `HTTP ${response.status}`;
      }),
      Effect.orElseSucceed(() => `HTTP ${response.status}`),
    );
    return yield* new DockerEngineError({
      endpoint,
      failure: "status",
      status: response.status,
      cause: new Error(message),
    });
  });

  const decode =
    <S extends Schema.Decoder<unknown>>(schema: S, endpoint: string) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError((cause) => new DockerEngineError({ endpoint, failure: "response", cause })),
      );

  const bytes = (endpoint: string) => (response: HttpClientResponse.HttpClientResponse) =>
    response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError((cause) => new DockerEngineError({ endpoint, failure: "response", cause })),
    );

  const id = encodeURIComponent;

  return {
    info: send({ method: "GET", endpoint: "/info", path: "/info", ok: [200] }).pipe(
      Effect.flatMap(decode(EngineInfo, "GET /info")),
    ),
    inspectImage: (ref: string) =>
      send({
        method: "GET",
        endpoint: "/images/{ref}/json",
        path: `/images/${id(ref)}/json`,
        ok: [200, 404],
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : decode(EngineImage, "GET /images/{ref}/json")(response),
        ),
      ),
    removeImage: (ref: string) =>
      send({
        method: "DELETE",
        endpoint: "/images/{ref}",
        path: `/images/${id(ref)}`,
        ok: [200, 404],
      }).pipe(Effect.asVoid),
    inspectNetwork: (name: string) =>
      send({
        method: "GET",
        endpoint: "/networks/{id}",
        path: `/networks/${id(name)}`,
        ok: [200, 404],
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : decode(EngineNetwork, "GET /networks/{id}")(response),
        ),
      ),
    /** A network that already exists is success. */
    createNetwork: (body: unknown) =>
      send({
        method: "POST",
        endpoint: "/networks/create",
        path: "/networks/create",
        json: body,
        ok: [201, 409],
      }).pipe(Effect.asVoid),
    removeNetwork: (name: string) =>
      send({
        method: "DELETE",
        endpoint: "/networks/{id}",
        path: `/networks/${id(name)}`,
        ok: [204, 404],
      }).pipe(Effect.asVoid),
    /** Creating an existing volume returns it. */
    createVolume: (body: { readonly Name: string; readonly Labels: Record<string, string> }) =>
      send({
        method: "POST",
        endpoint: "/volumes/create",
        path: "/volumes/create",
        json: body,
        ok: [201],
      }).pipe(Effect.asVoid),
    listVolumes: (labels: Readonly<Record<string, string>>) =>
      send({
        method: "GET",
        endpoint: "/volumes",
        path: "/volumes",
        query: { filters: labelFilters(labels, []) },
        ok: [200],
      }).pipe(
        Effect.flatMap(decode(EngineVolumeList, "GET /volumes")),
        Effect.map((list) => list.Volumes ?? []),
      ),
    /** A missing volume is success; one still in use fails 409. */
    removeVolume: (name: string) =>
      send({
        method: "DELETE",
        endpoint: "/volumes/{name}",
        path: `/volumes/${id(name)}`,
        ok: [204, 404],
      }).pipe(Effect.asVoid),
    /** False when a container of that name already exists (409). */
    createContainer: (name: string, body: unknown) =>
      send({
        method: "POST",
        endpoint: "/containers/create",
        path: "/containers/create",
        query: { name },
        json: body,
        ok: [201, 409],
      }).pipe(Effect.map((response) => response.status === 201)),
    inspectContainer: (ref: string) =>
      send({
        method: "GET",
        endpoint: "/containers/{id}/json",
        path: `/containers/${id(ref)}/json`,
        ok: [200, 404],
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : decode(EngineContainer, "GET /containers/{id}/json")(response),
        ),
      ),
    /** Every container, running or not, carrying the labels and having each `present` label. */
    listContainers: (labels: Readonly<Record<string, string>>, present: ReadonlyArray<string>) =>
      send({
        method: "GET",
        endpoint: "/containers/json",
        path: "/containers/json",
        query: { all: "true", filters: labelFilters(labels, present) },
        ok: [200],
      }).pipe(Effect.flatMap(decode(Schema.Array(EngineContainerSummary), "GET /containers/json"))),
    /** Starting a running container (304) is success. */
    startContainer: (ref: string) =>
      send({
        method: "POST",
        endpoint: "/containers/{id}/start",
        path: `/containers/${id(ref)}/start`,
        ok: [204, 304],
      }).pipe(Effect.asVoid),
    /** Stopping a stopped container (304) is success; a missing one fails 404. */
    stopContainer: (ref: string, graceSeconds: number) =>
      send({
        method: "POST",
        endpoint: "/containers/{id}/stop",
        path: `/containers/${id(ref)}/stop`,
        query: { t: String(graceSeconds) },
        ok: [204, 304],
      }).pipe(Effect.asVoid),
    /** The exit code once the container is not running. */
    waitContainer: (ref: string) =>
      send({
        method: "POST",
        endpoint: "/containers/{id}/wait",
        path: `/containers/${id(ref)}/wait`,
        ok: [200],
      }).pipe(
        Effect.flatMap(decode(EngineWait, "POST /containers/{id}/wait")),
        Effect.map((wait) => wait.StatusCode),
      ),
    /** Force-removes; a missing container is success. Never removes volumes. */
    removeContainer: (ref: string) =>
      send({
        method: "DELETE",
        endpoint: "/containers/{id}",
        path: `/containers/${id(ref)}`,
        query: { force: "true" },
        ok: [204, 404],
      }).pipe(Effect.asVoid),
    /** Extracts a tar at `path`; works on created and stopped containers. */
    putArchive: (ref: string, path: string, tar: Uint8Array) =>
      send({
        method: "PUT",
        endpoint: "/containers/{id}/archive",
        path: `/containers/${id(ref)}/archive`,
        query: { path },
        tar,
        ok: [200],
      }).pipe(Effect.asVoid),
    /** A tar of `path`, or null when the container or the path is missing. */
    getArchive: (ref: string, path: string) =>
      send({
        method: "GET",
        endpoint: "/containers/{id}/archive",
        path: `/containers/${id(ref)}/archive`,
        query: { path },
        ok: [200, 404],
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : bytes("GET /containers/{id}/archive")(response),
        ),
      ),
  };
};

export type DockerEngine = ReturnType<typeof makeDockerEngine>;
