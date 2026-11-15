import {
  type MemberId,
  MessageId,
  type SharedWithYouState,
  type SpaceId,
  SpaceTask,
  type SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Reads for InboxService. Each runs once per Inbox read; the service method owns the span.

const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(SpaceTask));

export const latestEventSequence = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
  `;
  return rows[0]?.sequence ?? 0;
});

/** Threads with a request or card waiting on a person; the shell says which one shows. */
export const pendingRequestThreadIds = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'
    UNION
    SELECT thread_id FROM orchestration_v2_projection_turn_items
    WHERE type = 'link_request' AND status = 'waiting'
    UNION
    SELECT r.thread_id FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_turn_items secret
      ON secret.thread_id = r.thread_id AND secret.run_id = r.run_id
    WHERE r.status IN ('preparing', 'starting', 'running', 'waiting')
      AND secret.type = 'secret_request' AND secret.status = 'waiting'
  `;
  return rows.map((row) => ThreadId.make(row.thread_id));
});

/** The approval's command or the question, from the card that asks it. */
export const requestExcerpt = Effect.fnUntraced(function* (threadId: ThreadId, requestId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly prompt: string | null;
    readonly question: string | null;
    readonly title: string | null;
  }>`
    SELECT json_extract(payload_json, '$.prompt') AS prompt,
      json_extract(payload_json, '$.questions[0].question') AS question,
      json_extract(payload_json, '$.title') AS title
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
      AND (json_extract(payload_json, '$.requestId') = ${requestId} OR turn_item_id = ${requestId})
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : (row.prompt ?? row.question ?? row.title);
});

/** Each thread's last visit by the member: the row's for its holder, else the member row's. */
export const memberVisits = Effect.fnUntraced(function* (input: {
  readonly memberId: MemberId;
  readonly serverOwnerId: MemberId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
}) {
  if (input.threadIds.length === 0) return new Map<ThreadId, string | null>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly last_visited_at: string | null }>`
    SELECT t.thread_id,
      CASE
        WHEN COALESCE(json_extract(t.payload_json, '$.ownerId'), ${input.serverOwnerId}, ${input.memberId})
          = ${input.memberId}
          THEN json_extract(t.payload_json, '$.lastVisitedAt')
        ELSE ms.last_visited_at
      END AS last_visited_at
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_thread_member_state ms
      ON ms.thread_id = t.thread_id AND ms.member_id = ${input.memberId}
    WHERE t.thread_id IN (SELECT value FROM json_each(${yield* encodeIds(input.threadIds)}))
  `;
  return new Map(rows.map((row) => [ThreadId.make(row.thread_id), row.last_visited_at]));
});

/** Room posts naming the member, by someone else, newer than `since`, newest first. */
export const mentionPosts = Effect.fnUntraced(function* (input: {
  readonly spaceId: SpaceId;
  readonly memberId: MemberId;
  readonly since: string | null;
  readonly limit: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly entry_id: string;
    readonly created_at: string;
    readonly author_id: MemberId;
    readonly text: string;
  }>`
    SELECT e.entry_id, e.created_at,
      json_extract(e.payload_json, '$.authorId') AS author_id,
      json_extract(e.payload_json, '$.text') AS text
    FROM orchestration_v2_projection_space_room_entries e
    WHERE e.space_id = ${input.spaceId}
      AND e.created_at > ${input.since ?? ""}
      AND json_extract(e.payload_json, '$.type') = 'post'
      AND json_extract(e.payload_json, '$.authorId') IS NOT ${input.memberId}
      AND EXISTS (
        SELECT 1 FROM json_each(e.payload_json, '$.mentions') mention
        WHERE json_extract(mention.value, '$.memberId') = ${input.memberId}
      )
    ORDER BY e.created_at DESC, e.rowid DESC
    LIMIT ${input.limit}
  `;
});

/** Pair's finished replies in a room newer than `since`, each with its run's prompt id. */
export const roomReplies = Effect.fnUntraced(function* (input: {
  readonly roomThreadId: ThreadId;
  readonly since: string | null;
  readonly limit: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly created_at: string;
    readonly text: string;
    readonly trigger_id: string | null;
  }>`
    SELECT m.created_at, json_extract(m.payload_json, '$.text') AS text,
      json_extract(r.payload_json, '$.userMessageId') AS trigger_id
    FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
    WHERE m.thread_id = ${input.roomThreadId} AND m.role = 'assistant' AND m.streaming = 0
      AND m.created_at > ${input.since ?? ""}
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ${input.limit}
  `;
});

/** Of these room posts, the ones the member wrote. */
export const memberPostIds = Effect.fnUntraced(function* (
  memberId: MemberId,
  entryIds: ReadonlyArray<string>,
) {
  if (entryIds.length === 0) return new Set<MessageId>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly entry_id: string }>`
    SELECT entry_id FROM orchestration_v2_projection_space_room_entries
    WHERE entry_id IN (SELECT value FROM json_each(${yield* encodeIds(entryIds)}))
      AND json_extract(payload_json, '$.authorId') = ${memberId}
  `;
  return new Set(rows.map((row) => MessageId.make(row.entry_id)));
});

/** How many threads that are not deleted each task has. */
export const taskThreadCounts = Effect.fnUntraced(function* (taskIds: ReadonlyArray<SpaceTaskId>) {
  if (taskIds.length === 0) return new Map<string, number>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly task_id: string; readonly threads: number }>`
    SELECT task.value AS task_id, (
      SELECT COUNT(*) FROM orchestration_v2_projection_threads t
      WHERE (CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.space.taskId') END)
        = task.value
        AND json_extract(t.payload_json, '$.deletedAt') IS NULL
    ) AS threads
    FROM json_each(${yield* encodeIds(taskIds)}) task
  `;
  return new Map(rows.map((row) => [row.task_id, row.threads]));
});

/** The member's newest Done and Canceled tasks in these spaces. */
export const closedTasks = Effect.fnUntraced(function* (input: {
  readonly ownerId: MemberId;
  readonly spaceIds: ReadonlyArray<SpaceId>;
  readonly limit: number;
}) {
  if (input.spaceIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_tasks
    WHERE owner_id = ${input.ownerId} AND status IN ('done', 'canceled') AND deleted_at IS NULL
      AND space_id IN (SELECT value FROM json_each(${yield* encodeIds(input.spaceIds)}))
    ORDER BY updated_at DESC, rowid DESC
    LIMIT ${input.limit}
  `;
  return yield* Effect.forEach(rows, (row) => decodeTask(row.payload_json));
});

/** When each task was last given to its owner: its newest created or assigned room line. */
export const taskAssignedAt = Effect.fnUntraced(function* (taskIds: ReadonlyArray<SpaceTaskId>) {
  if (taskIds.length === 0) return new Map<string, string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly task_id: string; readonly at: string }>`
    SELECT task_id, MAX(created_at) AS at FROM orchestration_v2_projection_space_room_entries
    WHERE task_id IN (SELECT value FROM json_each(${yield* encodeIds(taskIds)}))
      AND json_extract(payload_json, '$.line.type') IN ('task-created', 'task-assigned')
    GROUP BY task_id
  `;
  return new Map(rows.map((row) => [row.task_id, row.at]));
});

export interface SharedThreadRow {
  readonly thread_id: ThreadId;
  readonly title: string;
  readonly owner_id: MemberId;
  readonly via: "name" | "team";
  readonly created_at: string;
  readonly last_activity_at: string;
  readonly shared_at: string | null;
  readonly shared_by: MemberId | null;
  readonly space_id: SpaceId | null;
  readonly task_id: SpaceTaskId | null;
  readonly state: SharedWithYouState;
  readonly last_visited_at: string | null;
}

/**
 * Listed cloud threads someone else holds, on a machine shared with the member by name (`name`) or
 * with the whole team (`team`). Rooms, subagents and side chats are never listed. With
 * `everyoneSeesLocal` (access not enforced), threads without a machine count as shared with the team.
 */
export const sharedThreads = Effect.fnUntraced(function* (input: {
  readonly memberId: MemberId;
  readonly serverOwnerId: MemberId | null;
  readonly byNameOnly: boolean;
  readonly everyoneSeesLocal: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<SharedThreadRow>`
    SELECT * FROM (
      SELECT t.thread_id, t.title, t.created_at, t.updated_at AS last_activity_at,
        COALESCE(json_extract(t.payload_json, '$.ownerId'), ${input.serverOwnerId}) AS owner_id,
        CASE WHEN s.audience = 'members' THEN 'name' ELSE 'team' END AS via,
        json_extract(s.payload_json, '$.access.updatedAt') AS shared_at,
        json_extract(s.payload_json, '$.access.updatedBy') AS shared_by,
        json_extract(t.payload_json, '$.space.spaceId') AS space_id,
        json_extract(t.payload_json, '$.space.taskId') AS task_id,
        CASE
          WHEN json_extract(t.payload_json, '$.settledOverride') = 'settled' THEN 'settled'
          WHEN EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests q
            WHERE q.thread_id = t.thread_id AND q.status = 'pending'
          ) THEN 'needs-someone'
          WHEN EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id
              AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          ) THEN 'working'
          ELSE 'idle'
        END AS state,
        ms.last_visited_at
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_sandboxes s
        ON s.sandbox_id = json_extract(t.payload_json, '$.sandboxId')
      LEFT JOIN projection_thread_member_state ms
        ON ms.thread_id = t.thread_id AND ms.member_id = ${input.memberId}
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND COALESCE(json_extract(t.payload_json, '$.lineage.sideChat'), 0) = 0
        AND json_extract(t.payload_json, '$.space.kind') IS NOT 'room'
        AND (
          (s.audience = 'members' AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_sandbox_members m
            WHERE m.sandbox_id = s.sandbox_id AND m.member_id = ${input.memberId}
          ))
          OR (${input.byNameOnly ? 0 : 1} = 1 AND s.sandbox_id IS NOT NULL
            AND (s.audience IS NULL OR s.audience = 'team'))
          OR (${input.byNameOnly || !input.everyoneSeesLocal ? 0 : 1} = 1 AND s.sandbox_id IS NULL)
        )
    )
    WHERE owner_id IS NOT ${input.memberId}
    ORDER BY last_activity_at DESC, thread_id DESC
  `;
});

export interface MemberItemRow {
  readonly item_id: string;
  readonly dismissed_at: string | null;
  readonly snoozed_until: string | null;
}

export const memberItems = Effect.fnUntraced(function* (memberId: MemberId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<MemberItemRow>`
    SELECT item_id, dismissed_at, snoozed_until FROM inbox_member_items
    WHERE member_id = ${memberId}
  `;
});

export const writeMemberItem = Effect.fnUntraced(function* (input: {
  readonly memberId: MemberId;
  readonly itemId: string;
  readonly dismissedAt?: string | null;
  readonly snoozedUntil?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO inbox_member_items (member_id, item_id, dismissed_at, snoozed_until)
    VALUES (
      ${input.memberId}, ${input.itemId}, ${input.dismissedAt ?? null}, ${input.snoozedUntil ?? null}
    )
    ON CONFLICT(member_id, item_id) DO UPDATE SET
      dismissed_at = ${input.dismissedAt === undefined ? sql`dismissed_at` : input.dismissedAt},
      snoozed_until = ${input.snoozedUntil === undefined ? sql`snoozed_until` : input.snoozedUntil}
  `;
});
