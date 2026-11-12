import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Spaces, their active members (for "which spaces can I see"), and each room's timeline.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_spaces (
      space_id TEXT PRIMARY KEY,
      room_thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      archived_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_members (
      space_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (space_id, member_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_members_member
    ON orchestration_v2_projection_space_members (member_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_room_entries (
      entry_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_room_entries_space
    ON orchestration_v2_projection_space_room_entries (space_id, created_at)
  `;
});
