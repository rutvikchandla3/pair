import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0085 from "./085_MemberGitHub.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("085_MemberGitHub", () => {
  it.effect("adds unbound GitHub columns, binds an account to one active member, reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* sql`
        INSERT INTO members (id, name, role, created_at)
        VALUES ('bob', 'Bob', 'member', '2026-10-01T00:00:00.000Z'),
          ('carol', 'Carol', 'member', '2026-10-01T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* Migration0085;

      assert.deepStrictEqual(
        yield* sql`
          SELECT github_user_id, github_login, github_connected_at FROM members WHERE id = 'bob'
        `,
        [{ github_user_id: null, github_login: null, github_connected_at: null }],
      );
      yield* sql`UPDATE members SET github_user_id = 7, github_login = 'bob' WHERE id = 'bob'`;
      const taken = yield* Effect.flip(
        sql`UPDATE members SET github_user_id = 7 WHERE id = 'carol'`,
      );
      assert.strictEqual(taken._tag, "SqlError");
      // A removed member's binding no longer holds the account.
      yield* sql`UPDATE members SET removed_at = '2026-10-02T00:00:00.000Z' WHERE id = 'bob'`;
      yield* sql`UPDATE members SET github_user_id = 7 WHERE id = 'carol'`;
    }).pipe(Effect.provide(layerMemory)),
  );
});
