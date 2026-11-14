import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// 102's index ran json_extract on every write, so a thread with malformed JSON could not be saved.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_ov2_projection_threads_space_task`;
  yield* sql`
    CREATE INDEX idx_ov2_projection_threads_space_task
    ON orchestration_v2_projection_threads (
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.space.taskId') END)
    )
    WHERE (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.space.taskId') END)
      IS NOT NULL
  `;
});
