import {
  ComputeDriverId,
  isProviderNativeSubagentThread,
  MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Sandbox,
  OrchestrationV2SandboxJson,
  type OrchestrationV2ThreadShellSandbox,
  type SandboxId,
  SandboxSize,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface SandboxThreadRow {
  readonly threadId: ThreadId;
  readonly attachedAt: DateTime.Utc;
  readonly archived: boolean;
}

interface UsageInterval {
  readonly threadId: ThreadId;
  readonly memberId: MemberId | null;
  readonly driverId: ComputeDriverId;
  readonly size: SandboxSize;
}

type UsageIntervalChange = {
  readonly close: boolean;
  readonly open: UsageInterval | null;
};

/** "Billed" is 04 §4's "running": provisioning, waking or ready, and not waiting for admission. */
const isBilled = (sandbox: OrchestrationV2Sandbox) =>
  sandbox.admission === null &&
  (sandbox.state === "ready" || sandbox.state === "provisioning" || sandbox.state === "waking");

/** Machine time bills to the owner thread and member at one size, so a change to any splits it. */
export const usageIntervalChange = (
  open: UsageInterval | null,
  next: OrchestrationV2Sandbox,
): UsageIntervalChange => {
  const billed = isBilled(next);
  const close =
    open !== null &&
    (!billed ||
      open.threadId !== next.ownerThreadId ||
      open.memberId !== next.ownerMemberId ||
      open.size !== next.size);
  return {
    close,
    open:
      billed && (open === null || close)
        ? {
            threadId: next.ownerThreadId,
            memberId: next.ownerMemberId,
            driverId: next.driverId,
            size: next.size,
          }
        : null,
  };
};

export const sandboxShellSummary = (
  sandbox: OrchestrationV2Sandbox,
): OrchestrationV2ThreadShellSandbox => ({
  state: sandbox.state,
  ownerThreadId: sandbox.ownerThreadId,
  ...(sandbox.admission === null
    ? {}
    : {
        admission: {
          reason: sandbox.admission.reason,
          since: DateTime.formatIso(sandbox.admission.since),
        },
      }),
  runnerConnected: sandbox.state === "ready" && sandbox.runnerLostAt === null,
  ...(sandbox.failure === null
    ? {}
    : { failureCode: sandbox.failure.code, retryable: sandbox.failure.retryable }),
});

const SandboxPayload = Schema.fromJsonString(OrchestrationV2SandboxJson);
const encodeSandbox = Schema.encodeEffect(SandboxPayload);
const decodeSandbox = Schema.decodeUnknownEffect(SandboxPayload);
const encodeTimestamp = Schema.encodeEffect(Schema.DateTimeUtcFromString);
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeIntervalRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      interval_id: Schema.Number,
      thread_id: ThreadId,
      member_id: Schema.NullOr(MemberId),
      driver_id: ComputeDriverId,
      size: SandboxSize,
      started_at: Schema.String,
      ended_at: Schema.NullOr(Schema.String),
    }),
  ),
);

/** Runs once per event; the projection apply that calls it owns the span. */
export const applySandboxUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "sandbox.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const sandbox = event.payload;
  const payloadJson = yield* encodeSandbox(sandbox);
  const admissionSince =
    sandbox.admission === null ? null : yield* encodeTimestamp(sandbox.admission.since);
  const updatedAt = yield* encodeTimestamp(sandbox.updatedAt);
  yield* sql`
    INSERT INTO orchestration_v2_projection_sandboxes (
      sandbox_id, project_id, owner_thread_id, owner_member_id, driver_id, state, generation,
      admission_since, updated_at, payload_json
    )
    VALUES (
      ${sandbox.id}, ${sandbox.projectId}, ${sandbox.ownerThreadId}, ${sandbox.ownerMemberId},
      ${sandbox.driverId}, ${sandbox.state}, ${sandbox.generation}, ${admissionSince},
      ${updatedAt}, ${payloadJson}
    )
    ON CONFLICT(sandbox_id) DO UPDATE SET
      project_id = excluded.project_id,
      owner_thread_id = excluded.owner_thread_id,
      owner_member_id = excluded.owner_member_id,
      driver_id = excluded.driver_id,
      state = excluded.state,
      generation = excluded.generation,
      admission_since = excluded.admission_since,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;

  const latest = (yield* decodeIntervalRows(
    yield* sql`
      SELECT interval_id, thread_id, member_id, driver_id, size, started_at, ended_at
      FROM sandbox_usage_intervals
      WHERE sandbox_id = ${sandbox.id}
      ORDER BY interval_id DESC
      LIMIT 1
    `,
  ))[0];
  // The ledger outlives events and is never cleared, so a replayed event older than its last
  // boundary has already been counted.
  if (
    latest !== undefined &&
    DateTime.isLessThan(event.occurredAt, DateTime.makeUnsafe(latest.ended_at ?? latest.started_at))
  ) {
    return;
  }
  const open =
    latest === undefined || latest.ended_at !== null
      ? null
      : {
          intervalId: latest.interval_id,
          threadId: latest.thread_id,
          memberId: latest.member_id,
          driverId: latest.driver_id,
          size: latest.size,
        };
  const change = usageIntervalChange(open, sandbox);
  const at = yield* encodeTimestamp(event.occurredAt);
  if (change.close && open !== null) {
    yield* sql`
      UPDATE sandbox_usage_intervals SET ended_at = ${at} WHERE interval_id = ${open.intervalId}
    `;
  }
  if (change.open !== null) {
    yield* sql`
      INSERT INTO sandbox_usage_intervals (
        sandbox_id, thread_id, member_id, driver_id, size, started_at, ended_at
      )
      VALUES (
        ${sandbox.id}, ${change.open.threadId}, ${change.open.memberId}, ${change.open.driverId},
        ${change.open.size}, ${at}, NULL
      )
    `;
  }
});

/**
 * Membership comes only from each thread's own payload. Provider-native subagents inherit
 * `sandboxId` but get no row: they never prompt, and their work is their parent's turn.
 */
export const applySandboxMembership = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  at: DateTime.Utc,
) {
  if (thread.sandboxId === undefined || isProviderNativeSubagentThread(thread)) return;
  const sql = yield* SqlClient.SqlClient;
  if (thread.deletedAt !== null) {
    yield* sql`
      DELETE FROM orchestration_v2_projection_sandbox_threads
      WHERE sandbox_id = ${thread.sandboxId} AND thread_id = ${thread.id}
    `;
    return;
  }
  const attachedAt = yield* encodeTimestamp(at);
  yield* sql`
    INSERT INTO orchestration_v2_projection_sandbox_threads (
      sandbox_id, thread_id, attached_at, archived
    )
    VALUES (${thread.sandboxId}, ${thread.id}, ${attachedAt}, ${thread.archivedAt === null ? 0 : 1})
    ON CONFLICT(sandbox_id, thread_id) DO UPDATE SET archived = excluded.archived
  `;
});

export const getSandboxes = Effect.fn("SandboxProjection.getSandboxes")(function* (
  ids: ReadonlyArray<SandboxId>,
) {
  const sandboxes = new Map<SandboxId, OrchestrationV2Sandbox>();
  if (ids.length === 0) return sandboxes;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_sandboxes
    WHERE sandbox_id IN (SELECT value FROM json_each(${yield* encodeIds(ids)}))
  `;
  for (const row of rows) {
    const sandbox = yield* decodeSandbox(row.payload_json);
    sandboxes.set(sandbox.id, sandbox);
  }
  return sandboxes;
});

export const getSandbox = Effect.fn("SandboxProjection.getSandbox")(function* (id: SandboxId) {
  return (yield* getSandboxes([id])).get(id) ?? null;
});

/** Every sandbox not yet destroyed; the lifecycle worker and the reconciler sweep these. */
export const listLiveSandboxes = Effect.fn("SandboxProjection.listLiveSandboxes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_sandboxes
    WHERE state <> 'destroyed'
    ORDER BY sandbox_id ASC
  `;
  return yield* Effect.forEach(rows, (row) => decodeSandbox(row.payload_json));
});

/** 04 §4's "running" on one driver (as `isBilled` says), and how many there wait for admission. */
export const countAdmission = Effect.fn("SandboxProjection.countAdmission")(function* (
  driverId: ComputeDriverId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly running: number | null; readonly waiting: number | null }>`
    SELECT
      SUM(CASE WHEN admission_since IS NULL THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN admission_since IS NULL THEN 0 ELSE 1 END) AS waiting
    FROM orchestration_v2_projection_sandboxes
    WHERE driver_id = ${driverId} AND state IN ('provisioning', 'waking', 'ready')
  `;
  return { running: rows[0]?.running ?? 0, waiting: rows[0]?.waiting ?? 0 };
});

/** Settings → Cloud's machine counts; a machine waiting for admission counts as waiting only. */
export const countStates = Effect.fn("SandboxProjection.countStates")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly ready: number | null;
    readonly sleeping: number | null;
    readonly failed: number | null;
    readonly waiting: number | null;
  }>`
    SELECT
      SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN state = 'sleeping' THEN 1 ELSE 0 END) AS sleeping,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state IN ('provisioning', 'waking') AND admission_since IS NOT NULL
        THEN 1 ELSE 0 END) AS waiting
    FROM orchestration_v2_projection_sandboxes
  `;
  const row = rows[0];
  return {
    ready: row?.ready ?? 0,
    sleeping: row?.sleeping ?? 0,
    failed: row?.failed ?? 0,
    waiting: row?.waiting ?? 0,
  };
});

/** Live (not deleted) threads using the sandbox, oldest first: attached_at, then thread_id. */
export const listSandboxThreads = Effect.fn("SandboxProjection.listSandboxThreads")(function* (
  id: SandboxId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly attached_at: string;
    readonly archived: number;
  }>`
    SELECT thread_id, attached_at, archived
    FROM orchestration_v2_projection_sandbox_threads
    WHERE sandbox_id = ${id}
    ORDER BY attached_at ASC, thread_id ASC
  `;
  return rows.map((row): SandboxThreadRow => ({
    threadId: ThreadId.make(row.thread_id),
    attachedAt: DateTime.makeUnsafe(row.attached_at),
    archived: row.archived === 1,
  }));
});

/** Threads attached to a sandbox that is not destroyed. */
export const listLiveSandboxThreadIds = Effect.fn("SandboxProjection.listLiveSandboxThreadIds")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT st.thread_id
      FROM orchestration_v2_projection_sandbox_threads st
      JOIN orchestration_v2_projection_sandboxes s ON s.sandbox_id = st.sandbox_id
      WHERE s.state <> 'destroyed'
    `;
    return rows.map((row) => ThreadId.make(row.thread_id));
  },
);
