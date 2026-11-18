import {
  BOT_ESCALATE_AFTER_MS,
  BOT_QUIET_AFTER_MS,
  type BotId,
  type BotJob,
  type BotSession,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as InboxProjection from "../inbox/InboxProjection.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { BotService } from "./BotService.ts";
import { BotEscalations, BotThreads } from "./botThreads.ts";

/** How often a stale session request is considered for escalation. */
const ESCALATE_EVERY_MS = 30_000;
/** How often sessions are checked for a quiet stretch. */
const QUIET_EVERY_MS = 60_000;
/** A wake's session text is capped so one long error can't bloat the home thread. */
const WAKE_TEXT_LIMIT = 300;
/** Shell statuses that mean a run is still going, so a session can go quiet. */
const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);

export type RunEndKind = "completed" | "usage-limit" | "failed" | "stopped";

export interface RunEnd {
  readonly kind: RunEndKind;
  /** A usage limit's reset time, ISO. */
  readonly resetAt: string | null;
  readonly error: string | null;
}

/** What a finished run amounts to. Null when the run has not ended. */
export function classifyRunEnd(
  status: OrchestrationV2ThreadShell["status"],
  shell: Pick<OrchestrationV2ThreadShell, "lastErrorClass" | "lastError" | "usageLimitResetAt">,
): RunEnd | null {
  if (status === "completed") return { kind: "completed", resetAt: null, error: null };
  if (status === "failed") {
    if (shell.lastErrorClass === "usage_limit" && shell.usageLimitResetAt != null) {
      return {
        kind: "usage-limit",
        resetAt: shell.usageLimitResetAt,
        error: shell.lastError ?? null,
      };
    }
    return { kind: "failed", resetAt: null, error: shell.lastError ?? null };
  }
  if (status === "interrupted" || status === "cancelled") {
    return { kind: "stopped", resetAt: null, error: null };
  }
  return null;
}

/** The fields of a `message.updated` payload that decide takeover. */
export interface TakeoverEvent {
  readonly type: string;
  readonly threadId: string;
  readonly payload: {
    readonly role?: string | undefined;
    readonly createdBy?: string | undefined;
    readonly idleCompaction?: string | undefined;
  };
}

export interface TakeoverSession {
  readonly threadId: string;
  readonly takenOver: boolean;
}

/**
 * A user's own message in a session means they took it over. A session starts with the bot's task,
 * which is created by the agent, so its first message can never match.
 */
export function isTakeoverMessage(event: TakeoverEvent, session: TakeoverSession): boolean {
  if (event.type !== "message.updated" || event.threadId !== session.threadId) return false;
  return (
    event.payload.role === "user" &&
    event.payload.createdBy === "user" &&
    event.payload.idleCompaction === undefined
  );
}

export interface PendingRequest {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly botId: BotId;
  /** When the request was raised, epoch ms. */
  readonly since: number;
}

/** Requests that waited long enough, or whose bot is paused, so their owner should see them now. */
export function dueEscalations(
  pending: ReadonlyArray<PendingRequest>,
  now: number,
  pausedBots: ReadonlySet<string>,
): ReadonlyArray<PendingRequest> {
  return pending.filter(
    (entry) => pausedBots.has(entry.botId) || now - entry.since >= BOT_ESCALATE_AFTER_MS,
  );
}

export interface QuietCandidate {
  readonly threadId: ThreadId;
  readonly jobStatus: string;
  readonly active: boolean;
  readonly lastOutputAt: number;
}

/**
 * The sessions that just went quiet, and the wake marks after this check. A mark clears the moment
 * the session produces output again, so each quiet stretch wakes the bot once.
 */
export function quietSessions(
  candidates: ReadonlyArray<QuietCandidate>,
  now: number,
  woken: ReadonlySet<string>,
): { readonly due: ReadonlyArray<QuietCandidate>; readonly woken: ReadonlySet<string> } {
  const next = new Set(woken);
  const due: Array<QuietCandidate> = [];
  for (const candidate of candidates) {
    if (now - candidate.lastOutputAt < BOT_QUIET_AFTER_MS) {
      // New output: this quiet stretch is over.
      next.delete(candidate.threadId);
      continue;
    }
    if (candidate.jobStatus !== "working" || !candidate.active) continue;
    if (next.has(candidate.threadId)) continue;
    next.add(candidate.threadId);
    due.push(candidate);
  }
  return { due, woken: next };
}

type JobPullRequest = BotJob["pullRequests"][number];

/** The part of a thread shell's pull-request link the job cares about. */
export interface PullRequestLinkInput {
  readonly number: JobPullRequest["number"];
  readonly url: string;
  readonly snapshot?: { readonly state?: string } | null;
}

/** The job's PRs after folding in a session shell's links, keyed by number. */
export function mergePullRequests(
  existing: ReadonlyArray<JobPullRequest>,
  links: ReadonlyArray<PullRequestLinkInput>,
): ReadonlyArray<JobPullRequest> {
  const byNumber = new Map<number, JobPullRequest>(existing.map((pr) => [pr.number, pr]));
  for (const link of links) {
    byNumber.set(link.number, {
      number: link.number,
      url: link.url,
      state: link.snapshot?.state ?? byNumber.get(link.number)?.state ?? "open",
    });
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

/** The newest activity the shell records: output, or the run that is still going. */
function lastOutputAt(shell: OrchestrationV2ThreadShell): number {
  let at = DateTime.toEpochMillis(shell.updatedAt);
  if (shell.latestVisibleMessage != null) {
    at = Math.max(at, DateTime.toEpochMillis(shell.latestVisibleMessage.updatedAt));
  }
  if (shell.activityRunStartedAt != null) {
    at = Math.max(at, DateTime.toEpochMillis(shell.activityRunStartedAt));
  }
  return at;
}

const truncate = (text: string, limit = WAKE_TEXT_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** "HH:MM" from an ISO instant, for a timeline line. */
const clockLabel = (iso: string) => iso.slice(11, 16);

export class BotWatcher extends Context.Service<
  BotWatcher,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/bots/BotWatcher") {}

const make = Effect.gen(function* () {
  const bots = yield* BotService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;

  const pending = yield* Ref.make(new Map<string, PendingRequest>());
  const quietWoken = yield* Ref.make<ReadonlySet<string>>(new Set());

  const readShell = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  const dropPending = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Ref.update(pending, (entries) => {
      const key = `${threadId}:${requestId}`;
      if (!entries.has(key)) return entries;
      const next = new Map(entries);
      next.delete(key);
      return next;
    });

  /** Copy the session shell's PRs into the job, only when the set actually changed. */
  const syncPullRequests = Effect.fnUntraced(function* (
    session: BotSession,
    job: BotJob,
    shell: OrchestrationV2ThreadShell,
  ) {
    const links = shell.pullRequests ?? [];
    if (links.length === 0) return;
    const merged = mergePullRequests(job.pullRequests, links);
    const unchanged =
      merged.length === job.pullRequests.length &&
      merged.every((pr, index) => {
        const before = job.pullRequests[index];
        return before !== undefined && before.number === pr.number && before.state === pr.state;
      });
    if (unchanged) return;
    yield* bots.updateJob(session.botId, session.jobId, { pullRequests: merged });
  });

  const onRunUpdated = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>,
    session: BotSession,
  ) {
    const shell = yield* readShell(event.threadId);
    if (shell === null) return;
    const job = Option.getOrNull(yield* bots.getJob(session.jobId));
    if (job === null) return;
    yield* syncPullRequests(session, job, shell);
    const end = classifyRunEnd(event.payload.status, shell);
    if (end === null) return;
    const title = session.title;
    const label = `J-${job.number}`;
    const at = `Session "${title}" (thread ${event.threadId}, ${label})`;
    switch (end.kind) {
      case "completed": {
        yield* bots.addEvent({
          botId: session.botId,
          jobId: session.jobId,
          kind: "session-finished",
          text: `${title} finished`,
          sessionThreadId: event.threadId,
        });
        if (!session.takenOver) {
          yield* bots.publishWake({
            botId: session.botId,
            reason: "session-finished",
            text: `${at} finished. Read its report with t3_thread_read, then continue the job or finish it.`,
          });
        }
        return;
      }
      case "usage-limit": {
        const resetAt = end.resetAt ?? "";
        yield* bots.addEvent({
          botId: session.botId,
          jobId: session.jobId,
          kind: "session-failed",
          text: `${title} paused until ${clockLabel(resetAt)}`,
          sessionThreadId: event.threadId,
        });
        if (!session.takenOver) {
          yield* bots.publishWake({
            botId: session.botId,
            reason: "session-usage-limit",
            text: `${at} hit a usage limit until ${resetAt}. Move the work to another model with a new session, or wait.`,
          });
        }
        return;
      }
      case "failed": {
        yield* bots.addEvent({
          botId: session.botId,
          jobId: session.jobId,
          kind: "session-failed",
          text: `${title} failed`,
          sessionThreadId: event.threadId,
        });
        if (!session.takenOver) {
          const error = truncate(end.error ?? "no error reported");
          yield* bots.publishWake({
            botId: session.botId,
            reason: "session-failed",
            text: `${at} failed: ${error}. Nudge it once with bot_session_message, or start a replacement.`,
          });
        }
        return;
      }
      case "stopped": {
        yield* bots.addEvent({
          botId: session.botId,
          jobId: session.jobId,
          kind: "info",
          text: `${title} stopped`,
          sessionThreadId: event.threadId,
        });
        // The user stopped the job: no need to tell the bot about its sessions.
        if (!session.takenOver && job.status === "working") {
          yield* bots.publishWake({
            botId: session.botId,
            reason: "session-stopped",
            text: `${at} stopped.`,
          });
        }
        return;
      }
    }
  });

  const onRuntimeRequest = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>,
    session: BotSession,
  ) {
    const key = `${event.threadId}:${event.payload.id}`;
    if (event.payload.status !== "pending") {
      BotEscalations.clear(event.threadId, event.payload.id);
      yield* dropPending(event.threadId, event.payload.id);
      return;
    }
    if (session.takenOver) return;
    if ((yield* Ref.get(pending)).has(key)) return;
    const excerpt = yield* InboxProjection.requestExcerpt(event.threadId, event.payload.id).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const job = Option.getOrNull(yield* bots.getJob(session.jobId));
    if (job === null) return;
    const question = truncate(excerpt ?? "no text");
    yield* bots.publishWake({
      botId: session.botId,
      reason: "session-request",
      text: `Session "${session.title}" (thread ${event.threadId}, J-${job.number}) is waiting: ${event.payload.kind} request ${event.payload.id}: "${question}". Answer with bot_session_respond if your playbook covers it and no limit applies; otherwise raise an Ask.`,
    });
    yield* Ref.update(pending, (entries) =>
      new Map(entries).set(key, {
        threadId: event.threadId,
        requestId: event.payload.id,
        botId: session.botId,
        since: DateTime.toEpochMillis(event.payload.createdAt),
      }),
    );
  });

  const onMessageUpdated = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "message.updated" }>,
    session: BotSession,
  ) {
    if (session.takenOver || !isTakeoverMessage(event, session)) return;
    yield* bots.setSessionTakenOver(event.threadId, true);
    const job = Option.getOrNull(yield* bots.getJob(session.jobId));
    const label = job === null ? "J-?" : `J-${job.number}`;
    yield* bots.publishWake({
      botId: session.botId,
      reason: "session-taken-over",
      text: `The user took over session "${session.title}" (thread ${event.threadId}, ${label}). Leave it alone until they hand it back.`,
    });
  });

  const handle: BotWatcher["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (BotThreads.sessionBotId(event.threadId) === undefined) return;
      if (
        event.type !== "run.updated" &&
        event.type !== "runtime-request.updated" &&
        event.type !== "message.updated"
      ) {
        return;
      }
      const session = Option.getOrNull(yield* bots.sessionForThread(event.threadId));
      if (session === null) return;
      if (event.type === "run.updated") {
        // Every run update can carry new pull requests; classifyRunEnd decides if it ended.
        yield* onRunUpdated(event, session);
        return;
      }
      if (event.type === "runtime-request.updated") {
        yield* onRuntimeRequest(event, session);
        return;
      }
      yield* onMessageUpdated(event, session);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("BotWatcher: handling a domain event failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  /** Move a request the bot already answered (or dismissed) out of the pending map. */
  const sweepPending = Effect.fnUntraced(function* () {
    const entries = [...(yield* Ref.get(pending)).values()];
    if (entries.length === 0) return [];
    const live: Array<PendingRequest> = [];
    for (const entry of entries) {
      const request = yield* projections
        .getRuntimeRequest(entry.threadId, entry.requestId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (request?.status === "pending") {
        live.push(entry);
      } else {
        BotEscalations.clear(entry.threadId, entry.requestId);
        yield* dropPending(entry.threadId, entry.requestId);
      }
    }
    return live;
  });

  const escalate = Effect.fn("BotWatcher.escalate")(function* () {
    const live = yield* sweepPending();
    if (live.length === 0) return;
    const all = yield* bots.listAllBots();
    const pausedBots = new Set<string>(all.filter((bot) => bot.paused).map((bot) => bot.id));
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const due of dueEscalations(live, now, pausedBots)) {
      if (BotEscalations.isEscalated(due.threadId, due.requestId)) continue;
      BotEscalations.mark(due.threadId, due.requestId);
      const session = Option.getOrNull(yield* bots.sessionForThread(due.threadId));
      if (session === null) continue;
      const job = Option.getOrNull(yield* bots.getJob(session.jobId));
      const label = job === null ? "" : ` (J-${job.number})`;
      const waited = Math.max(1, Math.round((now - due.since) / 60_000));
      yield* bots.addEvent({
        botId: session.botId,
        jobId: session.jobId,
        kind: "info",
        text: `${session.title} has waited ${waited}m; asked you${label}`,
        sessionThreadId: due.threadId,
      });
    }
  });

  const quiet = Effect.fn("BotWatcher.quiet")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const all = yield* bots.listAllBots();
    const candidates: Array<QuietCandidate> = [];
    const known = new Map<string, { readonly session: BotSession; readonly job: BotJob }>();
    for (const bot of all) {
      for (const session of yield* bots.listSessions(bot.id)) {
        const job = Option.getOrNull(yield* bots.getJob(session.jobId));
        if (job === null) continue;
        const shell = yield* readShell(session.threadId);
        candidates.push({
          threadId: session.threadId,
          jobStatus: job.status,
          active:
            shell !== null && (shell.activeRunId !== null || LIVE_RUN_STATUSES.has(shell.status)),
          lastOutputAt: shell === null ? now : lastOutputAt(shell),
        });
        known.set(session.threadId, { session, job });
      }
    }
    const { due, woken } = quietSessions(candidates, now, yield* Ref.get(quietWoken));
    yield* Ref.set(quietWoken, woken);
    for (const candidate of due) {
      const entry = known.get(candidate.threadId);
      if (entry === undefined) continue;
      const minutes = Math.max(1, Math.round((now - candidate.lastOutputAt) / 60_000));
      yield* bots.addEvent({
        botId: entry.session.botId,
        jobId: entry.session.jobId,
        kind: "session-quiet",
        text: `${entry.session.title} quiet ${minutes}m`,
        sessionThreadId: entry.session.threadId,
      });
      yield* bots.publishWake({
        botId: entry.session.botId,
        reason: "session-quiet",
        text: `Session "${entry.session.title}" (thread ${entry.session.threadId}, J-${entry.job.number}) has had no new output for ${minutes}m. Ask it for a status with bot_session_message.`,
      });
    }
  });

  const every = <E, R>(everyMs: number, tick: Effect.Effect<unknown, E, R>) =>
    Effect.forever(
      Effect.sleep(Duration.millis(everyMs)).pipe(
        Effect.andThen(
          tick.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("BotWatcher: a periodic sweep failed", { cause }),
            ),
          ),
        ),
      ),
    );

  const start: BotWatcher["Service"]["start"] = Effect.fn("BotWatcher.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => handle(event)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("BotWatcher: the domain event stream failed", { cause }),
        ),
      ),
    );
    yield* forkParked(every(ESCALATE_EVERY_MS, escalate()));
    yield* forkParked(every(QUIET_EVERY_MS, quiet()));
  });

  return { start, handle } satisfies BotWatcher["Service"];
});

export const layer = Layer.effect(BotWatcher, make);
