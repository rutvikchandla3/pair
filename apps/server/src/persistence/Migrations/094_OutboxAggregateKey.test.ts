import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0094 from "./094_OutboxAggregateKey.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });
const at = "2026-11-10T00:00:00.000Z";

describe("094_OutboxAggregateKey", () => {
  it.effect("keeps thread rows in order and refuses a team-image row with a thread id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      for (const [effectId, threadId, status] of [
        ["effect-c", "thread-1", "running"],
        ["effect-a", "thread-2", "pending"],
        ["effect-b", "thread-1", "succeeded"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            available_at, created_at, updated_at
          )
          VALUES (${effectId}, 'command-1', ${threadId}, 'provider-turn.start', '{}', ${status}, ${at}, ${at}, ${at})
        `;
      }

      yield* Migration0094;

      assert.deepStrictEqual(
        yield* sql`
          SELECT rowid, effect_id, thread_id, status, aggregate_kind, aggregate_id
          FROM orchestration_v2_effect_outbox
          ORDER BY rowid
        `,
        [
          {
            rowid: 1,
            effect_id: "effect-c",
            thread_id: "thread-1",
            status: "running",
            aggregate_kind: "thread",
            aggregate_id: "thread-1",
          },
          {
            rowid: 2,
            effect_id: "effect-a",
            thread_id: "thread-2",
            status: "pending",
            aggregate_kind: "thread",
            aggregate_id: "thread-2",
          },
          {
            rowid: 3,
            effect_id: "effect-b",
            thread_id: "thread-1",
            status: "succeeded",
            aggregate_kind: "thread",
            aggregate_id: "thread-1",
          },
        ],
      );

      const insert = (effectId: string, threadId: string | null) => sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, aggregate_kind, effect_type, payload_json, status,
          available_at, created_at, updated_at
        )
        VALUES (${effectId}, 'command-2', ${threadId}, 'team-image', 'team-image.build.launch', '{}', 'pending', ${at}, ${at}, ${at})
      `;
      yield* insert("effect-bad", "thread-1").pipe(Effect.flip);
      yield* insert("effect-image", null);
      assert.deepStrictEqual(
        yield* sql`
          SELECT aggregate_kind, aggregate_id FROM orchestration_v2_effect_outbox
          WHERE effect_id = 'effect-image'
        `,
        [{ aggregate_kind: "team-image", aggregate_id: "team-image" }],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
