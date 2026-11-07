import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type DockerSandboxDriver,
  EnvironmentId,
  type SandboxDriverCheckResult,
} from "@t3tools/contracts";
import { RunnerLostError } from "@t3tools/contracts/runner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import type * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { SandboxBootstrapSource } from "../lifecycle/SandboxBootstrapSource.ts";
import * as RunnerGrants from "../runnerHub/RunnerGrants.ts";
import * as RunnerHub from "../runnerHub/RunnerHub.ts";
import * as RunnerHubTesting from "../runnerHub/RunnerHubTesting.ts";
import type { ComputeDriver, ComputeDriverHealth } from "./ComputeDriver.ts";
import * as ComputeDriverCheck from "./ComputeDriverCheck.ts";
import * as FakeComputeDriver from "./ComputeDriverTesting.ts";

const driverId = ComputeDriverId.make("local");
const local: DockerSandboxDriver = { kind: "docker", id: driverId, label: "This machine" };
const healthy: ComputeDriverHealth = {
  isolation: "container",
  privateNetworkBlock: { applied: true },
  baseImage: { ref: "t3-sandbox:dev", digest: "sha256:base", version: null },
};

/** The check over a fake driver, with the hub the test supplies. */
const layerCheck = <E>(
  fake: ComputeDriver["Service"],
  hub: Layer.Layer<RunnerHub.RunnerHub | WorkspaceHosts.WorkspaceHosts, E>,
) =>
  ComputeDriverCheck.layer.pipe(
    Layer.provide(
      Layer.effect(
        SandboxBootstrapSource,
        Effect.gen(function* () {
          const runners = yield* RunnerHub.RunnerHub;
          return SandboxBootstrapSource.of({
            forGeneration: (input) =>
              runners.mintEnrollment(input.sandboxId, input.generation).pipe(
                Effect.map((enrollmentSecret) => ({
                  ...input,
                  runnerBuildId: "build",
                  serverUrl: "unix:/run/pair-host/runner.sock",
                  enrollmentSecret,
                })),
                Effect.orDie,
              ),
          });
        }),
      ),
    ),
    Layer.provideMerge(hub),
    Layer.provide(
      Layer.mergeAll(
        FakeComputeDriver.layerRegistry(fake),
        ServerSettingsService.layerTest({ sandbox: { drivers: [local] } }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"),
          ),
        }),
        NodeCrypto.layer,
      ),
    ),
  );

const layerRealHub = RunnerHub.layer.pipe(
  Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
  Layer.provide(RunnerGrants.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

/** A hub whose runner never dials: `connection` waits on `hello`, which the test settles. */
const layerWaitingHub = (input: {
  readonly waiting: Deferred.Deferred<void>;
  readonly hello: Deferred.Deferred<void, RunnerLostError>;
}) =>
  Layer.mergeAll(
    Layer.mock(RunnerHub.RunnerHub)({
      mintEnrollment: () => Effect.succeed(Redacted.make("secret")),
      connection: () =>
        Deferred.succeed(input.waiting, undefined).pipe(
          Effect.andThen(Deferred.await(input.hello)),
          Effect.andThen(Effect.die("a check runner never connects here")),
        ),
      revoke: () => Effect.void,
    }),
    WorkspaceHostTesting.layerFromContext,
  );

const take = <Tag extends FakeComputeDriver.FakeComputeCall["_tag"]>(
  calls: Queue.Dequeue<FakeComputeDriver.FakeComputeCall>,
  tag: Tag,
) =>
  Queue.take(calls).pipe(
    Effect.flatMap((call) =>
      call._tag === tag
        ? Effect.succeed(call as FakeComputeDriver.FakeComputeCall & { readonly _tag: Tag })
        : Effect.die(`Expected ${tag}, got ${call._tag}`),
    ),
  );

/** Answers health and create, and returns the create's input. */
const bootMachine = Effect.fnUntraced(function* (
  calls: Queue.Dequeue<FakeComputeDriver.FakeComputeCall>,
) {
  yield* Deferred.succeed((yield* take(calls, "health")).reply, healthy);
  const create = yield* take(calls, "create");
  yield* Deferred.succeed(create.reply, { driverRef: create.input.name, baseImage: null });
  return create.input;
});

const outline = (result: SandboxDriverCheckResult) =>
  result.steps.map(({ step, ok }) => `${step}:${ok ? "ok" : "failed"}`);

it.effect("boots a machine, reaches its runner, runs git there, then destroys it", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* FakeComputeDriver.make(driverId);
    yield* Effect.gen(function* () {
      const check = yield* ComputeDriverCheck.ComputeDriverCheck;
      const hub = yield* RunnerHub.RunnerHub;
      const running = yield* check.check({ driverId }).pipe(Effect.forkChild);
      const input = yield* bootMachine(calls);
      // The machine boots: its runner enrolls with the bootstrap's secret and says hello.
      const runner = yield* RunnerHubTesting.makeRunner(input.bootstrap.enrollmentSecret);
      yield* runner.connect();
      const destroy = yield* take(calls, "destroy");
      assert.equal(destroy.ref, input.name);
      assert.equal(input.tags["pair.sandbox"], input.sandboxId);
      yield* Deferred.succeed(destroy.reply, undefined);

      const result = yield* Fiber.join(running);
      assert.deepEqual(outline(result), [
        "image:ok",
        "create:ok",
        "runner:ok",
        "git:ok",
        "discard:ok",
      ]);
      assert.match(result.steps[3]?.message ?? "", /^git version /);
      // Revoked: the check's runner keeps no live boot or credential.
      const status = yield* hub.status(input.sandboxId).pipe(Stream.runHead);
      assert.equal(Option.getOrThrow(status)._tag, "lost");
    }).pipe(Effect.provide(layerCheck(driver, layerRealHub)));
  }).pipe(Effect.scoped),
);

it.effect("destroys the machine when its runner never connects", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* FakeComputeDriver.make(driverId);
    const waiting = yield* Deferred.make<void>();
    const hello = yield* Deferred.make<void, RunnerLostError>();
    yield* Effect.gen(function* () {
      const check = yield* ComputeDriverCheck.ComputeDriverCheck;
      const running = yield* check.check({ driverId }).pipe(Effect.forkChild);
      const input = yield* bootMachine(calls);
      yield* Deferred.await(waiting);
      yield* Deferred.fail(hello, new RunnerLostError({ reason: "lease-expired" }));
      const destroy = yield* take(calls, "destroy");
      assert.equal(destroy.ref, input.name);
      yield* Deferred.succeed(destroy.reply, undefined);
      assert.deepEqual(outline(yield* Fiber.join(running)), [
        "image:ok",
        "create:ok",
        "runner:failed",
        "discard:ok",
      ]);
    }).pipe(Effect.provide(layerCheck(driver, layerWaitingHub({ waiting, hello }))));
  }).pipe(Effect.scoped),
);

it.effect("stops at three minutes and still destroys the machine", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* FakeComputeDriver.make(driverId);
    const waiting = yield* Deferred.make<void>();
    const hello = yield* Deferred.make<void, RunnerLostError>();
    yield* Effect.gen(function* () {
      const check = yield* ComputeDriverCheck.ComputeDriverCheck;
      const running = yield* check.check({ driverId }).pipe(Effect.forkChild);
      yield* bootMachine(calls);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("3 minutes");
      yield* Deferred.succeed((yield* take(calls, "destroy")).reply, undefined);
      const result = yield* Fiber.join(running);
      assert.deepEqual(outline(result), ["image:ok", "create:ok", "runner:failed", "discard:ok"]);
      assert.equal(result.steps[2]?.message, "Timed out after 3 minutes.");
    }).pipe(Effect.provide(layerCheck(driver, layerWaitingHub({ waiting, hello }))));
  }).pipe(Effect.scoped),
);

it.effect("destroys the machine when the check is interrupted", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* FakeComputeDriver.make(driverId);
    const waiting = yield* Deferred.make<void>();
    const hello = yield* Deferred.make<void, RunnerLostError>();
    yield* Effect.gen(function* () {
      const check = yield* ComputeDriverCheck.ComputeDriverCheck;
      const running = yield* check.check({ driverId }).pipe(Effect.forkChild);
      const input = yield* bootMachine(calls);
      yield* Deferred.await(waiting);
      const interrupting = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
      const destroy = yield* take(calls, "destroy");
      assert.equal(destroy.ref, input.name);
      yield* Deferred.succeed(destroy.reply, undefined);
      yield* Fiber.join(interrupting);
    }).pipe(Effect.provide(layerCheck(driver, layerWaitingHub({ waiting, hello }))));
  }).pipe(Effect.scoped),
);
