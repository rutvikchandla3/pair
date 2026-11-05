import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0083 from "./083_ThreadMemberFollow.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("083_ThreadMemberFollow", () => {
  it.effect("adds followed_at as not following to existing rows, and reruns cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      yield* sql`
        INSERT INTO projection_thread_member_state (thread_id, member_id, pinned_at, updated_at)
        VALUES ('thread-1', 'member-1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* Migration0083;

      assert.deepStrictEqual(
        yield* sql`SELECT pinned_at, followed_at FROM projection_thread_member_state`,
        [{ pinned_at: "2026-10-01T00:00:00.000Z", followed_at: null }],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
