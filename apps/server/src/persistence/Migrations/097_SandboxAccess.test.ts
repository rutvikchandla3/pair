import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("097_SandboxAccess", () => {
  it.effect("reads an existing machine as having no audience and lists each member once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_sandboxes (
          sandbox_id, project_id, owner_thread_id, owner_member_id, driver_id, state,
          generation, admission_since, updated_at, payload_json
        )
        VALUES (
          'sbx_existing', 'project-1', 'thread-1', NULL, 'docker', 'ready',
          1, NULL, '2026-01-01T00:00:00.000Z', '{}'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 97 });

      assert.deepStrictEqual(
        yield* sql`SELECT audience FROM orchestration_v2_projection_sandboxes`,
        [{ audience: null }],
      );
      const insert = (memberId: string) => sql`
        INSERT INTO orchestration_v2_projection_sandbox_members (sandbox_id, member_id)
        VALUES ('sbx_existing', ${memberId})
      `;
      yield* insert("member-bob");
      yield* insert("member-carol");
      yield* insert("member-bob").pipe(Effect.flip);
      assert.deepStrictEqual(
        (yield* sql`SELECT member_id FROM orchestration_v2_projection_sandbox_members`).map(
          (row) => row.member_id,
        ),
        ["member-bob", "member-carol"],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
