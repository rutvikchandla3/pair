import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who prompted a run and who wrote a thread's latest message, kept at write time so shell reads
// stay plain column reads. Only threads with a second human author can differ from the holder.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_runs)
  `;
  if (!runColumns.some((column) => column.name === "author_id")) {
    yield* sql`ALTER TABLE orchestration_v2_projection_runs ADD COLUMN author_id TEXT`;
  }
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "latest_user_message_author_id")) {
    yield* sql`
      ALTER TABLE orchestration_v2_projection_threads ADD COLUMN latest_user_message_author_id TEXT
    `;
  }

  const sharedThreads = sql.literal(`(
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_array_length(payload_json, '$.humanAuthorIds') > 1
  )`);
  yield* sql`
    UPDATE orchestration_v2_projection_runs
    SET author_id = (
      SELECT json_extract(prompt.payload_json, '$.authorId')
      FROM orchestration_v2_projection_messages prompt
      WHERE prompt.message_id = json_extract(orchestration_v2_projection_runs.payload_json, '$.userMessageId')
    )
    WHERE author_id IS NULL AND thread_id IN ${sharedThreads}
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET latest_user_message_author_id = (
      SELECT json_extract(message.payload_json, '$.authorId')
      FROM orchestration_v2_projection_messages message
      WHERE message.thread_id = orchestration_v2_projection_threads.thread_id
        AND message.role = 'user'
        AND json_extract(message.payload_json, '$.createdBy') = 'user'
        AND json_type(message.payload_json, '$.idleCompaction') IS NULL
      ORDER BY message.updated_at DESC, message.message_id DESC
      LIMIT 1
    )
    WHERE thread_id IN ${sharedThreads}
  `;
});
