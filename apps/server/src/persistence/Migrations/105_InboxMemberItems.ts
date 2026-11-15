import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Inbox items are derived on read; only a member's Done and task-item snoozes are stored.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS inbox_member_items (
      member_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      dismissed_at TEXT,
      snoozed_until TEXT,
      PRIMARY KEY (member_id, item_id)
    ) WITHOUT ROWID
  `;
  // "prompt" marks a follow that prompting added, which ends on its own; null is permanent.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_member_state)
  `;
  if (!columns.some((column) => column.name === "follow_source")) {
    yield* sql`ALTER TABLE projection_thread_member_state ADD COLUMN follow_source TEXT`;
  }
});
