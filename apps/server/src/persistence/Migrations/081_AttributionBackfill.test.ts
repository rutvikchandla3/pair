import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0081 from "./081_AttributionBackfill.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });
const AT = "2026-09-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const threadId of ["thread-human", "thread-agent"]) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      )
      VALUES (${threadId}, 'project-1', 'Title', 'codex', 'full-access', 'default', ${AT}, ${AT}, '{}')
    `;
  }
  const messages = [
    ["message-human", "thread-human", { createdBy: "user" }],
    ["message-guest", "thread-human", { createdBy: "user", context: { guest: { name: "G" } } }],
    ["message-scheduled", "thread-agent", { createdBy: "user", scheduledTaskId: "task-1" }],
    ["message-agent", "thread-agent", { createdBy: "agent" }],
  ] as const;
  for (const [id, threadId, payload] of messages) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (${id}, ${threadId}, NULL, NULL, 'user', 0, ${AT}, ${AT}, ${JSON.stringify(payload)})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES (
        ${`item-${id}`}, ${threadId}, 1, 'user_message', 'completed', ${AT},
        ${JSON.stringify(payload)}
      )
    `;
  }
  yield* sql`
    INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
      model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
      created_at, updated_at, last_run_status, run_count
    )
    VALUES (
      'task-1', 'Task', 'Prompt', 1, '{}', 'project-1', '{}', '{}', 'full-access', 'default',
      'user', 'web', ${AT}, ${AT}, 'never', 0
    )
  `;
});

const readState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    threads: yield* sql<{ readonly id: string; readonly ownerId: string | null; readonly authors: string | null }>`
      SELECT thread_id AS id, payload_json ->> '$.ownerId' AS "ownerId",
        payload_json -> '$.humanAuthorIds' AS authors
      FROM orchestration_v2_projection_threads ORDER BY thread_id
    `,
    messages: yield* sql<{ readonly id: string; readonly authorId: string | null }>`
      SELECT message_id AS id, payload_json ->> '$.authorId' AS "authorId"
      FROM orchestration_v2_projection_messages ORDER BY message_id
    `,
    items: yield* sql<{ readonly id: string; readonly authorId: string | null }>`
      SELECT turn_item_id AS id, payload_json ->> '$.authorId' AS "authorId"
      FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id
    `,
    tasks: yield* sql`SELECT created_by_member_id FROM scheduled_tasks`,
  };
});

describe("081_AttributionBackfill", () => {
  it.effect("attributes existing human work to the owner and nothing else, idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* seed;
      yield* runMigrations({ toMigrationInclusive: 81 });
      const [owner] = yield* sql<{ readonly id: string }>`SELECT id FROM members WHERE is_owner = 1`;
      const ownerId = owner!.id;

      const migrated = yield* readState;
      assert.deepStrictEqual(migrated.threads, [
        { id: "thread-agent", ownerId, authors: null },
        { id: "thread-human", ownerId, authors: JSON.stringify([ownerId]) },
      ]);
      const authored = {
        "message-agent": null,
        "message-guest": null,
        "message-human": ownerId,
        "message-scheduled": null,
      };
      assert.deepStrictEqual(
        migrated.messages,
        Object.entries(authored).map(([id, authorId]) => ({ id, authorId })),
      );
      assert.deepStrictEqual(
        migrated.items,
        Object.entries(authored).map(([id, authorId]) => ({ id: `item-${id}`, authorId })),
      );
      assert.deepStrictEqual(migrated.tasks, [{ created_by_member_id: ownerId }]);

      yield* Migration0081;
      assert.deepStrictEqual(yield* readState, migrated);
    }).pipe(Effect.provide(layerMemory)),
  );
});
