import { BOT_QUIET_AFTER_MS, type BotAsk, type BotJob, type BotSession } from "@t3tools/contracts";

import { relativeTime } from "../../lib/time";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVE_SESSION_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FAILED_SESSION_STATUSES = new Set(["failed", "rolled_back"]);
const STOPPED_SESSION_STATUSES = new Set(["interrupted", "cancelled"]);

export interface BotJobGroups {
  readonly inProgress: ReadonlyArray<BotJob>;
  readonly doneThisWeek: ReadonlyArray<BotJob>;
}

/** Newest job number first, so the Briefing reads J-15, J-14, J-13. */
function byNumberDesc(a: BotJob, b: BotJob): number {
  return b.number - a.number;
}

/** In progress, then done in the last week; stopped and older done jobs drop out. */
export function groupJobs(jobs: ReadonlyArray<BotJob>, nowMs: number = Date.now()): BotJobGroups {
  const inProgress: BotJob[] = [];
  const doneThisWeek: BotJob[] = [];
  for (const job of jobs) {
    if (job.status === "working") inProgress.push(job);
    else if (
      job.status === "done" &&
      job.finishedAt !== null &&
      nowMs - Date.parse(job.finishedAt) <= WEEK_MS
    ) {
      doneThisWeek.push(job);
    }
  }
  return {
    inProgress: inProgress.sort(byNumberDesc),
    doneThisWeek: doneThisWeek.sort(byNumberDesc),
  };
}

/** The bot's headline, or the placeholder until its first update. */
export function jobHeadline(job: BotJob, botName: string): string {
  const headline = job.headline.trim();
  return headline === "" ? `Waiting for ${botName}` : headline;
}

/** The avatar's initial: the first letter of the name, upper-cased. */
export function botInitial(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "?" : first.toUpperCase();
}

export type BotSessionStateKind =
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "paused"
  | "taken-over"
  | "quiet";

/** The shell facts a session's state is derived from; a slice of `EnvironmentThreadShell`. */
export interface BotSessionShell {
  readonly status: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly blockedOnThreadWait: boolean;
  readonly usageLimitResetAt: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface BotSessionState {
  readonly kind: BotSessionStateKind;
  /** The session's own line, e.g. `Upgrade web quiet 34m`. Empty when there is nothing to say. */
  readonly label: string;
  /** A state worth the warning colour: taken over, failed, paused or quiet. */
  readonly trouble: boolean;
}

/** Local time of day, e.g. `14:00`, for "paused until 14:00". */
export function timeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionState(kind: BotSessionStateKind, label: string, trouble: boolean): BotSessionState {
  return { kind, label, trouble };
}

/** One session's state from its thread shell; taken over wins over everything. */
export function botSessionState(input: {
  readonly session: BotSession;
  readonly shell: BotSessionShell | null;
  readonly botName: string;
  readonly nowMs: number;
}): BotSessionState {
  const { session, shell, botName, nowMs } = input;
  if (session.takenOver) return sessionState("taken-over", "You took over", true);
  if (shell === null) return sessionState("working", "", false);
  const resetAt = shell.usageLimitResetAt;
  if (resetAt !== null && Date.parse(resetAt) > nowMs) {
    return sessionState("paused", `${session.title} paused until ${timeOfDay(resetAt)}`, true);
  }
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.blockedOnThreadWait) {
    return sessionState("waiting", `Waiting on ${botName}`, false);
  }
  if (
    shell.lastError !== null ||
    (shell.status !== null && FAILED_SESSION_STATUSES.has(shell.status))
  ) {
    return sessionState("failed", `${session.title} failed`, true);
  }
  if (shell.status !== null && STOPPED_SESSION_STATUSES.has(shell.status)) {
    return sessionState("stopped", `${session.title} stopped`, true);
  }
  if (shell.status === null || ACTIVE_SESSION_STATUSES.has(shell.status)) {
    const updatedAt = Date.parse(shell.updatedAt);
    if (Number.isFinite(updatedAt) && nowMs - updatedAt >= BOT_QUIET_AFTER_MS) {
      return sessionState(
        "quiet",
        `${session.title} quiet ${relativeTime(shell.updatedAt, nowMs)}`,
        true,
      );
    }
    return sessionState("working", "", false);
  }
  return sessionState("done", "", false);
}

/** Worse states rank lower; the Briefing names the worst session when one is in trouble. */
const SESSION_SEVERITY: Readonly<Record<BotSessionStateKind, number>> = {
  "taken-over": 0,
  failed: 1,
  paused: 2,
  quiet: 3,
  stopped: 4,
  waiting: 5,
  working: 6,
  done: 7,
};

/** The state worth showing first: taken over, failed, paused, quiet, stopped, then the rest. */
export function worstSessionState(states: ReadonlyArray<BotSessionState>): BotSessionState | null {
  let worst: BotSessionState | null = null;
  for (const state of states) {
    if (worst === null || SESSION_SEVERITY[state.kind] < SESSION_SEVERITY[worst.kind]) {
      worst = state;
    }
  }
  return worst;
}

/** "2 of 3 sessions done", or the worst session when one is in trouble; null with no sessions. */
export function jobProgressLabel(states: ReadonlyArray<BotSessionState>): string | null {
  if (states.length === 0) return null;
  const worst = worstSessionState(states);
  if (worst !== null && worst.trouble) return worst.label;
  const done = states.filter((state) => state.kind === "done").length;
  return `${done} of ${states.length} sessions done`;
}

/** The bot's open Asks; "Needs you" on the Briefing and in the sidebar count. */
export function needsYouCount(asks: ReadonlyArray<BotAsk>): number {
  return asks.filter((ask) => ask.status === "open").length;
}

/** The header's muted summary, e.g. "5 jobs · 3 sessions working · 2 need you". */
export function botSummaryLine(input: {
  readonly jobCount: number;
  readonly sessionStates: ReadonlyArray<BotSessionState>;
  readonly needsYou: number;
}): string {
  const working = input.sessionStates.filter(
    (state) => state.kind === "working" || state.kind === "quiet",
  ).length;
  const parts = [`${input.jobCount} ${input.jobCount === 1 ? "job" : "jobs"}`];
  if (working > 0) parts.push(`${working} ${working === 1 ? "session" : "sessions"} working`);
  if (input.needsYou > 0) parts.push(`${input.needsYou} need you`);
  return parts.join(" · ");
}
