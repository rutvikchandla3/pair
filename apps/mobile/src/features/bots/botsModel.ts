import {
  BOT_QUIET_AFTER_MS,
  type Bot,
  type BotAsk,
  type BotJob,
  botJobFinished,
  type BotSession,
} from "@t3tools/contracts";

import { relativeTime } from "../../lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_SESSION_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FAILED_SESSION_STATUSES = new Set(["failed", "rolled_back"]);
const STOPPED_SESSION_STATUSES = new Set(["interrupted", "cancelled"]);

export type BotSessionStateKind =
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "paused"
  | "taken-over"
  | "quiet"
  | "unreachable";

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
  /** The shell's last update, for a finished row's relative time. Null without a shell. */
  readonly updatedAt: string | null;
}

/** Local time of day, e.g. `14:00`, for "paused until 14:00". */
export function timeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionState(
  kind: BotSessionStateKind,
  label: string,
  trouble: boolean,
  updatedAt: string | null,
): BotSessionState {
  return { kind, label, trouble, updatedAt };
}

function cloudSessionState(
  session: BotSession,
  cloud: NonNullable<BotSession["cloud"]>,
  botName: string,
  nowMs: number,
): BotSessionState {
  const at = cloud.lastOutputAt;
  switch (cloud.state) {
    case "unreachable":
      return sessionState("unreachable", `Can't reach ${cloud.label}`, true, at);
    case "waiting":
      return sessionState("waiting", `Waiting on ${botName}`, false, at);
    case "failed":
      return sessionState("failed", `${session.title} failed`, true, at);
    case "stopped":
      return sessionState("stopped", `${session.title} stopped`, true, at);
    case "done":
      return sessionState("done", "", false, at);
    case "working": {
      const updatedAt = Date.parse(at);
      if (Number.isFinite(updatedAt) && nowMs - updatedAt >= BOT_QUIET_AFTER_MS) {
        return sessionState("quiet", `${session.title} quiet ${relativeTime(at, nowMs)}`, true, at);
      }
      return sessionState("working", "", false, at);
    }
  }
}

/**
 * One session's state. A finished job's state wins, since an archived session thread has no shell;
 * otherwise it comes from the shell, and taken over wins over everything.
 */
export function botSessionState(input: {
  readonly session: BotSession;
  readonly job: BotJob | undefined;
  readonly shell: BotSessionShell | null;
  readonly botName: string;
  readonly nowMs: number;
}): BotSessionState {
  const { session, job, shell, botName, nowMs } = input;
  if (job?.status === "done") {
    const at = shell?.updatedAt ?? session.cloud?.lastOutputAt ?? job.finishedAt;
    return sessionState("done", "", false, at);
  }
  if (job?.status === "stopped") {
    return sessionState(
      "stopped",
      `${session.title} stopped`,
      true,
      shell?.updatedAt ?? job.finishedAt,
    );
  }
  if (session.takenOver) return sessionState("taken-over", "You took over", true, null);
  // A cloud session's shell is on the cloud; without it, the bot's server's last read stands.
  if (shell === null && session.cloud !== undefined) {
    return cloudSessionState(session, session.cloud, botName, nowMs);
  }
  if (shell === null) return sessionState("working", "", false, null);
  const resetAt = shell.usageLimitResetAt;
  if (resetAt !== null && Date.parse(resetAt) > nowMs) {
    return sessionState(
      "paused",
      `${session.title} paused until ${timeOfDay(resetAt)}`,
      true,
      shell.updatedAt,
    );
  }
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.blockedOnThreadWait) {
    return sessionState("waiting", `Waiting on ${botName}`, false, shell.updatedAt);
  }
  if (
    shell.lastError !== null ||
    (shell.status !== null && FAILED_SESSION_STATUSES.has(shell.status))
  ) {
    return sessionState("failed", `${session.title} failed`, true, shell.updatedAt);
  }
  if (shell.status !== null && STOPPED_SESSION_STATUSES.has(shell.status)) {
    return sessionState("stopped", `${session.title} stopped`, true, shell.updatedAt);
  }
  if (shell.status === null || ACTIVE_SESSION_STATUSES.has(shell.status)) {
    const updatedAt = Date.parse(shell.updatedAt);
    if (Number.isFinite(updatedAt) && nowMs - updatedAt >= BOT_QUIET_AFTER_MS) {
      return sessionState(
        "quiet",
        `${session.title} quiet ${relativeTime(shell.updatedAt, nowMs)}`,
        true,
        shell.updatedAt,
      );
    }
    return sessionState("working", "", false, shell.updatedAt);
  }
  return sessionState("done", "", false, shell.updatedAt);
}

/** The bot's open Asks; the row's count pill and the status line read it. */
export function needsYouCount(asks: ReadonlyArray<BotAsk>): number {
  return asks.filter((ask) => ask.status === "open").length;
}

/** `idle` is "Nothing running": the list shows the bot's role there instead, when it has one. */
export type BotStatusTone = "input" | "muted" | "paused" | "idle";

export interface BotStatusLine {
  readonly text: string;
  readonly tone: BotStatusTone;
}

/** A session the bot is working on: not finished, failed, stopped or unreachable. */
function isWorkingState(state: BotSessionState): boolean {
  return (
    state.kind !== "done" &&
    state.kind !== "failed" &&
    state.kind !== "stopped" &&
    state.kind !== "unreachable"
  );
}

/** The newest session of the ask's job, else the job's title; null when the ask names neither. */
function askSubject(
  ask: BotAsk,
  jobs: ReadonlyArray<BotJob>,
  sessions: ReadonlyArray<BotSession>,
): string | null {
  if (ask.jobId === null) return null;
  let newest: BotSession | null = null;
  for (const session of sessions) {
    if (session.jobId !== ask.jobId) continue;
    if (newest === null || Date.parse(session.createdAt) > Date.parse(newest.createdAt)) {
      newest = session;
    }
  }
  if (newest !== null) return newest.title;
  return jobs.find((job) => job.id === ask.jobId)?.title ?? null;
}

/** The bot row's one status line: a question that needs you, work in progress, or nothing. */
export function botStatusLine(input: {
  readonly bot: Pick<Bot, "paused">;
  readonly asks: ReadonlyArray<BotAsk>;
  readonly jobs: ReadonlyArray<BotJob>;
  readonly sessions: ReadonlyArray<BotSession>;
  readonly sessionStates: ReadonlyArray<BotSessionState>;
}): BotStatusLine {
  if (input.bot.paused) return { text: "Paused", tone: "paused" };
  const open = input.asks.filter((ask) => ask.status === "open");
  if (open.length === 1) {
    const subject = askSubject(open[0]!, input.jobs, input.sessions);
    return subject === null
      ? { text: "1 question for you", tone: "input" }
      : { text: `${subject} needs you`, tone: "input" };
  }
  if (open.length > 1) return { text: `${open.length} questions for you`, tone: "input" };
  const working = input.sessionStates.filter(isWorkingState).length;
  const unreachable = input.sessionStates.filter((state) => state.kind === "unreachable").length;
  if (working > 0 || unreachable > 0) {
    const parts = [
      ...(working === 0 ? [] : [`${working} ${working === 1 ? "session" : "sessions"} working`]),
      ...(unreachable === 0 ? [] : [`${unreachable} can't be reached`]),
    ];
    return { text: parts.join(" · "), tone: "muted" };
  }
  return { text: "Nothing running", tone: "idle" };
}

/** Needs you, then failed sessions, then the bot's running work, then the last day's finished. */
export type BotSessionBucket = "needs-you" | "working" | "offline" | "failed" | "finished";

const BUCKET_RANK: Readonly<Record<BotSessionBucket, number>> = {
  "needs-you": 0,
  failed: 1,
  working: 2,
  // Not finished, and it may well still be running there.
  offline: 2,
  finished: 3,
};

export interface BotSessionRow {
  readonly session: BotSession;
  readonly state: BotSessionState;
  readonly bucket: BotSessionBucket;
  /** The session's job is done or stopped, so the row offers Archive job. */
  readonly jobFinished: boolean;
}

export interface BotSessionRows {
  /** Needs you, failed, working, then finished in the last day, newest first. */
  readonly rows: ReadonlyArray<BotSessionRow>;
  /** Finished longer ago than a day, newest first; behind "N earlier". */
  readonly earlier: ReadonlyArray<BotSessionRow>;
  /** Sessions of archived jobs; after the earlier ones, behind the same disclosure. */
  readonly archived: ReadonlyArray<BotSessionRow>;
}

function sessionBucket(hasOpenAsk: boolean, state: BotSessionState): BotSessionBucket {
  if (state.kind === "done") return "finished";
  if (hasOpenAsk) return "needs-you";
  if (state.kind === "failed" || state.kind === "stopped") return "failed";
  if (state.kind === "unreachable") return "offline";
  return "working";
}

function finishedInLastDay(row: BotSessionRow, nowMs: number): boolean {
  const updatedAt = row.state.updatedAt === null ? Number.NaN : Date.parse(row.state.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= DAY_MS;
}

/** The sessions nested under a bot, ordered, with older finished and archived rows set apart. */
export function botSessionRows(input: {
  readonly sessions: ReadonlyArray<BotSession>;
  readonly states: ReadonlyArray<BotSessionState>;
  readonly jobs: ReadonlyArray<BotJob>;
  readonly asks: ReadonlyArray<BotAsk>;
  readonly nowMs: number;
}): BotSessionRows {
  const jobs = new Map(input.jobs.map((job) => [job.id, job]));
  const listed: BotSessionRow[] = [];
  const archived: BotSessionRow[] = [];
  input.sessions.forEach((session, index) => {
    const state = input.states[index];
    if (state === undefined) return;
    const job = jobs.get(session.jobId);
    const hasOpenAsk = input.asks.some(
      (ask) => ask.status === "open" && ask.jobId === session.jobId,
    );
    const row: BotSessionRow = {
      session,
      state,
      bucket: sessionBucket(hasOpenAsk, state),
      jobFinished: job !== undefined && botJobFinished(job),
    };
    // A question on an archived job keeps it in the list.
    if (job !== undefined && job.archivedAt !== null && !hasOpenAsk) archived.push(row);
    else listed.push(row);
  });
  const ordered = listed.sort((left, right) => {
    const rank = BUCKET_RANK[left.bucket] - BUCKET_RANK[right.bucket];
    if (rank !== 0) return rank;
    if (left.bucket !== "finished") return 0;
    return (right.state.updatedAt ?? "").localeCompare(left.state.updatedAt ?? "");
  });
  return {
    rows: ordered.filter((row) => row.bucket !== "finished" || finishedInLastDay(row, input.nowMs)),
    earlier: ordered.filter(
      (row) => row.bucket === "finished" && !finishedInLastDay(row, input.nowMs),
    ),
    archived: archived.sort((left, right) =>
      right.session.createdAt.localeCompare(left.session.createdAt),
    ),
  };
}
