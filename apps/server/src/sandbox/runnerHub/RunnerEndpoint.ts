// @effect-diagnostics nodeBuiltinImport:off - the runner-only listeners (03 3.2).
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ComputeDriverId, type SandboxDriverInstance } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { acceptsPrivateNetworkConnection, formatHostForUrl } from "../../startupAccess.ts";
import { type DockerHost, parseDockerHost } from "../compute/DockerEngineApi.ts";
import { RunnerBundle } from "./RunnerBundle.ts";
import { RunnerHub } from "./RunnerHub.ts";
import * as RunnerRoute from "./RunnerRoute.ts";

const RUNNER_SOCKET_NAME = "runner.sock";
// Below macOS's 104-byte and Linux's 108-byte sockaddr_un limits, as CodexManagedTokenBroker.
const UNIX_SOCKET_PATH_BYTES = 100;

/** What `SandboxBootstrap.serverUrl` carries, as the server's machine sees it. */
export interface RunnerDialPlan {
  /** `unix:<socket on the server's disk>`, which the driver mounts by directory, or a URL. */
  readonly serverUrl: string;
}

export class RunnerRouteError extends Schema.TaggedError<RunnerRouteError>()("RunnerRouteError", {
  driverId: ComputeDriverId,
  reason: Schema.Literals([
    "runner-url-required",
    "unsupported-platform",
    "socket-path-too-long",
    "socket-unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "runner-url-required":
        return `Machines on ${this.driverId} cannot reach this server's disk. Set a runner URL for it, or start the server with a runner listener.`;
      case "unsupported-platform":
        return `Sandboxes cannot reach a server on this platform without a runner URL for ${this.driverId}.`;
      case "socket-path-too-long":
        return `The runner socket path is too long for this server's state directory. Set a runner URL for ${this.driverId}.`;
      case "socket-unavailable":
        return "The server could not open its runner socket.";
    }
  }
}

export class RunnerListenerError extends Schema.TaggedError<RunnerListenerError>()(
  "RunnerListenerError",
  { host: Schema.String, port: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The runner listener could not bind ${formatHostForUrl(this.host)}:${this.port}.`;
  }
}

type RunnerDialRoute =
  | { readonly _tag: "unix"; readonly socketPath: string }
  | { readonly _tag: "url"; readonly url: string };

/** 03 3.2: how one driver's sandboxes reach this server. */
export const chooseRunnerRoute = (input: {
  readonly runnerUrl: string | undefined;
  /** Null for a VM driver, whose machines never share the server's host. */
  readonly dockerHost: DockerHost | null;
  readonly serverPlatform: NodeJS.Platform;
  /** The live listener's port, never Vite's; null when it is not a TCP listener. */
  readonly serverPort: number | null;
  /** `--runner-host`/`--runner-port`, as bound; the member listener then refuses runners. */
  readonly runnerListener: { readonly url: string; readonly port: number } | null;
  /** `<stateDir>/sandbox/runner-socket` */
  readonly hostSocketDir: string;
}): Result.Result<RunnerDialRoute, RunnerRouteError["reason"]> => {
  if (input.runnerUrl !== undefined) return Result.succeed({ _tag: "url", url: input.runnerUrl });
  // A remote daemon or a VM cannot mount the server's disk (04 7).
  if (input.dockerHost?._tag !== "Unix") {
    return input.runnerListener === null
      ? Result.fail("runner-url-required")
      : Result.succeed({ _tag: "url", url: input.runnerListener.url });
  }
  const tcpPort = input.runnerListener?.port ?? input.serverPort;
  if (input.serverPlatform === "darwin" && tcpPort !== null) {
    // Docker Desktop's VM reaches the host's loopback through this name.
    return Result.succeed({ _tag: "url", url: `http://host.docker.internal:${tcpPort}` });
  }
  if (input.serverPlatform !== "linux") return Result.fail("unsupported-platform");
  const socketPath = `${input.hostSocketDir.replace(/\/+$/, "")}/${RUNNER_SOCKET_NAME}`;
  if (Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_BYTES) {
    return Result.fail("socket-path-too-long");
  }
  return Result.succeed({ _tag: "unix", socketPath });
};

export class RunnerEndpoint extends Context.Service<
  RunnerEndpoint,
  {
    /** Opens the Unix listener on first use of a "unix" route; it lives as long as the server. */
    readonly planFor: (
      driver: SandboxDriverInstance,
    ) => Effect.Effect<RunnerDialPlan, RunnerRouteError>;
    /** Whether the member listener must serve `/runner/*`. */
    readonly dialsOverTcp: Effect.Effect<boolean>;
    /** The runner listener's URL, when the server was started with one. */
    readonly runnerListenerUrl: Option.Option<string>;
  }
>()("t3/sandbox/runnerHub/RunnerEndpoint") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const httpServer = yield* HttpServer.HttpServer;
  const hub = yield* RunnerHub;
  const bundle = yield* RunnerBundle;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const hostSocketDir = path.join(config.stateDir, "sandbox", "runner-socket");
  const serverPort = NetAddress.isInetAddress(httpServer.address) ? httpServer.address.port : null;
  const lock = yield* Semaphore.make(1);
  let listening = false;

  // Opened while the layer builds, so a port that is taken fails the server's start.
  const runnerListener =
    config.runnerListener === undefined ? null : yield* listenTcp(config.runnerListener);

  // Runner routes only: no /api, /ws or /mcp on this socket.
  const listen = Effect.fn("RunnerEndpoint.listen")(function* (socketPath: string) {
    yield* fs.makeDirectory(hostSocketDir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(hostSocketDir, 0o700);
    yield* fs.remove(socketPath, { force: true });
    yield* Layer.buildWithScope(
      HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(
          NodeHttpServer.layer(() => NodeHttp.createServer(), {
            path: socketPath,
            // 03 3.1: the runner's frames are not compressed.
            websocket: { perMessageDeflate: false },
          }),
        ),
      ),
      scope,
    ).pipe(Effect.provideService(RunnerHub, hub), Effect.provideService(RunnerBundle, bundle));
    yield* Effect.logInfo("runner socket listening", { socketPath });
  });

  const routeFor = Effect.fnUntraced(function* (driver: SandboxDriverInstance) {
    return chooseRunnerRoute({
      runnerUrl: driver.runnerUrl,
      dockerHost:
        driver.kind === "docker"
          ? parseDockerHost(
              driver.dockerHost,
              yield* HostProcess.Environment,
              yield* HostProcess.HomeDirectory,
            )
          : null,
      serverPlatform: yield* HostProcess.Platform,
      serverPort,
      runnerListener,
      hostSocketDir,
    });
  });

  const planFor = Effect.fn("RunnerEndpoint.planFor")(function* (driver: SandboxDriverInstance) {
    const route = yield* routeFor(driver);
    if (Result.isFailure(route)) {
      return yield* new RunnerRouteError({ driverId: driver.id, reason: route.failure });
    }
    if (route.success._tag === "url") return { serverUrl: route.success.url };
    const { socketPath } = route.success;
    yield* lock.withPermits(1)(
      Effect.suspend(() => (listening ? Effect.void : listen(socketPath))).pipe(
        Effect.tap(() => Effect.sync(() => (listening = true))),
        Effect.mapError(
          (cause) =>
            new RunnerRouteError({ driverId: driver.id, reason: "socket-unavailable", cause }),
        ),
      ),
    );
    return { serverUrl: `unix:${socketPath}` };
  });

  // Per request, since an admin can add a TCP-dialing driver while the server runs.
  const dialsOverTcp = Effect.gen(function* () {
    if (runnerListener !== null) return false;
    const drivers = yield* settings.getSettings.pipe(
      Effect.map((current) => current.sandbox?.drivers ?? []),
      Effect.orElseSucceed(() => []),
    );
    for (const driver of drivers) {
      const route = yield* routeFor(driver);
      if (Result.isSuccess(route) && route.success._tag === "url") return true;
    }
    return false;
  });

  return RunnerEndpoint.of({
    planFor,
    dialsOverTcp,
    runnerListenerUrl: runnerListener === null ? Option.none() : Option.some(runnerListener.url),
  });
});

/** Runner routes only, and never for a peer outside loopback or a private network. */
const listenTcp = Effect.fn("RunnerEndpoint.listenTcp")(function* (address: {
  readonly host: string;
  readonly port: number;
}) {
  const scope = yield* Effect.scope;
  const services = yield* Layer.buildWithScope(
    HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(
          () => {
            const server = NodeHttp.createServer();
            server.on("connection", (socket) => {
              if (!acceptsPrivateNetworkConnection(socket)) socket.destroy();
            });
            return server;
          },
          {
            host: address.host,
            port: address.port,
            // 03 3.1: the runner's frames are not compressed.
            websocket: { perMessageDeflate: false },
          },
        ),
      ),
    ),
    scope,
  ).pipe(
    Effect.catchTags({
      ServeError: (error) =>
        Effect.fail(new RunnerListenerError({ ...address, cause: error.cause })),
    }),
  );
  const bound = Context.get(services, HttpServer.HttpServer).address;
  const port = NetAddress.isInetAddress(bound) ? bound.port : address.port;
  const url = `http://${formatHostForUrl(address.host)}:${port}`;
  yield* Effect.logInfo("runner listener listening", { url });
  return { url, port };
});

export const layer = Layer.effect(RunnerEndpoint, make);
