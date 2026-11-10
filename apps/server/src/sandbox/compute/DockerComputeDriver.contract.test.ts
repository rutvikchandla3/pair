// @effect-diagnostics nodeBuiltinImport:off - the probe target and runner socket are local Node fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type DockerSandboxDriver,
  EnvironmentId,
  SandboxId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { RunnerBundle, RunnerBundleUnavailableError } from "../runnerHub/RunnerBundle.ts";
import { RunnerEndpoint } from "../runnerHub/RunnerEndpoint.ts";
import { sandboxBackendName, sandboxTags } from "./ComputeDriver.ts";
import { computeDriverContract } from "./computeDriverContract.ts";
import * as DockerComputeDriver from "./DockerComputeDriver.ts";
import { makeDockerEngine } from "./DockerEngineApi.ts";

// Built from testdata/stand-in-runner; it doubles as the egress helper's image.
const CONTRACT_IMAGE = "t3-sandbox-contract:test";

const config: DockerSandboxDriver = {
  kind: "docker",
  id: ComputeDriverId.make("docker-contract"),
  label: "Contract Docker",
};

const testEngine = Effect.gen(function* () {
  const dispatcher = yield* NodeHttpClient.makeDispatcherOptions({
    connect: { socketPath: "/var/run/docker.sock" },
  });
  const client = yield* NodeHttpClient.makeUndici.pipe(
    Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
  );
  return makeDockerEngine(client, "http://docker");
});

/** Removes everything the driver made for this install, firewall chains included. */
const cleanupInstall = (installId: EnvironmentId) =>
  Effect.gen(function* () {
    const engine = yield* testEngine;
    const ours = { "pair.install": installId };
    for (const container of yield* engine.listContainers(ours, [])) {
      yield* engine.removeContainer(container.Id);
    }
    for (const volume of yield* engine.listVolumes(ours)) {
      yield* engine.removeVolume(volume.Name);
    }
    const key = installId.slice(0, 8);
    const network = yield* engine.inspectNetwork(`pair-${key}`);
    if (network === null) return;
    const subnet = network.IPAM.Config?.[0]?.Subnet ?? "0.0.0.0/32";
    const chain = `PAIR-${key}`;
    const helper = `pair-${key}-cleanup`;
    yield* engine.createContainer(helper, {
      Image: CONTRACT_IMAGE,
      User: "0",
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [
        [
          "for ipt in iptables-legacy iptables-nft; do",
          `  $ipt -D DOCKER-USER -s '${subnet}' -j '${chain}' 2>/dev/null || true`,
          `  $ipt -D INPUT -i 'pair-${key}' -j '${chain}-in' 2>/dev/null || true`,
          `  for c in '${chain}' '${chain}-in'; do $ipt -F "$c" 2>/dev/null; $ipt -X "$c" 2>/dev/null; done`,
          "done; true",
        ].join("\n"),
      ],
      Labels: ours,
      HostConfig: { NetworkMode: "host", CapAdd: ["NET_ADMIN", "NET_RAW"] },
    });
    yield* engine.startContainer(helper);
    yield* engine.waitContainer(helper);
    yield* engine.removeContainer(helper);
    yield* engine.removeNetwork(`pair-${key}`);
  }).pipe(Effect.scoped, Effect.orDie);

const makeContractDriver = (installId: EnvironmentId) =>
  Effect.gen(function* () {
    // Registered before the driver, so it runs after the suite has destroyed its sandboxes.
    yield* Effect.addFinalizer(() => cleanupInstall(installId));
    return yield* DockerComputeDriver.make(config).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(installId),
          }),
          ServerSettingsService.layerTest({
            sandbox: { drivers: [config], baseImage: CONTRACT_IMAGE },
          }),
          // The suite hands each bootstrap its own socket; no route is needed past the egress block.
          Layer.succeed(RunnerEndpoint, {
            planFor: () => Effect.succeed({ serverUrl: "unix:/unused/runner.sock" }),
            dialsOverTcp: Effect.succeed(false),
          }),
          Layer.succeed(RunnerBundle, {
            current: Effect.fail(new RunnerBundleUnavailableError({ reason: "not-bundled" })),
          }),
          NodeServices.layer,
        ),
      ),
      Effect.orDie,
    );
  });

const ProbeResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ host: Schema.String, port: Schema.Number, ok: Schema.Boolean }),
  ),
});
type ProbeTarget = { readonly host: string; readonly port: number };

/** A runner socket that hands the stand-in probe targets and collects what it could reach. */
const makeProbeServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-docker-probe-" });
  const socketPath = path.join(directory, "runner.sock");
  const targets = yield* Deferred.make<ReadonlyArray<ProbeTarget>>();
  const results = yield* Deferred.make<typeof ProbeResults.Type>();
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), { path: socketPath });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url === "/probes" && request.method === "GET") {
        return HttpServerResponse.jsonUnsafe(yield* Deferred.await(targets));
      }
      if (request.url === "/probes" && request.method === "POST") {
        yield* Deferred.succeed(results, yield* HttpServerRequest.schemaBodyJson(ProbeResults));
      }
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
  );
  yield* fs.chmod(directory, 0o755);
  yield* fs.chmod(socketPath, 0o666);
  return { serverUrl: `unix:${socketPath}`, targets, results };
});

/** A TCP listener on every host address, so the bridge gateway answers on it. */
const listenOnHost = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer((socket) => socket.destroy());
    server.listen(0, "0.0.0.0", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

describe.runIf(process.env.T3_TEST_DOCKER === "1")("DockerComputeDriver on a real daemon", () => {
  computeDriverContract("DockerComputeDriver", (installId) => makeContractDriver(installId));

  it.live("blocks the bridge gateway and metadata but not the public route", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbeServer;
      const listener = yield* listenOnHost;
      const port = (listener.address() as NodeNet.AddressInfo).port;
      const installId = EnvironmentId.make(NodeCrypto.randomUUID());
      const driver = yield* makeContractDriver(installId);
      yield* Effect.addFinalizer(() =>
        driver.list({ "pair.install": installId }).pipe(
          Effect.flatMap((sandboxes) =>
            Effect.forEach(sandboxes, (sandbox) => driver.destroy(sandbox.driverRef)),
          ),
          Effect.ignore,
        ),
      );
      const sandboxId = SandboxId.make(`sbx_${NodeCrypto.randomBytes(10).toString("hex")}`);

      yield* driver.create({
        name: sandboxBackendName(installId, sandboxId, 1),
        sandboxId,
        generation: 1,
        image: { type: "base" },
        size: "small",
        tags: sandboxTags({ installId, sandboxId, generation: 1, driverId: driver.driverId }),
        bootstrap: {
          sandboxId,
          generation: 1,
          runnerBuildId: "contract",
          serverUrl: probe.serverUrl,
          enrollmentSecret: Redacted.make("enroll"),
        },
      });
      const network = yield* testEngine.pipe(
        Effect.flatMap((engine) => engine.inspectNetwork(`pair-${installId.slice(0, 8)}`)),
        Effect.scoped,
      );
      const gateway = network?.IPAM.Config?.[0]?.Gateway;
      assert.isString(gateway);
      yield* Deferred.succeed(probe.targets, [
        { host: gateway!, port },
        { host: "169.254.169.254", port: 80 },
        { host: "1.1.1.1", port: 443 },
      ]);

      const { results } = yield* Deferred.await(probe.results);
      assert.deepStrictEqual(
        results.map((result) => [result.host, result.ok]),
        [
          [gateway, false],
          ["169.254.169.254", false],
          ["1.1.1.1", true],
        ],
      );
      const health = yield* driver.health;
      assert.deepStrictEqual(health.privateNetworkBlock, { applied: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("snapshot commits a machine once and replays to the same image", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbeServer;
      const installId = EnvironmentId.make(NodeCrypto.randomUUID());
      const driver = yield* makeContractDriver(installId);
      const sandboxId = SandboxId.make(`sbx_${NodeCrypto.randomBytes(10).toString("hex")}`);
      const name = `t3-team-image-contract:${installId.slice(0, 8)}`;
      yield* Effect.addFinalizer(() =>
        driver
          .deleteImage(name)
          .pipe(
            Effect.andThen(driver.destroy(sandboxBackendName(installId, sandboxId, 1))),
            Effect.ignore,
          ),
      );
      const { driverRef } = yield* driver.create({
        name: sandboxBackendName(installId, sandboxId, 1),
        sandboxId,
        generation: 1,
        image: { type: "base" },
        size: "small",
        tags: sandboxTags({ installId, sandboxId, generation: 1, driverId: driver.driverId }),
        bootstrap: {
          sandboxId,
          generation: 1,
          runnerBuildId: "contract",
          serverUrl: probe.serverUrl,
          enrollmentSecret: Redacted.make("enroll"),
        },
      });

      const first = yield* driver.snapshot(driverRef, name);
      const replay = yield* driver.snapshot(driverRef, name);
      assert.deepStrictEqual(replay, first);
      assert.isNumber(first.sizeBytes);
      const image = yield* testEngine.pipe(
        Effect.flatMap((engine) => engine.inspectImage(name)),
        Effect.scoped,
      );
      assert.strictEqual(image?.Id, first.imageRef);
      // The daemon merges the container's labels into the commit's; this records which survive.
      assert.deepStrictEqual(image?.Config?.Labels, {
        ...sandboxTags({ installId, sandboxId, generation: 1, driverId: driver.driverId }),
        "pair.team-image.build": installId.slice(0, 8),
        "pair.team-image.machine": driverRef,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Under gVisor's rootfs overlay, a commit saves none of what the machine changed inside itself.
  it.live("an image build's commit holds what its machine changed inside itself", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbeServer;
      const installId = EnvironmentId.make(NodeCrypto.randomUUID());
      const driver = yield* makeContractDriver(installId);
      const sandboxId = SandboxId.make(`sbx_${NodeCrypto.randomBytes(10).toString("hex")}`);
      const machine = sandboxBackendName(installId, sandboxId, 1);
      const name = `t3-team-image-contract:${installId.slice(0, 8)}`;
      yield* Effect.addFinalizer(() =>
        driver.deleteImage(name).pipe(Effect.andThen(driver.destroy(machine)), Effect.ignore),
      );
      const { driverRef } = yield* driver.create({
        name: machine,
        sandboxId,
        generation: 1,
        image: { type: "base" },
        size: "small",
        tags: sandboxTags({ installId, sandboxId, generation: 1, driverId: driver.driverId }),
        bootstrap: {
          sandboxId,
          generation: 1,
          runnerBuildId: "contract",
          serverUrl: probe.serverUrl,
          enrollmentSecret: Redacted.make("enroll"),
        },
        purpose: "image-build",
      });
      const container = yield* testEngine.pipe(
        Effect.flatMap((engine) => engine.inspectContainer(driverRef)),
        Effect.scoped,
      );
      assert.strictEqual(container?.HostConfig?.Runtime, "runc");
      // The stand-in deletes its bootstrap file, then asks for probes and posts their results.
      yield* Deferred.succeed(probe.targets, []);
      yield* Deferred.await(probe.results);

      const { imageRef } = yield* driver.snapshot(driverRef, name);
      const generation = yield* driver.readImageFile(imageRef, "/etc/pair-runner/generation");
      assert.strictEqual(new TextDecoder().decode(generation as Uint8Array), "1\n");
      assert.isNull(yield* driver.readImageFile(imageRef, "/etc/pair-runner/bootstrap.env"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
