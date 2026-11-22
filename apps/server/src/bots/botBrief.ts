import {
  BOT_LIMIT_LABELS,
  type Bot,
  type BotAsk,
  type BotCloudSessionState,
  type BotId,
  type BotJob,
  type BotNote,
  type BotSession,
  BotsError,
  type EnvironmentId,
  type ProjectId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import { voiceGuide } from "./botPersona.ts";
import * as BotSessions from "./BotSessions.ts";
import * as BotService from "./BotService.ts";

/**
 * What one `bot_brief` may hold, whatever the bot has stored. It is read every turn, so each
 * section fills a character budget, most recent first, and counts what it left out.
 */
const BRIEF_LIMITS = {
  /** Each open job shows its newest sessions. */
  sessionsPerJob: 3,
  jobsChars: 18_000,
  /** Open jobs past `jobsChars` are still named, up to this. */
  otherJobsChars: 2_000,
  finishedJobs: 5,
  requestChars: 500,
  headlineChars: 160,
  reportChars: 300,
  lastAssistantChars: 300,
  /** Notes are ranked by citations, then recency. */
  notesChars: 10_000,
  noteChars: 300,
  instructionsChars: 5_000,
  charterChars: 1_500,
  projectsChars: 3_500,
  asksChars: 4_000,
  askChars: 300,
  optionChars: 120,
} as const;

/** The most a heavy bot's brief comes to, as `estimateTokens` counts: its budgets and their keys. */
export const BRIEF_TOKEN_CAP = 12_500;

/** Items in order until their JSON reaches `budget` characters; the rest are left out. */
const withinBudget = <A>(items: ReadonlyArray<A>, budget: number): Array<A> => {
  const kept: Array<A> = [];
  let used = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > budget) break;
    used += size;
    kept.push(item);
  }
  return kept;
};

/** About four characters a token, the usual rule of thumb for English and JSON. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const clip = (text: string, limit: number): string => {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
};

const HERE = "this machine";

/** The brief's status words for a cloud session, matching `liveState`'s for local ones. */
const cloudStatus = (state: BotCloudSessionState): string =>
  state === "done" ? "idle" : state === "waiting" ? "working" : state;

/** A session with its live state already read. */
export interface BriefSessionInput {
  readonly session: BotSession;
  readonly status: string;
  readonly pendingRequest: {
    readonly requestId: RuntimeRequestId;
    readonly kind: string;
    readonly text: string;
  } | null;
  readonly lastAssistantText: string | null;
  /** When its thread last changed, ISO; null when unknown. */
  readonly changedAt: string | null;
}

export interface BriefInput {
  readonly bot: Bot;
  readonly jobs: ReadonlyArray<BotJob>;
  readonly sessions: ReadonlyArray<BriefSessionInput>;
  readonly asks: ReadonlyArray<BotAsk>;
  readonly notes: ReadonlyArray<BotNote>;
  readonly projects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly cloud:
    | { readonly environmentId: EnvironmentId | null; readonly label: string }
    | { readonly unavailable: string };
  readonly now: string;
  /** The `asOf` of an earlier brief: only what changed after it. Null for the whole brief. */
  readonly since: string | null;
}

const after = (iso: string | null | undefined, since: string | null): boolean =>
  since === null || (iso != null && iso > since);

/** A session's last message is worth reading once its run has ended: a report or an error. */
const endedStatus = (status: string): boolean => status !== "working";

const briefSession = (input: BriefSessionInput, since: string | null) => {
  const { session } = input;
  const base = {
    threadId: session.threadId,
    role: session.role,
    title: session.title,
    modelSelection: session.modelSelection ?? null,
    takenOver: session.takenOver,
    status: input.status,
    pendingRequest: input.pendingRequest,
    lastAssistantText:
      input.lastAssistantText !== null && endedStatus(input.status) && after(input.changedAt, since)
        ? clip(input.lastAssistantText, BRIEF_LIMITS.lastAssistantChars)
        : null,
  };
  if (session.cloud === undefined) return { ...base, where: HERE, reachable: true };
  return {
    ...base,
    where: session.cloud.label,
    environmentId: session.cloud.environmentId,
    reachable: session.cloud.state !== "unreachable",
  };
};

/**
 * The brief a bot reads every turn, within `BRIEF_LIMITS`. With `since`, only jobs, sessions,
 * notes and asks that changed after it, so a bot that already holds an earlier brief reads a few
 * lines instead of everything again.
 */
export const composeBrief = (input: BriefInput) => {
  const { bot, since } = input;
  const sessionsByJob = new Map<string, Array<BriefSessionInput>>();
  for (const entry of input.sessions) {
    const list = sessionsByJob.get(entry.session.jobId) ?? [];
    list.push(entry);
    sessionsByJob.set(entry.session.jobId, list);
  }
  const jobSessions = (job: BotJob) =>
    (sessionsByJob.get(job.id) ?? []).toSorted((left, right) =>
      right.session.createdAt.localeCompare(left.session.createdAt),
    );
  const changed = (job: BotJob) =>
    after(job.updatedAt, since) || jobSessions(job).some((entry) => after(entry.changedAt, since));

  const working = input.jobs.filter((job) => job.status === "working");
  const open = working
    .filter(changed)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((job) => {
      const sessions = jobSessions(job);
      const shown = sessions.slice(0, BRIEF_LIMITS.sessionsPerJob);
      return {
        jobId: job.id,
        number: job.number,
        title: job.title,
        request: clip(job.request, BRIEF_LIMITS.requestChars),
        projectId: job.projectId,
        status: job.status,
        headline: clip(job.headline, BRIEF_LIMITS.headlineChars),
        pullRequests: job.pullRequests,
        sessions: shown
          .filter((entry) => after(entry.changedAt, since))
          .map((entry) => briefSession(entry, since)),
        moreSessions: sessions.length - shown.length,
      };
    });
  const jobs = withinBudget(open, BRIEF_LIMITS.jobsChars);
  const otherOpenJobs = withinBudget(
    open.slice(jobs.length).map((job) => ({ jobId: job.jobId, title: job.title })),
    BRIEF_LIMITS.otherJobsChars,
  );
  const finished = input.jobs
    .filter((job) => job.status !== "working" && after(job.finishedAt, since))
    .toSorted((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))
    .slice(0, BRIEF_LIMITS.finishedJobs);

  const notes = withinBudget(
    input.notes
      .filter((note) => after(note.updatedAt, since))
      .toSorted(
        (left, right) =>
          right.citedCount - left.citedCount || right.updatedAt.localeCompare(left.updatedAt),
      )
      .map((note) => ({
        noteId: note.id,
        text: clip(note.text, BRIEF_LIMITS.noteChars),
        source: note.source,
        citedCount: note.citedCount,
      })),
    BRIEF_LIMITS.notesChars,
  );
  const openAsks = withinBudget(
    input.asks
      .filter((ask) => ask.status === "open")
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((ask) => ({
        askId: ask.id,
        jobId: ask.jobId,
        question: clip(ask.question, BRIEF_LIMITS.askChars),
        options: ask.options.map((option) => clip(option, BRIEF_LIMITS.optionChars)),
        pick: ask.pick === null ? null : clip(ask.pick, BRIEF_LIMITS.optionChars),
      })),
    BRIEF_LIMITS.asksChars,
  );

  return {
    asOf: input.now,
    since,
    bot: {
      name: bot.name,
      charter: clip(bot.charter, BRIEF_LIMITS.charterChars),
      voice: voiceGuide(bot.voice),
      paused: bot.paused,
      models: { worker: bot.models.worker, reviewer: bot.models.reviewer },
    },
    playbook: {
      instructions: after(bot.updatedAt, since)
        ? clip(bot.instructions, BRIEF_LIMITS.instructionsChars)
        : null,
      checkWithMeBefore: bot.limits.map((limit) => BOT_LIMIT_LABELS[limit]),
      notes,
      moreNotes: input.notes.length - notes.length,
    },
    projects: since === null ? withinBudget(input.projects, BRIEF_LIMITS.projectsChars) : null,
    cloud: input.cloud,
    jobs,
    otherOpenJobs,
    moreJobs: working.length - jobs.length - otherOpenJobs.length,
    finishedJobs: finished.map((job) => ({
      jobId: job.id,
      title: job.title,
      status: job.status,
      finishedAt: job.finishedAt,
      headline: clip(job.headline, BRIEF_LIMITS.headlineChars),
      pullRequests: job.pullRequests,
      report: job.report === null ? null : clip(job.report.changed, BRIEF_LIMITS.reportChars),
    })),
    openAsks,
    moreAsks: input.asks.filter((ask) => ask.status === "open").length - openAsks.length,
  };
};

export type Brief = ReturnType<typeof composeBrief>;

/** Stored times are ISO strings, so `since` compares as one; anything unreadable gets the whole brief. */
const normalizeSince = (since: string | null): string | null =>
  since === null ? null : Option.getOrNull(Option.map(DateTime.make(since), DateTime.formatIso));

const stoppedState = { status: "stopped", pendingRequest: null, lastAssistantText: null };

/** Reads what a brief needs from the stores and the session threads, then composes it. */
export const loadBrief = Effect.fn("bots.loadBrief")(function* (
  botId: BotId,
  options: { readonly since: string | null },
) {
  const bots = yield* BotService.BotService;
  const projects = yield* ProjectService.ProjectService;
  const sessions = yield* BotSessions.BotSessions;
  const snapshot = yield* bots.snapshotForBot(botId);
  const bot = snapshot.bots[0];
  if (bot === undefined) {
    return yield* new BotsError({ reason: "not-found", message: "That bot is gone." });
  }
  const shells = yield* projects
    .listShells()
    .pipe(
      Effect.mapError(
        () => new BotsError({ reason: "unavailable", message: "Could not read projects." }),
      ),
    );
  const homeProjects = new Set(
    (yield* bots.listAllBots())
      .map((candidate) => candidate.homeProjectId)
      .filter((projectId): projectId is ProjectId => projectId !== null),
  );
  // Only an open job's newest sessions are shown, so only those threads are read.
  const openJobIds = new Set(
    snapshot.jobs.filter((job) => job.status === "working").map((job) => job.id),
  );
  const newestFirst = snapshot.sessions
    .filter((session) => openJobIds.has(session.jobId))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const perJob = new Map<string, number>();
  const read = newestFirst.filter((session) => {
    const count = perJob.get(session.jobId) ?? 0;
    perJob.set(session.jobId, count + 1);
    return count < BRIEF_LIMITS.sessionsPerJob;
  });
  const live = yield* Effect.forEach(read, (session): Effect.Effect<BriefSessionInput> => {
    // A cloud session's state is what its follower last read: no call there per brief.
    if (session.cloud !== undefined) {
      const reachable = session.cloud.state !== "unreachable";
      return Effect.succeed({
        session,
        status: reachable ? cloudStatus(session.cloud.state) : "unreachable",
        pendingRequest: session.cloud.pendingRequest,
        lastAssistantText: null,
        changedAt: session.cloud.lastOutputAt,
      });
    }
    return sessions.liveState(session.threadId).pipe(
      Effect.map((state) => ({ session, ...state })),
      Effect.orElseSucceed(() => ({ session, ...stoppedState, changedAt: null })),
    );
  });
  const cloud = yield* sessions.cloudTarget().pipe(
    Effect.map((target) =>
      target === null ? { environmentId: null, label: "this server's cloud machines" } : target,
    ),
    Effect.catch((error) => Effect.succeed({ unavailable: error.message })),
  );
  return composeBrief({
    bot,
    jobs: snapshot.jobs,
    sessions: live,
    asks: snapshot.asks,
    notes: snapshot.notes,
    projects: shells
      .filter((shell) => shell.archivedAt == null && !homeProjects.has(shell.id))
      .map((shell) => ({
        projectId: shell.id,
        title: shell.title,
        workspaceRoot: shell.workspaceRoot,
      })),
    cloud,
    now: DateTime.formatIso(yield* DateTime.now),
    since: normalizeSince(options.since),
  });
});
