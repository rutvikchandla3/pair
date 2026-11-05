import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every existing human message was the owner's: before teams there was no one else. Guest,
// scheduled, agent-sent and notification messages carry `createdBy: 'user'` too but are no one's.
const HUMAN_MESSAGE = `
  json_extract(payload_json, '$.createdBy') = 'user'
  AND json_type(payload_json, '$.context.guest') IS NULL
  AND json_type(payload_json, '$.scheduledTaskId') IS NULL
  AND json_type(payload_json, '$.senderThreadId') IS NULL
  AND json_type(payload_json, '$.notification') IS NULL
  AND json_type(payload_json, '$.delegatedCompletion') IS NULL
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owner = sql.literal("(SELECT id FROM members WHERE is_owner = 1)");
  const humanMessage = sql.literal(HUMAN_MESSAGE);

  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.ownerId', ${owner})
    WHERE json_type(payload_json, '$.ownerId') IS NULL
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.humanAuthorIds', json_array(${owner}))
    WHERE json_type(payload_json, '$.humanAuthorIds') IS NULL
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages
        WHERE orchestration_v2_projection_messages.thread_id =
            orchestration_v2_projection_threads.thread_id
          AND role = 'user'
          AND ${humanMessage}
      )
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_messages
    SET payload_json = json_set(payload_json, '$.authorId', ${owner})
    WHERE role = 'user' AND json_type(payload_json, '$.authorId') IS NULL AND ${humanMessage}
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_set(payload_json, '$.authorId', ${owner})
    WHERE type = 'user_message' AND json_type(payload_json, '$.authorId') IS NULL
      AND ${humanMessage}
  `;

  const taskColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!taskColumns.some((column) => column.name === "created_by_member_id")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN created_by_member_id TEXT`;
  }
  yield* sql`
    UPDATE scheduled_tasks SET created_by_member_id = ${owner}
    WHERE created_by_member_id IS NULL
  `;
});
