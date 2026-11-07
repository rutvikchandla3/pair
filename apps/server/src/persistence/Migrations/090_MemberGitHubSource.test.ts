import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0090 from "./090_MemberGitHubSource.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("090_MemberGitHubSource", () => {
  it.effect("marks proven bindings as the app's, leaves claims unset, reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`
        INSERT INTO members (id, name, role, created_at, github_user_id, github_login, github_connected_at)
        VALUES ('bob', 'Bob', 'member', '2026-10-01T00:00:00.000Z', 7, 'bob', '2026-10-01T00:00:00.000Z'),
          ('carol', 'Carol', 'member', '2026-10-01T00:00:00.000Z', 8, 'carol', NULL),
          ('dave', 'Dave', 'member', '2026-10-01T00:00:00.000Z', NULL, 'dave', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 90 });
      yield* Migration0090;

      assert.deepStrictEqual(
        yield* sql`SELECT id, github_source FROM members WHERE is_owner = 0 ORDER BY id`,
        [
          { id: "bob", github_source: "app" },
          { id: "carol", github_source: "app" },
          { id: "dave", github_source: null },
        ],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
