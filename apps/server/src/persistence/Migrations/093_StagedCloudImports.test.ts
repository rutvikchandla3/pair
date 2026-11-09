import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0093 from "./093_StagedCloudImports.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("093_StagedCloudImports", () => {
  it.effect("keys a staged import by key and kind, and reruns cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      yield* Migration0093;
      const insert = (kind: string) => sql`
        INSERT INTO staged_cloud_imports (staging_key, kind, project_id, member_id, created_at)
        VALUES ('mv_0123456789abcdef0123456789abcdef', ${kind}, 'project-1', 'member-1', '2026-11-09T00:00:00.000Z')
      `;

      yield* insert("seed");
      yield* insert("seed").pipe(Effect.flip);
      yield* insert("context-export");

      assert.deepStrictEqual(
        yield* sql`SELECT kind, claimed_thread_id FROM staged_cloud_imports ORDER BY kind`,
        [
          { kind: "context-export", claimed_thread_id: null },
          { kind: "seed", claimed_thread_id: null },
        ],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
