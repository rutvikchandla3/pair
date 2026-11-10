import { assert, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type DockerSandboxDriver,
  EventId,
  MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Sandbox,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type * as Members from "../../persistence/Members.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TeamState from "../../team/TeamState.ts";
import * as ThreadAccess from "../../team/ThreadAccess.ts";
import { ComputeDriverError, type ComputeDriverHealth } from "../compute/ComputeDriver.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import { CheckpointMirror } from "../mirror/CheckpointMirror.ts";
import * as SandboxOverview from "./SandboxOverview.ts";
import * as SandboxRestoreMode from "./SandboxRestoreMode.ts";

const driverId = ComputeDriverId.make("local");
const local: DockerSandboxDriver = { kind: "docker", id: driverId, label: "This machine" };

const seed = Effect.fnUntraced(function* (
  index: number,
  state: string,
  waiting = false,
  payload = "{}",
) {
  const sql = yield* SqlClient.SqlClient;
  const sandboxId = SandboxId.make(`sbx_${index.toString(16).padStart(20, "0")}`);
  yield* sql`
    INSERT INTO orchestration_v2_projection_sandboxes (
      sandbox_id, project_id, owner_thread_id, owner_member_id, driver_id, state, generation,
      admission_since, updated_at, payload_json
    ) VALUES (
      ${sandboxId}, 'project:cloud', ${`thread:${index}`}, NULL, 'local', ${state}, 1,
      ${waiting ? "2026-11-07T00:00:00.000Z" : null}, '2026-11-07T00:00:00.000Z', ${payload}
    )
  `;
});

const member = (id: MemberId, fields: Partial<Members.MemberRecord> = {}) =>
  ({
    id,
    name: id,
    role: "member",
    gitName: null,
    gitEmail: null,
    isOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    removedAt: null,
    ...fields,
  }) satisfies Members.MemberRecord;
const serverOwner = MemberId.make("member-owner");
const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const erin = MemberId.make("member-erin");
const team = [
  member(serverOwner, { role: "admin", isOwner: true }),
  member(alice),
  member(bob),
  member(erin, { role: "admin" }),
];

/** Reads the overview as `reader` while the one driver answers its health check with `answer`. */
const readOverview = Effect.fn("SandboxOverviewTest.read")(function* (
  answer: (
    reply: Deferred.Deferred<ComputeDriverHealth, ComputeDriverError>,
  ) => Effect.Effect<unknown>,
  reader: MemberId = serverOwner,
  access: ThreadAccess.ThreadAccess["Service"] = ThreadAccess.makeTest(),
) {
  const { driver, calls } = yield* FakeComputeDriver.make(driverId, { defaultRunningCap: 3 });
  return yield* Effect.gen(function* () {
    const reading = yield* SandboxOverview.SandboxOverview.use((service) =>
      service.read(reader),
    ).pipe(Effect.forkChild);
    const health = yield* Queue.take(calls);
    if (health._tag !== "health") return yield* Effect.die(`Expected health, got ${health._tag}`);
    yield* answer(health.reply);
    return yield* Fiber.join(reading);
  }).pipe(
    Effect.provide(
      SandboxOverview.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FakeComputeDriver.layerRegistry(driver).pipe(
              Layer.provideMerge(
                // The admin's cap wins over the driver's default of 3.
                ServerSettingsService.layerTest({
                  sandbox: { drivers: [{ ...local, runningCap: 5 }] },
                }),
              ),
            ),
            ProjectionStore.layer,
            Layer.mock(CheckpointMirror)({ gitDir: () => "", diskBytes: Effect.succeed(4096) }),
            SandboxRestoreMode.layer,
            TeamState.layerTest(team),
            Layer.succeed(ThreadAccess.ThreadAccess)(access),
          ),
        ),
      ),
    ),
  );
});

const healthy = (reply: Deferred.Deferred<ComputeDriverHealth, ComputeDriverError>) =>
  Deferred.succeed(reply, {
    isolation: "container",
    privateNetworkBlock: { applied: true },
    baseImage: null,
  });

it.effect("counts machines by state and reads health, caps and the image from the drivers", () =>
  Effect.gen(function* () {
    yield* seed(1, "ready");
    yield* seed(2, "ready");
    yield* seed(3, "sleeping");
    yield* seed(4, "failed");
    yield* seed(5, "provisioning", true);
    yield* seed(6, "waking", true);
    // Starting, not waiting: neither ready nor queued.
    yield* seed(7, "provisioning");
    yield* seed(8, "destroyed");

    const overview = yield* readOverview((reply) =>
      Deferred.succeed(reply, {
        isolation: "container",
        privateNetworkBlock: { applied: true },
        baseImage: { ref: "ghcr.io/pair/t3-sandbox:1.2.3", digest: "sha256:x", version: "1.2.3" },
      }),
    );

    assert.deepEqual(overview, {
      drivers: [{ driverId, reachable: true, isolation: "runc", runningCap: 5 }],
      machines: { ready: 2, sleeping: 1, failed: 1, waiting: 2 },
      startsPerMinute: 10,
      baseImage: { ref: "ghcr.io/pair/t3-sandbox:1.2.3", label: "Pair base 1.2.3" },
      mirrorBytes: 4096,
    });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reports a virtual machine driver, and an unsupported one's hint", () =>
  Effect.gen(function* () {
    const vm = yield* readOverview((reply) =>
      Deferred.succeed(reply, {
        isolation: "vm",
        privateNetworkBlock: { applied: false, reason: "Set by your VPC's firewall rules." },
        baseImage: null,
      }),
    );
    assert.deepEqual(vm.drivers, [
      { driverId, reachable: true, isolation: "unknown", vm: true, runningCap: 5 },
    ]);

    const setupHint = "The Google Cloud driver runs only on a Pair Cloud server.";
    const unsupported = yield* readOverview((reply) =>
      Deferred.fail(
        reply,
        new ComputeDriverError({
          driverId,
          operation: "health",
          reason: "unsupported",
          retryable: false,
          setupHint,
        }),
      ),
    );
    assert.deepEqual(unsupported.drivers, [
      { driverId, reachable: false, isolation: "unknown", runningCap: 5, message: setupHint },
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("lists the team-image builds that machines not yet destroyed boot from", () =>
  Effect.gen(function* () {
    const booted = (id: string) => JSON.stringify({ imageBuild: { id, number: 1 } });
    yield* seed(1, "ready", false, booted("tib_00000000000000000001"));
    yield* seed(2, "sleeping", false, booted("tib_00000000000000000001"));
    yield* seed(3, "destroyed", false, booted("tib_00000000000000000002"));
    yield* seed(4, "ready");
    const ids = yield* ProjectionStore.ProjectionStoreV2.use((store) =>
      store.listSandboxImageBuildIds(),
    ).pipe(Effect.provide(ProjectionStore.layer));
    assert.deepStrictEqual([...ids], ["tib_00000000000000000001"]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("lists every live machine to an admin, with a title only where they can open it", () =>
  Effect.gen(function* () {
    const t0 = DateTime.makeUnsafe("2026-11-10T10:00:00.000Z");
    const projectId = ProjectId.make("project:cloud");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const machine = (hex: string, ownerMemberId: MemberId, state: "ready" | "destroyed") => {
      const id = SandboxId.make(`sbx_${hex.repeat(20)}`);
      const ownerThreadId = ThreadId.make(`thread:${hex}`);
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: ownerThreadId,
        projectId,
        title: `Thread ${hex}`,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: `feat/${hex}`,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ownerThreadId },
        forkedFrom: null,
        createdAt: t0,
        updatedAt: t0,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        ownerId: ownerMemberId,
        sandboxId: id,
      };
      const record: OrchestrationV2Sandbox = {
        id,
        projectId,
        ownerThreadId,
        ownerMemberId,
        driverId,
        size: "default",
        state,
        generation: 1,
        driverRef: null,
        admission: null,
        runnerLostAt: null,
        sleepReason: null,
        failure: null,
        createdAt: t0,
        updatedAt: t0,
      };
      return ProjectionStore.ProjectionStoreV2.use((store) =>
        Effect.gen(function* () {
          const at = { threadId: ownerThreadId, occurredAt: t0 };
          yield* store.apply({
            ...at,
            id: EventId.make(`e:${hex}:t`),
            type: "thread.created",
            payload: thread,
          });
          yield* store.apply({
            ...at,
            id: EventId.make(`e:${hex}:s`),
            type: "sandbox.updated",
            payload: record,
          });
        }),
      ).pipe(Effect.provide(ProjectionStore.layer), Effect.as(id));
    };
    const alices = yield* machine("a", alice, "ready");
    const bobs = yield* machine("b", bob, "ready");
    yield* machine("c", bob, "destroyed");
    const entry = (ownerMemberId: MemberId, memberIds: ReadonlyArray<MemberId>) => ({
      ownerMemberId,
      audience: "members" as const,
      memberIds: new Set(memberIds),
    });
    const access = ThreadAccess.makeTest({
      serverOwnerId: serverOwner,
      machines: new Map([
        [alices, entry(alice, [erin])],
        [bobs, entry(bob, [])],
      ]),
    });
    const listed = (hex: string, ownerMemberId: MemberId) => ({
      sandboxId: SandboxId.make(`sbx_${hex.repeat(20)}`),
      ownerMemberId,
      state: "ready" as const,
      size: "default" as const,
      driverId,
      createdAt: DateTime.makeUnsafe("2026-11-10T10:00:00.000Z"),
    });

    const forErin = yield* readOverview(healthy, erin, access);
    assert.deepEqual(forErin.machineList, [
      {
        ...listed("a", alice),
        thread: { threadId: ThreadId.make("thread:a"), title: "Thread a", branch: "feat/a" },
      },
      listed("b", bob),
    ]);
    assert.isUndefined((yield* readOverview(healthy, alice, access)).machineList);
    // Off a cloud-only server the overview is as it was.
    assert.isUndefined((yield* readOverview(healthy, erin)).machineList);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
