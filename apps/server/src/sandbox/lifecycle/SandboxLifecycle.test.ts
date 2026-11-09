import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  EnvironmentId,
  MemberId,
  MessageId,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  SandboxId,
  type ServerSettings as ServerSettingsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CheckpointRollback from "../../orchestration-v2/CheckpointRollbackService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderTurnControl from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequests from "../../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitles from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type BackendSandbox, ComputeDriverError } from "../compute/ComputeDriver.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import { GitHubAppInstallationTokens } from "../credentials/GitHubAppInstallationTokens.ts";
import * as SandboxCredentialRevocation from "../credentials/SandboxCredentialRevocation.ts";
import * as RunnerGrants from "../runnerHub/RunnerGrants.ts";
import * as RunnerHubLive from "../runnerHub/RunnerHub.ts";
import { RunnerHub, type RunnerHubFact, RunnerUnavailableError } from "../runnerHub/RunnerHub.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import * as RunnerHubFacts from "../runnerHub/RunnerHubFacts.ts";
import * as SandboxActivity from "./SandboxActivity.ts";
import * as SandboxAdmission from "./SandboxAdmission.ts";
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
const makeLayerTest = (
  sandboxAdmission?: Layer.Layer<
    SandboxAdmission.SandboxAdmission,
    never,
    ProjectionStore.ProjectionStoreV2 | ServerSettings.ServerSettingsService
  >,
) => {
  // One instance, so the admission's cap reads the settings a test updates.
  const layerSettings = ServerSettings.layerTest();
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "sandbox-lifecycle" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          {
            databaseLayer: layerDatabase,
            runEffectWorker: false,
            ...(sandboxAdmission === undefined
              ? {}
              : {
                  sandboxAdmission: sandboxAdmission.pipe(
                    Layer.provide(layerSettings),
                    Layer.orDie,
                  ),
                }),
          },
        ),
      ),
    ),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
};
const layerTest = makeLayerTest();

/** The fake driver the orchestrator's admission reads its cap from, built with the test layer. */
class AdmissionDriver extends Context.Service<
  AdmissionDriver,
  {
    readonly fake: Effect.Success<ReturnType<typeof FakeComputeDriver.make>>;
    /** Every admission snapshot reads the cap after the counts and waits here; open by default. */
    readonly capRead: Latch.Latch;
  }
>()("t3/sandbox/lifecycle/SandboxLifecycle.test/AdmissionDriver") {}

const layerAdmissionTest = (defaultRunningCap: number) => {
  const layerDriver = Layer.effect(
    AdmissionDriver,
    Effect.all({
      fake: FakeComputeDriver.make(ComputeDriverId.make("docker"), { defaultRunningCap }),
      capRead: Latch.make(true),
    }),
  );
  const layerAdmission = SandboxAdmission.layer.pipe(
    Layer.provide(
      Layer.effect(
        ComputeDriverRegistry.ComputeDriverRegistry,
        Effect.gen(function* () {
          const { fake, capRead } = yield* AdmissionDriver;
          const runningCap = FakeComputeDriver.runningCapFromSettings(
            yield* ServerSettings.ServerSettingsService,
            fake.driver,
          );
          return ComputeDriverRegistry.ComputeDriverRegistry.of({
            get: () => Effect.succeed(fake.driver),
            list: Effect.succeed([fake.driver]),
            runningCap: (driverId) => capRead.await.pipe(Effect.andThen(runningCap(driverId))),
          });
        }),
      ),
    ),
    Layer.provide(layerDriver),
  );
  return makeLayerTest(layerAdmission).pipe(Layer.provideMerge(layerDriver));
};

const installId = EnvironmentId.make("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");

/** The real hub and MCP registry over the test database; installation tokens only record revokes. */
const makeCredentials = Effect.fn("SandboxLifecycleTest.makeCredentials")(function* () {
  const revokedInstallationTokens = yield* Ref.make<ReadonlyArray<SandboxId>>([]);
  const mcp = yield* McpSessionRegistry.__testing.make().pipe(
    Effect.provideService(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    Effect.provideService(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(installId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const context = yield* Layer.build(
    SandboxCredentialRevocation.layer.pipe(
      Layer.provideMerge(
        RunnerHubLive.layer.pipe(
          Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
          Layer.provideMerge(RunnerGrants.layer),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(McpSessionRegistry.McpSessionRegistry, mcp),
          Layer.mock(GitHubAppInstallationTokens)({
            revoke: (sandboxId) =>
              Ref.update(revokedInstallationTokens, (revoked) => [...revoked, sandboxId]),
          }),
        ),
      ),
      Layer.provide(NodeCrypto.layer),
    ),
  );
  return { context, mcp, revokedInstallationTokens };
});

/** The real worker and executor over the real `SandboxEffects`, the fake driver and a recording bootstrap. */
const makeSandboxRuntime = Effect.fn("SandboxLifecycleTest.makeRuntime")(function* (
  driver?: Effect.Success<ReturnType<typeof FakeComputeDriver.make>>,
) {
  const fake = driver ?? (yield* FakeComputeDriver.make(ComputeDriverId.make("docker")));
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
  const activity = yield* SandboxActivity.makeTest;
  const layerDriver = Layer.mergeAll(
    FakeComputeDriver.layerRegistry(fake.driver),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(installId),
    }),
    Layer.succeed(SandboxActivity.SandboxActivity, activity.service),
  );
  const credentials = yield* makeCredentials();
  const layerSandboxEffects = SandboxEffects.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerDriver, layerBootstrap, Layer.succeedContext(credentials.context)),
    ),
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
  const effects = yield* SandboxEffects.SandboxEffects.pipe(Effect.provide(layerSandboxEffects));
  return { ...fake, bootstraps, worker, effects, layerDriver, activity, ...credentials };
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

const provisioned = Effect.fn("SandboxLifecycleTest.provisioned")(function* (
  key: string,
  beforeProvision: Effect.Effect<void> = Effect.void,
) {
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
  yield* beforeProvision;
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

/** The hello, then the `release-waiters` it enqueues, which makes no driver call. */
const attachAndRelease = (
  runtime: Runtime,
  threadId: ThreadId,
  sandboxId: SandboxId,
  generation: number,
) =>
  Effect.gen(function* () {
    yield* attach(threadId, sandboxId, generation);
    assert.equal(yield* runtime.worker.drain(1), 1);
    assert.equal(yield* Queue.size(runtime.calls), 0);
  });

const prompt = (threadId: ThreadId, key: string) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`prompt:${key}`),
    threadId,
    messageId: MessageId.make(`message:${key}`),
    text: "Carry on",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }).pipe(
    Effect.map((sent) => {
      const created = sent.storedEvents.find((stored) => stored.event.type === "run.created");
      if (created?.event.type !== "run.created") throw new Error("Expected a run");
      return { run: created.event.payload, storedEvents: sent.storedEvents };
    }),
  );

/** A side chat forks from the latest point; a fork needs a finished run, here one that failed. */
const forked = (sourceThreadId: ThreadId, key: string, sideChat = false) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:${key}`);
    let runId: RunId | undefined;
    if (!sideChat) {
      // Parked while the machine boots, then failed, so no provider is reached.
      ({
        run: { id: runId },
      } = yield* prompt(sourceThreadId, `${key}-source`));
      yield* dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make(`fail:${key}`),
        threadId: sourceThreadId,
        runId,
        failure: makeProviderFailure({
          message: "Stopped for the test.",
          class: "validation_error",
          retryable: false,
        }),
      });
    }
    yield* dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`fork:${key}`),
      sourceThreadId,
      targetThreadId: threadId,
      sourcePoint: runId === undefined ? { type: "latest_stable" } : { type: "run", runId },
      sideChat,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const answerStop = (call: FakeComputeDriver.FakeComputeCall) =>
  call._tag === "stop" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag);

const answerStart = (call: FakeComputeDriver.FakeComputeCall) =>
  call._tag === "start" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag);

const effectsOf = (commandId: string) =>
  EffectOutbox.EffectOutboxV2.use((outbox) => outbox.listByCommandId(CommandId.make(commandId)));

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

  it.effect.each([
    { name: "a create has failed", id: "fails", retryable: false, retryAfterMs: undefined },
    // The hint skips the in-effect driver retries: one driver call per attempt, not four.
    { name: "a hinted create has failed", id: "hinted", retryable: true, retryAfterMs: 1_000 },
  ])("records the last driver failure once every attempt of $name", (row) =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { sandboxId } = yield* provisioned(row.id);
      const creates = yield* Ref.make(0);
      yield* Queue.take(runtime.calls).pipe(
        Effect.flatMap((call) =>
          call._tag === "create"
            ? Ref.update(creates, (count) => count + 1).pipe(
                Effect.andThen(
                  Deferred.fail(
                    call.reply,
                    new ComputeDriverError({
                      driverId: ComputeDriverId.make("fake"),
                      operation: "create",
                      reason: "capacity",
                      retryable: row.retryable,
                      ...(row.retryAfterMs === undefined ? {} : { retryAfterMs: row.retryAfterMs }),
                    }),
                  ),
                ),
              )
            : Effect.die(`Expected create, got ${call._tag}`),
        ),
        Effect.forever,
        Effect.forkChild,
      );
      // Five attempts, each after the previous one's backoff or hint.
      yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        runtime.worker.drain().pipe(Effect.andThen(TestClock.adjust("1 second"))),
      );

      assert.equal(yield* Ref.get(creates), 5);
      const sandbox = yield* getSandbox(sandboxId);
      assert.equal(sandbox?.state, "failed");
      assert.deepEqual(sandbox?.failure, {
        code: "create-failed",
        message: "Compute driver fake failed to create: capacity.",
        retryable: row.retryable,
      });
      const [create] = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
        outbox.listByCommandId(CommandId.make(`provision:${row.id}`)),
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
        yield* attachAndRelease(runtime, threadId, sandboxId, 1);
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

        // Generation 2's start, and its deadline's stop and release, run first, in queue order,
        // and return without a driver call.
        assert.equal(yield* runtime.worker.drain(3), 3);
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
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
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
      assert.deepInclude(sandbox?.failure ?? {}, { code: "missing", retryable: true });
      assert.equal(sandbox?.driverRef, null);
      // The failure's release-waiters finds no parked run.
      assert.equal(yield* runtime.worker.drain(1), 1);
      assert.equal(yield* Queue.size(runtime.calls), 0);
      // A machine that stopped by itself keeps no credentials either.
      assert.deepEqual(yield* Ref.get(runtime.revokedInstallationTokens), [sandboxId]);
    }),
  );
  it.effect("a wake whose backend is gone fails as missing, and a retry provisions anew", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("gone");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.sleep",
        commandId: CommandId.make("sleep:gone"),
        threadId,
        sandboxId,
      });
      yield* runAnswering(runtime, (call) =>
        call._tag === "stop" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
      );

      yield* dispatch({
        type: "sandbox.wake",
        commandId: CommandId.make("wake:gone"),
        threadId,
        sandboxId,
      });
      yield* runAnswering(runtime, (call) =>
        call._tag === "start"
          ? Deferred.fail(
              call.reply,
              new ComputeDriverError({
                driverId: ComputeDriverId.make("fake"),
                operation: "start",
                reason: "not-found",
                retryable: false,
              }),
            )
          : Effect.die(call._tag),
      );
      assert.deepInclude(yield* getSandbox(sandboxId), { state: "failed", driverRef: null });
      assert.deepInclude((yield* getSandbox(sandboxId))?.failure ?? {}, {
        code: "missing",
        retryable: true,
      });

      yield* dispatch({
        type: "sandbox.retry",
        commandId: CommandId.make("retry:gone"),
        threadId,
        sandboxId,
      });
      const [create] = yield* effectsOf("retry:gone");
      assert.equal(create?.request.type, "sandbox.create");
      // The failure's release-waiters calls no driver; the new create does.
      assert.equal(yield* runtime.worker.drain(1), 1);
      yield* runAnswering(runtime, answerCreate);
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
        // The passes also failed earlier tests' machines that have no backend; their
        // release-waiters find no parked run and call no driver.
        yield* runtime.worker.drain();
        assert.equal(yield* Queue.size(runtime.calls), 0);
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
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      const deleted = yield* dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete"),
        threadId,
      });
      // Nobody else uses it: `destroyed` and its destroy commit with the deletion.
      const destroyed = deleted.storedEvents.find(
        (stored) => stored.event.type === "sandbox.updated",
      );
      assert.equal(
        destroyed?.event.type === "sandbox.updated" && destroyed.event.payload.state,
        "destroyed",
      );
      assert.deepInclude(
        (yield* effectsOf("delete")).map((effect) => effect.request.type),
        "sandbox.destroy",
      );
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

  it.effect(
    "stop revokes the runner grant, the attached threads' MCP tokens and the installation tokens",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeSandboxRuntime();
        const { threadId, sandboxId } = yield* provisioned("revoke");
        yield* runAnswering(runtime, answerCreate);
        yield* attachAndRelease(runtime, threadId, sandboxId, 1);
        const grants = yield* RunnerGrants.RunnerGrants.pipe(
          Effect.provide(Layer.succeedContext(runtime.context)),
        );
        const { token } = yield* grants.enroll(yield* grants.mint(sandboxId, 1));
        const mcpToken = (id: ThreadId) =>
          runtime.mcp
            .issue({ threadId: id, providerInstanceId: instanceId })
            .pipe(
              Effect.map((issued) => issued.config.authorizationHeader.replace(/^Bearer\s+/u, "")),
            );
        const ownerMcp = yield* mcpToken(threadId);
        const elsewhereMcp = yield* mcpToken(ThreadId.make("thread:elsewhere"));

        yield* dispatch({
          type: "sandbox.sleep",
          commandId: CommandId.make("sleep:revoke"),
          threadId,
          sandboxId,
        });
        // Nothing is revoked until the driver accepted the stop.
        yield* runAnswering(runtime, (call) =>
          call._tag === "stop"
            ? Effect.gen(function* () {
                assert.deepEqual(yield* grants.authenticate(token), { sandboxId, generation: 1 });
                yield* Deferred.succeed(call.reply, undefined);
              }).pipe(Effect.orDie)
            : Effect.die(call._tag),
        );

        const refused = yield* grants.authenticate(token).pipe(Effect.flip);
        assert.equal(refused._tag === "RunnerAuthError" && refused.reason, "revoked");
        assert.isUndefined(yield* runtime.mcp.resolve(ownerMcp));
        assert.isDefined(yield* runtime.mcp.resolve(elsewhereMcp));
        assert.deepEqual(yield* Ref.get(runtime.revokedInstallationTokens), [sandboxId]);
      }),
  );

  it.effect("a replayed destroy revokes again without error", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("replayed-destroy");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.discard",
        commandId: CommandId.make("discard:replayed-destroy"),
        threadId,
        sandboxId,
      });
      const answerDestroy = (call: FakeComputeDriver.FakeComputeCall) =>
        call._tag === "destroy" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag);
      yield* runAnswering(runtime, answerDestroy);
      assert.equal((yield* getSandbox(sandboxId))?.state, "destroyed");

      const replay = yield* runtime.effects
        .execute({ type: "sandbox.destroy", sandboxId, generation: 1 })
        .pipe(Effect.forkChild);
      yield* Queue.take(runtime.calls).pipe(Effect.flatMap(answerDestroy));
      yield* Fiber.join(replay);
      assert.deepEqual(yield* Ref.get(runtime.revokedInstallationTokens), [sandboxId, sandboxId]);
    }),
  );

  it.effect("records a git credential once, only for a thread on the sandbox", () =>
    Effect.gen(function* () {
      const { threadId, sandboxId } = yield* provisioned("git-credential");
      const { threadId: elsewhere } = yield* provisioned("elsewhere-git");
      const record = (id: ThreadId) =>
        dispatch({
          type: "sandbox.git-credential.record",
          commandId: CommandId.make(`git-credential:${id}`),
          threadId: id,
          sandboxId,
          source: "member-account",
          host: "github.com",
          repository: "org/repo",
          expiresAt: null,
        });
      yield* record(threadId);
      yield* record(threadId);
      const issued = yield* EventStore.EventStoreV2.use((events) =>
        events
          .read({ threadId, eventType: "sandbox.git-credential.issued" })
          .pipe(Stream.runCollect),
      );
      assert.deepEqual(
        Array.from(issued, (stored) => stored.event.payload),
        [
          {
            sandboxId,
            source: "member-account",
            host: "github.com",
            repository: "org/repo",
            expiresAt: null,
          },
        ],
      );
      const refused = yield* record(elsewhere).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
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
          agent: { uid: 1000, homeDirectory: "/home/t3", shell: "/bin/bash" },
          tmpDirectory: "/tmp",
          bundleDirectory: "/opt/pair-runner/build",
          imageEnvironment: {},
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

it.layer(layerTest)("runner return after a restart", (it) => {
  it.effect("loses a ready sandbox whose runner does not dial back within the lease", () =>
    Effect.gen(function* () {
      const { threadId, sandboxId } = yield* provisioned("restart-lost");
      yield* attach(threadId, sandboxId, 1);
      assert.equal((yield* getSandbox(sandboxId))?.state, "ready");
      yield* Layer.build(
        RunnerHubFacts.layer.pipe(
          Layer.provide(
            Layer.mock(RunnerHub)({
              facts: Stream.never,
              // The real hub fails this once the lease passes with no runner.
              connection: (id) => Effect.fail(new RunnerUnavailableError({ sandboxId: id })),
            }),
          ),
        ),
      );

      const stored = yield* EventSink.EventSinkV2.use((sink) =>
        sink.stream({ threadId, eventType: "sandbox.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "sandbox.updated" && stored.event.payload.runnerLostAt !== null,
          ),
          Stream.runHead,
        ),
      ).pipe(Effect.map(Option.getOrThrow));
      assert.equal(stored.commandId, `sandbox-lost:${sandboxId}:1:unattached`);
    }).pipe(Effect.scoped),
  );
});

// A released run leaves a provider turn queued, which no other test's worker may claim.
it.layer(layerTest)("cloud prompts", (it) => {
  it.effect("wakes a sleeping machine in the prompt's commit and releases the run on hello", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("prompt-wake");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.sleep",
        commandId: CommandId.make("sleep:prompt-wake"),
        threadId,
        sandboxId,
      });
      yield* runAnswering(runtime, (call) =>
        call._tag === "stop" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
      );

      const sent = yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("prompt:prompt-wake"),
        threadId,
        messageId: MessageId.make("message:prompt-wake"),
        text: "Carry on",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        // What clients send; it must not override the wait for the machine.
        deliveryIntent: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const stored = sent.storedEvents.map((entry) => entry.event);
      const woke = stored.find((event) => event.type === "sandbox.updated");
      assert.deepInclude(woke?.type === "sandbox.updated" ? woke.payload : {}, {
        state: "waking",
        generation: 2,
      });
      const created = stored.find((event) => event.type === "run.created");
      const run = created?.type === "run.created" ? created.payload : undefined;
      assert.equal(run?.status, "preparing");
      assert.isUndefined(run?.workspacePreparation);

      yield* runAnswering(runtime, (call) =>
        call._tag === "start" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
      );
      yield* attachAndRelease(runtime, threadId, sandboxId, 2);
      const { runs } = yield* ProjectionStore.ProjectionStoreV2.use((projections) =>
        projections.getThreadRecords(threadId, ["runs"]),
      );
      assert.equal(runs.find((candidate) => candidate.id === run?.id)?.status, "starting");
    }),
  );
});

it.layer(layerTest)("shared sandboxes", (it) => {
  it.effect.each([
    { name: "hands over to a fork after the owner's queued effects", forkDeleted: false },
    { name: "destroys when the fork is deleted before the hand-over runs", forkDeleted: true },
  ])("$name", ({ forkDeleted }) =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const key = forkDeleted ? "handgone" : "handover";
      const { threadId: owner, sandboxId } = yield* provisioned(key);
      const fork = yield* forked(owner, `${key}-fork`);
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, owner, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.sleep",
        commandId: CommandId.make(`sleep:${key}`),
        threadId: owner,
        sandboxId,
      });
      const deleteId = `delete:${key}`;
      yield* dispatch({
        type: "thread.delete",
        commandId: CommandId.make(deleteId),
        threadId: owner,
      });
      if (forkDeleted) {
        yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`delete:${key}-fork`),
          threadId: fork,
        });
      }
      const handOver = () =>
        effectsOf(deleteId).pipe(
          Effect.map((effects) =>
            effects.find((effect) => effect.request.type === "sandbox.hand-over"),
          ),
        );
      assert.deepInclude(yield* handOver(), { threadId: owner, status: "pending" });

      // The stop queued before the delete runs first; the hand-over waits behind it.
      const run = yield* runtime.worker.drain().pipe(Effect.forkChild);
      const nextCall = Effect.raceFirst(
        Queue.take(runtime.calls),
        Fiber.join(run).pipe(Effect.andThen(Effect.die("The drain made no more driver calls."))),
      );
      const stop = yield* nextCall;
      assert.equal((yield* handOver())?.status, "pending");
      yield* answerStop(stop);
      if (forkDeleted) {
        const destroy = yield* nextCall;
        if (destroy._tag !== "destroy") return yield* Effect.die(destroy._tag);
        yield* Deferred.succeed(destroy.reply, undefined);
        yield* Fiber.join(run);
        assert.deepInclude(yield* getSandbox(sandboxId), {
          state: "destroyed",
          ownerThreadId: owner,
        });
        const [last] = (yield* sandboxEvents(owner)).slice(-1);
        assert.equal(last?.type === "sandbox.updated" && last.payload.state, "destroyed");
        return;
      }
      yield* Fiber.join(run);
      assert.equal((yield* handOver())?.status, "succeeded");
      assert.deepInclude(yield* getSandbox(sandboxId), {
        state: "sleeping",
        ownerThreadId: fork,
      });
      const adopted = yield* sandboxEvents(fork);
      assert.equal(adopted.length, 1);

      // The sandbox's effects queue on the new owner from now on.
      yield* dispatch({
        type: "sandbox.wake",
        commandId: CommandId.make(`wake:${key}`),
        threadId: fork,
        sandboxId,
      });
      const [start] = yield* effectsOf(`wake:${key}`);
      assert.deepInclude(start, { threadId: fork });
      assert.equal(start?.request.type, "sandbox.start");
      yield* runAnswering(runtime, (call) =>
        call._tag === "start" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
      );
    }),
  );

  it.effect("a replayed hand-over adopts the same thread once", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId: owner, sandboxId } = yield* provisioned("replay");
      const first = yield* forked(owner, "replay-first");
      yield* forked(owner, "replay-second");
      yield* dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:replay"),
        threadId: owner,
      });
      yield* runtime.effects.handOver({ sandboxId, fromThreadId: owner });
      yield* runtime.effects.handOver({ sandboxId, fromThreadId: owner });

      const adoptId = CommandId.make(`sandbox-adopt:${sandboxId}:${owner}`);
      const receipt = yield* CommandReceiptStore.CommandReceiptStoreV2.use((receipts) =>
        receipts.getByCommandId(adoptId),
      );
      assert.deepInclude(Option.getOrThrow(receipt), { threadId: first, status: "accepted" });
      const adopted = yield* EventSink.EventSinkV2.use((sink) =>
        sink.readByCommandId({ commandId: adoptId }).pipe(Stream.runCollect),
      );
      assert.equal(adopted.length, 1);
      assert.equal((yield* getSandbox(sandboxId))?.ownerThreadId, first);
    }),
  );

  it.effect("reassigning the owning thread moves the machine's member, a fork's does not", () =>
    Effect.gen(function* () {
      const { threadId: owner, sandboxId } = yield* provisioned("reassign");
      const fork = yield* forked(owner, "reassign-fork");
      const reassign = (threadId: ThreadId, member: string) =>
        dispatch({
          type: "thread.owner.set",
          commandId: CommandId.make(`owner:${threadId}`),
          threadId,
          ownerId: MemberId.make(member),
        });
      yield* reassign(fork, "member-fork");
      assert.isNull((yield* getSandbox(sandboxId))?.ownerMemberId);
      yield* reassign(owner, "member-owner");
      assert.equal((yield* getSandbox(sandboxId))?.ownerMemberId, "member-owner");
    }),
  );
});

// A released run leaves a provider turn queued, which no other test's worker may claim.
it.layer(layerTest)("side chat prompts", (it) => {
  it.effect("two side-chat prompts make one wake", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId: owner, sandboxId } = yield* provisioned("side-wake");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, owner, sandboxId, 1);
      yield* dispatch({
        type: "sandbox.sleep",
        commandId: CommandId.make("sleep:side-wake"),
        threadId: owner,
        sandboxId,
      });
      yield* runAnswering(runtime, answerStop);
      const sideChats = [
        yield* forked(owner, "side-wake-b", true),
        yield* forked(owner, "side-wake-c", true),
      ];
      const runIds = yield* Effect.forEach(sideChats, (threadId) =>
        prompt(threadId, threadId).pipe(
          Effect.map(({ run, storedEvents }) => {
            // Another thread can't write the owner's stream; it asks with an effect instead.
            assert.isFalse(storedEvents.some((stored) => stored.event.type === "sandbox.updated"));
            assert.equal(run.status, "preparing");
            return run.id;
          }),
        ),
      );

      // Both requests run; the one wake they make is the only driver call.
      const run = yield* runtime.worker.drain().pipe(Effect.forkChild);
      const start = yield* Effect.raceFirst(
        Queue.take(runtime.calls),
        Fiber.join(run).pipe(Effect.andThen(Effect.die("The prompts never woke the machine."))),
      );
      if (start._tag !== "start") return yield* Effect.die(`Expected start, got ${start._tag}`);
      yield* Deferred.succeed(start.reply, undefined);
      assert.equal(yield* Fiber.join(run), 3);
      const wakeId = `sandbox-wake:${sandboxId}:${owner}:1`;
      const waking = (yield* sandboxEvents(owner)).filter(
        (event) => event.type === "sandbox.updated" && event.payload.state === "waking",
      );
      assert.equal(waking.length, 1);
      assert.deepEqual(
        (yield* effectsOf(wakeId)).map((effect) => [effect.request.type, effect.threadId]),
        [["sandbox.start", owner]],
      );

      yield* attachAndRelease(runtime, owner, sandboxId, 2);
      for (const [index, threadId] of sideChats.entries()) {
        const { runs } = yield* ProjectionStore.ProjectionStoreV2.use((projections) =>
          projections.getThreadRecords(threadId, ["runs"]),
        );
        assert.equal(runs.find((run) => run.id === runIds[index])?.status, "starting");
      }
    }),
  );
});

// Sweeps read every sandbox in the database, so they get one of their own.
it.layer(layerTest)("sandbox lifecycle worker", (it) => {
  it.effect("stops a ready Docker sandbox once its owner settles, and not before", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("settle");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
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
      yield* runAnswering(runtime, answerStop);
      assert.equal((yield* getSandbox(sandboxId))?.state, "sleeping");

      // A wake on the still-settled thread stays up until it has been idle for the window.
      yield* TestClock.adjust("1 minute");
      yield* dispatch({
        type: "sandbox.wake",
        commandId: CommandId.make("wake:settle"),
        threadId,
        sandboxId,
      });
      yield* runAnswering(runtime, answerStart);
      yield* attachAndRelease(runtime, threadId, sandboxId, 2);
      yield* sweep();
      assert.equal((yield* getSandbox(sandboxId))?.state, "ready");
      yield* TestClock.adjust("60 minutes");
      yield* sweep();
      assert.deepInclude(yield* getSandbox(sandboxId), { state: "sleeping", sleepReason: "idle" });
      yield* runAnswering(runtime, answerStop);
    }).pipe(Effect.scoped),
  );

  it.effect("sleeps an idle machine at its deadline", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("idle");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );

      yield* TestClock.adjust("59 minutes");
      yield* sweep();
      assert.equal((yield* getSandbox(sandboxId))?.state, "ready");
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      assert.deepInclude(yield* getSandbox(sandboxId), { state: "sleeping", sleepReason: "idle" });
      yield* runAnswering(runtime, answerStop);
    }).pipe(Effect.scoped),
  );

  it.effect("a viewer lease renewal moves the idle deadline", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId, sandboxId } = yield* provisioned("lease");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, threadId, sandboxId, 1);
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );

      yield* TestClock.adjust("30 minutes");
      assert.isTrue(yield* runtime.activity.service.view(threadId));
      assert.isFalse(yield* runtime.activity.service.view(threadId));
      yield* TestClock.adjust("59 minutes");
      yield* sweep();
      assert.equal((yield* getSandbox(sandboxId))?.state, "ready");
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      assert.deepInclude(yield* getSandbox(sandboxId), { state: "sleeping", sleepReason: "idle" });
      yield* runAnswering(runtime, answerStop);
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

const delegate = (
  parentThreadId: ThreadId,
  parentRun: { readonly id: RunId; readonly rootNodeId: NodeId | null },
  key: string,
  placement: Pick<
    Extract<OrchestrationV2ServerCommand, { readonly type: "delegated_task.request" }>,
    "workspaceStrategy" | "sandbox"
  > = {},
) =>
  dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`delegate:${key}`),
    parentThreadId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId ?? NodeId.make("missing"),
    task: "Fix the cache.",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    ...placement,
  }).pipe(
    Effect.map((sent) => {
      const created = sent.storedEvents.find(
        (stored) =>
          stored.event.type === "thread.created" && stored.event.threadId !== parentThreadId,
      );
      if (created?.event.type !== "thread.created") throw new Error("Expected a child thread");
      const run = sent.storedEvents.find(
        (stored) =>
          stored.event.type === "run.created" && stored.event.threadId === created.event.threadId,
      );
      if (run?.event.type !== "run.created") throw new Error("Expected a child run");
      return { sent, child: created.event.payload, run: run.event.payload };
    }),
  );

// Recovery reads every thread in the database, so these get one of their own.
it.layer(layerTest)("delegated cloud tasks", (it) => {
  it.effect("a cloud task's own machine commits with it, once, and recovery re-arms it", () =>
    Effect.gen(function* () {
      const { threadId: parent, sandboxId: parentSandboxId } = yield* provisioned("delegate-cloud");
      const { run: parentRun } = yield* prompt(parent, "delegate-cloud");
      const sandboxId = SandboxId.make("sbx_de1e9a7ec10dde1e9a7e");
      const placement = {
        workspaceStrategy: { type: "worktree" as const, baseRef: "feature/cache" },
        sandbox: { sandboxId, driverId: ComputeDriverId.make("docker"), size: "default" as const },
      };
      const { sent, child, run } = yield* delegate(parent, parentRun, "cloud", placement);

      assert.equal(child.sandboxId, sandboxId);
      assert.notEqual(child.sandboxId, parentSandboxId);
      const provisioning = sent.storedEvents.find(
        (stored) => stored.event.type === "sandbox.updated",
      )?.event;
      assert.deepInclude(provisioning?.type === "sandbox.updated" ? provisioning.payload : {}, {
        id: sandboxId,
        ownerThreadId: child.id,
        state: "provisioning",
      });
      assert.deepInclude(run, {
        status: "preparing",
        workspacePreparation: { type: "worktree", baseRef: "feature/cache" },
      });
      const creates = () =>
        effectsOf("delegate:cloud").pipe(
          Effect.map((effects) =>
            effects
              .filter((effect) => effect.request.type === "sandbox.create")
              .map((effect) => effect.threadId),
          ),
        );
      assert.deepEqual(yield* creates(), [child.id]);

      // A retried delegation replays its receipt: no second machine.
      const replayed = yield* delegate(parent, parentRun, "cloud", placement);
      assert.isTrue(replayed.sent.replayed);
      assert.equal((yield* sandboxEvents(child.id)).length, 1);
      assert.deepEqual(yield* creates(), [child.id]);

      // The server dies before anything else runs: recovery prepares the child on its machine.
      const rearmed = yield* Deferred.make<ThreadLaunch.ThreadLaunchPreparationInput>();
      const layerRecovery = ProviderRuntimeRecovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              prepareRun: (input) =>
                input.threadId === child.id
                  ? Deferred.succeed(rearmed, input).pipe(Effect.asVoid)
                  : Effect.void,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
        assert.deepEqual(yield* Deferred.await(rearmed), {
          commandId: CommandId.make(`sandbox-rearm:${run.id}`),
          threadId: child.id,
          runId: run.id,
        });
      }).pipe(Effect.provide(layerRecovery));
    }),
  );
});

// A started parent run leaves a provider turn queued, which no other test's worker may claim.
it.layer(layerTest)("delegated shared tasks", (it) => {
  it.effect("a shared task on a stopped machine waits and asks for a wake", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime();
      const { threadId: parent, sandboxId } = yield* provisioned("delegate-shared");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, parent, sandboxId, 1);
      const { run: parentRun } = yield* prompt(parent, "delegate-shared");
      assert.equal(parentRun.status, "starting");
      // The backend stopped under the running turn.
      yield* dispatch({
        type: "sandbox.stopped",
        commandId: CommandId.make("stopped:delegate-shared"),
        threadId: parent,
        sandboxId,
        generation: 1,
      });

      const { child, run } = yield* delegate(parent, parentRun, "shared");
      assert.equal(child.sandboxId, sandboxId);
      assert.equal(run.status, "preparing");
      assert.isUndefined(run.workspacePreparation);
      assert.deepEqual(
        (yield* effectsOf("delegate:shared")).map((effect) => [
          effect.request.type,
          effect.threadId,
        ]),
        [["sandbox.request-wake", child.id]],
      );
    }),
  );
});

const answerCreateOf = (sandboxId: SandboxId) => (call: FakeComputeDriver.FakeComputeCall) =>
  call._tag === "create" && call.input.sandboxId === sandboxId
    ? answerCreate(call)
    : Effect.die(`Expected ${sandboxId}'s create, got ${call._tag}`);

it.layer(layerAdmissionTest(1))("sandbox admission at the team cap", (it) => {
  it.effect("two threads at one free slot admit one", () =>
    Effect.gen(function* () {
      const { fake, capRead } = yield* AdmissionDriver;
      const runtime = yield* makeSandboxRuntime(fake);
      // The first decision waits after reading the counts until both provisions are dispatched,
      // so without the admission lock both would count a free slot.
      yield* capRead.close;
      const started = yield* Ref.make(0);
      const startProvision = Ref.updateAndGet(started, (count) => count + 1).pipe(
        Effect.flatMap((count) => (count === 2 ? capRead.open : Effect.void)),
        Effect.asVoid,
      );
      const launched = yield* Effect.all(
        [provisioned("cap-a", startProvision), provisioned("cap-b", startProvision)],
        { concurrency: 2 },
      );
      const records = yield* Effect.forEach(launched, ({ sandboxId }) => getSandbox(sandboxId));
      const waitingIndex = records.findIndex((record) => record?.admission !== null);
      assert.sameMembers(
        records.map((record) => record?.admission?.reason ?? null),
        [null, "team-cap"],
      );
      const first = launched[1 - waitingIndex]!;
      const second = launched[waitingIndex]!;

      // Only the admitted machine is created.
      yield* runAnswering(runtime, answerCreateOf(first.sandboxId));
      yield* attachAndRelease(runtime, first.threadId, first.sandboxId, 1);
      yield* dispatch({
        type: "sandbox.discard",
        commandId: CommandId.make("discard:cap-a"),
        threadId: first.threadId,
        sandboxId: first.sandboxId,
      });
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );
      yield* sweep();
      assert.deepInclude(yield* getSandbox(second.sandboxId), {
        state: "provisioning",
        generation: 1,
        admission: null,
      });
      yield* runAnswering(runtime, (call) =>
        call._tag === "destroy" ? Deferred.succeed(call.reply, undefined) : Effect.die(call._tag),
      );
      yield* runAnswering(runtime, answerCreateOf(second.sandboxId));
    }).pipe(Effect.scoped),
  );
});

it.layer(layerAdmissionTest(1))("sandbox admission after a cap edit", (it) => {
  it.effect("raising the cap admits a waiting machine on the next sweep", () =>
    Effect.gen(function* () {
      const { fake } = yield* AdmissionDriver;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* provisioned("raise-a");
      const second = yield* provisioned("raise-b");
      assert.equal((yield* getSandbox(first.sandboxId))?.admission, null);
      assert.equal((yield* getSandbox(second.sandboxId))?.admission?.reason, "team-cap");

      // The test settings never emit, so the sweep gets a change stream that says when it was read.
      const changed = yield* Deferred.make<ServerSettingsSnapshot>();
      const handled = yield* Deferred.make<void>();
      const changes = Stream.fromEffect(Deferred.await(changed)).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.never),
      );
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(FakeComputeDriver.layerRegistry(fake.driver)),
        Effect.provideServiceEffect(
          SandboxActivity.SandboxActivity,
          Effect.map(SandboxActivity.makeTest, (activity) => activity.service),
        ),
        Effect.provideService(
          ServerSettings.ServerSettingsService,
          ServerSettings.ServerSettingsService.of({
            ...settings,
            subscribeChanges: Effect.succeed(changes),
          }),
        ),
      );
      // A full queue records no due time, so only the settings change can wake the sweep.
      yield* sweep();
      assert.equal((yield* getSandbox(second.sandboxId))?.admission?.reason, "team-cap");

      const driverId = ComputeDriverId.make("docker");
      yield* Deferred.succeed(
        changed,
        yield* settings.updateSettings({
          sandbox: {
            drivers: {
              [driverId]: { kind: "docker", id: driverId, label: "Docker", runningCap: 2 },
            },
          },
        }),
      );
      yield* Deferred.await(handled);
      yield* sweep();
      assert.deepInclude(yield* getSandbox(second.sandboxId), {
        state: "provisioning",
        admission: null,
      });
    }).pipe(Effect.scoped),
  );
});

it.layer(layerAdmissionTest(2))("sandbox admission of shared sandboxes", (it) => {
  it.effect("a shared sandbox counts once", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime((yield* AdmissionDriver).fake);
      const owner = yield* provisioned("shared-a");
      yield* runAnswering(runtime, answerCreate);
      yield* attachAndRelease(runtime, owner.threadId, owner.sandboxId, 1);
      yield* forked(owner.threadId, "shared-a-side-1", true);
      yield* forked(owner.threadId, "shared-a-side-2", true);

      const second = yield* provisioned("shared-b");
      assert.equal((yield* getSandbox(second.sandboxId))?.admission, null);
      const third = yield* provisioned("shared-c");
      assert.equal((yield* getSandbox(third.sandboxId))?.admission?.reason, "team-cap");
    }),
  );
});

it.layer(layerAdmissionTest(100))("sandbox admission at the start rate", (it) => {
  it.effect("the eleventh start in a minute waits", () =>
    Effect.gen(function* () {
      const launched = yield* Effect.forEach(
        Array.from({ length: 11 }, (_, index) => `rate-${index + 1}`),
        (key) => provisioned(key),
      );
      const reasons = yield* Effect.forEach(launched, ({ sandboxId }) =>
        getSandbox(sandboxId).pipe(Effect.map((record) => record?.admission?.reason ?? null)),
      );
      assert.deepEqual(reasons, [...Array.from({ length: 10 }, () => null), "rate-limit"]);

      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(FakeComputeDriver.layerRegistry((yield* AdmissionDriver).fake.driver)),
        Effect.provideServiceEffect(
          SandboxActivity.SandboxActivity,
          Effect.map(SandboxActivity.makeTest, (activity) => activity.service),
        ),
      );
      const eleventh = launched[10]!;
      yield* sweep();
      assert.equal((yield* getSandbox(eleventh.sandboxId))?.admission?.reason, "rate-limit");
      yield* TestClock.adjust("6 seconds");
      yield* sweep();
      assert.equal((yield* getSandbox(eleventh.sandboxId))?.admission, null);
    }).pipe(Effect.scoped),
  );
});

it.layer(layerAdmissionTest(1))("idle sleep under cap pressure", (it) => {
  it.effect("sleeps an idle machine early for a waiter, which the next sweep admits", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSandboxRuntime((yield* AdmissionDriver).fake);
      const first = yield* provisioned("pressure-a");
      yield* runAnswering(runtime, answerCreateOf(first.sandboxId));
      yield* attachAndRelease(runtime, first.threadId, first.sandboxId, 1);
      const second = yield* provisioned("pressure-b");
      assert.equal((yield* getSandbox(second.sandboxId))?.admission?.reason, "team-cap");
      const sweep = yield* SandboxLifecycleWorker.makeSweep.pipe(
        Effect.provide(runtime.layerDriver),
      );

      yield* TestClock.adjust("4 minutes");
      yield* sweep();
      assert.equal((yield* getSandbox(first.sandboxId))?.state, "ready");
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      assert.deepInclude(yield* getSandbox(first.sandboxId), {
        state: "sleeping",
        sleepReason: "cap-pressure",
      });
      yield* runAnswering(runtime, answerStop);
      yield* sweep();
      assert.equal((yield* getSandbox(second.sandboxId))?.admission, null);
      yield* runAnswering(runtime, answerCreateOf(second.sandboxId));
    }).pipe(Effect.scoped),
  );
});

it.layer(layerAdmissionTest(1))("sandbox admission of delegated tasks", (it) => {
  it.effect("a cloud task's own machine waits at a full cap", () =>
    Effect.gen(function* () {
      const { threadId: parent } = yield* provisioned("cap-delegate");
      const { run: parentRun } = yield* prompt(parent, "cap-delegate");
      const sandboxId = SandboxId.make("sbx_ca9de1e9a7ec10dde1e9");
      const { child } = yield* delegate(parent, parentRun, "cap-cloud", {
        workspaceStrategy: { type: "worktree", baseRef: "feature/cache" },
        sandbox: { sandboxId, driverId: ComputeDriverId.make("docker"), size: "default" },
      });
      assert.equal(child.sandboxId, sandboxId);
      assert.equal((yield* getSandbox(sandboxId))?.admission?.reason, "team-cap");
      assert.isFalse(
        (yield* effectsOf("delegate:cap-cloud")).some(
          (effect) => effect.request.type === "sandbox.create",
        ),
      );
    }),
  );
});
