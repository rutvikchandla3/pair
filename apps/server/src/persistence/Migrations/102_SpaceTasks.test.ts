import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { EVENT_LOG_PRUNED_THROUGH } from "../OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import Migration0102, { spaceTaskIdForThread } from "./102_SpaceTasks.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });
const AT = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-02T00:00:00.000Z";

const placement = (spaceId: string) => ({
  kind: "task",
  spaceId,
  createdBy: "m-lead",
  description: "Do the thing",
  base: { type: "default" },
  handedBack: { by: "m-dev", reason: "Blocked", at: AT },
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const thread = (id: string, payload: Record<string, unknown>) =>
    sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      )
      VALUES (
        ${id}, 'p-1', ${`Task ${id}`}, 'codex', 'approval-required', 'default', ${AT}, ${LATER},
        NULL, ${JSON.stringify({
          id,
          title: `Task ${id}`,
          ownerId: "m-dev",
          createdAt: AT,
          updatedAt: LATER,
          deletedAt: null,
          settledAt: null,
          pullRequests: [],
          ...payload,
        })}
      )
    `;
  const pr = (state: string) => [{ url: "https://example.test/pr/1", snapshot: { state } }];
  yield* thread("t-merged", { space: placement("s-1"), pullRequests: pr("merged") });
  yield* thread("t-settled", { space: placement("s-1"), settledAt: AT });
  yield* thread("t-open", { space: placement("s-1"), pullRequests: pr("open") });
  yield* thread("t-ran", { space: placement("s-1"), pullRequests: pr("closed") });
  yield* thread("t-unstarted", { space: placement("s-1") });
  yield* thread("t-room", { space: { kind: "room", spaceId: "s-1" } });
  for (const [runId, threadId] of [
    ["r-1", "t-merged"],
    ["r-2", "t-settled"],
    ["r-3", "t-open"],
    ["r-4", "t-ran"],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      )
      VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', ${AT}, '{}')
    `;
  }
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, roots_json
    )
    VALUES
      ('p-1', 'Repo', '/w/repo', '[]', ${AT}, ${AT}, NULL),
      ('p-ws', 'Workspace', '/w/ws', '[]', ${AT}, ${AT},
        '[{"projectId":"p-a","name":"a"},{"projectId":"p-b","name":"b"}]')
  `;
  const space = (id: string, projectId: string, archivedAt: string | null) =>
    sql`
      INSERT INTO orchestration_v2_projection_spaces (
        space_id, room_thread_id, owner_id, archived_at, updated_at, payload_json
      )
      VALUES (${id}, 't-room', 'm-lead', ${archivedAt}, ${AT}, ${JSON.stringify({
        id,
        roomThreadId: "t-room",
        name: id,
        projectId,
        pairBilling: { type: "owner" },
        archivedAt,
      })})
    `;
  yield* space("s-1", "p-1", null);
  yield* space("s-archived", "p-ws", AT);
  const entry = (id: string, line: Record<string, unknown>) =>
    sql`
      INSERT INTO orchestration_v2_projection_space_room_entries (
        entry_id, space_id, created_at, payload_json
      )
      VALUES (${id}, 's-archived', ${AT}, ${JSON.stringify({
        type: "system",
        id,
        spaceId: "s-archived",
        createdAt: AT,
        line,
      })})
    `;
  yield* entry("e-created", { type: "task-created", threadId: "t-unstarted", ownerId: "m-dev" });
  yield* entry("e-billing", { type: "billing-changed", pairBilling: { type: "owner" } });
  yield* entry("e-project", { type: "project-changed", projectId: "p-ws" });
  const action = (id: string, payload: Record<string, unknown>) =>
    sql`
      INSERT INTO orchestration_v2_projection_space_actions (
        action_id, space_id, room_message_id, created_at, payload_json
      )
      VALUES (${id}, 's-1', 'msg-1', ${AT}, ${JSON.stringify({ id, spaceId: "s-1", ...payload })})
    `;
  yield* action("a-created", {
    request: { type: "task.create", title: "T", description: "D", ownerId: "m-dev" },
    outcome: {
      type: "task.created",
      threadId: "t-unstarted",
      ownerId: "m-dev",
      title: "T",
      started: false,
    },
  });
  yield* action("a-message", {
    request: { type: "task.message", taskId: "t-ran", text: "Go" },
    outcome: {
      type: "task.message.queued",
      threadId: "t-ran",
      ownerId: "m-dev",
      title: "T",
      messageId: "msg-2",
    },
  });
  // Sequences 1–4 are projected; 5 is the unprojected tail.
  const event = (sequence: number, stream: string, type: string, version = 2) =>
    sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      )
      VALUES (
        ${sequence}, ${`ev-${sequence}`}, 'thread', ${stream}, ${sequence}, ${type}, ${AT},
        'server', '{}', '{}', ${version}
      )
    `;
  yield* event(1, "t-ran", "thread.created");
  yield* event(2, "t-ran", "thread.metadata-updated");
  yield* event(3, "t-ran", "thread.metadata-updated");
  yield* event(4, "t-open", "thread.metadata-updated");
  yield* event(5, "t-ran", "thread.metadata-updated");
  yield* sql`
    UPDATE orchestration_v2_projection_metadata SET last_sequence = 4
    WHERE projection_name = 'thread-projections'
  `;
});

describe("102_SpaceTasks", () => {
  it.effect("turns v1 task threads into tasks and prunes the projected tail", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });
      yield* seed;
      yield* Migration0102;

      const tasks = yield* sql<{
        readonly task_id: string;
        readonly status: string;
        readonly payload_json: string;
      }>`SELECT task_id, status, payload_json FROM orchestration_v2_projection_space_tasks`;
      const statusOf = (threadId: string) =>
        tasks.find((task) => task.task_id === spaceTaskIdForThread(threadId))?.status;
      assert.deepStrictEqual(
        ["t-merged", "t-settled", "t-open", "t-unstarted", "t-ran"].map(statusOf),
        ["done", "done", "in-review", "todo", "in-progress"],
      );
      assert.strictEqual(tasks.length, 5);
      assert.match(spaceTaskIdForThread("t-ran"), /^stk_[0-9a-f]{20}$/);
      const ranTask = JSON.parse(
        tasks.find((task) => task.task_id === spaceTaskIdForThread("t-ran"))!.payload_json,
      );
      assert.deepStrictEqual(ranTask, {
        id: spaceTaskIdForThread("t-ran"),
        spaceId: "s-1",
        title: "Task t-ran",
        description: "Do the thing",
        ownerId: "m-dev",
        createdBy: "m-lead",
        createdAt: AT,
        assignedBy: "m-lead",
        status: "in-progress",
        statusVersion: 1,
        statusChangedAt: LATER,
        statusChangedBy: { type: "member", memberId: "m-lead" },
        handedBack: { by: "m-dev", reason: "Blocked", at: AT },
        remindedAt: null,
        via: null,
        updatedAt: LATER,
        deletedAt: null,
      });

      const threads = yield* sql<{
        readonly thread_id: string;
        readonly deleted_at: string | null;
        readonly payload_json: string;
      }>`SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads`;
      const threadRow = (id: string) => threads.find((thread) => thread.thread_id === id)!;
      assert.deepStrictEqual(JSON.parse(threadRow("t-ran").payload_json).space, {
        kind: "task",
        spaceId: "s-1",
        taskId: spaceTaskIdForThread("t-ran"),
        linkedBy: "m-lead",
        linkedAt: AT,
        via: "start",
      });
      assert.strictEqual(threadRow("t-ran").deleted_at, null);
      const unstarted = JSON.parse(threadRow("t-unstarted").payload_json);
      assert.notStrictEqual(threadRow("t-unstarted").deleted_at, null);
      assert.strictEqual(unstarted.deletedAt, threadRow("t-unstarted").deleted_at);
      assert.strictEqual(unstarted.space, undefined);
      assert.deepStrictEqual(JSON.parse(threadRow("t-room").payload_json).space, {
        kind: "room",
        spaceId: "s-1",
      });

      const spaces = yield* sql<{ readonly space_id: string; readonly payload_json: string }>`
        SELECT space_id, payload_json FROM orchestration_v2_projection_spaces ORDER BY space_id
      `;
      assert.deepStrictEqual(
        spaces.map((row) => {
          const space = JSON.parse(row.payload_json);
          return [row.space_id, space.repositoryIds, "pairBilling" in space, space.archivedAt];
        }),
        [
          ["s-1", ["p-1"], false, null],
          ["s-archived", ["p-a", "p-b"], false, AT],
        ],
      );

      const entries = yield* sql<{
        readonly entry_id: string;
        readonly task_id: string | null;
        readonly payload_json: string;
      }>`
        SELECT entry_id, task_id, payload_json FROM orchestration_v2_projection_space_room_entries
        ORDER BY entry_id
      `;
      assert.deepStrictEqual(
        entries.map((row) => [row.entry_id, row.task_id, JSON.parse(row.payload_json).line]),
        [
          [
            "e-created",
            spaceTaskIdForThread("t-unstarted"),
            { type: "task-created", ownerId: "m-dev", taskId: spaceTaskIdForThread("t-unstarted") },
          ],
          [
            "e-project",
            null,
            { type: "repositories-changed", repositoryIds: ["p-a", "p-b"], projectId: "p-ws" },
          ],
        ],
      );

      const actions = yield* sql<{ readonly action_id: string; readonly payload_json: string }>`
        SELECT action_id, payload_json FROM orchestration_v2_projection_space_actions
        ORDER BY action_id
      `;
      const [created, message] = actions.map((row) => JSON.parse(row.payload_json));
      assert.deepStrictEqual(created.outcome, {
        type: "task.created",
        taskId: spaceTaskIdForThread("t-unstarted"),
        threadId: null,
        ownerId: "m-dev",
        title: "T",
        started: false,
      });
      assert.deepStrictEqual(message.request, {
        type: "thread.message",
        threadId: "t-ran",
        text: "Go",
      });
      assert.strictEqual(message.outcome.type, "thread.message.queued");

      // 1 is a thread.created, 4 is t-open's head, 5 is past the projected boundary.
      const events = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        events.map((row) => row.sequence),
        [1, 4, 5],
      );
      const pruned = yield* sql<{ readonly last_sequence: number }>`
        SELECT last_sequence FROM orchestration_v2_projection_metadata
        WHERE projection_name = ${EVENT_LOG_PRUNED_THROUGH}
      `;
      assert.deepStrictEqual(pruned, [{ last_sequence: 4 }]);
    }).pipe(Effect.provide(layerMemory)),
  );
});
