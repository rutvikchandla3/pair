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

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { type BackendSandbox, sandboxBackendName } from "../compute/ComputeDriver.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import {
  pairBackends,
  planReconciliation,
  type ReconcileAction,
  layer as reconcilerLayer,
} from "./SandboxReconciler.ts";

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
  readonly [string, OrchestrationV2Sandbox | null, BackendSandbox | null, ReconcileAction]
> = [
  ["ready and running", record(), backend(), Keep],
  ["waking and starting", record({ state: "waking" }), backend({ status: "starting" }), Keep],
  ["provisioning and running", record({ state: "provisioning" }), backend(), Keep],
  ["ready but stopped", record(), backend({ status: "stopped" }), { _tag: "ReportStopped" }],
  ["ready but missing", record(), null, { _tag: "ReportLost", retryable: true }],
  [
    "waking but failed",
    record({ state: "waking" }),
    backend({ status: "failed" }),
    { _tag: "ReportLost", retryable: true },
  ],
  [
    "waking with a stopped backend",
    record({ state: "waking" }),
    backend({ status: "stopped" }),
    Keep,
  ],
  [
    "provisioning with a stopped backend",
    record({ state: "provisioning" }),
    backend({ status: "stopped" }),
    Keep,
  ],
  ["sleeping but running", record({ state: "sleeping" }), backend(), { _tag: "StopBackend" }],
  [
    "sleeping but missing",
    record({ state: "sleeping" }),
    null,
    { _tag: "ReportLost", retryable: false },
  ],
  [
    "provisioning, no ref, found by name",
    record({ state: "provisioning", driverRef: null }),
    backend({ driverRef: "found" }),
    { _tag: "ReportCreated", driverRef: "found" },
  ],
  [
    "provisioning, no ref, nothing found",
    record({ state: "provisioning", driverRef: null }),
    null,
    Keep,
  ],
  [
    "failed retryable but running",
    record({ state: "failed", failure: retryable }),
    backend(),
    { _tag: "StopBackend" },
  ],
  [
    "failed for good with an old backend",
    record({ state: "failed", failure: final }),
    backend({ status: "stopped" }),
    { _tag: "DestroyBackend" },
  ],
  [
    "destroyed with an old backend",
    record({ state: "destroyed" }),
    backend(),
    { _tag: "DestroyBackend" },
  ],
  [
    "no record, created 6 minutes ago",
    null,
    backend({ createdAt: minutesAgo(6) }),
    { _tag: "DestroyBackend" },
  ],
  ["no record, created exactly 5 minutes ago", null, backend({ createdAt: minutesAgo(5) }), Keep],
  ["no record, created 4 minutes ago", null, backend({ createdAt: minutesAgo(4) }), Keep],
  [
    "a stray of a record that holds another ref",
    record({ driverRef: "current" }),
    backend({ driverRef: "stray", name: sandboxBackendName(installId, sandboxId, 1) }),
    { _tag: "DestroyBackend" },
  ],
];

describe("planReconciliation", () => {
  it.each(rows.map(([name, current, found, expected]) => ({ name, current, found, expected })))(
    "$name",
    ({ current, found, expected }) => {
      const pairs = pairBackends(
        current === null ? [] : [current],
        found === null ? [] : [found],
        installId,
      );
      // The stray row also yields the record's own "missing" pair; plan the backend's pair.
      const pair = pairs.find((candidate) => candidate.backend === found) ?? pairs[0];
      expect(planReconciliation(pair?.record ?? null, pair?.backend ?? null, now)).toEqual(
        expected,
      );
    },
  );

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

it.effect("lists backends on activation, then every 10 minutes", () =>
  Effect.gen(function* () {
    const fake = yield* FakeComputeDriver.make();
    const answerPass = Effect.gen(function* () {
      const list = yield* Queue.take(fake.calls);
      assert.equal(list._tag, "list");
      if (list._tag === "list") yield* Deferred.succeed(list.reply, []);
      const health = yield* Queue.take(fake.calls);
      if (health._tag !== "health") return yield* Effect.die(`Expected health, got ${health._tag}`);
      yield* Deferred.succeed(health.reply, {
        isolation: "container",
        privateNetworkBlock: { applied: true },
        baseImage: null,
      });
    });
    yield* Effect.gen(function* () {
      yield* answerPass;
      yield* TestClock.adjust("9 minutes");
      assert.equal(yield* Queue.size(fake.calls), 0);
      yield* TestClock.adjust("1 minute");
      yield* answerPass;
    }).pipe(
      Effect.provide(
        reconcilerLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Scheduler.layer,
              FakeComputeDriver.layerRegistry(fake.driver),
              SqlitePersistence.layerMemory,
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(installId),
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              ThreadCommandExecutor.layer,
            ),
          ),
        ),
      ),
    );
  }),
);
