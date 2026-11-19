import {
  type Bot,
  BotCloudSession,
  BotJob,
  type BotCloudSessionState,
  type BotSession,
  type EnvironmentId,
  type OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadTimelineItem,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { forkParked } from "../serverActivation.ts";
import { BotService } from "./BotService.ts";
import { isLinkGone, loadBotLinkScope } from "./botCloud.ts";
import {
  mergePullRequests,
  type RunEnd,
  reportRequest,
  reportRunEnd,
  reportTakeover,
} from "./BotWatcher.ts";

/** How often a working cloud session is read. */
const CLOUD_ACTIVE_EVERY_MS = 15_000;
/** How often a settled cloud session is read, to catch a new run there. */
export const CLOUD_SETTLED_EVERY_MS = 60_000;
/** Failing this long, a cloud the link can still reach in principle counts as unreachable. */
export const CLOUD_UNREACHABLE_AFTER_MS = 3 * 60_000;
/** Pages of new timeline read per check, so a burst can't hold one sweep. */
const MAX_PAGES = 5;

const sameCloud = Schema.toEquivalence(BotCloudSession);
const samePullRequests = Schema.toEquivalence(BotJob.fields.pullRequests);

export const STOP_FOLLOWING = "Stop following them";
const outageQuestion = (label: string) => `Can't reach ${label}.`;

const LIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STOPPED_STATUSES = new Set(["interrupted", "cancelled", "rolled_back"]);

type ThreadDetail = OrchestratorMcpThreadReadResult["thread"];

/** The cloud session's state from the thread there. */
function cloudState(detail: ThreadDetail): BotCloudSessionState {
  if (detail.archived) return "stopped";
  if (detail.pendingRequestCount > 0) return "waiting";
  if (LIVE_STATUSES.has(detail.status)) return "working";
  if (detail.status === "failed") return "failed";
  if (STOPPED_STATUSES.has(detail.status)) return "stopped";
  return "done";
}

/** What a run that ended there amounts to, as `classifyRunEnd` does for a local shell. */
function cloudRunEnd(status: string, error: string | null): RunEnd | null {
  if (status === "completed") return { kind: "completed", resetAt: null, error: null };
  if (status === "failed") return { kind: "failed", resetAt: null, error };
  if (STOPPED_STATUSES.has(status)) return { kind: "stopped", resetAt: null, error: null };
  return null;
}

/** The user's own message in the session there: the bot's messages arrive as an agent's. */
const isCloudTakeover = (items: ReadonlyArray<OrchestratorMcpThreadTimelineItem>) =>
  items.some((item) => item.type === "user_message" && item.createdBy === "user");

/** Per bot and cloud: since when calls fail, and whether this outage was already announced. */
interface Reach {
  readonly failingSince: number;
  readonly announced: boolean;
}

export class BotCloudSessions extends Context.Service<
  BotCloudSessions,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every followed cloud session that is due; `start` runs it on a timer. */
    readonly sweep: () => Effect.Effect<void>;
  }
>()("t3/bots/BotCloudSessions") {}

const make = Effect.gen(function* () {
  const bots = yield* BotService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  const reach = new Map<string, Reach>();
  const dueAt = new Map<string, number>();
  const reachKey = (bot: Bot, environmentId: EnvironmentId) => `${bot.id}\n${environmentId}`;

  /** New timeline items since the session's cursor, and the thread's detail. */
  const readNew = Effect.fn("BotCloudSessions.readNew")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    session: BotSession,
    cloud: BotCloudSession,
  ) {
    const items: Array<OrchestratorMcpThreadTimelineItem> = [];
    let position = cloud.position;
    let read: OrchestratorMcpThreadReadResult | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      read = yield* forwarding.readThread(scope, cloud.environmentId, {
        threadId: session.threadId,
        view: "messages",
        afterPosition: position,
        limit: 100,
        maxCharsPerItem: 200,
      });
      items.push(...read.items);
      for (const item of read.items) position = Math.max(position, item.position);
      if (!read.hasMore || read.nextPosition === null) break;
      position = Math.max(position, read.nextPosition);
    }
    return { read: read!, items, position };
  });

  /** The error a failed run there reported, if it reported one. */
  const runError = Effect.fn("BotCloudSessions.runError")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    session: BotSession,
    cloud: BotCloudSession,
    runId: string,
  ) {
    const read = yield* forwarding.readThread(scope, cloud.environmentId, {
      threadId: session.threadId,
      view: "activity",
      afterPosition: cloud.position,
      limit: 100,
      maxCharsPerItem: 600,
    });
    return (
      read.items.findLast((item) => item.type === "error" && item.runId === runId)?.text ?? null
    );
  });

  /** Reads the session there and turns what changed into the wakes a local session sends. */
  const reconcile = Effect.fn("BotCloudSessions.reconcile")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    bot: Bot,
    initial: BotSession,
    cloud: BotCloudSession,
    job: BotJob,
  ) {
    let session = initial;
    const { read, items, position } = yield* readNew(scope, session, cloud);
    const detail = read.thread;

    const pullRequests = detail.pullRequests ?? [];
    if (pullRequests.length > 0) {
      const merged = mergePullRequests(
        job.pullRequests,
        pullRequests.map((pr) => ({
          number: pr.number,
          url: pr.url,
          snapshot: pr.state === null ? null : { state: pr.state },
        })),
      );
      if (!samePullRequests(merged, job.pullRequests)) {
        yield* bots.updateJob(session.botId, session.jobId, { pullRequests: merged });
      }
    }

    if (!session.takenOver && isCloudTakeover(items)) {
      yield* reportTakeover(bots, session);
      session = { ...session, takenOver: true };
    }

    let reportedRunId = cloud.reportedRunId;
    const latest = read.recentRuns.toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (latest !== undefined && latest.runId !== reportedRunId) {
      const error =
        latest.status === "failed" ? yield* runError(scope, session, cloud, latest.runId) : null;
      const end = cloudRunEnd(latest.status, error);
      if (end !== null) {
        yield* reportRunEnd(bots, session, job, end);
        reportedRunId = latest.runId;
      }
    }

    let pendingRequest: BotCloudSession["pendingRequest"] = null;
    const reportedRequestIds: Array<RuntimeRequestId> = [];
    if (detail.pendingRequestCount > 0) {
      const listed = yield* forwarding.call(
        scope,
        ThreadToolkit.tools.t3_pending_request,
        cloud.environmentId,
        { action: "list", threadId: session.threadId },
      );
      const requestIds = "requestIds" in listed ? listed.requestIds : [];
      for (const requestId of requestIds) {
        reportedRequestIds.push(requestId);
        const known = cloud.pendingRequest?.requestId === requestId ? cloud.pendingRequest : null;
        if (known !== null && cloud.reportedRequestIds.includes(requestId)) {
          pendingRequest ??= known;
          continue;
        }
        const question = yield* forwarding.call(
          scope,
          ThreadToolkit.tools.t3_pending_request,
          cloud.environmentId,
          { action: "read", threadId: session.threadId, requestId },
        );
        const text =
          "questions" in question
            ? (question.questions[0]?.question ?? "a question")
            : "a question";
        pendingRequest ??= { requestId, kind: "user-input", text };
        if (!session.takenOver && !cloud.reportedRequestIds.includes(requestId)) {
          yield* reportRequest(bots, session, { id: requestId, kind: "user-input", text });
        }
      }
      // The link lists questions only; the rest wait on an approval the bot can't give.
      if (detail.pendingRequestCount > requestIds.length) {
        const approvalId = RuntimeRequestId.make(`approval:${detail.latestRunId ?? "none"}`);
        reportedRequestIds.push(approvalId);
        pendingRequest ??= { requestId: approvalId, kind: "approval", text: "an approval" };
        if (!session.takenOver && !cloud.reportedRequestIds.includes(approvalId)) {
          yield* reportRequest(
            bots,
            session,
            { id: approvalId, kind: "approval", text: "an approval" },
            `It can't be approved from here: ask the user with bot_ask to open the session and approve it.`,
          );
        }
      }
    }

    const next: BotCloudSession = {
      ...cloud,
      state: cloudState(detail),
      pendingRequest,
      lastOutputAt: detail.updatedAt,
      reportedRunId,
      reportedRequestIds,
      position,
    };
    if (!sameCloud(next, cloud)) {
      yield* bots.setSessionCloud(session.threadId, next);
    }
    return next.state;
  });

  /** The bot's open question about this outage, if one is open. */
  const outageAsk = Effect.fn("BotCloudSessions.outageAsk")(function* (bot: Bot, label: string) {
    const asks = yield* bots.listAsks(bot.id);
    return asks
      .filter((ask) => ask.question === outageQuestion(label))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  });

  /** Once per outage: mark its sessions, tell the bot, and ask the user to relink. */
  const announceOutage = Effect.fn("BotCloudSessions.announceOutage")(function* (
    bot: Bot,
    cloud: BotCloudSession,
    sessions: ReadonlyArray<BotSession>,
    reason: string,
  ) {
    for (const session of sessions) {
      if (session.cloud === undefined || session.cloud.state === "unreachable") continue;
      yield* bots.setSessionCloud(session.threadId, { ...session.cloud, state: "unreachable" });
    }
    yield* bots.addEvent({ botId: bot.id, kind: "info", text: `Can't reach ${cloud.label}` });
    yield* bots.publishWake({
      botId: bot.id,
      reason: "cloud-unreachable",
      label: `Can't reach ${cloud.label}`,
      text: `Can't reach ${cloud.label} (environmentId ${cloud.environmentId}): ${reason}. Its sessions may still be running there. The user has been asked to fix the link; don't start cloud sessions until it's back.`,
    });
    const open = yield* outageAsk(bot, cloud.label);
    if (open?.status === "open") return;
    const titles = sessions.map((session) => session.title).join(", ");
    yield* bots.createAsk(bot.id, {
      jobId: sessions.length === 1 ? (sessions[0]?.jobId ?? null) : null,
      question: outageQuestion(cloud.label),
      why: `${sessions.length === 1 ? "1 session there" : `${sessions.length} sessions there`} can't be followed: ${titles}. They may keep running on ${cloud.label}; open them there to stop them. ${reason}. If the link expired, link it again in Settings → Connections.`,
      options: [STOP_FOLLOWING],
      pick: null,
    });
  });

  const recover = Effect.fn("BotCloudSessions.recover")(function* (bot: Bot, label: string) {
    const ask = yield* outageAsk(bot, label);
    if (ask === undefined || ask.status !== "open") return;
    yield* bots.resolveAsk(bot.id, ask.id, {
      answerKind: "text",
      answer: `${label} is reachable again`,
      eventText: `${label} is reachable again`,
    });
  });

  /** A call there failed: count it toward an outage, announcing it once it is one. */
  const failed = Effect.fn("BotCloudSessions.failed")(function* (
    bot: Bot,
    cloud: BotCloudSession,
    sessions: ReadonlyArray<BotSession>,
    error: OrchestratorMcpFailure,
  ) {
    const key = reachKey(bot, cloud.environmentId);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const before = reach.get(key);
    const gone = yield* isLinkGone(links, cloud.environmentId, error);
    const current: Reach = before ?? { failingSince: now, announced: false };
    if (current.announced) return;
    if (gone || now - current.failingSince >= CLOUD_UNREACHABLE_AFTER_MS) {
      reach.set(key, { ...current, announced: true });
      yield* announceOutage(bot, cloud, sessions, error.message.replace(/\.$/, ""));
      return;
    }
    reach.set(key, current);
  });

  /** The user stopped following an unreachable cloud's sessions from the Ask. */
  const stoppedFollowing = Effect.fn("BotCloudSessions.stoppedFollowing")(function* (
    bot: Bot,
    label: string,
  ) {
    const ask = yield* outageAsk(bot, label);
    return ask?.status === "answered" && ask.answer === STOP_FOLLOWING;
  });

  const owesStop = (session: BotSession, job: BotJob) =>
    job.status !== "working" &&
    session.cloud !== undefined &&
    session.cloud.stoppedThere !== true &&
    (session.cloud.state === "working" ||
      session.cloud.state === "waiting" ||
      session.cloud.state === "unreachable");

  const sweepBot = Effect.fn("BotCloudSessions.sweepBot")(function* (bot: Bot, now: number) {
    const all = (yield* bots.listSessions(bot.id)).filter((session) => session.cloud !== undefined);
    if (all.length === 0) return;
    const jobs = new Map<string, BotJob>();
    for (const job of yield* bots.listJobs(bot.id)) jobs.set(job.id, job);
    const linkScope = yield* loadBotLinkScope(threads, hereId, bot).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (linkScope === null) return;
    const { scope } = linkScope;
    const byCloud = new Map<EnvironmentId, Array<BotSession>>();
    for (const session of all) {
      const job = jobs.get(session.jobId);
      if (job === undefined || session.cloud === undefined) continue;
      const followed =
        session.cloud.unfollowed !== true &&
        (job.status === "working" ||
          (session.cloud.state !== "done" &&
            session.cloud.state !== "failed" &&
            session.cloud.state !== "stopped"));
      if (!followed && !owesStop(session, job)) continue;
      const list = byCloud.get(session.cloud.environmentId) ?? [];
      list.push(session);
      byCloud.set(session.cloud.environmentId, list);
    }
    for (const [environmentId, sessions] of byCloud) {
      const first = sessions[0]?.cloud;
      if (first === undefined) continue;
      const key = reachKey(bot, environmentId);
      if (
        sessions.some((session) => session.cloud?.state === "unreachable") &&
        (yield* stoppedFollowing(bot, first.label))
      ) {
        for (const session of sessions) {
          if (session.cloud === undefined || session.cloud.unfollowed === true) continue;
          yield* bots.setSessionCloud(session.threadId, {
            ...session.cloud,
            state: "stopped",
            unfollowed: true,
          });
          yield* bots.addEvent({
            botId: bot.id,
            jobId: session.jobId,
            kind: "info",
            text: `Stopped following ${session.title}`,
            sessionThreadId: session.threadId,
          });
        }
        reach.delete(key);
        continue;
      }
      let reached = false;
      let failure: OrchestratorMcpFailure | undefined;
      for (const session of sessions) {
        const cloud = session.cloud;
        const job = jobs.get(session.jobId);
        if (cloud === undefined || job === undefined) continue;
        if ((dueAt.get(session.threadId) ?? 0) > now && cloud.state !== "unreachable") continue;
        const outcome = yield* Effect.gen(function* () {
          if (owesStop(session, job)) {
            yield* forwarding.interruptThread(scope, cloud.environmentId, {
              threadId: session.threadId,
              stop: true,
              clientRequestId: `bot-job-stop:${job.id}:${session.threadId}`,
            });
            yield* bots.setSessionCloud(session.threadId, {
              ...cloud,
              state: "stopped",
              stoppedThere: true,
            });
            return "stopped" as const;
          }
          if (cloud.unfollowed === true) return cloud.state;
          return yield* reconcile(scope, bot, session, cloud, job);
        }).pipe(
          Effect.map((state) => ({ ok: true as const, state })),
          Effect.catchTags({
            OrchestratorMcpFailure: (error) => Effect.succeed({ ok: false as const, error }),
          }),
        );
        if (outcome.ok) {
          reached = true;
          dueAt.set(
            session.threadId,
            now +
              (outcome.state === "working" || outcome.state === "waiting"
                ? CLOUD_ACTIVE_EVERY_MS
                : CLOUD_SETTLED_EVERY_MS),
          );
        } else if (outcome.error.code === "thread_not_found") {
          // The cloud answered: only this session's thread is gone there.
          reached = true;
          yield* bots.setSessionCloud(session.threadId, {
            ...cloud,
            state: "stopped",
            unfollowed: true,
          });
          yield* bots.addEvent({
            botId: bot.id,
            jobId: session.jobId,
            kind: "info",
            text: `${session.title} is gone from ${cloud.label}`,
            sessionThreadId: session.threadId,
          });
        } else {
          failure = outcome.error;
          // One failure speaks for the cloud; the rest of its sessions wait for the next sweep.
          break;
        }
      }
      if (failure !== undefined) {
        yield* failed(bot, first, sessions, failure);
      } else if (reached) {
        const before = reach.get(key);
        reach.delete(key);
        if (before?.announced === true || first.state === "unreachable") {
          yield* bots.addEvent({
            botId: bot.id,
            kind: "info",
            text: `${first.label} is reachable again`,
          });
          yield* recover(bot, first.label);
        }
      }
    }
  });

  const sweep: BotCloudSessions["Service"]["sweep"] = Effect.fn("BotCloudSessions.sweep")(
    function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const bot of yield* bots.listAllBots()) {
        yield* sweepBot(bot, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("BotCloudSessions: following a bot's cloud sessions failed", {
              botId: bot.id,
              cause,
            }),
          ),
        );
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("BotCloudSessions: a sweep failed", { cause })),
  );

  const start: BotCloudSessions["Service"]["start"] = Effect.fn("BotCloudSessions.start")(
    function* () {
      yield* forkParked(
        Effect.forever(
          Effect.sleep(Duration.millis(CLOUD_ACTIVE_EVERY_MS)).pipe(Effect.andThen(sweep())),
        ),
      );
    },
  );

  return { start, sweep } satisfies BotCloudSessions["Service"];
});

export const layer = Layer.effect(BotCloudSessions, make);
