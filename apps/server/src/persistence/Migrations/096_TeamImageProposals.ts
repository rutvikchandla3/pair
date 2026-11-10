import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The unique index is the one-open-proposal-per-thread rule's backstop; the decider refuses first.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_image_proposals (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS team_image_proposals_open_thread
    ON team_image_proposals (thread_id) WHERE status = 'open'
  `;
});
