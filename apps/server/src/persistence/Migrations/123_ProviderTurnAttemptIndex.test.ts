import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

// Pair's 109 already created this index, so upstream's 123 must accept a database that has it.
it.effect("runs after 109 created the same attempt index, keeping Pair's two-column index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 109 });
    yield* runMigrations({ toMigrationInclusive: 123 });

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_index_info('orchestration_v2_projection_provider_turns_attempt_idx')
      ORDER BY seqno
    `;
    assert.deepStrictEqual(
      columns.map((column) => column.name),
      ["run_attempt_id", "thread_id"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
