import {
  type MemberId,
  type MessageId,
  OrchestrationV2ConversationMessageJson,
  type OrchestrationV2DomainEvent,
  Space,
  SpaceAction,
  type SpaceActionId,
  type SpaceId,
  type SpaceNoteId,
  SpaceNoteItem,
  SpaceNotesChange,
  SpaceRoomEntry,
  SpaceTask,
  type SpaceTaskId,
  spaceActiveMemberIds,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const SpacePayload = Schema.fromJsonString(Space);
const encodeSpace = Schema.encodeEffect(SpacePayload);
const decodeSpace = Schema.decodeUnknownEffect(SpacePayload);
const EntryPayload = Schema.fromJsonString(SpaceRoomEntry);
const encodeEntry = Schema.encodeEffect(EntryPayload);
const decodeEntry = Schema.decodeUnknownEffect(EntryPayload);
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const TaskPayload = Schema.fromJsonString(SpaceTask);
const encodeTask = Schema.encodeEffect(TaskPayload);
const decodeTask = Schema.decodeUnknownEffect(TaskPayload);

/** The task a room line is about, so a task's activity is an indexed read of its room. */
const entryTaskId = (entry: SpaceRoomEntry): SpaceTaskId | null =>
  entry.type === "system" && "taskId" in entry.line ? entry.line.taskId : null;

/** Runs once per event; the projection apply that calls it owns the span. */
export const applySpaceUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "space.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const space = event.payload;
  const payloadJson = yield* encodeSpace(space);
  yield* sql`
    INSERT INTO orchestration_v2_projection_spaces (
      space_id, room_thread_id, owner_id, archived_at, updated_at, payload_json
    )
    VALUES (
      ${space.id}, ${space.roomThreadId}, ${space.ownerId}, ${space.archivedAt},
      ${space.updatedAt}, ${payloadJson}
    )
    ON CONFLICT(space_id) DO UPDATE SET
      room_thread_id = excluded.room_thread_id,
      owner_id = excluded.owner_id,
      archived_at = excluded.archived_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;
  yield* sql`DELETE FROM orchestration_v2_projection_space_members WHERE space_id = ${space.id}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_space_members (space_id, member_id)
    SELECT ${space.id}, value FROM json_each(${yield* encodeIds(spaceActiveMemberIds(space))})
  `;
});

export const applySpaceRoomEntry = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "space.room-entry" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const entry = event.payload;
  yield* sql`
    INSERT INTO orchestration_v2_projection_space_room_entries (
      entry_id, space_id, created_at, task_id, payload_json
    )
    VALUES (
      ${entry.id}, ${entry.spaceId}, ${entry.createdAt}, ${entryTaskId(entry)},
      ${yield* encodeEntry(entry)}
    )
    ON CONFLICT(entry_id) DO NOTHING
  `;
});

export const applySpaceTaskUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "space.task.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const task = event.payload;
  yield* sql`
    INSERT INTO orchestration_v2_projection_space_tasks (
      task_id, space_id, owner_id, status, deleted_at, updated_at, payload_json
    )
    VALUES (
      ${task.id}, ${task.spaceId}, ${task.ownerId}, ${task.status}, ${task.deletedAt},
      ${task.updatedAt}, ${yield* encodeTask(task)}
    )
    ON CONFLICT(task_id) DO UPDATE SET
      space_id = excluded.space_id,
      owner_id = excluded.owner_id,
      status = excluded.status,
      deleted_at = excluded.deleted_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;
});

/** Deleted ones too: a room line or record may still name it. */
export const getSpaceTask = Effect.fnUntraced(function* (taskId: SpaceTaskId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_tasks WHERE task_id = ${taskId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeTask(row.payload_json);
});

/** The space's tasks that are not deleted, most recently changed first. */
export const listSpaceTasks = Effect.fnUntraced(function* (spaceId: SpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_tasks
    WHERE space_id = ${spaceId} AND deleted_at IS NULL
    ORDER BY updated_at DESC, rowid DESC
  `;
  return yield* Effect.forEach(rows, (row) => decodeTask(row.payload_json));
});

/** Open (to do, in progress, in review) tasks of these spaces, most recently changed first. */
export const listOpenSpaceTasks = Effect.fnUntraced(function* (spaceIds: ReadonlyArray<SpaceId>) {
  if (spaceIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_tasks
    WHERE space_id IN (SELECT value FROM json_each(${yield* encodeIds(spaceIds)}))
      AND deleted_at IS NULL AND status IN ('todo', 'in-progress', 'in-review')
    ORDER BY updated_at DESC, rowid DESC
  `;
  return yield* Effect.forEach(rows, (row) => decodeTask(row.payload_json));
});

/** Ids of the threads on a task that are not deleted, newest first. */
export const listTaskThreadIds = Effect.fnUntraced(function* (taskId: SpaceTaskId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.space.taskId') END)
      = ${taskId}
      AND json_extract(payload_json, '$.space.kind') = 'task'
      AND json_extract(payload_json, '$.deletedAt') IS NULL
    ORDER BY created_at DESC, rowid DESC
  `;
  return rows.map((row) => row.thread_id);
});

/** The task's newest `limit` room lines, oldest first. */
export const listTaskEntries = Effect.fnUntraced(function* (input: {
  readonly taskId: SpaceTaskId;
  readonly limit: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_room_entries
    WHERE task_id = ${input.taskId}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ${input.limit}
  `;
  const entries = yield* Effect.forEach(rows, (row) => decodeEntry(row.payload_json));
  return entries.toReversed();
});

export const getSpace = Effect.fnUntraced(function* (spaceId: SpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_spaces WHERE space_id = ${spaceId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeSpace(row.payload_json);
});

/** Spaces the member belongs to, or every space when `memberId` is null. */
export const listSpaces = Effect.fnUntraced(function* (memberId: MemberId | null) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    memberId === null
      ? yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_spaces ORDER BY updated_at DESC
        `
      : yield* sql<{ readonly payload_json: string }>`
          SELECT s.payload_json
          FROM orchestration_v2_projection_spaces s
          JOIN orchestration_v2_projection_space_members m ON m.space_id = s.space_id
          WHERE m.member_id = ${memberId}
          ORDER BY s.updated_at DESC
        `;
  return yield* Effect.forEach(rows, (row) => decodeSpace(row.payload_json));
});

/** The newest `limit` entries before `before` (an entry id), oldest first. */
export const listRoomEntries = Effect.fnUntraced(function* (input: {
  readonly spaceId: SpaceId;
  readonly limit: number;
  readonly before?: MessageId | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    input.before === undefined
      ? yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_space_room_entries
          WHERE space_id = ${input.spaceId}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${input.limit}
        `
      : yield* sql<{ readonly payload_json: string }>`
          SELECT e.payload_json FROM orchestration_v2_projection_space_room_entries e
          JOIN orchestration_v2_projection_space_room_entries cursor
            ON cursor.entry_id = ${input.before}
          WHERE e.space_id = ${input.spaceId}
            AND (e.created_at < cursor.created_at
              OR (e.created_at = cursor.created_at AND e.rowid < cursor.rowid))
          ORDER BY e.created_at DESC, e.rowid DESC
          LIMIT ${input.limit}
        `;
  const entries = yield* Effect.forEach(rows, (row) => decodeEntry(row.payload_json));
  return entries.toReversed();
});

export const getRoomEntry = Effect.fnUntraced(function* (entryId: MessageId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_room_entries
    WHERE entry_id = ${entryId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeEntry(row.payload_json);
});

/** Ids of the threads on the space's tasks that are not deleted, newest first. */
export const listSpaceTaskThreadIds = Effect.fnUntraced(function* (spaceId: SpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.space.spaceId') = ${spaceId}
      AND json_extract(payload_json, '$.space.kind') = 'task'
      AND json_extract(payload_json, '$.deletedAt') IS NULL
    ORDER BY created_at DESC, rowid DESC
  `;
  return rows.map((row) => row.thread_id);
});

const ActionPayload = Schema.fromJsonString(SpaceAction);
const encodeAction = Schema.encodeEffect(ActionPayload);
const decodeAction = Schema.decodeUnknownEffect(ActionPayload);
const NotePayload = Schema.fromJsonString(SpaceNoteItem);
const encodeNote = Schema.encodeEffect(NotePayload);
const decodeNote = Schema.decodeUnknownEffect(NotePayload);
const NotesChangePayload = Schema.fromJsonString(SpaceNotesChange);
const encodeNotesChange = Schema.encodeEffect(NotesChangePayload);
const decodeNotesChange = Schema.decodeUnknownEffect(NotesChangePayload);
const MessagePayload = Schema.fromJsonString(OrchestrationV2ConversationMessageJson);
const decodeMessage = Schema.decodeUnknownEffect(MessagePayload);

export const applySpaceActionUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "space.action.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const action = event.payload;
  yield* sql`
    INSERT INTO orchestration_v2_projection_space_actions (
      action_id, space_id, room_message_id, created_at, payload_json
    )
    VALUES (
      ${action.id}, ${action.spaceId}, ${action.via?.roomMessageId ?? null}, ${action.createdAt},
      ${yield* encodeAction(action)}
    )
    ON CONFLICT(action_id) DO UPDATE SET payload_json = excluded.payload_json
  `;
});

export const applySpaceNotesChanged = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "space.notes.changed" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const change = event.payload;
  if (change.after === null) {
    yield* sql`DELETE FROM orchestration_v2_projection_space_notes WHERE note_id = ${change.noteId}`;
  } else {
    yield* sql`
      INSERT INTO orchestration_v2_projection_space_notes (note_id, space_id, created_at, payload_json)
      VALUES (
        ${change.noteId}, ${change.spaceId}, ${change.after.createdAt},
        ${yield* encodeNote(change.after)}
      )
      ON CONFLICT(note_id) DO UPDATE SET payload_json = excluded.payload_json
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_space_note_history (
      space_id, note_id, action_id, removed_at, payload_json
    )
    VALUES (
      ${change.spaceId}, ${change.noteId}, ${change.actionId}, ${change.tombstone?.removedAt ?? null},
      ${yield* encodeNotesChange(change)}
    )
  `;
});

export const getSpaceAction = Effect.fnUntraced(function* (actionId: SpaceActionId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_actions WHERE action_id = ${actionId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeAction(row.payload_json);
});

/**
 * The space's newest `limit` actions (none older than `since`), oldest first; or every action a
 * tag's replies took.
 */
export const listSpaceActions = Effect.fnUntraced(function* (
  input:
    | { readonly spaceId: SpaceId; readonly limit: number; readonly since?: string | undefined }
    | { readonly roomMessageId: MessageId },
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    "roomMessageId" in input
      ? yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_space_actions
          WHERE room_message_id = ${input.roomMessageId}
          ORDER BY created_at, rowid
        `
      : yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_space_actions
          WHERE space_id = ${input.spaceId} AND created_at >= ${input.since ?? ""}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${input.limit}
        `;
  const actions = yield* Effect.forEach(rows, (row) => decodeAction(row.payload_json));
  return "roomMessageId" in input ? actions : actions.toReversed();
});

export const listSpaceNotes = Effect.fnUntraced(function* (spaceId: SpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_notes
    WHERE space_id = ${spaceId}
    ORDER BY created_at, rowid
  `;
  return yield* Effect.forEach(rows, (row) => decodeNote(row.payload_json));
});

/** Items people removed since `since`, newest first. */
export const listSpaceNoteTombstones = Effect.fnUntraced(function* (
  spaceId: SpaceId,
  since: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_note_history
    WHERE space_id = ${spaceId} AND removed_at IS NOT NULL AND removed_at > ${since}
    ORDER BY sequence DESC
  `;
  const changes = yield* Effect.forEach(rows, (row) => decodeNotesChange(row.payload_json));
  return changes.flatMap((change) => (change.tombstone === null ? [] : [change.tombstone]));
});

/** Each item an action changed, as it was before the action's first change to it. */
export const listSpaceNotesBeforeAction = Effect.fnUntraced(function* (actionId: SpaceActionId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_space_note_history
    WHERE action_id = ${actionId}
    ORDER BY sequence
  `;
  const before = new Map<SpaceNoteId, SpaceNoteItem | null>();
  for (const row of rows) {
    const change = yield* decodeNotesChange(row.payload_json);
    if (!before.has(change.noteId)) before.set(change.noteId, change.before);
  }
  return before;
});

/**
 * A message in the space a note may cite: a room post, or a message in one of its tasks. Only a
 * person's own words count; agent output and @pair's messages don't.
 */
export const findSpaceMessage = Effect.fnUntraced(function* (
  spaceId: SpaceId,
  messageId: MessageId,
) {
  const entry = yield* getRoomEntry(messageId);
  if (entry !== null) {
    if (entry.type !== "post" || entry.spaceId !== spaceId) return null;
    const space = yield* getSpace(spaceId);
    if (space === null) return null;
    return {
      threadId: space.roomThreadId,
      authorId: entry.authorId,
      at: entry.createdAt,
      text: entry.text,
      byPerson: entry.authorKind === "user",
    };
  }
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT m.payload_json FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
    WHERE m.message_id = ${messageId}
      AND json_extract(t.payload_json, '$.space.spaceId') = ${spaceId}
      AND json_extract(t.payload_json, '$.deletedAt') IS NULL
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const message = yield* decodeMessage(row.payload_json);
  return {
    threadId: message.threadId,
    authorId: message.authorId ?? null,
    at: DateTime.formatIso(message.createdAt),
    text: message.text,
    byPerson:
      message.role === "user" &&
      message.createdBy === "user" &&
      message.authorId !== undefined &&
      message.via === undefined,
  };
});

/** Pair's finished replies in a room since `since`, oldest first, each with the post it answered. */
export const listRoomReplies = Effect.fnUntraced(function* (input: {
  readonly roomThreadId: string;
  readonly since?: string | undefined;
  readonly limit: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string; readonly trigger_id: string | null }>`
    SELECT m.payload_json, json_extract(r.payload_json, '$.userMessageId') AS trigger_id
    FROM orchestration_v2_projection_messages m
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
    WHERE m.thread_id = ${input.roomThreadId} AND m.role = 'assistant' AND m.streaming = 0
      AND m.created_at >= ${input.since ?? ""}
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ${input.limit}
  `;
  const replies = yield* Effect.forEach(rows, (row) =>
    Effect.map(decodeMessage(row.payload_json), (message) => ({
      message,
      triggerId: row.trigger_id,
    })),
  );
  return replies.toReversed();
});

/** A message in one of `threadIds`, or null. */
export const getThreadsMessage = Effect.fnUntraced(function* (
  threadIds: ReadonlyArray<string>,
  messageId: MessageId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_messages
    WHERE message_id = ${messageId}
      AND thread_id IN (SELECT value FROM json_each(${yield* encodeIds(threadIds)}))
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeMessage(row.payload_json);
});

export interface SpaceSearchRow {
  readonly kind: "post" | "reply" | "task";
  readonly id: string;
  readonly thread_id: string;
  readonly created_at: string;
  readonly author_id: string | null;
  readonly text: string;
  readonly prev_id: string | null;
  readonly prev_author_id: string | null;
  readonly prev_kind: string | null;
  readonly prev_text: string | null;
}

/**
 * Room posts, Pair's replies and people's own messages in `taskThreadIds` containing `needle`
 * (ASCII case-insensitive), newest first, each with the message before it in the same thread.
 */
export const searchSpaceMessages = Effect.fnUntraced(function* (input: {
  readonly spaceId: SpaceId;
  readonly roomThreadId: string;
  readonly taskThreadIds: ReadonlyArray<string>;
  readonly needle: string;
  readonly before?: string | undefined;
  readonly limit: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const taskIds = yield* encodeIds(input.taskThreadIds);
  return yield* sql<SpaceSearchRow>`
    WITH corpus AS (
      SELECT 'post' AS kind, entry_id AS id, ${input.roomThreadId} AS thread_id, 'posts' AS lane,
        created_at, rowid AS ord, json_extract(payload_json, '$.authorId') AS author_id,
        json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_space_room_entries
      WHERE space_id = ${input.spaceId} AND json_extract(payload_json, '$.type') = 'post'
      UNION ALL
      SELECT 'reply', message_id, thread_id, thread_id, created_at, rowid, NULL,
        json_extract(payload_json, '$.text')
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${input.roomThreadId} AND role = 'assistant' AND streaming = 0
      UNION ALL
      SELECT 'task', message_id, thread_id, thread_id, created_at, rowid,
        json_extract(payload_json, '$.authorId'), json_extract(payload_json, '$.text')
      FROM orchestration_v2_projection_messages
      WHERE thread_id IN (SELECT value FROM json_each(${taskIds})) AND role = 'user'
        AND json_extract(payload_json, '$.createdBy') = 'user'
        AND json_extract(payload_json, '$.authorId') IS NOT NULL
    ),
    ranked AS (
      SELECT *, LAG(id) OVER lane_order AS prev_id, LAG(author_id) OVER lane_order AS prev_author_id,
        LAG(kind) OVER lane_order AS prev_kind, LAG(text) OVER lane_order AS prev_text
      FROM corpus
      WINDOW lane_order AS (PARTITION BY lane ORDER BY created_at, ord)
    )
    SELECT kind, id, thread_id, created_at, author_id, text, prev_id, prev_author_id, prev_kind,
      substr(prev_text, 1, 400) AS prev_text
    FROM ranked
    WHERE instr(lower(text), lower(${input.needle})) > 0
      AND (${input.before ?? null} IS NULL OR created_at < ${input.before ?? null})
    ORDER BY created_at DESC, ord DESC
    LIMIT ${input.limit}
  `;
});
