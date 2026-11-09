import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The source of truth for team images: events are pruned like any stream's and never rebuild these.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_image_recipe_revisions (
      revision INTEGER PRIMARY KEY,
      recipe_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      saved_by_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_image_builds (
      image_build_id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      machine_sandbox_id TEXT,
      machine_driver_ref TEXT,
      machine_destroyed_at TEXT,
      log_deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS team_image_builds_status_idx ON team_image_builds (status)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_image_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_build_id TEXT,
      next_build_number INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO team_image_state (id, active_build_id, next_build_number)
    VALUES (1, NULL, 1)
  `;
});
