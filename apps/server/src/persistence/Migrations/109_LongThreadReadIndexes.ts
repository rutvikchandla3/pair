import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Turns on long threads look up runs and provider turns by index instead of walking the thread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_thread_completed_idx
    ON orchestration_v2_projection_runs(thread_id, completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id, thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_usage_idx
    ON orchestration_v2_projection_provider_turns(
      provider_thread_id, json_extract(payload_json, '$.tokenUsage.updatedAt') DESC, ordinal
    )
    WHERE run_attempt_id IS NOT NULL AND json_extract(payload_json, '$.tokenUsage') IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_live_idx
    ON orchestration_v2_projection_provider_turns(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
});
