import type { ThreadId } from "@t3tools/contracts";

/** Under the server's 6-minute lease, so one late tick does not let it lapse. */
const VIEWER_LEASE_RENEW_MS = 5 * 60_000;

/** When each thread's lease was last sent from this client. */
export type ViewerLeaseState = ReadonlyMap<ThreadId, number>;

export const INITIAL_VIEWER_LEASE: ViewerLeaseState = new Map();

/** Whether the viewed thread's machine needs a `sandbox.viewing` renewal now. */
export function stepViewerLease(
  state: ViewerLeaseState,
  input: {
    readonly threadId: ThreadId;
    readonly cloud: boolean;
    readonly visible: boolean;
    readonly focused: boolean;
    readonly nowMs: number;
  },
): { readonly state: ViewerLeaseState; readonly send: ThreadId | null } {
  if (!input.cloud || !input.visible || !input.focused) return { state, send: null };
  const sentAt = state.get(input.threadId);
  if (sentAt !== undefined && input.nowMs - sentAt < VIEWER_LEASE_RENEW_MS) {
    return { state, send: null };
  }
  const next = new Map<ThreadId, number>();
  for (const [threadId, at] of state) {
    if (input.nowMs - at < VIEWER_LEASE_RENEW_MS) next.set(threadId, at);
  }
  next.set(input.threadId, input.nowMs);
  return { state: next, send: input.threadId };
}
