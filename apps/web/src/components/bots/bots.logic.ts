import {
  BOT_QUIET_AFTER_MS,
  type Bot,
  type BotAsk,
  type BotSession,
  type BotsSnapshot,
  type RunId,
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

/** The bot's sessions. */
export function botSessions(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotSession> {
  return snapshot.sessions.filter((session) => session.botId === botId);
}

/** A bot's open asks, oldest first: what needs you, and what the status button jumps to. */
export function openAsks(snapshot: BotsSnapshot, botId: string): ReadonlyArray<BotAsk> {
  return snapshot.asks
    .filter((ask) => ask.botId === botId && ask.status === "open")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function workingKinds(kind: BotSessionStateKind): boolean {
  return kind === "working" || kind === "quiet" || kind === "waiting";
}

/** The bot's sessions that are still doing something, the home thread excluded. */
function workingSessionCount(
  snapshot: BotsSnapshot,
  botId: string,
  shells: ShellLookup,
  now: number = Date.now(),
): number {
  return botSessions(snapshot, botId).filter((session) =>
    workingKinds(sessionState(session, shellFor(shells, session.threadId), now).kind),
  ).length;
}

/** Whether the home thread itself is running a turn. */
function homeThreadWorking(bot: Bot, shells: ShellLookup): boolean {
  if (bot.homeThreadId === null) return false;
  const shell = shells?.get(bot.homeThreadId);
  if (shell === null || shell === undefined) return false;
  const runtime = shell.runtime;
  return runtime !== null && runtime !== undefined && WORKING_STATUSES.has(runtime.status);
}

/**
 * The bot page's header status. `needs` is a button that scrolls the chat to the oldest open ask;
 * `text` is plain muted copy. Session names, never job numbers.
 */
export type BotStatusLine =
  | { readonly kind: "needs"; readonly label: string; readonly focusRunId: RunId | null }
  | { readonly kind: "text"; readonly label: string };

/** The title of the newest session of the ask's job, falling back to the job title. */
function askTitle(snapshot: BotsSnapshot, ask: BotAsk): string | null {
  if (ask.jobId === null) return null;
  const sessions = snapshot.sessions
    .filter((session) => session.jobId === ask.jobId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const newest = sessions[0];
  if (newest !== undefined) return newest.title;
  return snapshot.jobs.find((job) => job.id === ask.jobId)?.title ?? null;
}

export function botStatusLine(
  snapshot: BotsSnapshot,
  bot: Bot,
  shells: ShellLookup,
  now: number = Date.now(),
): BotStatusLine {
  const asks = openAsks(snapshot, bot.id);
  if (asks.length > 0) {
    const oldest = asks[0]!;
    const label =
      asks.length === 1
        ? `${askTitle(snapshot, oldest) ?? bot.name} needs you`
        : `${asks.length} questions for you`;
    return { kind: "needs", label, focusRunId: oldest.homeRunId };
  }
  if (bot.paused) return { kind: "text", label: "Paused" };
  const working = workingSessionCount(snapshot, bot.id, shells, now);
  if (working === 0) {
    return { kind: "text", label: homeThreadWorking(bot, shells) ? "Working…" : "Nothing running" };
  }
  return {
    kind: "text",
    label: `${working} ${working === 1 ? "session" : "sessions"} working · nothing needs you`,
  };
}

/** The four glyphs a sidebar session row or a thread chip shows. */
export type BotSessionGlyph = "needs-you" | "working" | "done" | "failed";

/**
 * One session's sidebar glyph. Needs-you wins over everything but a finished session; the rest is
 * the session's own state, with a paused or failed session reading as failed.
 */
export function botSessionGlyph(
  session: BotSession,
  shell: EnvironmentThreadShell | null | undefined,
  openAskJobIds: ReadonlySet<string>,
  now: number = Date.now(),
): BotSessionGlyph {
  const state = sessionState(session, shell, now);
  if (state.kind !== "done" && openAskJobIds.has(session.jobId)) return "needs-you";
  switch (state.kind) {
    case "done":
      return "done";
    case "failed":
    case "stopped":
    case "paused-until":
      return "failed";
    default:
      return "working";
  }
}

export interface BotSidebarSession {
  readonly session: BotSession;
  readonly glyph: BotSessionGlyph;
  /** When a done session finished, for its relative time; null for the rest. */
  readonly finishedAt: string | null;
}

export interface BotSidebarSessions {
  /** Needs-you, working, failed, then finished in the last 24 hours, newest first. */
  readonly rows: ReadonlyArray<BotSidebarSession>;
  /** Finished longer ago than 24 hours, newest first; behind "N earlier". */
  readonly earlier: ReadonlyArray<BotSidebarSession>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const GLYPH_ORDER: Readonly<Record<BotSessionGlyph, number>> = {
  "needs-you": 0,
  working: 1,
  failed: 2,
  done: 3,
};

/** The sidebar's nested session list: ordering and each row's glyph. */
export function botSidebarSessions(
  snapshot: BotsSnapshot,
  botId: string,
  shells: ShellLookup,
  now: number = Date.now(),
): BotSidebarSessions {
  const openAskJobIds = new Set(
    openAsks(snapshot, botId).flatMap((ask) => (ask.jobId === null ? [] : [ask.jobId])),
  );
  const decorated = botSessions(snapshot, botId).map((session): BotSidebarSession => {
    const shell = shellFor(shells, session.threadId);
    const glyph = botSessionGlyph(session, shell, openAskJobIds, now);
    return {
      session,
      glyph,
      finishedAt: glyph === "done" ? (shell?.updatedAt ?? null) : null,
    };
  });
  const byGlyphThenNewest = (left: BotSidebarSession, right: BotSidebarSession): number =>
    GLYPH_ORDER[left.glyph] - GLYPH_ORDER[right.glyph] ||
    right.session.createdAt.localeCompare(left.session.createdAt);
  const newestFirst = (left: BotSidebarSession, right: BotSidebarSession): number =>
    (right.finishedAt ?? "").localeCompare(left.finishedAt ?? "");
  const active = decorated.filter((row) => row.glyph !== "done").sort(byGlyphThenNewest);
  const finished = decorated.filter((row) => row.glyph === "done").sort(newestFirst);
  const recent = finished.filter((row) => {
    const finishedAt = row.finishedAt === null ? Number.NaN : Date.parse(row.finishedAt);
    return Number.isFinite(finishedAt) && now - finishedAt <= DAY_MS;
  });
  const earlier = finished.filter((row) => !recent.includes(row));
  return { rows: [...active, ...recent], earlier };
}

/** Whether the bot or any of its sessions is working, for the sidebar row's glyph. */
export function botWorking(
  snapshot: BotsSnapshot,
  bot: Bot,
  shells: ShellLookup,
  now: number = Date.now(),
): boolean {
  if (homeThreadWorking(bot, shells)) return true;
  return botSidebarSessions(snapshot, bot.id, shells, now).rows.some(
    (row) => row.glyph === "working",
  );
}

export type ThreadChipState = "input" | "working" | "done" | "failed";

/** A thread link chip's state glyph, from the shell the client already holds. */
export function threadChipState(
  shell: EnvironmentThreadShell | null | undefined,
): ThreadChipState | null {
  if (shell === null || shell === undefined) return null;
  if (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    (shell.pendingSubagentRequest !== undefined && shell.pendingSubagentRequest !== null)
  ) {
    return "input";
  }
  const runtime = shell.runtime;
  if (runtime !== null && runtime !== undefined) {
    if (runtime.status === "failed") return "failed";
    if (WORKING_STATUSES.has(runtime.status)) return "working";
    if (runtime.status === "idle" || runtime.status === "completed") return "done";
    if (STOPPED_STATUSES.has(runtime.status)) return "failed";
  }
  const latestRun = shell.latestRun;
  if (latestRun !== null && latestRun !== undefined) {
    if (latestRun.status === "completed") return "done";
    if (STOPPED_STATUSES.has(latestRun.status)) return "failed";
    if (WORKING_STATUSES.has(latestRun.status)) return "working";
  }
  return "working";
}
