// @effect-diagnostics nodeBuiltinImport:off - plain HTTP over the runner's Unix socket.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type DockerSandboxDriver,
  type SandboxDriverInstance,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { ServerConfig } from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { DockerHost } from "../compute/DockerEngineApi.ts";
import * as RunnerBundle from "./RunnerBundle.ts";
import * as RunnerEndpoint from "./RunnerEndpoint.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";

const local: DockerHost = { _tag: "Unix", socketPaths: ["/var/run/docker.sock"] };
const tcp: DockerHost = { _tag: "Tcp", origin: "http://docker.example:2375", tls: null };
const refused = (reason: RunnerEndpoint.RunnerRouteError["reason"]) => Result.fail(reason);
const listener = { url: "http://10.0.0.2:3774", port: 3774 };

interface RouteRow {
  readonly name: string;
  readonly runnerUrl: string | undefined;
  readonly dockerHost: DockerHost | null;
  readonly platform: NodeJS.Platform;
  readonly hostSocketDir?: string;
  readonly runnerListener?: { readonly url: string; readonly port: number };
  readonly expected: ReturnType<typeof RunnerEndpoint.chooseRunnerRoute>;
}

describe("chooseRunnerRoute", () => {
  it.each<RouteRow>([
    {
      name: "the admin's runner URL wins, whatever the host",
      runnerUrl: "https://t3.example.com",
      dockerHost: tcp,
      platform: "win32",
      expected: Result.succeed({ _tag: "url", url: "https://t3.example.com" }),
    },
    {
      name: "a local daemon on Linux mounts the socket",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "linux",
      expected: Result.succeed({ _tag: "unix", socketPath: "/srv/t3/runner-socket/runner.sock" }),
    },
    {
      name: "Docker Desktop reaches the live port through host.docker.internal",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "darwin",
      expected: Result.succeed({ _tag: "url", url: "http://host.docker.internal:3773" }),
    },
    {
      name: "a remote daemon cannot mount the server's disk",
      runnerUrl: undefined,
      dockerHost: tcp,
      platform: "linux",
      expected: refused("runner-url-required"),
    },
    {
      name: "Windows needs a runner URL",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "win32",
      expected: refused("unsupported-platform"),
    },
    {
      name: "a socket path past the sockaddr limit",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "linux",
      hostSocketDir: `/srv/${"x".repeat(90)}`,
      expected: refused("socket-path-too-long"),
    },
    {
      name: "a VM driver dials its runner URL",
      runnerUrl: "http://10.0.0.2:3774",
      dockerHost: null,
      platform: "linux",
      expected: Result.succeed({ _tag: "url", url: "http://10.0.0.2:3774" }),
    },
    {
      name: "a VM driver without a runner URL cannot mount the server's disk",
      runnerUrl: undefined,
      dockerHost: null,
      platform: "linux",
      expected: refused("runner-url-required"),
    },
    {
      name: "a VM driver dials the runner listener by default",
      runnerUrl: undefined,
      dockerHost: null,
      platform: "linux",
      runnerListener: listener,
      expected: Result.succeed({ _tag: "url", url: listener.url }),
    },
    {
      name: "a remote daemon dials the runner listener by default",
      runnerUrl: undefined,
      dockerHost: tcp,
      platform: "linux",
      runnerListener: listener,
      expected: Result.succeed({ _tag: "url", url: listener.url }),
    },
    {
      name: "a local daemon on Linux keeps the socket beside a runner listener",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "linux",
      runnerListener: listener,
      expected: Result.succeed({ _tag: "unix", socketPath: "/srv/t3/runner-socket/runner.sock" }),
    },
    {
      name: "Docker Desktop reaches the runner listener's port, since the live port refuses runners",
      runnerUrl: undefined,
      dockerHost: local,
      platform: "darwin",
      runnerListener: listener,
      expected: Result.succeed({ _tag: "url", url: "http://host.docker.internal:3774" }),
    },
    {
      name: "the admin's runner URL wins over the runner listener",
      runnerUrl: "https://t3.example.com",
      dockerHost: null,
      platform: "linux",
      runnerListener: listener,
      expected: Result.succeed({ _tag: "url", url: "https://t3.example.com" }),
    },
  ])("$name", ({ runnerUrl, dockerHost, platform, hostSocketDir, runnerListener, expected }) => {
    assert.deepStrictEqual(
      RunnerEndpoint.chooseRunnerRoute({
        runnerUrl,
        dockerHost,
        serverPlatform: platform,
        serverPort: 3773,
        runnerListener: runnerListener ?? null,
        hostSocketDir: hostSocketDir ?? "/srv/t3/runner-socket",
      }),
      expected,
    );
  });
});

const httpStatus = (target: NodeHttp.RequestOptions, path: string) =>
  Effect.callback<number>((resume) => {
    const request = NodeHttp.get({ ...target, path }, (response) => {
      response.resume();
      resume(Effect.succeed(response.statusCode ?? 0));
    });
    request.on("error", (error) => resume(Effect.die(error)));
    return Effect.sync(() => request.destroy());
  });

const upgradeStatus = (url: string, headers: Record<string, string>) =>
  Effect.callback<number>((resume) => {
    const ws = new NodeWS.WebSocket(url, { headers });
    ws.on("error", () => undefined);
    ws.on("unexpected-response", (_request, response) =>
      resume(Effect.succeed(response.statusCode ?? 0)),
    );
    ws.on("open", () => resume(Effect.succeed(101)));
    return Effect.sync(() => ws.terminate());
  });

const driver: DockerSandboxDriver = {
  kind: "docker",
  id: ComputeDriverId.make("local"),
  label: "Local",
};

const liveEndpoint = (
  config: Partial<ServerConfig["Service"]>,
  drivers: ReadonlyArray<SandboxDriverInstance> = [],
) =>
  RunnerEndpoint.layer.pipe(
    Layer.provide(
      Layer.mock(ServerConfig)({ runnerListener: undefined, ...config } as ServerConfig["Service"]),
    ),
    Layer.provide(ServerSettings.layerTest({ sandbox: { drivers } })),
    Layer.provide(NodeHttpServer.layerTest),
    Layer.provide(
      Layer.succeed(RunnerBundle.RunnerBundle, {
        current: Effect.fail(
          new RunnerBundle.RunnerBundleUnavailableError({ reason: "not-bundled" }),
        ),
      }),
    ),
    Layer.provide(
      RunnerHub.layer.pipe(
        Layer.provide(RunnerGrants.layer),
        Layer.provide(WorkspaceHostTesting.layerFromContext),
      ),
    ),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );

// Live: a real Unix listener and real upgrades, so the status codes are the wire's.
it.live("opens the runner socket once and serves only the runner routes on it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-endpoint-" });
    const services = yield* Layer.build(liveEndpoint({ stateDir }));
    const endpoint = Context.get(services, RunnerEndpoint.RunnerEndpoint);
    const planFor = endpoint
      .planFor(driver)
      .pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
      );

    const plan = yield* planFor;
    const socketPath = `${stateDir}/sandbox/runner-socket/runner.sock`;
    assert.strictEqual(plan.serverUrl, `unix:${socketPath}`);
    assert.strictEqual((yield* fs.stat(`${stateDir}/sandbox/runner-socket`)).mode & 0o777, 0o700);
    const inode = (yield* fs.stat(socketPath)).ino;

    assert.strictEqual(
      yield* upgradeStatus(`ws+unix:${socketPath}:/runner/v1/connect`, {
        authorization: "Bearer unknown",
        "x-pair-runner-protocol": "1",
      }),
      401,
    );
    assert.strictEqual(yield* httpStatus({ socketPath }, "/api/auth/session"), 404);

    assert.deepStrictEqual(yield* planFor, plan);
    assert.deepStrictEqual((yield* fs.stat(socketPath)).ino, inode);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Live: a real TCP listener, a real upgrade, and a real port collision.
it.live("opens the runner listener at start and serves only the runner routes on it", () =>
  Effect.gen(function* () {
    const memberListener: SandboxDriverInstance = {
      ...driver,
      runnerUrl: "http://127.0.0.1:3773",
    };
    const services = yield* Layer.build(
      liveEndpoint({ stateDir: "/srv/t3", runnerListener: { host: "127.0.0.1", port: 0 } }, [
        memberListener,
      ]),
    );
    const endpoint = Context.get(services, RunnerEndpoint.RunnerEndpoint);
    assert(Option.isSome(endpoint.runnerListenerUrl));
    const url = new URL(endpoint.runnerListenerUrl.value);
    const target = { host: url.hostname, port: Number(url.port) };

    // The route is there: a plain GET is refused for want of an upgrade, not a credential.
    assert.strictEqual(yield* httpStatus(target, "/runner/v1/connect"), 400);
    for (const path of ["/api/auth/session", "/mcp", "/"]) {
      assert.strictEqual(yield* httpStatus(target, path), 404, path);
    }
    assert.strictEqual(yield* upgradeStatus(`ws://${url.host}/ws`, {}), 404);
    // The member listener never serves runners, even for a driver pointed at it.
    assert.isFalse(
      yield* endpoint.dialsOverTcp.pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    const taken = yield* Layer.build(
      liveEndpoint({
        stateDir: "/srv/t3",
        runnerListener: { host: "127.0.0.1", port: target.port },
      }),
    ).pipe(Effect.flip);
    assert.strictEqual(
      taken.message,
      `The runner listener could not bind 127.0.0.1:${target.port}.`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gce = (runnerUrl?: string): SandboxDriverInstance => ({
  kind: "gce",
  id: ComputeDriverId.make("gce"),
  label: "Google Cloud",
  ...(runnerUrl === undefined ? {} : { runnerUrl }),
});

describe("dialsOverTcp", () => {
  it.effect.each([
    { name: "a VM driver with a runner URL", driver: gce("http://10.0.0.2:3773"), expected: true },
    { name: "a VM driver without one", driver: gce(), expected: false },
  ])("$name", ({ driver, expected }) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        RunnerEndpoint.layer.pipe(
          Layer.provide(
            Layer.mock(ServerConfig)({
              stateDir: "/srv/t3",
              runnerListener: undefined,
            } as ServerConfig["Service"]),
          ),
          Layer.provide(ServerSettings.layerTest({ sandbox: { drivers: [driver] } })),
          Layer.provide(NodeHttpServer.layerTest),
          Layer.provide(Layer.mock(RunnerBundle.RunnerBundle)({})),
          Layer.provide(Layer.mock(RunnerHub.RunnerHub)({})),
        ),
      );
      const endpoint = Context.get(services, RunnerEndpoint.RunnerEndpoint);
      assert.strictEqual(
        yield* endpoint.dialsOverTcp.pipe(Effect.provideService(HostProcess.Platform, "linux")),
        expected,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
