import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// @pair: action records and confirm cards, the notes, and notes people removed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_actions (
      action_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      room_message_id TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_actions_space
    ON orchestration_v2_projection_space_actions (space_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_actions_trigger
    ON orchestration_v2_projection_space_actions (room_message_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_notes (
      note_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_notes_space
    ON orchestration_v2_projection_space_notes (space_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_note_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      action_id TEXT,
      removed_at TEXT,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_note_history_space
    ON orchestration_v2_projection_space_note_history (space_id, removed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_projection_space_note_history_action
    ON orchestration_v2_projection_space_note_history (action_id)
  `;
});
