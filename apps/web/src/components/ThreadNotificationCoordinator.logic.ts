import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

export type ThreadNotificationKind = "input" | "completion" | "message" | "assigned" | "archived";

export interface ThreadNotificationObservation {
  /** Status and request key, or status and run without a request, while the thread needs attention. */
  readonly attention: string | null;
  /** The pending request's id, when it has one; null whenever attention is. */
  readonly requestId: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** When the latest message a person wrote arrived, if one did. */
  readonly messageAt: number | null;
  /** The stored holder; null is the server owner. */
  readonly ownerId: string | null;
  /** The latest run answers a background-work progress wake, like a Monitor line. */
  readonly backgroundWake: boolean;
}

/** Matches the push relay's completion confirmation: a final wake can start right after a progress wake. */
export const RELEASED_COMPLETION_GRACE_MS = 5_000;

/**
 * Whether completion notifications are suppressed by snooze. A completion that landed
 * during the snooze stays suppressed even when its update is processed after the wake.
 */
export function isSnoozedForNotification(
  thread: ThreadSnoozeShell,
  completedAt: number | null,
  now: number,
): boolean {
  if (effectiveSnoozed(thread, { now: new Date(now).toISOString() })) return true;
  if (completedAt === null) return false;
  if (thread.snoozedAt != null && completedAt < Date.parse(thread.snoozedAt)) return false;
  return effectiveSnoozed(thread, { now: new Date(completedAt).toISOString() });
}

export function createThreadNotificationGate<
  Key,
  Observation extends ThreadNotificationObservation = ThreadNotificationObservation,
>(notify: (key: Key, kind: ThreadNotificationKind, observation: Observation) => void) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // Wake completions waiting out the grace, by completion time; no timer while paused.
  const releases = new Map<
    Key,
    {
      readonly at: number;
      readonly observation: Observation;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  const release = (key: Key, at: number, observation: Observation) => {
    const timer = setTimeout(() => {
      releases.delete(key);
      handled.set(key, at);
      notify(key, "completion", observation);
    }, RELEASED_COMPLETION_GRACE_MS);
    releases.set(key, { at, observation, timer });
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  const cancel = (key: Key) => {
    clearTimeout(releases.get(key)?.timer);
    releases.delete(key);
  };
  // Attention keys with a request id seen since the thread last stopped needing attention.
  const attended = new Map<Key, Set<string>>();
  const attend = (
    key: Key,
    prior: ThreadNotificationObservation | undefined,
    next: ThreadNotificationObservation,
  ): boolean => {
    if (next.attention === null) {
      attended.delete(key);
      return false;
    }
    if (next.requestId === null) return next.attention !== prior?.attention;
    const seen = attended.get(key);
    if (seen?.has(next.attention)) return false;
    if (seen) seen.add(next.attention);
    else attended.set(key, new Set([next.attention]));
    return true;
  };
  return {
    observe(
      key: Key,
      prior: Observation | undefined,
      next: Observation,
      options: { readonly archived: boolean; readonly quiet: boolean; readonly snoozed: boolean },
    ): void {
      // The grace survives updates that keep the wake's completion; anything else cancels it.
      const pending = releases.get(key);
      const silenced = options.archived || options.quiet || options.snoozed;
      if (pending?.at === next.completedAt && !silenced) {
        if (pending.timer === undefined) release(key, pending.at, next);
        return;
      }
      cancel(key);
      // The first sighting, archived or snoozed threads, and stopped or silent runs never notify completion.
      if (!prior || silenced) skip(key, next.completedAt);
      const fresh = attend(key, prior, next);
      if (!prior || options.archived) return;
      if (next.ownerId !== prior.ownerId) notify(key, "assigned", next);
      if (next.messageAt !== null && next.messageAt > (prior.messageAt ?? -Infinity)) {
        notify(key, "message", next);
      }
      if (fresh) {
        notify(key, "input", next);
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (next.backgroundWake) {
        release(key, at, next);
        return;
      }
      handled.set(key, at);
      notify(key, "completion", next);
    },
    /** A thread left the snapshot because it was archived; one never seen stays silent. */
    archived(key: Key, prior: Observation | undefined): void {
      if (prior) notify(key, "archived", prior);
    },
    /** Stops grace timers while the snapshot is stale; the next observation restarts or drops them. */
    pause(): void {
      for (const [key, { at, observation, timer }] of releases) {
        clearTimeout(timer);
        releases.set(key, { at, observation, timer: undefined });
      }
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of releases.keys()) if (!keys.has(key)) cancel(key);
      for (const key of attended.keys()) if (!keys.has(key)) attended.delete(key);
    },
    clear(): void {
      for (const key of releases.keys()) cancel(key);
      handled.clear();
      attended.clear();
    },
  };
}
