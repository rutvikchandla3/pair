import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A replayed mint replaces a generation's secret, but the machine may hold the one before it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_runner_superseded_enrollments (
      enrollment_hash TEXT PRIMARY KEY,
      sandbox_id TEXT NOT NULL,
      boot_generation INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
});
