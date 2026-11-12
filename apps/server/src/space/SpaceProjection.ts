import {
  type MemberId,
  type MessageId,
  type OrchestrationV2DomainEvent,
  Space,
  type SpaceId,
  SpaceRoomEntry,
  spaceActiveMemberIds,
} from "@t3tools/contracts";
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
      entry_id, space_id, created_at, payload_json
    )
    VALUES (${entry.id}, ${entry.spaceId}, ${entry.createdAt}, ${yield* encodeEntry(entry)})
    ON CONFLICT(entry_id) DO NOTHING
  `;
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

/** Ids of the space's task threads that are not deleted, newest first. */
export const listSpaceTaskThreadIds = Effect.fnUntraced(function* (spaceId: SpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.space.spaceId') = ${spaceId}
      AND json_extract(payload_json, '$.space.kind') = 'task'
      AND json_extract(payload_json, '$.deletedAt') IS NULL
    ORDER BY created_at DESC
  `;
  return rows.map((row) => row.thread_id);
});
