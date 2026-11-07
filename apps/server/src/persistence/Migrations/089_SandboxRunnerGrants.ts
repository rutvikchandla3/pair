import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Hashes only: the enrollment secret and the sandbox token never reach the database.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_runner_grants (
      sandbox_id TEXT NOT NULL,
      boot_generation INTEGER NOT NULL,
      enrollment_hash TEXT NOT NULL UNIQUE,
      enrollment_expires_at TEXT NOT NULL,
      enrollment_consumed_at TEXT,
      token_hash TEXT UNIQUE,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sandbox_id, boot_generation)
    )
  `;
});
