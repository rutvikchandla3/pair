// @effect-diagnostics nodeBuiltinImport:off -- the MCP proxy is a node:http server over forwarded bytes, and the broker is a node:net socket.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import type { SandboxId } from "@t3tools/contracts";
import {
  type RunnerCallError,
  type RunnerGitCredentialRequest,
  RunnerGitCredentialRequest as GitCredentialRequestSchema,
  RunnerGitCredentialResponse,
  type RunnerLostError,
} from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import {
  ProjectionStoreV2,
  type ProjectionStoreV2Shape,
} from "../../orchestration-v2/ProjectionStore.ts";
import { CodexManagedTokenBroker } from "../../provider/CodexManagedTokenBroker.ts";
import * as CodexManagedTokenProtocol from "../../provider/CodexManagedTokenProtocol.ts";
import {
  type WorkspaceHost,
  WorkspaceHostUnavailableError,
} from "../../workspaceHost/WorkspaceHost.ts";
import { GitCredentialService } from "../credentials/GitCredentialService.ts";
import type { RunnerTcpConnection } from "./RunnerConnection.ts";
import { RunnerHub, type RunnerUnavailableError } from "./RunnerHub.ts";

const GIT_REQUEST_BYTES = 8 * 1024;
const LINE_IDLE_MS = 5_000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

const encoder = new TextEncoder();
const decodeCodexRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexManagedTokenProtocol.Request),
);
const decodeGitRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(GitCredentialRequestSchema)),
);
const encodeGitResponse = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(RunnerGitCredentialResponse)),
);

/** Only `/mcp`, and only a thread token of the provider session that opened the forward. */
export const mcpForwardAllows = (
  scope: McpThreadInvocationScope | undefined,
  ownerKey: string,
  pathname: string,
) => pathname === "/mcp" && scope !== undefined && scope.thread.providerSessionId === ownerKey;

/** One Codex app-server serves every thread of an instance, so the owner is the instance. */
export const codexForwardAllows = (
  request: typeof CodexManagedTokenProtocol.Request.Type,
  ownerKey: string,
) => request.instanceId === ownerKey;

class ForwardFrameError extends Schema.TaggedError<ForwardFrameError>()("ForwardFrameError", {}) {
  override get message(): string {
    return "The forwarded frame was invalid or incomplete.";
  }
}

/** One newline-terminated frame and nothing after it, as `CodexManagedTokenProtocol` frames are. */
const readLine = Effect.fn("RunnerForwards.readLine")(
  function* <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) {
    const chunks: Array<Uint8Array> = [];
    let length = 0;
    let newline = false;
    yield* stream.pipe(
      Stream.takeUntil((chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        newline = chunk.includes(10);
        return newline || length > maxBytes;
      }),
      Stream.runDrain,
    );
    const bytes = Buffer.concat(chunks);
    if (!newline || bytes.length > maxBytes || bytes.indexOf(10) !== bytes.length - 1) {
      return yield* new ForwardFrameError();
    }
    return bytes.subarray(0, bytes.length - 1).toString("utf8");
  },
  Effect.timeoutOrElse({
    duration: LINE_IDLE_MS,
    orElse: () => Effect.fail(new ForwardFrameError()),
  }),
);

/**
 * The `git-credential` answer for a thread of `sandboxId`: the helper's `T3CODE_THREAD_ID`, or the
 * sandbox's owner thread for terminals and scripts, which carry none. A thread that does not use
 * the sandbox gets `null` without reaching the service.
 */
export const answerGitCredential = Effect.fn("RunnerForwards.answerGitCredential")(function* (
  deps: {
    readonly projections: Pick<ProjectionStoreV2Shape, "getSandbox" | "listSandboxThreads">;
    readonly credentials: GitCredentialService["Service"];
  },
  sandboxId: SandboxId,
  request: RunnerGitCredentialRequest,
) {
  // The server mints; nothing is stored or erased.
  if (request.operation !== "get") return null;
  const threadId =
    request.threadId ?? (yield* deps.projections.getSandbox(sandboxId))?.ownerThreadId;
  if (threadId === undefined) return null;
  const threads = yield* deps.projections.listSandboxThreads(sandboxId);
  if (!threads.some((row) => row.threadId === threadId)) return null;
  return yield* deps.credentials.answer({
    sandboxId,
    threadId,
    protocol: request.protocol,
    host: request.host,
    path: request.path,
  });
});

const bearer = (header: string | undefined) => {
  const match = header === undefined ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
};

const withoutHopByHop = (headers: NodeHttp.IncomingHttpHeaders) => {
  const kept: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) kept[name] = value;
  }
  return kept;
};

/** A Node socket over a forwarded connection, for an `http.Server` that never listens. */
const toDuplex = (
  connection: RunnerTcpConnection,
  runFork: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => {
    readonly addObserver: (observer: (exit: Exit.Exit<A, E>) => void) => unknown;
  },
  closed: Deferred.Deferred<void>,
) => {
  const wanted = Latch.makeUnsafe(true);
  const settle =
    (callback: (error?: Error | null) => void) => (exit: Exit.Exit<unknown, unknown>) =>
      callback(Exit.isSuccess(exit) ? null : new Error("the forwarded connection failed"));
  const duplex = new NodeStream.Duplex({
    read: () => wanted.openUnsafe(),
    write: (chunk: Buffer, _encoding, callback) => {
      runFork(connection.write(chunk)).addObserver(settle(callback));
    },
    final: (callback) => {
      runFork(connection.close).addObserver(settle(callback));
    },
    destroy: (error, callback) => {
      Deferred.doneUnsafe(closed, Exit.void);
      callback(error);
    },
  });
  // node:http sets socket timeouts and options; the runner's socket owns them.
  Object.assign(duplex, {
    setTimeout: () => duplex,
    setNoDelay: () => duplex,
    setKeepAlive: () => duplex,
  });
  const pump = connection.read.pipe(
    Stream.runForEach((chunk) =>
      Effect.suspend(() => {
        if (duplex.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          return Effect.void;
        }
        wanted.closeUnsafe();
        return wanted.await;
      }),
    ),
    Effect.andThen(Effect.sync(() => duplex.push(null))),
    Effect.catchCause(() => Effect.sync(() => duplex.destroy())),
  );
  return { duplex, pump };
};

export class RunnerForwards extends Context.Service<
  RunnerForwards,
  {
    /**
     * Opens a named forward in the sandbox for `ownerKey`; closing the scope closes the listener.
     * Returns the in-sandbox address: the `/mcp` URL or the broker socket's path.
     */
    readonly open: (input: {
      readonly sandboxId: SandboxId;
      readonly name: "mcp" | "codex-token";
      readonly ownerKey: string;
    }) => Effect.Effect<string, RunnerUnavailableError | RunnerCallError, Scope.Scope>;
  }
>()("t3/sandbox/runnerHub/RunnerForwards") {}

/** `SandboxWorkspaceHost.exposeServerEndpoint` for one sandbox. */
export const exposeServerEndpoint =
  (
    forwards: RunnerForwards["Service"],
    sandboxId: SandboxId,
  ): WorkspaceHost["exposeServerEndpoint"] =>
  (endpoint) =>
    forwards.open({ sandboxId, name: endpoint.name, ownerKey: endpoint.ownerKey }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("could not open a sandbox forward", { name: endpoint.name, cause }),
      ),
      Effect.mapError(() => new WorkspaceHostUnavailableError({ sandboxId })),
    );

const make = Effect.gen(function* () {
  const hub = yield* RunnerHub;
  const registry = yield* McpSessionRegistry;
  const broker = yield* CodexManagedTokenBroker;
  const projections = yield* ProjectionStoreV2;
  const credentials = yield* GitCredentialService;
  const layerScope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const target = new URL(registry.endpoint);
  const owners = new WeakMap<object, string>();

  const refuse = (response: NodeHttp.ServerResponse, status: 401 | 404) =>
    Effect.sync(() => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(status === 404 ? '{"error":"not_found"}' : '{"error":"unauthorized"}');
    });

  const proxy = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    search: string,
  ) =>
    Effect.callback<void>((resume) => {
      const upstream = NodeHttp.request(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port,
          path: `${target.pathname}${search}`,
          method: request.method,
          headers: { ...withoutHopByHop(request.headers), host: target.host },
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, withoutHopByHop(reply.headers));
          // Server-sent events stream through as they arrive.
          response.flushHeaders();
          reply.pipe(response);
          reply.once("end", () => resume(Effect.void));
        },
      );
      upstream.once("error", () => {
        if (response.headersSent) response.destroy();
        else response.writeHead(502).end();
        resume(Effect.void);
      });
      response.once("close", () => {
        upstream.destroy();
        resume(Effect.void);
      });
      request.pipe(upstream);
      return Effect.sync(() => upstream.destroy());
    });

  // Never logs the bearer or a body.
  const handleMcp = Effect.fn("RunnerForwards.mcpRequest")(function* (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const ownerKey = owners.get(request.socket);
    const url = URL.parse(request.url ?? "/", "http://forward.invalid");
    if (ownerKey === undefined || url === null || url.pathname !== "/mcp") {
      return yield* refuse(response, 404);
    }
    const token = bearer(request.headers.authorization);
    const scope = token === undefined ? undefined : yield* registry.resolve(token);
    if (!mcpForwardAllows(scope, ownerKey, url.pathname)) {
      yield* Effect.logWarning("refused a sandbox MCP request", {
        providerSessionId: ownerKey,
        reason: token === undefined ? "missing_bearer" : "not_this_session",
      });
      return yield* refuse(response, 401);
    }
    yield* Effect.logDebug("forwarding a sandbox MCP request", { providerSessionId: ownerKey });
    yield* proxy(request, response, url.search);
  });

  const mcpServer = NodeHttp.createServer((request, response) => {
    runFork(handleMcp(request, response));
  });
  mcpServer.on("clientError", (_error, socket) => socket.destroy());

  const serveMcp =
    (ownerKey: string) =>
    (connection: RunnerTcpConnection): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const { duplex, pump } = toDuplex(connection, runFork, closed);
        yield* Effect.addFinalizer(() => Effect.sync(() => duplex.destroy()));
        owners.set(duplex, ownerKey);
        yield* Effect.forkScoped(pump);
        mcpServer.emit("connection", duplex);
        yield* Deferred.await(closed);
      });

  const brokerRoundTrip = (endpoint: string, frame: string) =>
    Effect.acquireRelease(
      Effect.sync(() => NodeNet.createConnection(endpoint)),
      (socket) => Effect.sync(() => socket.destroy()),
    ).pipe(
      Effect.flatMap((socket) => {
        socket.on("error", () => undefined);
        socket.once("connect", () => socket.write(`${frame}\n`));
        return CodexManagedTokenProtocol.readFrame(
          socket,
          CodexManagedTokenProtocol.RESPONSE_BYTES,
          CodexManagedTokenProtocol.COMMAND_TIMEOUT_MS,
        );
      }),
      Effect.scoped,
    );

  const serveCodex =
    (ownerKey: string) =>
    (connection: RunnerTcpConnection): Effect.Effect<void> =>
      Effect.gen(function* () {
        const frame = yield* readLine(connection.read, CodexManagedTokenProtocol.REQUEST_BYTES);
        const request = yield* decodeCodexRequest(frame);
        // Refused before the broker sees a byte.
        if (!codexForwardAllows(request, ownerKey)) {
          return yield* Effect.logWarning("refused a sandbox Codex token request", {
            instanceId: ownerKey,
          });
        }
        const reply = yield* brokerRoundTrip(yield* broker.endpoint, frame);
        yield* connection.write(encoder.encode(`${reply}\n`));
        yield* connection.close;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("sandbox Codex token forward ended", { cause }),
        ),
      );

  const serveGit =
    (sandboxId: SandboxId) =>
    (connection: RunnerTcpConnection): Effect.Effect<void> =>
      Effect.gen(function* () {
        const request = yield* readLine(connection.read, GIT_REQUEST_BYTES).pipe(
          Effect.flatMap(decodeGitRequest),
        );
        const credential = yield* answerGitCredential(
          { projections, credentials },
          sandboxId,
          request,
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not answer a sandbox git credential request", {
              sandboxId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        const line = yield* encodeGitResponse({ version: 1, credential });
        yield* connection.write(encoder.encode(`${line}\n`));
        yield* connection.close;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("sandbox git credential forward ended", { sandboxId, cause }),
        ),
      );

  // One git listener per runner boot at a fixed path, so terminals and scripts reach it too.
  yield* hub.boots.pipe(
    Stream.runForEach(({ sandboxId, connection }) =>
      Effect.gen(function* () {
        yield* connection.openForward({
          name: "git-credential",
          ownerKey: sandboxId,
          serve: serveGit(sandboxId),
        });
        yield* connection.ended;
      }).pipe(
        Effect.scoped,
        Effect.catch((cause: RunnerCallError | RunnerLostError) =>
          Effect.logWarning("could not open the sandbox git credential forward", {
            sandboxId,
            cause,
          }),
        ),
        Effect.forkIn(layerScope),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const open: RunnerForwards["Service"]["open"] = Effect.fn("RunnerForwards.open")(function* ({
    sandboxId,
    name,
    ownerKey,
  }) {
    const connection = yield* hub.connection(sandboxId);
    const address = yield* connection.openForward({
      name,
      ownerKey,
      serve: name === "mcp" ? serveMcp(ownerKey) : serveCodex(ownerKey),
    });
    return name === "mcp" ? `http://${address}/mcp` : address;
  });

  return RunnerForwards.of({ open });
});

export const layer = Layer.effect(RunnerForwards, make);
