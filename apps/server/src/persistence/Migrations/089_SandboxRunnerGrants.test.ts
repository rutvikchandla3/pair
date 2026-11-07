import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0089 from "./089_SandboxRunnerGrants.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("089_SandboxRunnerGrants", () => {
  it.effect(
    "keys a grant by sandbox and generation, refuses a reused hash, and reruns cleanly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 89 });
        yield* Migration0089;

        yield* sql`
        INSERT INTO sandbox_runner_grants (sandbox_id, boot_generation, enrollment_hash, enrollment_expires_at, created_at)
        VALUES ('sbx_00000000000000000001', 1, 'hash-1', '2026-11-01T00:15:00.000Z', '2026-11-01T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO sandbox_runner_grants (sandbox_id, boot_generation, enrollment_hash, enrollment_expires_at, created_at)
        VALUES ('sbx_00000000000000000002', 1, 'hash-1', '2026-11-01T00:15:00.000Z', '2026-11-01T00:00:00.000Z')
      `.pipe(Effect.flip);
        yield* sql`
        INSERT INTO sandbox_runner_grants (sandbox_id, boot_generation, enrollment_hash, enrollment_expires_at, created_at)
        VALUES ('sbx_00000000000000000001', 1, 'hash-2', '2026-11-01T00:15:00.000Z', '2026-11-01T00:00:00.000Z')
      `.pipe(Effect.flip);

        assert.deepStrictEqual(
          yield* sql`SELECT sandbox_id, boot_generation, token_hash FROM sandbox_runner_grants`,
          [{ sandbox_id: "sbx_00000000000000000001", boot_generation: 1, token_hash: null }],
        );
      }).pipe(Effect.provide(layerMemory)),
  );
});
