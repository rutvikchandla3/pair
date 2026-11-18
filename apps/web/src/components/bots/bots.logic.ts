import {
  BOT_ESCALATE_AFTER_MS,
  BOT_EVENTS_PER_BOT,
  BOT_QUIET_AFTER_MS,
  type Bot,
  type BotAsk,
  type BotEvent,
  type BotJob,
  type BotSession,
  type BotsSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Live state of one bot session, derived from its thread shell. */
export type BotSessionStateKind =
  | "working"
  | "quiet"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "paused-until"
  | "taken-over";

export interface BotSessionState {
  readonly kind: BotSessionStateKind;
  /** Quiet: no new output for this many milliseconds. */
  readonly quietMs?: number;
  /** Paused: when the usage limit lifts. */
  readonly until?: string;
}

export type ShellLookup = ReadonlyMap<string, EnvironmentThreadShell | null> | undefined;

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STOPPED_STATUSES = new Set(["interrupted", "cancelled", "rolled_back"]);

function shellFor(
  shells: ShellLookup,
  threadId: ThreadId,
): EnvironmentThreadShell | null | undefined {
  return shells?.get(threadId);
}

/**
 * The session's live state. `shell` is the ordinary thread shell the client already holds; a
 * missing shell means the thread has not loaded yet, which reads as working.
 */
export function sessionState(
  session: BotSession,
  shell: EnvironmentThreadShell | null | undefined,
  now: number = Date.now(),
): BotSessionState {
  if (session.takenOver) return { kind: "taken-over" };
  if (shell === null || shell === undefined) return { kind: "working" };
  if (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    (shell.pendingSubagentRequest !== undefined && shell.pendingSubagentRequest !== null) ||
    shell.blockedOnThreadWait === true
  ) {
    return { kind: "waiting" };
  }
  const runtime = shell.runtime;
  if (runtime !== null && runtime !== undefined) {
    if (runtime.status === "failed") {
      if (runtime.lastErrorClass === "usage_limit" && runtime.usageLimitResetAt) {
        return { kind: "paused-until", until: runtime.usageLimitResetAt };
      }
      return { kind: "failed" };
    }
    if (WORKING_STATUSES.has(runtime.status)) {
      const updatedAt = Date.parse(shell.updatedAt);
      const quietMs = Number.isFinite(updatedAt) ? now - updatedAt : 0;
      if (quietMs >= BOT_QUIET_AFTER_MS) return { kind: "quiet", quietMs };
      return { kind: "working" };
    }
    if (runtime.status === "idle" || runtime.status === "completed") return { kind: "done" };
    if (STOPPED_STATUSES.has(runtime.status)) return { kind: "stopped" };
  }
  const latestRun = shell.latestRun;
  if (latestRun !== null && latestRun.status === "completed") return { kind: "done" };
  if (latestRun !== null && STOPPED_STATUSES.has(latestRun.status)) return { kind: "stopped" };
  return { kind: "working" };
}

export interface JobProgress {
  readonly label: string;
  /** True when the label names a session in trouble and should be shown in the warning colour. */
  readonly warning: boolean;
}

export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Minutes a quiet session has been silent, at least 1. */
export function quietMinutes(quietMs: number): number {
  return Math.max(1, Math.floor(quietMs / 60_000));
}

function troubleLabel(session: BotSession, state: BotSessionState): string | null {
  switch (state.kind) {
    case "taken-over":
      return "You took over";
    case "failed":
      return `${session.title} failed`;
    case "paused-until":
      return `${session.title} paused until ${formatClockTime(state.until ?? "")}`;
    case "quiet":
      return `${session.title} quiet ${quietMinutes(state.quietMs ?? 0)}m`;
    default:
      return null;
  }
}

/** Worst-first: taken over, then failed, paused, quiet. */
const TROUBLE_ORDER: ReadonlyArray<BotSessionStateKind> = [
  "taken-over",
  "failed",
  "paused-until",
  "quiet",
];

/**
 * The job row's progress label. Normally "n of m sessions done"; when a session is in trouble,
 * it names the worst one instead, in the warning colour.
 */
export function jobProgress(
  job: BotJob,
  sessions: ReadonlyArray<BotSession>,
  shells: ShellLookup,
  now: number = Date.now(),
): JobProgress {
  const jobSessions = sessions.filter((session) => session.jobId === job.id);
  if (jobSessions.length === 0) return { label: "No sessions yet", warning: false };
  const states = jobSessions.map((session) => ({
    session,
    state: sessionState(session, shellFor(shells, session.threadId), now),
  }));
  for (const kind of TROUBLE_ORDER) {
    const match = states.find((entry) => entry.state.kind === kind);
    if (match === undefined) continue;
    const label = troubleLabel(match.session, match.state);
    if (label !== null) return { label, warning: true };
  }
  const done = states.filter((entry) => entry.state.kind === "done").length;
  return { label: `${done} of ${jobSessions.length} sessions done`, warning: false };
}

/** The bot's jobs, newest number first. */
export function botJobs(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotJob> {
  return snapshot.jobs
    .filter((job) => job.botId === botId)
    .sort((left, right) => right.number - left.number);
}

/** The bot's sessions. */
export function botSessions(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotSession> {
  return snapshot.sessions.filter((session) => session.botId === botId);
}

/** A bot's open asks: what needs you on its Briefing and in the sidebar. */
export function openAsks(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotAsk> {
  return snapshot.asks.filter((ask) => ask.botId === botId && ask.status === "open");
}

/** Answered asks, newest first. */
export function answeredAsks(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotAsk> {
  return snapshot.asks
    .filter((ask) => ask.botId === botId && ask.status === "answered")
    .sort((left, right) =>
      compareIso(right.answeredAt ?? right.createdAt, left.answeredAt ?? left.createdAt),
    );
}

/**
 * A session waiting on the bot for longer than the escalate window, which the Briefing and the
 * sidebar count as needing you. `shell.updatedAt` stands in for when the request was raised.
 */
export function escalatedSession(
  session: BotSession,
  shell: EnvironmentThreadShell | null | undefined,
  now: number,
): boolean {
  if (shell === null || shell === undefined) return false;
  if (sessionState(session, shell, now).kind !== "waiting") return false;
  const updatedAt = Date.parse(shell.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt >= BOT_ESCALATE_AFTER_MS;
}

/** The bot's sessions whose unanswered request has waited past the escalate window. */
export function escalatedSessions(
  snapshot: BotsSnapshot,
  botId: string,
  shells: ShellLookup,
  now: number = Date.now(),
): ReadonlyArray<BotSession> {
  return botSessions(snapshot, botId).filter((session) =>
    escalatedSession(session, shellFor(shells, session.threadId), now),
  );
}

/** Open asks plus escalated session requests: what needs you on the Briefing. */
export function needsYouCount(
  snapshot: BotsSnapshot,
  botId: string,
  shells?: ShellLookup,
  now: number = Date.now(),
): number {
  return openAsks(snapshot, botId).length + escalatedSessions(snapshot, botId, shells, now).length;
}

export interface BotSummary {
  readonly jobs: number;
  readonly sessionsWorking: number;
  readonly needYou: number;
  readonly label: string;
}

/** "5 jobs · 3 sessions working · 2 need you", always equal to the Briefing rows below it. */
export function botSummary(
  snapshot: BotsSnapshot,
  botId: string,
  shells: ShellLookup,
  now: number = Date.now(),
): BotSummary {
  const jobs = botJobs(snapshot, botId);
  const sessions = botSessions(snapshot, botId);
  const sessionsWorking = sessions.filter((session) => {
    const state = sessionState(session, shellFor(shells, session.threadId), now);
    return state.kind === "working" || state.kind === "quiet";
  }).length;
  const needYou = needsYouCount(snapshot, botId, shells, now);
  if (jobs.length === 0) {
    return { jobs: 0, sessionsWorking, needYou, label: "No jobs yet" };
  }
  const label = `${jobs.length} ${plural(jobs.length, "job", "jobs")} · ${sessionsWorking} ${plural(sessionsWorking, "session", "sessions")} working · ${needYou} need you`;
  return { jobs: jobs.length, sessionsWorking, needYou, label };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function compareIso(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}

/** Decision events newer than the visit mark; newest first. */
export function decisionsSince(
  events: ReadonlyArray<BotEvent>,
  lastSeenAt: string | null,
): ReadonlyArray<BotEvent> {
  return events
    .filter(
      (event) =>
        event.kind === "decision" &&
        (lastSeenAt === null || compareIso(event.createdAt, lastSeenAt) > 0),
    )
    .sort((left, right) => compareIso(right.createdAt, left.createdAt));
}

/** Whether the headline moved since the visit mark, for the row's dot. */
export function headlineChanged(job: BotJob, lastSeenAt: string | null): boolean {
  if (job.headlineAt === null) return false;
  if (lastSeenAt === null) return true;
  return compareIso(job.headlineAt, lastSeenAt) > 0;
}

export interface JobGroups {
  readonly inProgress: ReadonlyArray<BotJob>;
  readonly doneThisWeek: ReadonlyArray<BotJob>;
  readonly all: ReadonlyArray<BotJob>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The Briefing's job sections. */
export function jobGroups(jobs: ReadonlyArray<BotJob>, now: number = Date.now()): JobGroups {
  const all = [...jobs].sort((left, right) => right.number - left.number);
  const inProgress = all.filter((job) => job.status === "working");
  const doneThisWeek = all.filter((job) => {
    if (job.status !== "done" || job.finishedAt === null) return false;
    const finishedAt = Date.parse(job.finishedAt);
    return Number.isFinite(finishedAt) && now - finishedAt <= WEEK_MS;
  });
  return { inProgress, doneThisWeek, all };
}

/** Decision events for one job, newest first. */
export function jobDecisions(
  events: ReadonlyArray<BotEvent>,
  jobId: string,
): ReadonlyArray<BotEvent> {
  return events
    .filter((event) => event.kind === "decision" && event.jobId === jobId)
    .sort((left, right) => compareIso(right.createdAt, left.createdAt));
}

/** The job's timeline, newest first, at most `limit` rows (never more than the snapshot holds). */
export function jobTimeline(
  events: ReadonlyArray<BotEvent>,
  jobId: string,
  limit = 20,
): ReadonlyArray<BotEvent> {
  return events
    .filter((event) => event.jobId === jobId)
    .sort((left, right) => compareIso(right.createdAt, left.createdAt))
    .slice(0, Math.min(limit, BOT_EVENTS_PER_BOT));
}

/** Answered asks for one job, newest first. */
export function jobAnsweredAsks(snapshot: BotsSnapshot, jobId: string): ReadonlyArray<BotAsk> {
  return snapshot.asks
    .filter((ask) => ask.jobId === jobId && ask.status === "answered")
    .sort((left, right) =>
      compareIso(right.answeredAt ?? right.createdAt, left.answeredAt ?? left.createdAt),
    );
}

/** The project options the composer offers: the user's projects minus the bot's hidden ones. */
export function composerProjects<Project>(
  projects: ReadonlyArray<Project>,
  homeProjectIds: ReadonlySet<string>,
  projectIdOf: (project: Project) => string,
): ReadonlyArray<Project> {
  return projects.filter((project) => !homeProjectIds.has(projectIdOf(project)));
}

export const BOT_EXAMPLE_JOBS: ReadonlyArray<string> = [
  "Make the sidebar drag flicker go away",
  "Upgrade Effect to the latest patch release",
  "Add a changeset check to CI",
];

/** The muted state copy for a session row. */
export function sessionStateLabel(state: BotSessionState): string {
  switch (state.kind) {
    case "working":
      return "Working";
    case "quiet":
      return `Quiet ${quietMinutes(state.quietMs ?? 0)}m`;
    case "waiting":
      return "Waiting on Atlas";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "paused-until":
      return `Paused until ${formatClockTime(state.until ?? "")}`;
    case "taken-over":
      return "You took over";
  }
}

export function botColor(bot: Bot): string {
  return bot.color.trim() === "" ? "#4f46e5" : bot.color;
}

/** One line of plain text from a markdown message: no headings, emphasis or code ticks. */
export function plainPreview(markdown: string, limit = 160): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/(\*\*|__|`)/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

/** Ends a sentence with a full stop unless it already ends with one. */
export function endSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}
