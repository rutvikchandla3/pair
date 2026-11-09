import { assert, describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  EnvironmentId,
  type OrchestrationV2Sandbox,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type BackendSandbox, sandboxBackendName } from "../compute/ComputeDriver.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import type { ComputeDriver } from "../compute/ComputeDriver.ts";
import {
  pairBackends,
  planReconciliation,
  type ReconcileAction,
  layer as reconcilerLayer,
} from "./SandboxReconciler.ts";
import { SandboxRestoreMode, layer as restoreModeLayer } from "./SandboxRestoreMode.ts";

const installId = EnvironmentId.make("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const now = DateTime.makeUnsafe("2026-11-07T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.makeUnsafe(Date.parse("2026-11-07T12:00:00.000Z") - minutes * 60_000);
const backendName = sandboxBackendName(installId, sandboxId, 2);

const record = (patch: Partial<OrchestrationV2Sandbox> = {}): OrchestrationV2Sandbox => ({
  id: sandboxId,
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make("thread-owner"),
  ownerMemberId: null,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 2,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(60),
  ...patch,
});

const backend = (patch: Partial<BackendSandbox> = {}): BackendSandbox => ({
  driverRef: "ref",
  name: backendName,
  sandboxId,
  status: "running",
  createdAt: minutesAgo(60),
  ...patch,
});

const retryable = { code: "lost", message: "Gone.", retryable: true };
const final = { ...retryable, retryable: false };
const Keep: ReconcileAction = { _tag: "Keep" };

// One row per line of 04 §5's table, planned through the pairing the reconciler does.
const rows: ReadonlyArray<
  readonly [string, OrchestrationV2Sandbox | null, BackendSandbox | null, boolean, ReconcileAction]
> = [
  ["ready and running", record(), backend(), false, Keep],
  [
    "waking and starting",
    record({ state: "waking" }),
    backend({ status: "starting" }),
    false,
    Keep,
  ],
  ["provisioning and running", record({ state: "provisioning" }), backend(), false, Keep],
  ["ready but stopped", record(), backend({ status: "stopped" }), false, { _tag: "ReportStopped" }],
  ["ready but missing", record(), null, false, { _tag: "ReportLost", retryable: true }],
  [
    "waking but failed",
    record({ state: "waking" }),
    backend({ status: "failed" }),
    false,
    { _tag: "ReportLost", retryable: true },
  ],
  [
    "waking with a stopped backend",
    record({ state: "waking" }),
    backend({ status: "stopped" }),
    false,
    Keep,
  ],
  [
    "provisioning with a stopped backend",
    record({ state: "provisioning" }),
    backend({ status: "stopped" }),
    false,
    Keep,
  ],
  [
    "sleeping but running",
    record({ state: "sleeping" }),
    backend(),
    false,
    { _tag: "StopBackend" },
  ],
  [
    "sleeping but missing",
    record({ state: "sleeping" }),
    null,
    false,
    { _tag: "ReportLost", retryable: false },
  ],
  [
    "provisioning, no ref, found by name",
    record({ state: "provisioning", driverRef: null }),
    backend({ driverRef: "found" }),
    false,
    { _tag: "ReportCreated", driverRef: "found" },
  ],
  [
    "provisioning, no ref, nothing found",
    record({ state: "provisioning", driverRef: null }),
    null,
    false,
    Keep,
  ],
  [
    "failed retryable but running",
    record({ state: "failed", failure: retryable }),
    backend(),
    false,
    { _tag: "StopBackend" },
  ],
  [
    "failed for good with an old backend",
    record({ state: "failed", failure: final }),
    backend({ status: "stopped" }),
    false,
    { _tag: "DestroyBackend" },
  ],
  [
    "destroyed with an old backend",
    record({ state: "destroyed" }),
    backend(),
    false,
    { _tag: "DestroyBackend" },
  ],
  [
    "no record, created 6 minutes ago",
    null,
    backend({ createdAt: minutesAgo(6) }),
    false,
    { _tag: "DestroyBackend" },
  ],
  [
    "no record, created exactly 5 minutes ago",
    null,
    backend({ createdAt: minutesAgo(5) }),
    false,
    Keep,
  ],
  ["no record, created 4 minutes ago", null, backend({ createdAt: minutesAgo(4) }), false, Keep],
  [
    "a stray of a record that holds another ref",
    record({ driverRef: "current" }),
    backend({ driverRef: "stray", name: sandboxBackendName(installId, sandboxId, 1) }),
    false,
    { _tag: "DestroyBackend" },
  ],
  // Restore mode destroys nothing; records still follow their backends.
  ["restore mode, no record, running", null, backend(), true, { _tag: "StopOrphan" }],
  [
    "restore mode, no record, starting and young",
    null,
    backend({ status: "starting", createdAt: minutesAgo(1) }),
    true,
    { _tag: "StopOrphan" },
  ],
  ["restore mode, no record, stopped", null, backend({ status: "stopped" }), true, Keep],
  [
    "restore mode, destroyed with an old backend",
    record({ state: "destroyed" }),
    backend(),
    true,
    { _tag: "StopOrphan" },
  ],
  [
    "restore mode, failed for good with a stopped backend",
    record({ state: "failed", failure: final }),
    backend({ status: "stopped" }),
    true,
    Keep,
  ],
  [
    "restore mode, a stray of a record that holds another ref",
    record({ driverRef: "current" }),
    backend({ driverRef: "stray", name: sandboxBackendName(installId, sandboxId, 1) }),
    true,
    { _tag: "StopOrphan" },
  ],
  ["restore mode, ready and running", record(), backend(), true, Keep],
  [
    "restore mode, ready and stopped",
    record(),
    backend({ status: "stopped" }),
    true,
    { _tag: "ReportStopped" },
  ],
  [
    "restore mode, ready but missing",
    record(),
    null,
    true,
    { _tag: "ReportLost", retryable: true },
  ],
  [
    "restore mode, sleeping but running",
    record({ state: "sleeping" }),
    backend(),
    true,
    { _tag: "StopBackend" },
  ],
  [
    "restore mode, provisioning, no ref, found by name",
    record({ state: "provisioning", driverRef: null }),
    backend({ driverRef: "found" }),
    true,
    { _tag: "ReportCreated", driverRef: "found" },
  ],
];

describe("planReconciliation", () => {
  it.each(
    rows.map(([name, current, found, restoreMode, expected]) => ({
      name,
      current,
      found,
      restoreMode,
      expected,
    })),
  )("$name", ({ current, found, restoreMode, expected }) => {
    const pairs = pairBackends(
      current === null ? [] : [current],
      found === null ? [] : [found],
      installId,
    );
    // The stray row also yields the record's own "missing" pair; plan the backend's pair.
    const pair = pairs.find((candidate) => candidate.backend === found) ?? pairs[0];
    expect(
      planReconciliation(pair?.record ?? null, pair?.backend ?? null, now, restoreMode),
    ).toEqual(expected);
  });

  it("pairs by ref, by the current name without one, and leaves strays and missing records", () => {
    const byRef = record();
    const byName = record({
      id: SandboxId.make("sbx_11111111111111111111"),
      driverRef: null,
      generation: 3,
    });
    const missing = record({ id: SandboxId.make("sbx_22222222222222222222"), driverRef: "gone" });
    const destroyed = record({
      id: SandboxId.make("sbx_33333333333333333333"),
      state: "destroyed",
    });
    const named = backend({
      driverRef: "named",
      sandboxId: byName.id,
      name: sandboxBackendName(installId, byName.id, 3),
    });
    const olderGeneration = backend({
      driverRef: "older",
      sandboxId: byName.id,
      name: sandboxBackendName(installId, byName.id, 2),
    });
    const untagged = backend({ driverRef: "untagged", sandboxId: null });
    const pairs = pairBackends(
      [byRef, byName, missing, destroyed],
      [backend(), named, olderGeneration, untagged],
      installId,
    );
    expect(pairs).toEqual([
      { record: byRef, backend: backend() },
      { record: byName, backend: named },
      { record: null, backend: olderGeneration },
      { record: null, backend: untagged },
      { record: missing, backend: null },
    ]);
  });
});

const reconciler = (
  driver: ComputeDriver["Service"],
  options: { readonly restoreMode?: boolean } = {},
) =>
  reconcilerLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Scheduler.layer,
        FakeComputeDriver.layerRegistry(driver).pipe(
          Layer.provide(ServerSettingsService.layerTest()),
        ),
        SqlitePersistence.layerMemory,
        ServerSettingsService.layerTest(),
        restoreModeLayer,
        Layer.mock(ServerConfig.ServerConfig)({
          restoreMode: options.restoreMode,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(installId),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        ThreadCommandExecutor.layer,
      ),
    ),
  );

/** Answers one pass's list with `backends`, then its stops and destroys; returns those calls. */
const answerPass = Effect.fnUntraced(function* (
  calls: Queue.Dequeue<FakeComputeDriver.FakeComputeCall>,
  backends: ReadonlyArray<BackendSandbox>,
) {
  const list = yield* Queue.take(calls);
  if (list._tag !== "list") return yield* Effect.die(`Expected list, got ${list._tag}`);
  yield* Deferred.succeed(list.reply, backends);
  const driverCalls: Array<string> = [];
  while (true) {
    const call = yield* Queue.take(calls);
    if (call._tag === "health") {
      yield* Deferred.succeed(call.reply, {
        isolation: "container",
        privateNetworkBlock: { applied: true },
        baseImage: null,
      });
      return driverCalls;
    }
    if (call._tag !== "stop" && call._tag !== "destroy") {
      return yield* Effect.die(`Expected stop or destroy, got ${call._tag}`);
    }
    driverCalls.push(`${call._tag} ${call.ref}`);
    yield* Deferred.succeed(call.reply, undefined);
  }
});

const restoreModeSince = ServerSettingsService.use((settings) =>
  Effect.map(settings.getSettings, (current) => current.sandbox?.restoreModeSince),
);
const leaveRestoreMode = ServerSettingsService.use((settings) =>
  settings.updateSettings({ sandbox: { restoreModeSince: null } }),
);
const stoppedMachines = SandboxRestoreMode.use((restoreMode) => restoreMode.machines);

it.effect("lists backends on activation, then every 10 minutes", () =>
  Effect.gen(function* () {
    const fake = yield* FakeComputeDriver.make();
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* answerPass(fake.calls, []), []);
      yield* TestClock.adjust("9 minutes");
      assert.equal(yield* Queue.size(fake.calls), 0);
      yield* TestClock.adjust("1 minute");
      assert.deepEqual(yield* answerPass(fake.calls, []), []);
    }).pipe(Effect.provide(reconciler(fake.driver)));
  }),
);

it.effect("turns restore mode on for a tagged backend with no record, and destroys nothing", () =>
  Effect.gen(function* () {
    const fake = yield* FakeComputeDriver.make();
    // The test clock starts at the epoch.
    const orphan = backend({ driverRef: "orphan", createdAt: DateTime.makeUnsafe(-60 * 60_000) });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* answerPass(fake.calls, [orphan]), ["stop orphan"]);
      const since = yield* restoreModeSince;
      assert.equal(since && DateTime.toEpochMillis(since), 0);
      assert.deepEqual(yield* stoppedMachines, [
        {
          sandboxId,
          driverId: fake.driver.driverId,
          createdAt: orphan.createdAt,
          hasRecord: false,
        },
      ]);

      yield* leaveRestoreMode;
      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(yield* answerPass(fake.calls, [{ ...orphan, status: "stopped" }]), [
        "destroy orphan",
      ]);
      assert.isUndefined(yield* restoreModeSince);
    }).pipe(Effect.provide(reconciler(fake.driver)));
  }),
);

it.effect("keeps restore mode off for an unrecorded backend still inside the grace period", () =>
  Effect.gen(function* () {
    const fake = yield* FakeComputeDriver.make();
    const young = backend({ driverRef: "young", createdAt: DateTime.makeUnsafe(-60_000) });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* answerPass(fake.calls, [young]), []);
      assert.isUndefined(yield* restoreModeSince);
    }).pipe(Effect.provide(reconciler(fake.driver)));
  }),
);

it.effect("turns restore mode on once from --restore-mode, so leaving it holds", () =>
  Effect.gen(function* () {
    const fake = yield* FakeComputeDriver.make();
    // Too young to turn restore mode on by itself, and restore mode has no grace period.
    const young = backend({ driverRef: "young", createdAt: DateTime.makeUnsafe(-60_000) });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* answerPass(fake.calls, [young]), ["stop young"]);
      assert.isDefined(yield* restoreModeSince);

      yield* leaveRestoreMode;
      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(yield* answerPass(fake.calls, []), []);
      assert.isUndefined(yield* restoreModeSince);
    }).pipe(Effect.provide(reconciler(fake.driver, { restoreMode: true })));
  }),
);
