import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who can open a cloud session, for paged reads that filter in SQL. NULL `audience` reads as `team`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_v2_projection_sandboxes ADD COLUMN audience TEXT`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_sandbox_members (
      sandbox_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (sandbox_id, member_id)
    ) WITHOUT ROWID
  `;
});
