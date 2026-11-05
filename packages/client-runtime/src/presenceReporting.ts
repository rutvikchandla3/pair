import {
  PRESENCE_IDLE_AFTER_MS,
  PRESENCE_TYPING_REFRESH_MS,
  PRESENCE_TYPING_TTL_MS,
  type PresenceReportInput,
  type ThreadId,
} from "@t3tools/contracts";

/** What one connection has told, or would tell, the server about itself. */
export interface PresenceReporterState {
  /** Another member is connected. Nothing is reported while this is false. */
  readonly others: boolean;
  readonly viewingThreadId: ThreadId | null;
  readonly idle: boolean;
  /** When `typing: true` was last sent, or null when the server holds no typing for us. */
  readonly typingSentAt: number | null;
}

export const INITIAL_PRESENCE_REPORTER: PresenceReporterState = {
  others: false,
  viewingThreadId: null,
  idle: false,
  typingSentAt: null,
};

export type PresenceReporterSignal =
  | { readonly type: "others"; readonly others: boolean }
  | { readonly type: "viewing"; readonly threadId: ThreadId | null }
  /** Input after an idle check went idle. */
  | { readonly type: "input" }
  | { readonly type: "idleCheck"; readonly lastInputAt: number }
  | { readonly type: "keystroke"; readonly threadId: ThreadId }
  | { readonly type: "sent" };

export interface PresenceReporterStep {
  readonly state: PresenceReporterState;
  readonly report?: PresenceReportInput;
}

/** Cheap enough for every keystroke: whether `keystroke` would report anything. */
export function shouldReportKeystroke(
  state: PresenceReporterState,
  threadId: ThreadId,
  now: number,
): boolean {
  return (
    state.others &&
    state.viewingThreadId === threadId &&
    (state.typingSentAt === null || now - state.typingSentAt >= PRESENCE_TYPING_REFRESH_MS)
  );
}

export function isPresenceIdle(lastInputAt: number, now: number): boolean {
  return now - lastInputAt >= PRESENCE_IDLE_AFTER_MS;
}

const reportWhenOthers = (
  state: PresenceReporterState,
  report: PresenceReportInput,
): PresenceReporterStep => (state.others ? { state, report } : { state });

export function stepPresenceReporter(
  state: PresenceReporterState,
  signal: PresenceReporterSignal,
  now: number,
): PresenceReporterStep {
  switch (signal.type) {
    case "others": {
      if (signal.others === state.others) return { state };
      // The server resets a member who is left alone, typing included.
      const next = { ...state, others: signal.others, typingSentAt: null };
      return signal.others
        ? { state: next, report: { viewingThreadId: next.viewingThreadId, idle: next.idle } }
        : { state: next };
    }
    case "viewing": {
      if (signal.threadId === state.viewingThreadId) return { state };
      // The server clears typing when the viewed thread changes.
      const next = { ...state, viewingThreadId: signal.threadId, typingSentAt: null };
      return reportWhenOthers(next, { viewingThreadId: signal.threadId });
    }
    case "input":
      return state.idle ? reportWhenOthers({ ...state, idle: false }, { idle: false }) : { state };
    case "idleCheck":
      return !state.idle && isPresenceIdle(signal.lastInputAt, now)
        ? reportWhenOthers({ ...state, idle: true }, { idle: true })
        : { state };
    case "keystroke":
      return shouldReportKeystroke(state, signal.threadId, now)
        ? { state: { ...state, typingSentAt: now }, report: { typing: true } }
        : { state };
    case "sent": {
      if (state.typingSentAt === null) return { state };
      const next = { ...state, typingSentAt: null };
      // Past the TTL the server has already let it expire.
      return now - state.typingSentAt < PRESENCE_TYPING_TTL_MS
        ? reportWhenOthers(next, { typing: false })
        : { state: next };
    }
  }
}
