import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import type { IdleInput } from "./SandboxDecisions.ts";

/** Clients renew every 5 minutes while a cloud thread is visible and focused (04 §2). */
const VIEWER_LEASE_MS = 6 * 60_000;
// A renewal is activity for the driver's whole idle window, so it outlives the lease.
const VIEWED_AT_RETENTION_MS = 24 * 60 * 60_000;

export class SandboxActivity extends Context.Service<
  SandboxActivity,
  {
    /** Renews this thread's lease; true when no live lease covered it (2.2 wakes on that). */
    readonly view: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly read: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<IdleInput["activity"]>;
  }
>()("t3/sandbox/lifecycle/SandboxActivity") {}

/** In memory: after a restart the record and thread activity anchor the idle clock. */
const makeLeases = () => {
  const renewedAt = new Map<ThreadId, number>();
  return {
    renew: (threadId: ThreadId) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => {
        const previous = renewedAt.get(threadId);
        renewedAt.set(threadId, nowMs);
        return previous === undefined || nowMs - previous >= VIEWER_LEASE_MS;
      }),
    viewedAt: (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => {
        for (const [threadId, at] of renewedAt) {
          if (nowMs - at >= VIEWED_AT_RETENTION_MS) renewedAt.delete(threadId);
        }
        let latest: number | null = null;
        for (const threadId of threadIds) {
          const at = renewedAt.get(threadId);
          if (at !== undefined && (latest === null || at > latest)) latest = at;
        }
        return latest;
      }),
  };
};

export const layer = Layer.effect(
  SandboxActivity,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const terminals = yield* TerminalManager.TerminalManager;
    const sql = yield* SqlClient.SqlClient;
    const leases = makeLeases();

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
      view: Effect.fn("SandboxActivity.view")(function* (threadId) {
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
        return yield* leases.renew(threadId);
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

/** Real leases over the test clock; terminal and schedule activity come from these refs. */
export const makeTest = Effect.gen(function* () {
  const terminalAt = yield* Ref.make<number | null>(null);
  const nextScheduledAt = yield* Ref.make<number | null>(null);
  const leases = makeLeases();
  const service = SandboxActivity.of({
    view: leases.renew,
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
