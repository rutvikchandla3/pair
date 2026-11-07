// @effect-diagnostics nodeBuiltinImport:off - the stand-in runner server is a local Node HTTP fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, SandboxId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";

import {
  type ComputeDriver,
  type ComputeDriverCreateInput,
  type SandboxBootstrap,
  sandboxBackendName,
  sandboxTags,
} from "./ComputeDriver.ts";
import { STAND_IN_RUNNER_HELLO_PATH, StandInRunnerHello } from "./ComputeDriverTesting.ts";

export interface StandInRunnerServer {
  /** A Unix socket in its own temp directory, which a driver may bind-mount by directory. */
  readonly socketPath: string;
  /** `unix:<socketPath>`, passed as every bootstrap's `serverUrl`. */
  readonly serverUrl: string;
  readonly awaitHello: (
    sandboxId: SandboxId,
    generation: number,
  ) => Effect.Effect<StandInRunnerHello>;
}

/**
 * Hello is plain HTTP, not the runner protocol: the contract image then needs only Node, and what
 * is under test is the mount and the bootstrap (1.7 owns the protocol).
 */
const makeStandInRunnerServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compute-contract-" });
  const socketPath = path.join(directory, "runner.sock");
  const hellos = new Map<string, Deferred.Deferred<StandInRunnerHello>>();
  const helloFor = (sandboxId: SandboxId, generation: number) => {
    const key = `${sandboxId}:g${generation}`;
    let hello = hellos.get(key);
    if (hello === undefined) {
      hello = Deferred.makeUnsafe<StandInRunnerHello>();
      hellos.set(key, hello);
    }
    return hello;
  };

  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), { path: socketPath });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST" || request.url !== STAND_IN_RUNNER_HELLO_PATH) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const hello = yield* HttpServerRequest.schemaBodyJson(StandInRunnerHello);
      // The first hello of a generation wins; a replay must not change what the test saw.
      yield* Deferred.succeed(helloFor(hello.sandboxId, hello.generation), hello);
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
  );
  // A sandbox's runner user is not the test's user.
  yield* fs.chmod(directory, 0o755);
  yield* fs.chmod(socketPath, 0o666);

  return {
    socketPath,
    serverUrl: `unix:${socketPath}`,
    awaitHello: (sandboxId, generation) =>
      Effect.suspend(() => Deferred.await(helloFor(sandboxId, generation))),
  } satisfies StandInRunnerServer;
});

export type MakeContractDriver = (
  installId: EnvironmentId,
  runner: StandInRunnerServer,
) => Effect.Effect<ComputeDriver["Service"], never, Scope.Scope>;

const randomInstallId = () => EnvironmentId.make(NodeCrypto.randomUUID());
const randomSandboxId = () => SandboxId.make(`sbx_${NodeCrypto.randomBytes(10).toString("hex")}`);

/**
 * Registers the suite every compute driver must pass. Each case uses fresh install and sandbox
 * ids and destroys what its install created, so a real backend can run it repeatedly.
 */
export const computeDriverContract = (name: string, makeDriver: MakeContractDriver) => {
  const setup = Effect.gen(function* () {
    const runner = yield* makeStandInRunnerServer;
    const install = Effect.fn("computeDriverContract.install")(function* (
      installId: EnvironmentId,
    ) {
      const driver = yield* makeDriver(installId, runner);
      const ours = { "pair.install": installId };
      // Runs before the driver's own scope closes: finalizers run in reverse.
      yield* Effect.addFinalizer(() =>
        driver.list(ours).pipe(
          Effect.flatMap((sandboxes) =>
            Effect.forEach(sandboxes, (sandbox) => driver.destroy(sandbox.driverRef), {
              discard: true,
            }),
          ),
          Effect.ignore,
        ),
      );
      const bootstrap = (sandboxId: SandboxId, generation: number): SandboxBootstrap => ({
        sandboxId,
        generation,
        runnerBuildId: "contract",
        serverUrl: runner.serverUrl,
        enrollmentSecret: Redacted.make(`enroll-${NodeCrypto.randomBytes(8).toString("hex")}`),
      });
      const createInput = (sandboxId: SandboxId, generation = 1): ComputeDriverCreateInput => ({
        name: sandboxBackendName(installId, sandboxId, generation),
        sandboxId,
        generation,
        image: { type: "base" },
        size: "small",
        tags: sandboxTags({ installId, sandboxId, generation, driverId: driver.driverId }),
        bootstrap: bootstrap(sandboxId, generation),
      });
      return { driver, ours, bootstrap, createInput };
    });
    return { runner, install };
  }).pipe(Effect.provide(NodeServices.layer));

  describe(`${name} compute driver contract`, () => {
    it.live("creates once per name", () =>
      Effect.gen(function* () {
        const { install } = yield* setup;
        const { driver, ours, createInput } = yield* install(randomInstallId());
        const input = createInput(randomSandboxId());

        const first = yield* driver.create(input);
        const second = yield* driver.create(input);
        assert.strictEqual(second.driverRef, first.driverRef);

        const listed = yield* driver.list(ours);
        assert.deepStrictEqual(
          listed.map((sandbox) => [sandbox.driverRef, sandbox.sandboxId]),
          [[first.driverRef, input.sandboxId]],
        );
      }),
    );

    it.live("delivers this generation's bootstrap", () =>
      Effect.gen(function* () {
        const { runner, install } = yield* setup;
        const { driver, createInput } = yield* install(randomInstallId());
        const input = createInput(randomSandboxId());

        yield* driver.create(input);
        const hello = yield* runner.awaitHello(input.sandboxId, 1);
        assert.deepStrictEqual(hello, {
          sandboxId: input.sandboxId,
          generation: 1,
          enroll: Redacted.value(input.bootstrap.enrollmentSecret),
          marker: null,
        });
      }),
    );

    it.live("keeps the disk across stop and start", () =>
      Effect.gen(function* () {
        const { runner, install } = yield* setup;
        const { driver, bootstrap, createInput } = yield* install(randomInstallId());
        const input = createInput(randomSandboxId());

        const { driverRef } = yield* driver.create(input);
        yield* runner.awaitHello(input.sandboxId, 1);
        yield* driver.stop(driverRef);
        assert.strictEqual((yield* driver.status(driverRef)).status, "stopped");

        const next = bootstrap(input.sandboxId, 2);
        yield* driver.start(driverRef, next);
        const hello = yield* runner.awaitHello(input.sandboxId, 2);
        assert.strictEqual(hello.marker, "g1");
        assert.strictEqual(hello.enroll, Redacted.value(next.enrollmentSecret));
        assert.strictEqual((yield* driver.status(driverRef)).status, "running");
      }),
    );

    it.live("stops and destroys idempotently", () =>
      Effect.gen(function* () {
        const { runner, install } = yield* setup;
        const { driver, createInput } = yield* install(randomInstallId());
        const input = createInput(randomSandboxId());

        const { driverRef } = yield* driver.create(input);
        yield* runner.awaitHello(input.sandboxId, 1);
        yield* driver.stop(driverRef);
        yield* driver.stop(driverRef);
        yield* driver.destroy(driverRef);
        yield* driver.destroy(driverRef);
      }),
    );

    it.live("lists only sandboxes carrying every given tag", () =>
      Effect.gen(function* () {
        const { install } = yield* setup;
        const ourInstall = yield* install(randomInstallId());
        const theirInstall = yield* install(randomInstallId());
        const first = ourInstall.createInput(randomSandboxId());
        const second = ourInstall.createInput(randomSandboxId());

        const firstRef = (yield* ourInstall.driver.create(first)).driverRef;
        const secondRef = (yield* ourInstall.driver.create(second)).driverRef;
        const theirRef = (yield* theirInstall.driver.create(
          theirInstall.createInput(randomSandboxId()),
        )).driverRef;

        const refs = (sandboxes: ReadonlyArray<{ readonly driverRef: string }>) =>
          sandboxes.map((sandbox) => sandbox.driverRef).toSorted();
        assert.deepStrictEqual(
          refs(yield* ourInstall.driver.list(ourInstall.ours)),
          [firstRef, secondRef].toSorted(),
        );
        assert.deepStrictEqual(
          refs(
            yield* ourInstall.driver.list({ ...ourInstall.ours, "pair.sandbox": first.sandboxId }),
          ),
          [firstRef],
        );
        assert.deepStrictEqual(refs(yield* theirInstall.driver.list(theirInstall.ours)), [
          theirRef,
        ]);
      }),
    );

    it.live("reports a destroyed sandbox as missing", () =>
      Effect.gen(function* () {
        const { install } = yield* setup;
        const { driver, ours, createInput } = yield* install(randomInstallId());

        const { driverRef } = yield* driver.create(createInput(randomSandboxId()));
        yield* driver.destroy(driverRef);
        assert.strictEqual((yield* driver.status(driverRef)).status, "missing");
        assert.deepStrictEqual(yield* driver.list(ours), []);
      }),
    );

    it.live("deletes a missing image without failing", () =>
      Effect.gen(function* () {
        const { install } = yield* setup;
        const { driver } = yield* install(randomInstallId());
        yield* driver.deleteImage(`pair-contract-missing:${NodeCrypto.randomUUID()}`);
      }),
    );
  });
};
