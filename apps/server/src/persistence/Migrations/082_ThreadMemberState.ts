import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Only members other than a thread's holder get rows; the holder's state stays in the thread row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_member_state (
      thread_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      pinned_at TEXT,
      pin_order_key TEXT,
      active_order_key TEXT,
      last_visited_at TEXT,
      snoozed_until TEXT,
      snoozed_at TEXT,
      last_snooze_wake_at TEXT,
      opens_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, member_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_member_state_member
    ON projection_thread_member_state (member_id, thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_member_state_pinned
    ON projection_thread_member_state (thread_id) WHERE pinned_at IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_member_state_snoozed
    ON projection_thread_member_state (thread_id) WHERE snoozed_until IS NOT NULL
  `;
});
