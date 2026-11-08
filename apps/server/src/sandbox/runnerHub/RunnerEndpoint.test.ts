// @effect-diagnostics nodeBuiltinImport:off - plain HTTP over the runner's Unix socket.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, describe, it } from "@effect/vitest";
import { ComputeDriverId, type DockerSandboxDriver } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

interface RouteRow {
  readonly name: string;
  readonly runnerUrl: string | undefined;
  readonly dockerHost: DockerHost;
  readonly platform: NodeJS.Platform;
  readonly hostSocketDir?: string;
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
  ])("$name", ({ runnerUrl, dockerHost, platform, hostSocketDir, expected }) => {
    assert.deepStrictEqual(
      RunnerEndpoint.chooseRunnerRoute({
        runnerUrl,
        dockerHost,
        serverPlatform: platform,
        serverPort: 3773,
        hostSocketDir: hostSocketDir ?? "/srv/t3/runner-socket",
      }),
      expected,
    );
  });
});

const httpStatus = (socketPath: string, path: string) =>
  Effect.callback<number>((resume) => {
    const request = NodeHttp.get({ socketPath, path }, (response) => {
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

// Live: a real Unix listener and real upgrades, so the status codes are the wire's.
it.live("opens the runner socket once and serves only the runner routes on it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-endpoint-" });
    const services = yield* Layer.build(
      RunnerEndpoint.layer.pipe(
        Layer.provide(Layer.mock(ServerConfig)({ stateDir } as ServerConfig["Service"])),
        Layer.provide(ServerSettings.layerTest()),
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
      ),
    );
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
    assert.strictEqual(yield* httpStatus(socketPath, "/api/auth/session"), 404);

    assert.deepStrictEqual(yield* planFor, plan);
    assert.deepStrictEqual((yield* fs.stat(socketPath)).ino, inode);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
