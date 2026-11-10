// @effect-diagnostics nodeBuiltinImport:off - the runner-only Unix socket listener (03 3.2).
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ComputeDriverId, type SandboxDriverInstance } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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
  /** `<stateDir>/sandbox/runner-socket` */
  readonly hostSocketDir: string;
}): Result.Result<RunnerDialRoute, RunnerRouteError["reason"]> => {
  if (input.runnerUrl !== undefined) return Result.succeed({ _tag: "url", url: input.runnerUrl });
  // A remote daemon or a VM cannot mount the server's disk (04 7).
  if (input.dockerHost?._tag !== "Unix") return Result.fail("runner-url-required");
  if (input.serverPlatform === "darwin" && input.serverPort !== null) {
    // Docker Desktop's VM reaches the host's loopback through this name.
    return Result.succeed({
      _tag: "url",
      url: `http://host.docker.internal:${input.serverPort}`,
    });
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
    /** Whether any configured driver's sandboxes reach `/runner/*` on the TCP listener. */
    readonly dialsOverTcp: Effect.Effect<boolean>;
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

  return RunnerEndpoint.of({ planFor, dialsOverTcp });
});

export const layer = Layer.effect(RunnerEndpoint, make);
