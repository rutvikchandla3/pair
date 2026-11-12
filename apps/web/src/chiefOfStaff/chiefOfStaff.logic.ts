import type {
  ChiefOfStaffCloseReason,
  ChiefOfStaffEvent,
  ChiefOfStaffSessionId,
  ChiefOfStaffSpeaker,
  ChiefOfStaffState,
  EnvironmentId,
} from "@t3tools/contracts";

/** `idle` before any session; `starting` while the microphone, peer and start RPC are set up. */
export type ChiefOfStaffPhase = "idle" | "starting" | ChiefOfStaffState;

interface ChiefOfStaffLine {
  readonly id: number;
  readonly role: ChiefOfStaffSpeaker;
  readonly text: string;
  readonly final: boolean;
}

export interface ChiefOfStaffWorkingItem {
  readonly id: string;
  readonly label: string;
  readonly status: "started" | "completed" | "failed";
}

export interface ChiefOfStaffView {
  readonly phase: ChiefOfStaffPhase;
  readonly environmentId: EnvironmentId | null;
  readonly sessionId: ChiefOfStaffSessionId | null;
  readonly lines: ReadonlyArray<ChiefOfStaffLine>;
  readonly working: ReadonlyArray<ChiefOfStaffWorkingItem>;
  readonly closeReason: ChiefOfStaffCloseReason | null;
  /** What ended the session, when the user should know: a failure, or another window taking over. */
  readonly message: string | null;
  readonly muted: boolean;
  readonly nextLineId: number;
}

export type ChiefOfStaffAction =
  | { readonly type: "start"; readonly environmentId: EnvironmentId }
  | { readonly type: "started"; readonly sessionId: ChiefOfStaffSessionId }
  | { readonly type: "event"; readonly event: ChiefOfStaffEvent }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "muted"; readonly muted: boolean }
  | { readonly type: "stopped" };

export const CHIEF_OF_STAFF_MAX_LINES = 6;
const CHIEF_OF_STAFF_MAX_WORKING = 4;

export const INITIAL_CHIEF_OF_STAFF_VIEW: ChiefOfStaffView = {
  phase: "idle",
  environmentId: null,
  sessionId: null,
  lines: [],
  working: [],
  closeReason: null,
  message: null,
  muted: false,
  nextLineId: 0,
};

const CLOSE_MESSAGES: Readonly<Record<ChiefOfStaffCloseReason, string | null>> = {
  stopped: null,
  replaced: "Chief of staff moved to another window.",
  ended: "The voice session ended.",
  failed: "The voice session failed.",
};

export function isChiefOfStaffLive(phase: ChiefOfStaffPhase): boolean {
  return phase !== "idle" && phase !== "closed";
}

export function reduceChiefOfStaff(
  view: ChiefOfStaffView,
  action: ChiefOfStaffAction,
): ChiefOfStaffView {
  switch (action.type) {
    case "start":
      if (isChiefOfStaffLive(view.phase)) return view;
      return {
        ...INITIAL_CHIEF_OF_STAFF_VIEW,
        phase: "starting",
        environmentId: action.environmentId,
        nextLineId: view.nextLineId,
      };
    case "started":
      return view.phase === "starting"
        ? { ...view, phase: "connecting", sessionId: action.sessionId }
        : view;
    case "failed":
      return isChiefOfStaffLive(view.phase)
        ? { ...view, phase: "closed", closeReason: "failed", message: action.message }
        : view;
    case "stopped":
      return isChiefOfStaffLive(view.phase)
        ? { ...view, phase: "closed", closeReason: "stopped", message: null }
        : view;
    case "muted":
      return isChiefOfStaffLive(view.phase) ? { ...view, muted: action.muted } : view;
    case "event":
      // Events belong to a session the start RPC already answered.
      return view.sessionId === null || !isChiefOfStaffLive(view.phase)
        ? view
        : applyEvent(view, action.event);
  }
}

function applyEvent(view: ChiefOfStaffView, event: ChiefOfStaffEvent): ChiefOfStaffView {
  switch (event._tag) {
    case "state":
      if (event.state !== "closed") return { ...view, phase: event.state };
      return {
        ...view,
        phase: "closed",
        closeReason: event.closeReason ?? "ended",
        message: event.message ?? CLOSE_MESSAGES[event.closeReason ?? "ended"],
      };
    case "transcript":
      return applyTranscript(view, event.role, event.text, event.final);
    case "working": {
      const item: ChiefOfStaffWorkingItem = {
        id: event.id,
        label: event.label,
        status: event.status,
      };
      const index = view.working.findIndex((candidate) => candidate.id === event.id);
      const working =
        index === -1
          ? [...view.working, item]
          : view.working.map((candidate, at) => (at === index ? item : candidate));
      return { ...view, working: working.slice(-CHIEF_OF_STAFF_MAX_WORKING) };
    }
  }
}

/** Deltas append to the role's open utterance; a final replaces it, or stands alone when none is open. */
function applyTranscript(
  view: ChiefOfStaffView,
  role: ChiefOfStaffSpeaker,
  text: string,
  final: boolean,
): ChiefOfStaffView {
  const openIndex = view.lines.findLastIndex((line) => line.role === role);
  const open = openIndex === -1 ? null : view.lines[openIndex]!;
  if (open !== null && !open.final) {
    const updated: ChiefOfStaffLine = { ...open, text: final ? text : open.text + text, final };
    if (final && updated.text.trim() === "") {
      return { ...view, lines: view.lines.filter((_, at) => at !== openIndex) };
    }
    return { ...view, lines: view.lines.map((line, at) => (at === openIndex ? updated : line)) };
  }
  if (text.trim() === "") return view;
  const line: ChiefOfStaffLine = { id: view.nextLineId, role, text, final };
  return {
    ...view,
    lines: [...view.lines, line].slice(-CHIEF_OF_STAFF_MAX_LINES),
    nextLineId: view.nextLineId + 1,
  };
}

const MICROPHONE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NotAllowedError:
    "Microphone access is blocked. Allow it for this app in your browser or system settings, then try again.",
  SecurityError:
    "Microphone access is blocked. Allow it for this app in your browser or system settings, then try again.",
  NotFoundError: "No microphone was found. Connect one and try again.",
  NotReadableError: "Another app is using the microphone. Close it and try again.",
  AbortError: "The microphone could not start. Try again.",
};

export const INSECURE_ORIGIN_MESSAGE =
  "Voice needs a secure page (HTTPS or localhost) to use the microphone. Open Pair over HTTPS or in the desktop app.";

export function microphoneErrorMessage(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  return MICROPHONE_ERROR_MESSAGES[name] ?? "The microphone could not start. Try again.";
}
