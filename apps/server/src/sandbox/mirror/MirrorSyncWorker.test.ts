import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import * as MirrorSync from "./MirrorSync.ts";
import * as MirrorSyncWorker from "./MirrorSyncWorker.ts";

const sandboxA = SandboxId.make("sbx_00000000000000000001");
const sandboxB = SandboxId.make("sbx_00000000000000000002");
const sandboxGone = SandboxId.make("sbx_00000000000000000003");
const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");
const threadGone = ThreadId.make("thread:gone");
const sandboxOf = new Map([
  [threadA, sandboxA],
  [threadB, sandboxB],
  [threadGone, sandboxGone],
]);
const scopeId = CheckpointScopeId.make("scope:worker");
const cwdOf = (threadId: ThreadId) => `/t3-sandbox/${sandboxOf.get(threadId)}/repo`;
const refOf = (threadId: ThreadId) => CheckpointRef.make(`refs/t3/checkpoints/${threadId}/1`);

type Outcome = "ok" | MirrorSync.MirrorSyncError["reason"];

/** A worker over fakes: each sync call takes the thread's next scripted outcome ("ok" when none). */
const makeHarness = Effect.fn("MirrorSyncWorkerTest.makeHarness")(function* (
  script: ReadonlyArray<readonly [ThreadId, ReadonlyArray<Outcome>]>,
) {
  const calls = yield* Queue.unbounded<ThreadId>();
  const outcomes = yield* Ref.make(new Map(script));
  const layer = MirrorSyncWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(MirrorSync.MirrorSync)({
          sync: ({ threadId, cwd, checkpointRefs }) =>
            Effect.gen(function* () {
              assert.equal(cwd, cwdOf(threadId));
              assert.deepEqual(checkpointRefs, [refOf(threadId)]);
              yield* Queue.offer(calls, threadId);
              const [next = "ok", ...rest] = (yield* Ref.get(outcomes)).get(threadId) ?? [];
              yield* Ref.update(outcomes, (current) => new Map(current).set(threadId, rest));
              if (next === "ok") return [ProjectId.make("project:worker")];
              return yield* new MirrorSync.MirrorSyncError({ threadId, reason: next });
            }),
        }),
        Layer.mock(CheckpointMirror.CheckpointMirror)({
          gitDir: () => "",
          tips: () => Effect.succeed(new Map()),
          maintain: () => Effect.void,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: (threadId) =>
            Effect.succeed({
              id: threadId,
              projectId: ProjectId.make("project:worker"),
              sandboxId: sandboxOf.get(threadId),
              deletedAt: null,
            } as never),
          getCheckpointContext: (threadId) =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [
                { id: scopeId, runId: null, kind: "root_run", cwd: cwdOf(threadId) },
              ],
              checkpoints: [
                {
                  scopeId,
                  runId: null,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: refOf(threadId),
                },
              ],
            }),
          listSandboxThreads: (sandboxId) =>
            Effect.succeed(
              [...sandboxOf]
                .filter(([, owner]) => owner === sandboxId)
                .map(([threadId]) => ({
                  threadId,
                  attachedAt: DateTime.makeUnsafe(0),
                  archived: false,
                })),
            ),
        }),
      ),
    ),
  );
  return { calls, layer };
});

const seedSandbox = Effect.fn("MirrorSyncWorkerTest.seedSandbox")(function* (
  sandboxId: SandboxId,
  threadId: ThreadId,
  state: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_sandboxes (
      sandbox_id, project_id, owner_thread_id, owner_member_id, driver_id, state, generation,
      admission_since, updated_at, payload_json
    ) VALUES (
      ${sandboxId}, 'project:worker', ${threadId}, NULL, 'docker', ${state}, 1,
      NULL, '2026-01-01T00:00:00.000Z', '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_sandbox_threads (sandbox_id, thread_id, attached_at)
    VALUES (${sandboxId}, ${threadId}, '2026-01-01T00:00:00.000Z')
  `;
});

it.effect("seeds live sandboxes' threads at start and retries a failed sync every 30 s", () =>
  Effect.gen(function* () {
    yield* seedSandbox(sandboxA, threadA, "ready");
    yield* seedSandbox(sandboxGone, threadGone, "destroyed");
    const { calls, layer } = yield* makeHarness([[threadA, ["bundle-failed"]]]);

    yield* Effect.gen(function* () {
      const worker = yield* MirrorSyncWorker.MirrorSyncWorker;
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.take(calls), threadA);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.take(calls), threadA);
      // Synced: it left the set, and the destroyed sandbox's thread was never pending.
      yield* worker.drain;
      assert.equal(yield* Queue.size(calls), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps an unreachable sandbox pending and flushes only the named sandbox", () =>
  Effect.gen(function* () {
    const { calls, layer } = yield* makeHarness([
      [threadA, ["sandbox-unavailable", "sandbox-unavailable"]],
    ]);

    yield* Effect.gen(function* () {
      const worker = yield* MirrorSyncWorker.MirrorSyncWorker;
      const hooks = yield* MirrorSync.MirrorHooks;
      const scope = {
        id: scopeId,
        threadId: threadA,
        runId: null,
        nodeId: "node:worker",
        parentScopeId: null,
        providerThreadId: null,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: cwdOf(threadA),
        createdAt: DateTime.makeUnsafe(0),
      } as const;
      const checkpoint = { status: "ready", ref: refOf(threadA) } as never;
      // A local capture never reaches the sync.
      yield* hooks.afterCapture({
        threadId: threadA,
        scope: { ...scope, cwd: "/repo" } as never,
        checkpoints: [checkpoint],
      });
      assert.equal(yield* Queue.size(calls), 0);
      // The capture's own sync fails; the thread is handed to the worker.
      yield* hooks.afterCapture({
        threadId: threadA,
        scope: scope as never,
        checkpoints: [checkpoint],
      });
      assert.equal(yield* Queue.take(calls), threadA);
      yield* worker.enqueue(threadB);

      yield* worker.flush(sandboxA);
      assert.deepEqual(yield* Queue.takeAll(calls), [threadA]);
      yield* worker.drain;
      assert.sameMembers([...(yield* Queue.takeAll(calls))], [threadA, threadB]);
      yield* worker.drain;
      assert.equal(yield* Queue.size(calls), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
