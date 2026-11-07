import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";

import { RunnerConfig, RunnerConfigError, type RunnerConfigShape } from "./RunnerConfig.ts";

const CONNECT_PATH = "/runner/v1/connect";
const FRAME_TIMEOUT = Duration.seconds(45);
const OPEN_TIMEOUT = Duration.seconds(10);
const REDIAL_BASE_MS = 250;
const REDIAL_CAP_MS = 10_000;
/** Bootstrap contract (infra/sandbox-image/pair-bootstrap.sh): fetch the named build once. */
const EXIT_OTHER_BUILD = 75;
/** The server refused the credential; the bootstrap does not retry. */
const EXIT_UNAUTHORIZED = 77;

/** The `Authorization` the runner dials with: `Enroll <secret>`, then `Bearer <token>`. */
export class RunnerCredential extends Context.Service<
  RunnerCredential,
  {
    readonly authorization: Effect.Effect<Redacted.Redacted<string>>;
    /** `runner.hello` hands over the sandbox token; later dials and restarts use it. */
    readonly setSandboxToken: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("t3/sandbox/runner/RunnerSocketServer/RunnerCredential") {}

/** Ends the runner with an exit code the bootstrap acts on. */
export class RunnerShutdown extends Context.Service<
  RunnerShutdown,
  { readonly exit: (code: number) => Effect.Effect<never> }
>()("t3/sandbox/runner/RunnerSocketServer/RunnerShutdown") {}

/** The upgrade response `ws` reports through `unexpected-response`, which Effect's socket hides. */
export class RunnerUpgradeRejected extends Schema.TaggedError<RunnerUpgradeRejected>()(
  "RunnerUpgradeRejected",
  { status: Schema.Number, body: Schema.String },
) {}

export class RunnerDialError extends Schema.TaggedError<RunnerDialError>()("RunnerDialError", {
  cause: Schema.Defect(),
}) {}

const isUpgradeRejected = Schema.is(RunnerUpgradeRejected);

const decodeMismatchBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runnerBuildId: Schema.optional(Schema.String) })),
);

export const layerCredential = Layer.effect(
  RunnerCredential,
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tokenPath = path.join(config.stateDir, "token");
    const initial = Option.isSome(config.enrollment)
      ? `Enroll ${Redacted.value(config.enrollment.value)}`
      : yield* fs.readFileString(tokenPath).pipe(
          Effect.map((token) => token.trim()),
          Effect.filterOrFail(
            (token) => token.length > 0,
            () => new RunnerConfigError({ missing: "PAIR_RUNNER_ENROLL or a sandbox token" }),
          ),
          Effect.mapError(
            () => new RunnerConfigError({ missing: "PAIR_RUNNER_ENROLL or a sandbox token" }),
          ),
          Effect.map((token) => `Bearer ${token}`),
        );
    const current = yield* Ref.make(Redacted.make(initial));
    return RunnerCredential.of({
      authorization: Ref.get(current),
      setSandboxToken: Effect.fn("RunnerCredential.setSandboxToken")(function* (token) {
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        const staging = `${tokenPath}.tmp`;
        yield* fs.writeFileString(staging, Redacted.value(token), { mode: 0o600 });
        yield* fs.chmod(staging, 0o600);
        yield* fs.rename(staging, tokenPath);
        yield* Ref.set(current, Redacted.make(`Bearer ${Redacted.value(token)}`));
      }),
    });
  }),
);

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname.startsWith("127.");

/** `unix:/p` becomes `ws+unix:/p:/runner/v1/connect`; `http(s)://h` becomes `ws(s)://h/...`. */
export const connectUrl = (
  runnerUrl: string,
): { readonly url: string; readonly compress: boolean } => {
  if (runnerUrl.startsWith("unix:")) {
    return { url: `ws+unix:${runnerUrl.slice("unix:".length)}:${CONNECT_PATH}`, compress: false };
  }
  const url = new URL(runnerUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${CONNECT_PATH}`;
  return { url: url.toString(), compress: !isLoopbackHost(url.hostname) };
};

/**
 * Over `ws`, not Effect's Node layer: it must choose `perMessageDeflate` (wasted on loopback and
 * Unix sockets) and see the upgrade response, which it re-emits as a `RunnerUpgradeRejected`.
 */
const makeWebSocketConstructor =
  (compress: boolean): Socket.WebSocketConstructor["Service"] =>
  (url, options) => {
    const headers =
      typeof options === "object" && !Array.isArray(options) ? options.headers : undefined;
    const ws = new NodeWS.WebSocket(url, {
      ...(headers === undefined ? {} : { headers: { ...headers } }),
      perMessageDeflate: compress,
    });
    ws.on("unexpected-response", (request, response) => {
      let body = "";
      const reject = () => {
        request.destroy();
        ws.emit("error", new RunnerUpgradeRejected({ status: response.statusCode ?? 0, body }));
      };
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      response.once("end", reject);
      response.once("error", reject);
    });
    // Effect drops its listeners before closing a socket still connecting; `ws` then emits an
    // `error` nobody handles, which would exit the runner.
    ws.addEventListener("error", () => undefined);
    return ws;
  };

const openWebSocket = (
  makeWebSocket: Socket.WebSocketConstructor["Service"],
  url: string,
  headers: Readonly<Record<string, string>>,
) =>
  Effect.callback<Socket.WebSocketLike, RunnerUpgradeRejected | RunnerDialError>((resume) => {
    const ws = makeWebSocket(url, { headers });
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resume(Effect.succeed(ws));
    };
    const onError = (event: Socket.WebSocketEvent) => {
      cleanup();
      const cause = (event as { readonly error?: unknown }).error ?? event;
      resume(Effect.fail(isUpgradeRejected(cause) ? cause : new RunnerDialError({ cause })));
    };
    const onClose = (event: Socket.WebSocketEvent) => {
      cleanup();
      resume(Effect.fail(new RunnerDialError({ cause: event })));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    return Effect.sync(() => {
      cleanup();
      ws.close();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: OPEN_TIMEOUT,
      orElse: () => Effect.fail(new RunnerDialError({ cause: "timed out opening the socket" })),
    }),
  );

/**
 * One dial with the current credential. A 426 hands the bootstrap the server's build and exits
 * 75; a 401 exits 77. Any other failure is the caller's to retry.
 */
export const dialWebSocket = Effect.fn("RunnerSocketServer.dial")(function* (
  config: RunnerConfigShape,
) {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const credential = yield* RunnerCredential;
  const shutdown = yield* RunnerShutdown;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authorization = yield* credential.authorization;
  const ws = yield* Effect.acquireRelease(
    openWebSocket(makeWebSocket, connectUrl(config.url).url, {
      Authorization: Redacted.value(authorization),
      "X-Pair-Runner-Protocol": String(RUNNER_PROTOCOL_VERSION),
      "X-Pair-Runner-Build": config.runnerBuildId,
    }),
    (ws) => Effect.sync(() => ws.close()),
  ).pipe(
    Effect.catchTags({
      RunnerUpgradeRejected: (rejected) => {
        if (rejected.status === 401) return shutdown.exit(EXIT_UNAUTHORIZED);
        if (rejected.status !== 426) {
          return Effect.fail(new RunnerDialError({ cause: rejected }));
        }
        const serverBuild = Option.flatMap(decodeMismatchBody(rejected.body), (body) =>
          Option.fromUndefinedOr(body.runnerBuildId),
        );
        return Option.match(serverBuild, {
          onNone: () => Effect.void,
          onSome: (build) =>
            fs
              .makeDirectory(config.stateDir, { recursive: true })
              .pipe(
                Effect.andThen(
                  fs.writeFileString(path.join(config.stateDir, "server-build"), build),
                ),
                Effect.ignore,
              ),
        }).pipe(Effect.andThen(shutdown.exit(EXIT_OTHER_BUILD)));
      },
    }),
  );
  return yield* Socket.fromWebSocket(Effect.succeed(ws));
});

/**
 * `RpcServer` keeps no frame timer, so a silent socket would hold the runner forever. The server
 * pings every 15 s; 45 s without a frame ends the socket and `run` redials.
 */
const withFrameTimer = (socket: Socket.Socket, timeout: Duration.Input): Socket.Socket =>
  Socket.make({
    reader: Effect.map(socket.reader, (reader) => ({
      ...reader,
      pull: reader.pull.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketCloseError({
                  code: 4000,
                  closeReason: "no frame within the dead-socket timeout",
                }),
              }),
            ),
        }),
      ),
    })),
    writer: socket.writer,
  });

/** After `failures` failed dials in a row: 250 ms doubling to 10 s, with full jitter. */
const redialDelay = (failures: number) =>
  Random.nextBetween(
    0,
    Math.min(REDIAL_CAP_MS, REDIAL_BASE_MS * 2 ** Math.max(0, failures - 1)),
  ).pipe(Effect.map((millis) => Duration.millis(millis)));

/**
 * The `SocketServer` `RpcServer.layerProtocolSocketServer` consumes: it dials one socket at a
 * time and hands it to the handler. A new socket is a new client id to the one `RpcServer`.
 */
export const make = (
  dial: Effect.Effect<Socket.Socket, RunnerDialError, Scope.Scope>,
  address: string,
): SocketServer.SocketServer["Service"] =>
  SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress(address),
    run: Effect.fn("RunnerSocketServer.run")(function* <R, E, _>(
      handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>,
    ) {
      let failures = 0;
      while (true) {
        const connected = yield* Effect.scoped(
          dial.pipe(
            Effect.flatMap((socket) => Effect.exit(handler(withFrameTimer(socket, FRAME_TIMEOUT)))),
            Effect.as(true),
          ),
        ).pipe(
          Effect.catchTags({
            RunnerDialError: (error) =>
              Effect.logWarning("runner dial failed", { cause: error.cause }).pipe(
                Effect.as(false),
              ),
          }),
        );
        failures = connected ? 0 : failures + 1;
        yield* Effect.sleep(yield* redialDelay(failures));
      }
    }),
  });

export const layer = Layer.effect(
  SocketServer.SocketServer,
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const context = yield* Effect.context<
      RunnerCredential | RunnerShutdown | FileSystem.FileSystem | Path.Path
    >();
    const dial = dialWebSocket(config).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        makeWebSocketConstructor(connectUrl(config.url).compress),
      ),
      Effect.provideContext(context),
    );
    return make(dial, config.url);
  }),
);
