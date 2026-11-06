import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Settings → Team reads the last week of provider turns without scanning every turn ever run.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_completed_idx
    ON orchestration_v2_projection_provider_turns(completed_at)
  `;
});
