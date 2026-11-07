import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CheckpointRollback from "../../orchestration-v2/CheckpointRollbackService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderTurnControl from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequests from "../../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitles from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type BackendSandbox, ComputeDriverError } from "../compute/ComputeDriver.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import { RunnerHub, type RunnerHubFact } from "../runnerHub/RunnerHub.ts";
import * as RunnerHubFacts from "../runnerHub/RunnerHubFacts.ts";
import * as SandboxBootstrapSource from "./SandboxBootstrapSource.ts";
import * as SandboxEffects from "./SandboxEffects.ts";
import * as SandboxLifecycleWorker from "./SandboxLifecycleWorker.ts";
import * as SandboxReconciler from "./SandboxReconciler.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Sandbox lifecycle runs never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagement.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "sandbox-lifecycle" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const installId = EnvironmentId.make("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");

/** The real worker and executor over the real `SandboxEffects`, the fake driver and a recording bootstrap. */
const makeSandboxRuntime = Effect.fn("SandboxLifecycleTest.makeRuntime")(function* () {
  const fake = yield* FakeComputeDriver.make(ComputeDriverId.make("docker"));
  const bootstraps = yield* Ref.make<ReadonlyArray<number>>([]);
  const layerBootstrap = Layer.succeed(
    SandboxBootstrapSource.SandboxBootstrapSource,
    SandboxBootstrapSource.SandboxBootstrapSource.of({
      forGeneration: Effect.fn("RecordingBootstrap.forGeneration")(function* (input) {
        yield* Ref.update(bootstraps, (generations) => [...generations, input.generation]);
        return {
          ...input,
          runnerBuildId: "build",
          serverUrl: "unix:/run/test.sock",
          enrollmentSecret: Redacted.make(`enroll-${input.generation}`),
        };
      }),
    }),
  );
  const layerDriver = Layer.mergeAll(
    FakeComputeDriver.layerRegistry(fake.driver),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(installId),
    }),
  );
  const layerSandboxEffects = SandboxEffects.layer.pipe(
    Layer.provide(Layer.merge(layerDriver, layerBootstrap)),
  );
  const layerWorker = EffectWorker.layerWithOptions({ workerId: "sandbox-lifecycle" }).pipe(
    Layer.provide(
      // Fresh: the replay harness already built (and memoized) one over a stub SandboxEffects.
      Layer.fresh(EffectWorker.layerExecutor).pipe(
        Layer.provide(
          Layer.mergeAll(
            layerSandboxEffects,
            Layer.mock(RunFinalization.RunFinalizationService)({}),
            Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
            Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
            Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({}),
            Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
            Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
          ),
        ),
      ),
    ),
  );
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(Effect.provide(layerWorker));
  return { ...fake, bootstraps, worker, layerDriver };
});

type Runtime = Effect.Success<ReturnType<typeof makeSandboxRuntime>>;

const dispatch = (command: OrchestrationV2ServerCommand) =>
  ThreadManagement.ThreadManagementService.use((threads) => threads.dispatch(command));

const getSandbox = (sandboxId: SandboxId) =>
  ProjectionStore.ProjectionStoreV2.use((projections) => projections.getSandbox(sandboxId));

/** Runs the next effect while the test answers the one driver call it makes. */
const runAnswering = (
  runtime: Runtime,
  answer: (call: FakeComputeDriver.FakeComputeCall) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const run = yield* runtime.worker.drain(1).pipe(Effect.forkChild);
    // An effect that ends without calling the driver must fail the test, not hang it.
    const call = yield* Effect.raceFirst(
      Queue.take(runtime.calls),
      Fiber.join(run).pipe(
        Effect.andThen(Effect.die("The effect finished without calling the driver.")),
      ),
    );
    yield* answer(call);
    assert.equal(yield* Fiber.join(run), 1);
  });

const provisioned = Effect.fn("SandboxLifecycleTest.provisioned")(function* (key: string) {
  const threadId = ThreadId.make(`thread:${key}`);
  const sandboxId = SandboxId.make(
    `sbx_${Array.from(key, (char) => char.charCodeAt(0).toString(16))
      .join("")
      .padEnd(20, "0")
      .slice(0, 20)}`,
  );
  yield* dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${key}`),
    threadId,
    projectId: ProjectId.make("project:sandbox-lifecycle"),
    title: key,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* dispatch({
    type: "sandbox.provision",
    commandId: CommandId.make(`provision:${key}`),
    threadId,
    sandboxId,
    projectId: ProjectId.make("project:sandbox-lifecycle"),
    driverId: ComputeDriverId.make("docker"),
    size: "default",
  });
  return { threadId, sandboxId };
});

const answerCreate = (call: FakeComputeDriver.FakeComputeCall) =>
  call._tag === "create"
    ? Deferred.succeed(call.reply, { driverRef: call.input.name, baseImage: null })
    : Effect.die(`Expected create, got ${call._tag}`);

const sandboxEvents = (threadId: ThreadId) =>
  EventStore.EventStoreV2.use((events) =>
    events.read({ threadId, eventType: "sandbox.updated" }).pipe(Stream.runCollect),
  ).pipe(Effect.map((events) => Array.from(events, (stored) => stored.event)));

/** Answers the reconciler's `list` with `backends`, then its health check. */
const answerReconcilePass = (runtime: Runtime, backends: ReadonlyArray<BackendSandbox>) =>
  Effect.gen(function* () {
    const list = yield* Queue.take(runtime.calls);
    if (list._tag !== "list") return yield* Effect.die(`Expected list, got ${list._tag}`);
    assert.deepEqual(list.tags, { "pair.install": installId });
    yield* Deferred.succeed(list.reply, backends);
    const health = yield* Queue.take(runtime.calls);
    if (health._tag !== "health") return yield* Effect.die(`Expected health, got ${health._tag}`);
    yield* Deferred.succeed(health.reply, {
      isolation: "container",
      privateNetworkBlock: { applied: true },
      baseImage: null,
    });
  });

const attach = (threadId: ThreadId, sandboxId: SandboxId, generation: number) =>
  dispatch({
    type: "sandbox.runner.attached",
    commandId: CommandId.make(`sandbox-attached:${sandboxId}:${generation}:boot`),
    threadId,
    sandboxId,
    generation,
    runnerBootId: "boot",
  });

it.layer(layerTest)("sandbox lifecycle", (it) => {
  it.effect("provisions a thread's sandbox and stores the backend ref the create answers", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("create");
      const thread = yield* ProjectionStore.ProjectionStoreV2.use((projections) =>
        projections.getThread(threadId),
      );
      assert.equal(thread.sandboxId, sandboxId);
      assert.deepInclude(yield* getSandbox(sandboxId), {
        state: "provisioning",
        generation: 1,
        driverRef: null,
      });

      const answered = yield* Deferred.make<FakeComputeDriver.FakeComputeCall>();
      yield* runAnswering(runtime, (call) =>
        Deferred.succeed(answered, call).pipe(Effect.andThen(answerCreate(call))),
      );
      const call = yield* Deferred.await(answered);
      assert.equal(call._tag, "create");
      if (call._tag === "create") {
        assert.equal(call.input.name, `pair-0f1e2d3c-${sandboxId}-g1`);
        assert.include(call.input.tags, { "pair.sandbox": sandboxId, "pair.generation": "1" });
      }
      assert.deepEqual(yield* Ref.get(runtime.bootstraps), [1]);
      assert.deepInclude(yield* getSandbox(sandboxId), {
        state: "provisioning",
        driverRef: `pair-0f1e2d3c-${sandboxId}-g1`,
      });
    }),
  );

  it.effect("records the last driver failure once every attempt of a create has failed", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { sandboxId } = yield* provisioned("fails");
      yield* Queue.take(runtime.calls).pipe(
        Effect.flatMap((call) =>
          call._tag === "create"
            ? Deferred.fail(
                call.reply,
                new ComputeDriverError({
                  driverId: ComputeDriverId.make("fake"),
                  operation: "create",
                  reason: "capacity",
                  retryable: false,
                }),
              )
            : Effect.die(`Expected create, got ${call._tag}`),
        ),
        Effect.forever,
        Effect.forkChild,
      );
      // Five attempts, each after the previous one's backoff.
      yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        runtime.worker.drain().pipe(Effect.andThen(TestClock.adjust("1 second"))),
      );

      const sandbox = yield* getSandbox(sandboxId);
      assert.equal(sandbox?.state, "failed");
      assert.deepEqual(sandbox?.failure, {
        code: "create-failed",
        message: "Compute driver fake failed to create: capacity.",
        retryable: false,
      });
      const [create] = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
        outbox.listByCommandId(CommandId.make("provision:fails")),
      );
      assert.equal(create?.status, "failed");
      assert.equal(create?.attemptCount, 5);
    }),
  );

  it.effect(
    "drops a start whose generation a retry has moved past without calling the driver",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeSandboxRuntime();
        const { threadId, sandboxId } = yield* provisioned("stale-start");
        yield* runAnswering(runtime, answerCreate);
        yield* attach(threadId, sandboxId, 1);
        const sleep = { commandId: CommandId.make("sleep:stale-start"), threadId, sandboxId };
        yield* dispatch({ type: "sandbox.sleep", ...sleep });
        yield* runAnswering(runtime, (call) =>
          call._tag === "stop" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
        );
        assert.deepInclude(yield* getSandbox(sandboxId), { state: "sleeping", generation: 1 });

        yield* dispatch({
          type: "sandbox.wake",
          commandId: CommandId.make("wake"),
          threadId,
          sandboxId,
        });
        yield* dispatch({
          type: "sandbox.failed",
          commandId: CommandId.make(`sandbox-failed:${sandboxId}:2:deadline`),
          threadId,
          sandboxId,
          generation: 2,
          failure: { code: "boot-timeout", message: "No hello.", retryable: true },
        });
        yield* dispatch({
          type: "sandbox.retry",
          commandId: CommandId.make("retry"),
          threadId,
          sandboxId,
        });
        assert.deepInclude(yield* getSandbox(sandboxId), { state: "waking", generation: 3 });

        // Generation 2's start and its deadline's stop run first, in queue order, and return
        // without a driver call.
        assert.equal(yield* runtime.worker.drain(2), 2);
        assert.equal(yield* Queue.size(runtime.calls), 0);
        const started = yield* Deferred.make<number>();
        yield* runAnswering(runtime, (call) =>
          call._tag === "start"
            ? Deferred.succeed(started, call.bootstrap.generation).pipe(
                Effect.andThen(Deferred.succeed(call.reply, undefined)),
              )
            : Effect.die(call._tag),
        );
        assert.equal(yield* Deferred.await(started), 3);
        assert.deepEqual(yield* Ref.get(runtime.bootstraps), [1, 3]);
      }),
  );

  it.effect("fails a sandbox whose runner was lost when the backend reports it missing", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("lost");
      yield* runAnswering(runtime, answerCreate);
      yield* attach(threadId, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.runner.lost",
        commandId: CommandId.make(`sandbox-lost:${sandboxId}:1:boot`),
        threadId,
        sandboxId,
        generation: 1,
        runnerBootId: "boot",
      });
      assert.isNotNull((yield* getSandbox(sandboxId))?.runnerLostAt);

      yield* runAnswering(runtime, (call) =>
        call._tag === "status"
          ? Effect.gen(function* () {
              return yield* Deferred.succeed(call.reply, {
                driverRef: call.driverRef,
                name: call.driverRef,
                sandboxId: null,
                status: "missing",
                createdAt: yield* DateTime.now,
              });
            })
          : Effect.die(call._tag),
      );
      const sandbox = yield* getSandbox(sandboxId);
      assert.equal(sandbox?.state, "failed");
      assert.deepInclude(sandbox?.failure ?? {}, { code: "lost", retryable: true });
      assert.equal(yield* Queue.size(runtime.calls), 0);
    }),
  );
  it.effect("adopts a backend found by name once, after its create's answer was lost", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("reconcile-created");
      const name = `pair-0f1e2d3c-${sandboxId}-g1`;
      const backend: BackendSandbox = {
        driverRef: `container-${sandboxId}`,
        name,
        sandboxId,
        status: "running",
        createdAt: yield* DateTime.now,
      };
      yield* Effect.gen(function* () {
        yield* answerReconcilePass(runtime, [backend]);
        assert.deepInclude(yield* getSandbox(sandboxId), {
          state: "provisioning",
          driverRef: backend.driverRef,
        });
        const afterFirst = (yield* sandboxEvents(threadId)).length;
        yield* TestClock.adjust("10 minutes");
        yield* answerReconcilePass(runtime, [backend]);
        assert.equal((yield* sandboxEvents(threadId)).length, afterFirst);
        // The requeued create reports under the same id, so its receipt drops the duplicate.
        yield* runAnswering(runtime, (call) =>
          call._tag === "create"
            ? Deferred.succeed(call.reply, { driverRef: backend.driverRef, baseImage: null })
            : Effect.die(`Expected create, got ${call._tag}`),
        );
        assert.equal((yield* sandboxEvents(threadId)).length, afterFirst);
      }).pipe(
        Effect.provide(
          SandboxReconciler.layer.pipe(
            Layer.provide(
              Layer.mergeAll(Scheduler.layer, runtime.layerDriver, ThreadCommandExecutor.layer),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("destroys the sandbox when its owner thread is deleted", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("delete");
      yield* runAnswering(runtime, answerCreate);
      yield* attach(threadId, sandboxId, 1);
      yield* dispatch({ type: "thread.delete", commandId: CommandId.make("delete"), threadId });
      // Deletion cleanup effects run first; the destroy is the only one that calls the driver.
      const run = yield* runtime.worker.drain().pipe(Effect.forkChild);
      const call = yield* Effect.raceFirst(
        Queue.take(runtime.calls),
        Fiber.join(run).pipe(Effect.andThen(Effect.die("Deletion never destroyed the sandbox."))),
      );
      if (call._tag !== "destroy") return yield* Effect.die(`Expected destroy, got ${call._tag}`);
      assert.equal(call.ref, `pair-0f1e2d3c-${sandboxId}-g1`);
      yield* Deferred.succeed(call.reply, undefined);
      yield* Fiber.join(run);
      assert.equal((yield* getSandbox(sandboxId))?.state, "destroyed");
      const [last] = (yield* sandboxEvents(threadId)).slice(-1);
      assert.equal(last?.type === "sandbox.updated" && last.payload.state, "destroyed");
    }),
  );

  it.effect("turns a runner's attached fact into a ready sandbox on the owner thread", () =>
    Effect.gen(function* () {
      const { threadId, sandboxId } = yield* provisioned("hub-facts");
      const facts = yield* Queue.unbounded<RunnerHubFact>();
      yield* Layer.build(
        RunnerHubFacts.layer.pipe(
          Layer.provide(Layer.mock(RunnerHub)({ facts: Stream.fromQueue(facts) })),
        ),
      );
      yield* Queue.offer(facts, {
        _tag: "attached",
        sandboxId,
        generation: 1,
        runnerBootId: "boot-1",
        info: {
          runnerBootId: "boot-1",
          runnerBuildId: "build",
          protocolVersion: 1,
          arch: "x64",
          cpus: 2,
          memoryBytes: 1024,
          handles: [],
        },
      });

      const stored = yield* EventSink.EventSinkV2.use((sink) =>
        sink.stream({ threadId, eventType: "sandbox.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "sandbox.updated" && stored.event.payload.state === "ready",
          ),
          Stream.runHead,
        ),
      ).pipe(Effect.map(Option.getOrThrow));
      assert.equal(stored.commandId, `sandbox-attached:${sandboxId}:1:boot-1`);
    }).pipe(Effect.scoped),
  );
});

// Sweeps read every sandbox in the database, so they get one of their own.
it.layer(layerTest)("sandbox lifecycle worker", (it) => {
  it.effect("stops a ready Docker sandbox once its owner settles, and not before", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("settle");
      yield* runAnswering(runtime, answerCreate);
      yield* attach(threadId, sandboxId, 1);
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );

      yield* dispatch({ type: "thread.settle", commandId: CommandId.make("settle:1"), threadId });
      yield* dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle"),
        threadId,
        reason: "user",
      });
      yield* sweep();
      assert.equal((yield* getSandbox(sandboxId))?.state, "ready");

      yield* dispatch({ type: "thread.settle", commandId: CommandId.make("settle:2"), threadId });
      yield* sweep();
      assert.deepInclude(yield* getSandbox(sandboxId), {
        state: "sleeping",
        sleepReason: "settled",
      });
      const sleeps = (yield* sandboxEvents(threadId)).filter(
        (event) => event.type === "sandbox.updated" && event.payload.state === "sleeping",
      );
      assert.equal(sleeps.length, 1);
      yield* runAnswering(runtime, (call) =>
        call._tag === "stop"
          ? Deferred.succeed(call.reply, undefined)
          : Effect.die(`Expected stop, got ${call._tag}`),
      );
      assert.equal((yield* getSandbox(sandboxId))?.state, "sleeping");
    }).pipe(Effect.scoped),
  );

  it.effect("fails a sandbox whose runner never connects at the boot deadline", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { sandboxId } = yield* provisioned("deadline");
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );
      yield* TestClock.adjust("9 minutes");
      yield* sweep();
      assert.equal((yield* getSandbox(sandboxId))?.state, "provisioning");
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      const sandbox = yield* getSandbox(sandboxId);
      assert.equal(sandbox?.state, "failed");
      assert.deepEqual(sandbox?.failure, {
        code: "boot-timeout",
        message: "The machine did not connect in time.",
        retryable: true,
      });
      // The create still queued ahead of it runs, then the deadline's stop frees the machine.
      yield* runAnswering(runtime, answerCreate);
      yield* runAnswering(runtime, (call) =>
        call._tag === "stop"
          ? Deferred.succeed(call.reply, undefined)
          : Effect.die(`Expected stop, got ${call._tag}`),
      );
      assert.deepInclude(yield* getSandbox(sandboxId), {
        state: "failed",
        driverRef: `pair-0f1e2d3c-${sandboxId}-g1`,
      });
    }).pipe(Effect.scoped),
  );
});
