import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The worker runs one effect per (aggregate_kind, aggregate_id). A non-thread kind has one stream,
// named after the kind (TEAM_IMAGE_STREAM_ID), so the key is derived and thread writers stay as
// they are. Rowids are copied: the claim orders a key's effects by rowid.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_effect_outbox_next (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT,
      aggregate_kind TEXT NOT NULL DEFAULT 'thread'
        CHECK (aggregate_kind IN ('thread', 'team-image')),
      aggregate_id TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(thread_id, aggregate_kind)) VIRTUAL,
      effect_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT,
      CHECK ((aggregate_kind = 'thread') = (thread_id IS NOT NULL))
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox_next (
      rowid,
      effect_id,
      command_id,
      thread_id,
      aggregate_kind,
      effect_type,
      payload_json,
      status,
      attempt_count,
      available_at,
      lease_owner,
      lease_expires_at,
      created_at,
      updated_at,
      completed_at,
      last_error
    )
    SELECT
      rowid,
      effect_id,
      command_id,
      thread_id,
      'thread',
      effect_type,
      payload_json,
      status,
      attempt_count,
      available_at,
      lease_owner,
      lease_expires_at,
      created_at,
      updated_at,
      completed_at,
      last_error
    FROM orchestration_v2_effect_outbox
    ORDER BY rowid
  `;
  yield* sql`DROP TABLE orchestration_v2_effect_outbox`;
  yield* sql`
    ALTER TABLE orchestration_v2_effect_outbox_next
    RENAME TO orchestration_v2_effect_outbox
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_claim_idx
    ON orchestration_v2_effect_outbox(status, available_at, lease_expires_at, created_at)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_command_idx
    ON orchestration_v2_effect_outbox(command_id, effect_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_thread_status_idx
    ON orchestration_v2_effect_outbox(thread_id, status, effect_type)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_aggregate_idx
    ON orchestration_v2_effect_outbox(aggregate_kind, aggregate_id, status)
  `;
});
