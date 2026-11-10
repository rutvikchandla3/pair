// @effect-diagnostics nodeBuiltinImport:off -- the bridge is a node:net listener Playwright dials.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { type ComputeDriverKind, PreviewMachineBrowserReason, SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { PREVIEW_BROWSER_ARGS } from "../../preview/ServerBrowserContexts.ts";
import {
  isRunnerLost,
  type PortConnectError,
  SANDBOX_ROOT,
  type WorkspaceHost,
} from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";
import type { RunnerConnection } from "../runnerHub/RunnerConnection.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import { toDuplex } from "../runnerHub/tcpDuplex.ts";

export class MachineBrowserError extends Schema.TaggedError<MachineBrowserError>()(
  "MachineBrowserError",
  {
    sandboxId: SandboxId,
    reason: PreviewMachineBrowserReason,
    /** launch-failed: Chrome's last stderr lines. */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-installed":
        return "This machine's image has no browser. Rebuild the team image, then start a new session.";
      case "machine-unavailable":
        return "The machine did not wake. Try again.";
      case "runner-outdated":
        return "This machine's runner is too old for the browser. Stop the machine and start it again.";
      case "launch-failed":
        return this.detail === undefined
          ? "The machine's browser did not start."
          : `The machine's browser did not start: ${this.detail}`;
    }
  }
}

/** One Chrome per machine (07 §5, 7.3), started on first use and kept for the runner boot. */
export class MachineBrowser extends Context.Service<
  MachineBrowser,
  {
    /**
     * `ws://127.0.0.1:<port>/devtools/browser/<guid>` on the server's loopback, for Playwright's
     * `connectOverCDP`. The path is the only secret guarding it: never log or return it in errors.
     */
    readonly endpoint: (sandboxId: SandboxId) => Effect.Effect<string, MachineBrowserError>;
    /** The machine's Chrome while one runs, so port listings and stop can leave it out. */
    readonly processId: (sandboxId: SandboxId) => Effect.Effect<number | undefined>;
    /**
     * SIGTERM to a running Chrome, waiting up to 2 seconds for it to exit, so a machine that
     * sleeps keeps its profile's cookies. Starts nothing and never fails.
     */
    readonly stopForSleep: (sandboxId: SandboxId) => Effect.Effect<void>;
  }
>()("t3/sandbox/browser/MachineBrowser") {}

/** `/usr/local/bin/pair-chrome` links the image's `chrome-headless-shell` (7.1). */
const MACHINE_CHROME_PATH = "/usr/local/bin/pair-chrome";
const START_TIMEOUT = Duration.seconds(30);
const STDERR_TAIL_LINES = 20;
// After Chrome exits, its last stderr lines may still be on their way.
const EXIT_STDERR_GRACE = Duration.seconds(1);
// A SIGKILLed Chrome loses the cookies it had not yet written to its profile.
const SLEEP_STOP_GRACE = Duration.seconds(2);
const REQUEST_HEAD_BYTES = 8 * 1024;
const REQUEST_HEAD_IDLE_MS = 10_000;
const NOT_FOUND = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const DEVTOOLS_LINE =
  /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/[\w-]+)/;

interface Entry {
  readonly boot: RunnerConnection;
  readonly scope: Scope.Closeable;
  readonly started: Deferred.Deferred<string, MachineBrowserError>;
  pid: number | undefined;
  terminate: Effect.Effect<void, PlatformError.PlatformError> | undefined;
}

/** The machine's base environment without the server's git identity: Chrome commits nothing. */
const browserEnvironment = (base: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  return env;
};

const chromeArgs = (sandboxId: SandboxId, kind: ComputeDriverKind | undefined) => [
  "--remote-debugging-port=0",
  `--user-data-dir=${SANDBOX_ROOT}/${sandboxId}/browser/profile`,
  ...PREVIEW_BROWSER_ARGS,
  // Q1: a container forbids the user namespaces Chrome's sandbox needs; VMs load its profile.
  ...(kind === "docker" ? ["--no-sandbox"] : []),
];

/** The first line of an HTTP request, once its CRLF arrives; the bytes read so far ride along. */
const readRequestHead = (socket: NodeNet.Socket) =>
  Effect.callback<Buffer | undefined>((resume) => {
    let head = Buffer.alloc(0);
    const finish = (value: Buffer | undefined) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.setTimeout(0);
      socket.pause();
      resume(Effect.succeed(value));
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.includes("\r\n")) finish(head);
      else if (head.length > REQUEST_HEAD_BYTES) finish(undefined);
    };
    const onEnd = () => finish(undefined);
    socket.setTimeout(REQUEST_HEAD_IDLE_MS, () => socket.destroy());
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    return Effect.sync(() => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    });
  });

const isRequestFor = (head: Buffer, path: string) => {
  const expected = Buffer.from(`GET ${path} HTTP/1.1\r\n`);
  const line = head.subarray(0, head.indexOf("\r\n") + 2);
  return line.length === expected.length && NodeCrypto.timingSafeEqual(line, expected);
};

export const make = Effect.fn("MachineBrowser.make")(function* (
  driverKind: (sandboxId: SandboxId) => Effect.Effect<ComputeDriverKind | undefined>,
) {
  const hub = yield* RunnerHub;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const layerScope = yield* Effect.scope;
  // Each entry's scope is a child of the layer's, so a shutdown closes every machine's Chrome.
  const entries = new Map<SandboxId, Entry>();
  const startLock = yield* Semaphore.make(1);

  // Closed from a fiber of its own: a fiber inside the entry's scope cannot close that scope.
  const drop = (sandboxId: SandboxId, entry: Entry) =>
    Effect.sync(() => {
      if (entries.get(sandboxId) === entry) entries.delete(sandboxId);
    }).pipe(
      Effect.andThen(Scope.close(entry.scope, Exit.void).pipe(Effect.forkIn(layerScope))),
      Effect.asVoid,
    );

  /** Accepts Playwright on the server's loopback and dials Chrome through the runner per socket. */
  const openBridge = Effect.fnUntraced(function* (
    sandboxId: SandboxId,
    connect: NonNullable<WorkspaceHost["ports"]>["connect"],
    chromePort: number,
    path: string,
  ) {
    const run = yield* FiberSet.makeRuntime<never, unknown, unknown>();
    const serve = Effect.fn("MachineBrowser.bridgeConnection")(
      function* (socket: NodeNet.Socket) {
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
        const head = yield* readRequestHead(socket);
        // Chrome's `/json` pages name the guid, so only the browser's own WebSocket goes through.
        if (head === undefined || !isRequestFor(head, path)) {
          return yield* Effect.callback<void>((resume) => {
            socket.once("close", () => resume(Effect.void));
            socket.end(NOT_FOUND, () => resume(Effect.void));
          });
        }
        const connection = yield* connect(chromePort);
        const closed = yield* Deferred.make<void>();
        const { duplex, pump } = toDuplex(connection, run, closed);
        yield* Effect.addFinalizer(() => Effect.sync(() => duplex.destroy()));
        yield* Effect.forkScoped(pump);
        socket.once("close", () => Deferred.doneUnsafe(closed, Exit.void));
        duplex.write(head);
        socket.pipe(duplex);
        duplex.pipe(socket);
        yield* Deferred.await(closed);
      },
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.logDebug("machine browser bridge connection ended", { sandboxId, cause }),
      ),
    );
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server, Error>((resume) => {
        const listener = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
          socket.on("error", () => socket.destroy());
          run(serve(socket));
        });
        listener.once("error", (error) => resume(Effect.fail(error)));
        listener.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(listener)));
      }).pipe(Effect.orDie),
      (listener) => Effect.sync(() => listener.close()),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die(new Error("the machine browser bridge has no TCP address"));
    }
    return address.port;
  });

  const start = Effect.fnUntraced(function* (
    sandboxId: SandboxId,
    host: WorkspaceHost,
    entry: Entry,
  ) {
    const fail = (reason: MachineBrowserError["reason"], detail?: string) =>
      new MachineBrowserError({
        sandboxId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      });
    const platformFailure = (error: PlatformError.PlatformError) =>
      isRunnerLost(error) ? fail("machine-unavailable") : fail("launch-failed", error.message);
    const connect = host.ports?.connect;
    if (connect === undefined) return yield* fail("machine-unavailable");
    if (
      !(yield* host.fileSystem.exists(MACHINE_CHROME_PATH).pipe(Effect.mapError(platformFailure)))
    ) {
      return yield* fail("not-installed");
    }
    const kind = yield* driverKind(sandboxId);
    // No thread id: the browser is the machine's, and port listings must not credit it to one.
    const child = yield* host.spawner
      .spawn(
        ChildProcess.make(MACHINE_CHROME_PATH, chromeArgs(sandboxId, kind), {
          env: browserEnvironment((yield* host.info).environment),
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(5),
        }),
      )
      .pipe(Effect.mapError(platformFailure));
    entry.pid = child.pid;
    entry.terminate = child.kill({ killSignal: "SIGTERM" });

    const tail: Array<string> = [];
    const exited = () => fail("launch-failed", tail.join("\n") || "it exited before it listened");
    const devtools = yield* Deferred.make<
      { readonly port: number; readonly path: string },
      MachineBrowserError
    >();
    // Drained until Chrome exits, so a full pipe never stalls it.
    const stderr = yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const match = DEVTOOLS_LINE.exec(line);
        if (match !== null) {
          return Deferred.succeed(devtools, { port: Number(match[1]), path: match[2]! });
        }
        tail.push(line);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
        return Effect.logDebug("machine browser stderr", { sandboxId, line });
      }),
      Effect.ignore,
      Effect.ensuring(Effect.suspend(() => Deferred.fail(devtools, exited()))),
      Effect.forkScoped,
    );
    // A Chrome that exits drops the entry, so the next `endpoint` starts another.
    yield* child.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(Fiber.await(stderr).pipe(Effect.timeoutOption(EXIT_STDERR_GRACE))),
      Effect.andThen(Effect.suspend(() => Deferred.fail(devtools, exited()))),
      Effect.andThen(
        Effect.logInfo("machine browser exited", { sandboxId }).pipe(
          Effect.andThen(drop(sandboxId, entry)),
        ),
      ),
      Effect.forkScoped,
    );

    const { port, path } = yield* Deferred.await(devtools).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          Effect.failSync(() =>
            fail(
              "launch-failed",
              ["it printed no DevTools address within 30 seconds", ...tail].join("\n"),
            ),
          ),
      }),
    );
    // One dial before handing out the endpoint, so an old runner fails here with what to do.
    yield* Effect.scoped(connect(port)).pipe(
      Effect.mapError((error: PortConnectError) => {
        switch (error._tag) {
          case "RunnerUnsupportedError":
            return fail("runner-outdated");
          case "RunnerLostError":
            return fail("machine-unavailable");
          default:
            return fail("launch-failed", error.message);
        }
      }),
    );
    const bridgePort = yield* openBridge(sandboxId, connect, port, path);
    yield* Effect.logInfo("machine browser started", { sandboxId, bridgePort });
    return `ws://127.0.0.1:${bridgePort}${path}`;
  });

  const entryFor = Effect.fnUntraced(function* (
    sandboxId: SandboxId,
    host: WorkspaceHost,
    boot: RunnerConnection,
  ) {
    const existing = entries.get(sandboxId);
    if (existing?.boot === boot) return existing;
    if (existing !== undefined) yield* drop(sandboxId, existing);
    const entry: Entry = {
      boot,
      scope: yield* Scope.fork(layerScope),
      started: yield* Deferred.make<string, MachineBrowserError>(),
      pid: undefined,
      terminate: undefined,
    };
    entries.set(sandboxId, entry);
    // Closing the boot's scope kills Chrome's group and closes the bridge.
    yield* boot.ended.pipe(Effect.andThen(drop(sandboxId, entry)), Effect.forkIn(entry.scope));
    yield* start(sandboxId, host, entry).pipe(
      Scope.provide(entry.scope),
      Effect.catchDefect((cause) =>
        Effect.fail(
          new MachineBrowserError({ sandboxId, reason: "launch-failed", detail: String(cause) }),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit)
          ? Deferred.succeed(entry.started, exit.value)
          : drop(sandboxId, entry).pipe(Effect.andThen(Deferred.done(entry.started, exit))),
      ),
      Effect.onInterrupt(() =>
        Deferred.fail(
          entry.started,
          new MachineBrowserError({ sandboxId, reason: "machine-unavailable" }),
        ),
      ),
      Effect.forkIn(entry.scope),
    );
    return entry;
  });

  const endpoint: MachineBrowser["Service"]["endpoint"] = Effect.fn("MachineBrowser.endpoint")(
    function* (sandboxId) {
      const unavailable = () =>
        new MachineBrowserError({ sandboxId, reason: "machine-unavailable" });
      const host = yield* hosts
        .forPath(`${SANDBOX_ROOT}/${sandboxId}`)
        .pipe(Effect.mapError(unavailable));
      const boot = yield* hub.connection(sandboxId).pipe(Effect.mapError(unavailable));
      const entry = yield* startLock.withPermits(1)(entryFor(sandboxId, host, boot));
      return yield* Deferred.await(entry.started);
    },
  );

  const processId: MachineBrowser["Service"]["processId"] = (sandboxId) =>
    Effect.sync(() => entries.get(sandboxId)?.pid);

  const stopForSleep: MachineBrowser["Service"]["stopForSleep"] = Effect.fn(
    "MachineBrowser.stopForSleep",
  )(function* (sandboxId) {
    const terminate = entries.get(sandboxId)?.terminate;
    if (terminate === undefined) return;
    const stopped = yield* terminate.pipe(
      Effect.timeoutOption(SLEEP_STOP_GRACE),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not stop the machine browser before sleep", {
          sandboxId,
          cause,
        }).pipe(Effect.as(Option.some(undefined))),
      ),
    );
    if (Option.isNone(stopped)) {
      yield* Effect.logWarning("the machine browser did not stop before sleep", { sandboxId });
    }
  });

  return MachineBrowser.of({ endpoint, processId, stopForSleep });
});

/** Only a cloud-only server builds this: no other server runs a machine's browser. */
export const layer = Layer.effect(
  MachineBrowser,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const drivers = yield* ComputeDriverRegistry;
    return yield* make((sandboxId) =>
      projections.getSandbox(sandboxId).pipe(
        Effect.flatMap((sandbox) =>
          sandbox === null ? Effect.undefined : drivers.get(sandbox.driverId),
        ),
        Effect.map((driver) => driver?.kind),
        // Unknown keeps Chrome's sandbox on.
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }),
);
