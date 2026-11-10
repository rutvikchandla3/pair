import { type MemberId, SandboxId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadAccess from "../../team/ThreadAccess.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import type { IdleInput } from "./SandboxDecisions.ts";

/** Clients renew every 5 minutes while a cloud thread is visible and focused (04 §2). */
const VIEWER_LEASE_MS = 6 * 60_000;
// A renewal is activity for the driver's whole idle window, so it outlives the lease.
const VIEWED_AT_RETENTION_MS = 24 * 60 * 60_000;

export class SandboxActivity extends Context.Service<
  SandboxActivity,
  {
    /**
     * Renews this thread's lease, held by `memberId` when a member's client asks; true when no
     * live lease covered it (2.2 wakes on that).
     */
    readonly view: (threadId: ThreadId, memberId?: MemberId) => Effect.Effect<boolean>;
    readonly read: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<IdleInput["activity"]>;
  }
>()("t3/sandbox/lifecycle/SandboxActivity") {}

interface Lease {
  readonly at: number;
  readonly sandboxId: SandboxId;
}

/**
 * In memory: after a restart the record and thread activity anchor the idle clock. A member's
 * lease counts only while `holds` says they can still open its machine, so one who is removed or
 * loses access stops keeping it awake.
 */
const makeLeases = (holds: (memberId: MemberId, sandboxId: SandboxId) => boolean) => {
  const leases = new Map<ThreadId, Map<MemberId | null, Lease>>();
  const latest = (threadId: ThreadId) => {
    let at: number | null = null;
    for (const [memberId, lease] of leases.get(threadId) ?? []) {
      if (memberId !== null && !holds(memberId, lease.sandboxId)) continue;
      if (at === null || lease.at > at) at = lease.at;
    }
    return at;
  };
  return {
    renew: (threadId: ThreadId, sandboxId: SandboxId, memberId: MemberId | null) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => {
        const previous = latest(threadId);
        const held = leases.get(threadId) ?? new Map<MemberId | null, Lease>();
        leases.set(threadId, held.set(memberId, { at: nowMs, sandboxId }));
        return previous === null || nowMs - previous >= VIEWER_LEASE_MS;
      }),
    viewedAt: (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => {
        for (const [threadId, held] of leases) {
          for (const [memberId, lease] of held) {
            if (
              nowMs - lease.at >= VIEWED_AT_RETENTION_MS ||
              (memberId !== null && !holds(memberId, lease.sandboxId))
            ) {
              held.delete(memberId);
            }
          }
          if (held.size === 0) leases.delete(threadId);
        }
        let viewed: number | null = null;
        for (const threadId of threadIds) {
          const at = latest(threadId);
          if (at !== null && (viewed === null || at > viewed)) viewed = at;
        }
        return viewed;
      }),
  };
};

export const layer = Layer.effect(
  SandboxActivity,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const terminals = yield* TerminalManager.TerminalManager;
    const sql = yield* SqlClient.SqlClient;
    const access = yield* ThreadAccess.ThreadAccess;
    const leases = makeLeases(
      (memberId, sandboxId) => !access.enforced || access.allowsSandbox(memberId, sandboxId),
    );

    const nextScheduledAt = Effect.fn("SandboxActivity.nextScheduledAt")(function* (
      threadIds: ReadonlyArray<ThreadId>,
    ) {
      if (threadIds.length === 0) return null;
      // Read directly: ScheduledTaskService is built inside the orchestration runtime.
      const rows = yield* sql<{ readonly nextRunAt: string }>`
        SELECT next_run_at AS "nextRunAt"
        FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND thread_id IN ${sql.in(threadIds)}
      `;
      const times = rows.map((row) => Date.parse(row.nextRunAt)).filter(Number.isFinite);
      return times.length === 0 ? null : Math.min(...times);
    });

    return SandboxActivity.of({
      view: Effect.fn("SandboxActivity.view")(function* (threadId, memberId) {
        const shell = yield* projections
          .getThreadShell(threadId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not read a viewed thread", { threadId, error }).pipe(
                Effect.as(null),
              ),
            ),
          );
        if (shell?.sandboxId === undefined) return false;
        return yield* leases.renew(threadId, shell.sandboxId, memberId ?? null);
      }),
      read: Effect.fn("SandboxActivity.read")(function* (threadIds) {
        return {
          viewedAt: yield* leases.viewedAt(threadIds),
          terminalAt: yield* terminals.lastActivityAt(threadIds),
          nextScheduledAt: yield* nextScheduledAt(threadIds).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not read scheduled runs for idle sleep", { error }).pipe(
                Effect.as(null),
              ),
            ),
          ),
        };
      }),
    });
  }),
);

const TEST_SANDBOX_ID = SandboxId.make("sbx_00000000000000000000");

/** Real leases over the test clock; terminal and schedule activity come from these refs. */
export const makeTest = Effect.gen(function* () {
  const terminalAt = yield* Ref.make<number | null>(null);
  const nextScheduledAt = yield* Ref.make<number | null>(null);
  const leases = makeLeases(() => true);
  const service = SandboxActivity.of({
    view: Effect.fn("SandboxActivityTest.view")(function* (threadId) {
      return yield* leases.renew(threadId, TEST_SANDBOX_ID, null);
    }),
    read: Effect.fn("SandboxActivityTest.read")(function* (threadIds) {
      return {
        viewedAt: yield* leases.viewedAt(threadIds),
        terminalAt: yield* Ref.get(terminalAt),
        nextScheduledAt: yield* Ref.get(nextScheduledAt),
      };
    }),
  });
  return { service, terminalAt, nextScheduledAt };
});
