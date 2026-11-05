export type ThreadNotificationKind = "input" | "completion" | "message" | "assigned" | "archived";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** When the latest message a person wrote arrived, if one did. */
  readonly messageAt: number | null;
  /** The stored holder; null is the server owner. */
  readonly ownerId: string | null;
}

export function createThreadNotificationGate<
  Key,
  Observation extends ThreadNotificationObservation = ThreadNotificationObservation,
>(notify: (key: Key, kind: ThreadNotificationKind, observation: Observation) => void) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: Observation | undefined,
      next: Observation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.ownerId !== prior.ownerId) notify(key, "assigned", next);
      if (next.messageAt !== null && next.messageAt > (prior.messageAt ?? -Infinity)) {
        notify(key, "message", next);
      }
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input", next);
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion", next);
    },
    /** A thread left the snapshot because it was archived; one never seen stays silent. */
    archived(key: Key, prior: Observation | undefined): void {
      if (prior) notify(key, "archived", prior);
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}
