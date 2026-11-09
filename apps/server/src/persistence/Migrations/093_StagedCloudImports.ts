import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// No CHECK on kind: a later kind (the context export) needs no migration.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS staged_cloud_imports (
      staging_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_thread_id TEXT,
      PRIMARY KEY (staging_key, kind)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_staged_cloud_imports_unclaimed
    ON staged_cloud_imports (created_at) WHERE claimed_thread_id IS NULL
  `;
});
