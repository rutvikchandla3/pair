import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The usage ledger has no `orchestration_v2_` prefix: events are pruned, so it is never rebuilt.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_sandboxes (
      sandbox_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      owner_member_id TEXT,
      driver_id TEXT NOT NULL,
      state TEXT NOT NULL,
      generation INTEGER NOT NULL,
      admission_since TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandboxes_owner_thread
    ON orchestration_v2_projection_sandboxes (owner_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandboxes_state_driver
    ON orchestration_v2_projection_sandboxes (state, driver_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandboxes_admission
    ON orchestration_v2_projection_sandboxes (admission_since)
    WHERE admission_since IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_sandbox_threads (
      sandbox_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      attached_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sandbox_id, thread_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_threads_thread
    ON orchestration_v2_projection_sandbox_threads (thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_usage_intervals (
      interval_id INTEGER PRIMARY KEY AUTOINCREMENT,
      sandbox_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      member_id TEXT,
      driver_id TEXT NOT NULL,
      size TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_usage_sandbox ON sandbox_usage_intervals (sandbox_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_usage_open
    ON sandbox_usage_intervals (sandbox_id)
    WHERE ended_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_usage_member
    ON sandbox_usage_intervals (member_id, started_at)
  `;
});
