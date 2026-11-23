import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0109 from "./109_LongThreadReadIndexes.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("109_LongThreadReadIndexes", () => {
  it.effect("indexes existing runs and provider turns, and reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
        )
        VALUES ('run-1', 'thread-1', 1, 'codex', 'completed', '2026-11-01T00:00:00.000Z',
          '2026-11-01T00:01:00.000Z', '{}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns (
          provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status,
          payload_json
        )
        VALUES
          ('turn-1', 'thread-1', 'provider-thread-1', 'node-1', 'attempt-1', 1, 'completed',
            '{"tokenUsage":{"usedTokens":1,"updatedAt":"2026-11-01T00:01:00.000Z"}}'),
          ('turn-2', 'thread-1', 'provider-thread-1', 'node-2', NULL, 2, 'running', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* Migration0109;

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name IN (
          'orchestration_v2_projection_runs_thread_completed_idx',
          'orchestration_v2_projection_provider_turns_attempt_idx',
          'orchestration_v2_projection_provider_turns_usage_idx',
          'orchestration_v2_projection_provider_turns_live_idx'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "orchestration_v2_projection_provider_turns_attempt_idx",
          "orchestration_v2_projection_provider_turns_live_idx",
          "orchestration_v2_projection_provider_turns_usage_idx",
          "orchestration_v2_projection_runs_thread_completed_idx",
        ],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
