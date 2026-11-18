import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Bots, their jobs, sessions, asks, notes and timeline rows. Every row carries its encoded schema
// value in `data_json`; the key columns exist only to index, filter and join.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      home_thread_id TEXT,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bots_owner ON bots(owner_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_jobs (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS bot_jobs_number ON bot_jobs(bot_id, number)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      thread_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_sessions_bot ON bot_sessions(bot_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_asks (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_asks_bot ON bot_asks(bot_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_notes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_notes_bot ON bot_notes(bot_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_events (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      job_id TEXT,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_events_bot ON bot_events(bot_id, created_at)`;
});
