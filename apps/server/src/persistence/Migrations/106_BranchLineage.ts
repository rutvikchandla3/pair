import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Branch off: one lineage record per branch, offers to sources, and each thread's lineage revision
// and pending step. A machine's threads get a stable slot for PAIR_THREAD_SLOT and PORT.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_branch_lineage (
      branch_thread_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_projection_branch_lineage_source
    ON orchestration_v2_projection_branch_lineage (source_thread_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_offers (
      offer_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      branch_thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_projection_offers_source
    ON orchestration_v2_projection_offers (source_thread_id, state, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_projection_offers_branch
    ON orchestration_v2_projection_offers (branch_thread_id, created_at)
  `;
  // `revision` bumps on every lineage or offer change naming the thread; `step_json` gates its queue.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_lineage_threads (
      thread_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      step_json TEXT
    ) WITHOUT ROWID
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_sandbox_threads)
  `;
  if (!columns.some((column) => column.name === "slot")) {
    yield* sql`ALTER TABLE orchestration_v2_projection_sandbox_threads ADD COLUMN slot INTEGER`;
  }
  // Existing machines number their unarchived threads by attach order, so the owner keeps 0.
  yield* sql`
    UPDATE orchestration_v2_projection_sandbox_threads
    SET slot = (
      SELECT numbered.slot FROM (
        SELECT sandbox_id, thread_id,
          ROW_NUMBER() OVER (PARTITION BY sandbox_id ORDER BY attached_at, thread_id) - 1 AS slot
        FROM orchestration_v2_projection_sandbox_threads
        WHERE archived = 0
      ) AS numbered
      WHERE numbered.sandbox_id = orchestration_v2_projection_sandbox_threads.sandbox_id
        AND numbered.thread_id = orchestration_v2_projection_sandbox_threads.thread_id
    )
    WHERE slot IS NULL AND archived = 0
  `;
});
