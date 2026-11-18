import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0088 from "./088_MemberPairBuilderUser.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("088_MemberPairBuilderUser", () => {
  it.effect("binds a Builder user to one member, removed or not, and reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* sql`
        INSERT INTO members (id, name, role, created_at)
        VALUES ('bob', 'Bob', 'member', '2026-10-01T00:00:00.000Z'),
          ('carol', 'Carol', 'member', '2026-10-01T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* Migration0088;

      assert.deepStrictEqual(
        yield* sql`SELECT pair_builder_user_id FROM members WHERE id = 'bob'`,
        [{ pair_builder_user_id: null }],
      );
      yield* sql`UPDATE members SET pair_builder_user_id = 'u-1' WHERE id = 'bob'`;
      yield* sql`UPDATE members SET removed_at = '2026-10-02T00:00:00.000Z' WHERE id = 'bob'`;
      // A removed member keeps the binding, so the Builder user cannot come back as someone new.
      const taken = yield* Effect.flip(
        sql`UPDATE members SET pair_builder_user_id = 'u-1' WHERE id = 'carol'`,
      );
      assert.strictEqual(taken._tag, "SqlError");
    }).pipe(Effect.provide(layerMemory)),
  );
});
