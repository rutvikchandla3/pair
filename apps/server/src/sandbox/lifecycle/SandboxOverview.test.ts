import { assert, it } from "@effect/vitest";
import { ComputeDriverId, type DockerSandboxDriver, SandboxId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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

    const { driver, calls } = yield* FakeComputeDriver.make(driverId, { defaultRunningCap: 3 });
    const overview = yield* Effect.gen(function* () {
      const reading = yield* SandboxOverview.SandboxOverview.use((service) => service.read).pipe(
        Effect.forkChild,
      );
      const health = yield* Queue.take(calls);
      if (health._tag !== "health") return yield* Effect.die(`Expected health, got ${health._tag}`);
      yield* Deferred.succeed(health.reply, {
        isolation: "container",
        privateNetworkBlock: { applied: true },
        baseImage: { ref: "ghcr.io/pair/t3-sandbox:1.2.3", digest: "sha256:x", version: "1.2.3" },
      });
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
            ),
          ),
        ),
      ),
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
