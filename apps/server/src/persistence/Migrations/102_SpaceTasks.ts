// @effect-diagnostics-next-line nodeBuiltinImport:off - migrations run with only SqlClient; no Digest service.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "../../orchestration-v2/ProjectionStore.ts";
import { EVENT_LOG_PRUNE_MARK, EVENT_LOG_PRUNED_THROUGH } from "../OrchestrationEventStore.ts";

type Json = Record<string, unknown>;

/** Deterministic, so a rerun and every room line map one v1 task thread to the same task. */
export const spaceTaskIdForThread = (threadId: string) =>
  `stk_${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 20)}`;

const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const JsonString = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownSync(JsonString);
const stringify = Schema.encodeSync(JsonString);
const parse = (json: string): Json => record(parseJson(json)) ?? {};

const v1Status = (thread: Json, ran: boolean) => {
  const states = (Array.isArray(thread.pullRequests) ? thread.pullRequests : []).map(
    (link) => record(record(link)?.snapshot)?.state,
  );
  if (states.includes("merged") || (thread.settledAt ?? null) !== null) return "done";
  if (states.includes("open")) return "in-review";
  return ran ? "in-progress" : "todo";
};

// Spaces v2: tasks become records on the room stream, and threads link to them. Projections are
// authoritative, so this rewrites them and prunes the event tail instead of rewriting old events.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_space_tasks (
      task_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_space_tasks_space
    ON orchestration_v2_projection_space_tasks (space_id, updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_space_tasks_owner
    ON orchestration_v2_projection_space_tasks (owner_id, status)
  `;
  const entryColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_space_room_entries)
  `;
  if (!entryColumns.some((column) => column.name === "task_id")) {
    yield* sql`ALTER TABLE orchestration_v2_projection_space_room_entries ADD COLUMN task_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_space_room_entries_task
    ON orchestration_v2_projection_space_room_entries (task_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ov2_projection_threads_space_task
    ON orchestration_v2_projection_threads (json_extract(payload_json, '$.space.taskId'))
    WHERE json_extract(payload_json, '$.space.taskId') IS NOT NULL
  `;

  // Tasks, from v1 task threads.
  const taskThreads = yield* sql<{
    readonly thread_id: string;
    readonly payload_json: string;
    readonly ran: number;
  }>`
    SELECT
      thread.thread_id,
      thread.payload_json,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS run WHERE run.thread_id = thread.thread_id
      ) AS ran
    FROM orchestration_v2_projection_threads AS thread
    WHERE json_extract(thread.payload_json, '$.space.kind') = 'task'
  `;
  for (const row of taskThreads) {
    const thread = parse(row.payload_json);
    const placement = record(thread.space) ?? {};
    const taskId = spaceTaskIdForThread(row.thread_id);
    const createdBy = String(placement.createdBy);
    const ownerId = typeof thread.ownerId === "string" ? thread.ownerId : createdBy;
    const createdAt = String(thread.createdAt);
    const updatedAt = String(thread.updatedAt);
    const deletedAt = typeof thread.deletedAt === "string" ? thread.deletedAt : null;
    const ran = row.ran === 1;
    const status = v1Status(thread, ran);
    const task = {
      id: taskId,
      spaceId: placement.spaceId,
      title: String(thread.title).trim().slice(0, 200).trim() || "Task",
      description: placement.description,
      ownerId,
      createdBy,
      createdAt,
      assignedBy: createdBy === ownerId ? null : createdBy,
      status,
      statusVersion: 1,
      statusChangedAt: updatedAt,
      statusChangedBy: { type: "member", memberId: createdBy },
      handedBack: placement.handedBack ?? null,
      remindedAt: placement.remindedAt ?? null,
      via: null,
      updatedAt,
      deletedAt,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_space_tasks (
        task_id, space_id, owner_id, status, deleted_at, updated_at, payload_json
      )
      VALUES (
        ${taskId}, ${String(placement.spaceId)}, ${ownerId}, ${status}, ${deletedAt},
        ${updatedAt}, ${stringify(task)}
      )
      ON CONFLICT(task_id) DO NOTHING
    `;
    if (ran) {
      const link = {
        kind: "task",
        spaceId: placement.spaceId,
        taskId,
        linkedBy: createdBy,
        linkedAt: createdAt,
        via: "start",
      };
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.space', json(${stringify(link)}))
        WHERE thread_id = ${row.thread_id}
      `;
    } else {
      // A v1 task that never ran is an empty placeholder; v2's assigned task has no thread.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET
          deleted_at = COALESCE(deleted_at, ${now}),
          payload_json = json_set(
            json_remove(payload_json, '$.space'),
            '$.deletedAt',
            COALESCE(json_extract(payload_json, '$.deletedAt'), ${now})
          )
        WHERE thread_id = ${row.thread_id}
      `;
    }
  }

  // Spaces: billing is the Team key now, and the project becomes its repositories.
  const spaces = yield* sql<{ readonly space_id: string; readonly payload_json: string }>`
    SELECT space_id, payload_json FROM orchestration_v2_projection_spaces
  `;
  const repositoriesBySpace = new Map<string, ReadonlyArray<string>>();
  for (const row of spaces) {
    const space = parse(row.payload_json);
    const projectId = String(space.projectId);
    const projects = yield* sql<{ readonly roots_json: string | null }>`
      SELECT roots_json FROM projection_projects WHERE project_id = ${projectId}
    `;
    const roots = projects[0]?.roots_json == null ? null : parseJson(projects[0].roots_json);
    const rootIds = Array.isArray(roots)
      ? roots.flatMap((root) => {
          const id = record(root)?.projectId;
          return typeof id === "string" ? [id] : [];
        })
      : [];
    const repositoryIds =
      Array.isArray(space.repositoryIds) && space.repositoryIds.length > 0
        ? (space.repositoryIds as ReadonlyArray<string>)
        : rootIds.length > 0
          ? rootIds
          : [projectId];
    repositoriesBySpace.set(row.space_id, repositoryIds);
    const { pairBilling: _billing, ...rest } = space;
    yield* sql`
      UPDATE orchestration_v2_projection_spaces
      SET payload_json = ${stringify({ ...rest, repositoryIds })}
      WHERE space_id = ${row.space_id}
    `;
  }

  // Room lines.
  yield* sql`
    DELETE FROM orchestration_v2_projection_space_room_entries
    WHERE json_extract(payload_json, '$.line.type') = 'billing-changed'
  `;
  const lines = yield* sql<{
    readonly entry_id: string;
    readonly space_id: string;
    readonly payload_json: string;
  }>`
    SELECT entry_id, space_id, payload_json FROM orchestration_v2_projection_space_room_entries
    WHERE json_extract(payload_json, '$.type') = 'system'
      AND json_extract(payload_json, '$.line.type')
        IN ('task-created', 'task-handed-back', 'project-changed')
  `;
  for (const row of lines) {
    const entry = parse(row.payload_json);
    const line = record(entry.line) ?? {};
    let next: Json;
    let taskId: string | null = null;
    if (line.type === "project-changed") {
      const projectId = String(line.projectId);
      next = {
        type: "repositories-changed",
        repositoryIds: repositoriesBySpace.get(row.space_id) ?? [projectId],
        projectId,
      };
    } else {
      if (typeof line.threadId !== "string") continue;
      const { threadId, ...rest } = line;
      taskId = spaceTaskIdForThread(threadId);
      next = { ...rest, taskId };
    }
    yield* sql`
      UPDATE orchestration_v2_projection_space_room_entries
      SET payload_json = ${stringify({ ...entry, line: next })}, task_id = ${taskId}
      WHERE entry_id = ${row.entry_id}
    `;
  }

  // @pair's records name tasks by task id and threads by thread id.
  const actions = yield* sql<{ readonly action_id: string; readonly payload_json: string }>`
    SELECT action_id, payload_json FROM orchestration_v2_projection_space_actions
    WHERE json_extract(payload_json, '$.request.type') = 'task.message'
      OR json_extract(payload_json, '$.outcome.type') IN ('task.created', 'task.message.queued')
  `;
  for (const row of actions) {
    const action = parse(row.payload_json);
    const request = record(action.request);
    const outcome = record(action.outcome);
    const nextRequest =
      request?.type === "task.message"
        ? (() => {
            const { taskId, ...rest } = request;
            return { ...rest, type: "thread.message", threadId: taskId };
          })()
        : request;
    let nextOutcome = outcome;
    if (outcome?.type === "task.created" && outcome.taskId === undefined) {
      const threadId = String(outcome.threadId);
      nextOutcome = {
        ...outcome,
        taskId: spaceTaskIdForThread(threadId),
        threadId: outcome.started === true ? threadId : null,
      };
    } else if (outcome?.type === "task.message.queued") {
      nextOutcome = { ...outcome, type: "thread.message.queued" };
    }
    yield* sql`
      UPDATE orchestration_v2_projection_space_actions
      SET payload_json = ${stringify({ ...action, request: nextRequest, outcome: nextOutcome })}
      WHERE action_id = ${row.action_id}
    `;
  }

  // Old events carry v1 shapes; drop the replayable tail so clients resync from snapshots once.
  const projectedRows = yield* sql<{ readonly projected: number | null }>`
    SELECT MIN(last_sequence) AS projected FROM orchestration_v2_projection_metadata
    WHERE projection_name NOT IN (${EVENT_LOG_PRUNE_MARK}, ${EVENT_LOG_PRUNED_THROUGH})
  `;
  const projected = projectedRows[0]?.projected ?? null;
  if (projected === null || projected <= 0) return;
  const prunedRows = yield* sql<{ readonly last_sequence: number }>`
    SELECT last_sequence FROM orchestration_v2_projection_metadata
    WHERE projection_name = ${EVENT_LOG_PRUNED_THROUGH}
  `;
  const through = Math.max(projected, prunedRows[0]?.last_sequence ?? 0);
  // Publish the boundary first so resuming clients take a snapshot, never a partial replay.
  yield* sql`
    INSERT INTO orchestration_v2_projection_metadata (
      projection_name, schema_version, last_sequence, updated_at
    )
    VALUES (
      ${EVENT_LOG_PRUNED_THROUGH}, ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, ${through}, ${now}
    )
    ON CONFLICT(projection_name) DO UPDATE SET
      last_sequence = excluded.last_sequence,
      updated_at = excluded.updated_at
  `;
  // Keeps the rows `ProjectionMaintenance.pruneEvents` keeps.
  yield* sql`
    DELETE FROM orchestration_events
    WHERE sequence <= ${through}
      AND application_event_version IS NOT 1
      AND event_type <> 'thread.created'
      AND NOT (
        event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
      )
      AND sequence NOT IN (
        SELECT MAX(sequence) FROM orchestration_events GROUP BY aggregate_kind, stream_id
      )
      AND sequence NOT IN (
        SELECT json_extract(payload_json, '$.promptSequence') FROM orchestration_events
        WHERE event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(payload_json, '$.promptSequence') = 'integer'
      )
  `;
});
