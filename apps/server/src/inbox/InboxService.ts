import {
  type BotsError,
  INBOX_NEEDS_YOU_REASONS,
  InboxError,
  type InboxItem,
  type InboxItemInput,
  type InboxListInput,
  type InboxListResult,
  type InboxSnoozeInput,
  type InboxSummary,
  type MemberId,
  MY_TASKS_CLOSED_LIMIT,
  type MyTasksClosedResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2ThreadShell,
  type SharedWithYouItem,
  type SharedWithYouListInput,
  type SharedWithYouListResult,
  type SharedWithYouPerson,
  type Space,
  type SpaceId,
  type SpaceTask,
  type SpaceTaskId,
  type ThreadId,
  isSpaceActiveMember,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { holderOf } from "../orchestration-v2/MemberThreadState.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { spaceReplyTrigger } from "../space/SpaceAgentDecisions.ts";
import * as TeamState from "../team/TeamState.ts";
import { ThreadAccess } from "../team/ThreadAccess.ts";
import { BotService } from "../bots/BotService.ts";
import { BotEscalations, BotThreads } from "../bots/botThreads.ts";
import * as InboxProjection from "./InboxProjection.ts";

/** Who is reading, and which threads they may open; absent, every thread. */
export interface InboxCaller {
  readonly memberId: MemberId;
  readonly mayOpen?: (threadId: ThreadId) => boolean;
}

const DEFAULT_PAGE = 50;
const EXCERPT_LENGTH = 280;
/** Per room and per kind, so a room never visited cannot make a read unbounded. */
const ROOM_ITEM_LIMIT = 50;
/** At most one recompute per subscription in this window; the first change goes out at once. */
const SUMMARY_WINDOW = Duration.millis(250);

/**
 * Each member's Inbox, derived on read from projections: what waits on them (Needs you, counted)
 * and what's for them (For you). Only their Done and their task-item snoozes are stored.
 */
export class InboxService extends Context.Service<
  InboxService,
  {
    readonly list: (
      caller: InboxCaller,
      input: InboxListInput,
    ) => Effect.Effect<InboxListResult, InboxError>;
    readonly summary: (caller: InboxCaller) => Effect.Effect<InboxSummary, InboxError>;
    /** The summary now, then each change, at most one recompute per window. */
    readonly subscribeSummary: (caller: InboxCaller) => Stream.Stream<InboxSummary, InboxError>;
    /** Done: For you items only. */
    readonly dismiss: (
      caller: InboxCaller,
      input: InboxItemInput,
    ) => Effect.Effect<Record<string, never>, InboxError>;
    /** Task items only; a thread's item snoozes the thread instead. */
    readonly snooze: (
      caller: InboxCaller,
      input: InboxSnoozeInput,
    ) => Effect.Effect<Record<string, never>, InboxError>;
    readonly unsnooze: (
      caller: InboxCaller,
      input: InboxItemInput,
    ) => Effect.Effect<Record<string, never>, InboxError>;
    readonly sharedWithYou: (
      caller: InboxCaller,
      input: SharedWithYouListInput,
    ) => Effect.Effect<SharedWithYouListResult, InboxError>;
    /** My tasks' Done and Canceled, newest first and bounded; `spaces.list` has the open ones. */
    readonly closedTasks: (caller: InboxCaller) => Effect.Effect<MyTasksClosedResult, InboxError>;
  }
>()("t3/inbox/InboxService") {}

/** What every source reads: the caller, and their active spaces with their room visits. */
interface InboxContext {
  readonly caller: InboxCaller;
  readonly serverOwnerId: MemberId | null;
  readonly spaces: ReadonlyArray<Space>;
  readonly spaceById: ReadonlyMap<SpaceId, Space>;
  /** The caller's last visit to each space's room, as an ISO time. */
  readonly roomVisits: ReadonlyMap<SpaceId, string | null>;
}

/** One kind of item. A new reason is a new source in `SOURCES`. */
type InboxSource = (context: InboxContext) => Effect.Effect<ReadonlyArray<InboxItem>, InboxError>;

const isInboxError = Schema.is(InboxError);
const failed = (cause: unknown) =>
  new InboxError({
    reason: "failed",
    message: cause instanceof Error ? cause.message : String(cause),
  });

const excerpt = (text: string | null | undefined) =>
  text == null || text.length === 0
    ? {}
    : { excerpt: text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text };

const isoMs = (iso: string) => Date.parse(iso);
const newer = (at: string, since: string | null) => since === null || isoMs(at) > isoMs(since);

/** Newest first; ties by id, so pages never repeat or skip an item. */
const byNewest = (left: InboxItem, right: InboxItem) =>
  isoMs(right.at) - isoMs(left.at) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

const isTaskItemId = (itemId: string) =>
  itemId.startsWith("task-assigned:") || itemId.startsWith("task-handed-back:");

/** A stable 31-bit FNV-1a hash of the items, so equal Inboxes share a revision. */
const revisionOf = (items: ReadonlyArray<InboxItem>, snoozed: ReadonlyArray<InboxItem>) => {
  let hash = 0x811c9dc5;
  const keys = [
    ...items.map((item) => `${item.id}@${item.at}\n`),
    ...snoozed.map((item) => `${item.id}~${item.snoozedUntil}\n`),
  ];
  for (const key of keys) {
    for (let index = 0; index < key.length; index++) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0) & 0x7fffffff;
};

const summarize = (
  items: ReadonlyArray<InboxItem>,
  snoozed: ReadonlyArray<InboxItem>,
): InboxSummary => {
  const bySpace = new Map<SpaceId, number>();
  let needsYou = 0;
  for (const item of items) {
    if (item.group !== "needs-you") continue;
    needsYou++;
    if (item.spaceId !== undefined) bySpace.set(item.spaceId, (bySpace.get(item.spaceId) ?? 0) + 1);
  }
  return {
    needsYou,
    bySpace: [...bySpace].map(([spaceId, count]) => ({ spaceId, needsYou: count })),
    revision: revisionOf(items, snoozed),
    snoozed: snoozed.length,
  };
};

/** Events that can add, change or clear someone's item. Streaming output never does. */
const mayChangeInbox = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("space.") ||
  event.type.startsWith("thread.") ||
  event.type.startsWith("sandbox.") ||
  event.type.startsWith("offer.") ||
  event.type === "runtime-request.updated" ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  (event.type === "turn-item.updated" &&
    (event.payload.type === "secret_request" || event.payload.type === "link_request"));

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* BotService;
  const read = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((cause) => (isInboxError(cause) ? cause : failed(cause))),
    );
  /** Bot reads map to the one Inbox error, so every source has the same error type. */
  const botsRead = <A>(effect: Effect.Effect<A, BotsError>) =>
    effect.pipe(Effect.mapError((cause) => failed(cause)));
  const team = yield* Effect.serviceOption(TeamState.TeamState);
  const serverOwnerId = Option.match(team, { onNone: () => null, onSome: (t) => t.ownerId });
  // Off cloud-only servers every member sees every local thread, so a teammate's is shared too.
  const everyoneSeesLocal = Option.match(yield* Effect.serviceOption(ThreadAccess), {
    onNone: () => true,
    onSome: (access) => !access.enforced,
  });
  /** Members whose stored Done or snooze changed. */
  const writes = yield* PubSub.unbounded<MemberId>();

  const mayOpen = (caller: InboxCaller, threadId: ThreadId) => caller.mayOpen?.(threadId) ?? true;

  const spaceFields = (context: InboxContext, spaceId: SpaceId | undefined) => {
    const space = spaceId === undefined ? undefined : context.spaceById.get(spaceId);
    return space === undefined ? {} : { spaceId: space.id, spaceName: space.name };
  };
  const taskFields = (task: SpaceTask) => ({
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
  });
  /** The space and task of a task thread, when the caller is in its space; `tasks` caches reads. */
  const shellTaskFields = Effect.fnUntraced(function* (
    context: InboxContext,
    shell: OrchestrationV2ThreadShell,
    tasks: Map<SpaceTaskId, SpaceTask | null>,
  ) {
    if (shell.space?.kind !== "task" || !context.spaceById.has(shell.space.spaceId)) return {};
    const taskId = shell.space.taskId;
    if (!tasks.has(taskId)) tasks.set(taskId, yield* read(projections.getSpaceTask(taskId)));
    const task = tasks.get(taskId) ?? null;
    return task === null || task.deletedAt !== null
      ? {}
      : { ...spaceFields(context, task.spaceId), ...taskFields(task) };
  });

  /**
   * Bot fields for a session's request. Null means the item is hidden: the bot still owns the
   * session and hasn't left the request unanswered long enough. Non-bot threads get `{}`.
   */
  const botRequestFields = Effect.fnUntraced(function* (
    threadId: ThreadId,
    requestId: OrchestrationV2PendingRuntimeRequestSummary["id"],
  ) {
    if (BotThreads.sessionBotId(threadId) === undefined) return {};
    const session = Option.getOrNull(yield* botsRead(bots.sessionForThread(threadId)));
    if (session === null) return {};
    if (!session.takenOver && !BotEscalations.isEscalated(threadId, requestId)) return null;
    const bot = Option.getOrNull(yield* botsRead(bots.getBot(session.botId)));
    if (bot === null) return null;
    const job = Option.getOrNull(yield* botsRead(bots.getJob(session.jobId)));
    return {
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      jobId: session.jobId,
      ...(job === null ? {} : { jobNumber: job.number, jobTitle: job.title }),
    };
  });

  const requestItems: InboxSource = Effect.fnUntraced(function* (context) {
    const memberId = context.caller.memberId;
    const threadIds = yield* read(InboxProjection.pendingRequestThreadIds());
    const tasks = new Map<SpaceTaskId, SpaceTask | null>();
    const items: Array<InboxItem> = [];
    for (const threadId of threadIds) {
      if (!mayOpen(context.caller, threadId)) continue;
      // A bot's home thread never lists its requests; sessions list only what the bot left to you.
      if (BotThreads.homeBotId(threadId) !== undefined) continue;
      const shell = yield* read(projections.getThreadShell(threadId));
      const request = shell?.pendingRuntimeRequest ?? null;
      if (shell == null || request === null || shell.deletedAt !== null) continue;
      if (shell.archivedAt !== null) continue;
      const holder = serverOwnerId === null ? shell.ownerId : holderOf(shell, serverOwnerId);
      // Only the holder and the latest prompter are asked; no one else is.
      if (memberId !== holder && memberId !== (shell.latestRunAuthorId ?? holder)) continue;
      const botFields = yield* botRequestFields(threadId, request.id);
      if (botFields === null) continue;
      const question = request.kind === "user_input" || request.kind === "mcp-elicitation";
      const where = yield* shellTaskFields(context, shell, tasks);
      const reason = question ? "question" : "approval";
      items.push({
        id: `${reason}:${threadId}:${request.id}`,
        group: "needs-you",
        reason,
        at: DateTime.formatIso(request.createdAt),
        actorId: null,
        threadId,
        threadTitle: shell.title,
        ...(holder == null ? {} : { threadOwnerId: holder }),
        ...where,
        requestId: request.id,
        ...botFields,
        ...excerpt(yield* read(InboxProjection.requestExcerpt(threadId, request.id))),
      });
    }
    return items;
  });

  const offerItems: InboxSource = Effect.fnUntraced(function* (context) {
    const memberId = context.caller.memberId;
    const offers = yield* read(projections.listOpenOffersForHolder(memberId));
    const tasks = new Map<SpaceTaskId, SpaceTask | null>();
    const items: Array<InboxItem> = [];
    for (const offer of offers) {
      if (!mayOpen(context.caller, offer.sourceThreadId)) continue;
      const shell = yield* read(projections.getThreadShell(offer.sourceThreadId));
      if (shell == null || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const where = yield* shellTaskFields(context, shell, tasks);
      const commits = offer.commits.length;
      items.push({
        id: `offer:${offer.id}`,
        group: "needs-you",
        reason: "offer",
        at: offer.updatedAt,
        actorId: offer.senderId,
        threadId: offer.sourceThreadId,
        threadTitle: shell.title,
        threadOwnerId: memberId,
        ...where,
        offerId: offer.id,
        excerpt: `${commits} ${commits === 1 ? "commit" : "commits"}`,
      });
    }
    return items;
  });

  const taskItems: InboxSource = Effect.fnUntraced(function* (context) {
    const memberId = context.caller.memberId;
    const open = yield* read(projections.listOpenSpaceTasks(context.spaces.map((s) => s.id)));
    const mine = open.filter((task) => task.ownerId === memberId);
    const ids = mine.map((task) => task.id);
    const threadCounts = yield* read(InboxProjection.taskThreadCounts(ids));
    const assignedAt = yield* read(InboxProjection.taskAssignedAt(ids));
    return mine.flatMap((task): ReadonlyArray<InboxItem> => {
      const where = { ...spaceFields(context, task.spaceId), ...taskFields(task) };
      if (task.handedBack !== null && task.handedBack.by !== memberId) {
        return [
          {
            id: `task-handed-back:${task.id}:${task.handedBack.at}`,
            group: "needs-you",
            reason: "task-handed-back",
            at: task.handedBack.at,
            actorId: task.handedBack.by,
            ...where,
            ...excerpt(task.handedBack.reason),
          },
        ];
      }
      const notStarted = task.status === "todo" && (threadCounts.get(task.id) ?? 0) === 0;
      if (!notStarted || task.assignedBy === null || task.assignedBy === memberId) return [];
      return [
        {
          id: `task-assigned:${task.id}`,
          group: "needs-you",
          reason: "task-assigned",
          at: assignedAt.get(task.id) ?? task.updatedAt,
          actorId: task.assignedBy,
          ...where,
        },
      ];
    });
  });

  const mentionItems: InboxSource = Effect.fnUntraced(function* (context) {
    const items: Array<InboxItem> = [];
    for (const space of context.spaces) {
      const posts = yield* read(
        InboxProjection.mentionPosts({
          spaceId: space.id,
          memberId: context.caller.memberId,
          since: context.roomVisits.get(space.id) ?? null,
          limit: ROOM_ITEM_LIMIT,
        }),
      );
      for (const post of posts) {
        items.push({
          id: `mention:${post.entry_id}`,
          group: "for-you",
          reason: "mention",
          at: post.created_at,
          actorId: post.author_id,
          spaceId: space.id,
          spaceName: space.name,
          ...excerpt(post.text),
        });
      }
    }
    return items;
  });

  const pairReplyItems: InboxSource = Effect.fnUntraced(function* (context) {
    const items: Array<InboxItem> = [];
    for (const space of context.spaces) {
      const replies = yield* read(
        InboxProjection.roomReplies({
          roomThreadId: space.roomThreadId,
          since: context.roomVisits.get(space.id) ?? null,
          limit: ROOM_ITEM_LIMIT,
        }),
      );
      // Newest first, so the first reply seen for a post is its latest.
      const latest = new Map<MessageId, (typeof replies)[number]>();
      for (const reply of replies) {
        if (reply.trigger_id === null) continue;
        const post = spaceReplyTrigger(MessageId.make(reply.trigger_id));
        if (!latest.has(post)) latest.set(post, reply);
      }
      const mine = yield* read(
        InboxProjection.memberPostIds(context.caller.memberId, [...latest.keys()]),
      );
      for (const [post, reply] of latest) {
        if (!mine.has(post)) continue;
        items.push({
          id: `pair-reply:${post}`,
          group: "for-you",
          reason: "pair-reply",
          at: reply.created_at,
          actorId: null,
          spaceId: space.id,
          spaceName: space.name,
          ...excerpt(reply.text),
        });
      }
    }
    return items;
  });

  const sharedItems: InboxSource = Effect.fnUntraced(function* (context) {
    const rows = yield* read(
      InboxProjection.sharedThreads({
        memberId: context.caller.memberId,
        serverOwnerId,
        byNameOnly: true,
        everyoneSeesLocal,
      }),
    );
    return rows.flatMap((row): ReadonlyArray<InboxItem> => {
      const threadId = row.thread_id;
      // Opening the thread handles it.
      if (row.last_visited_at !== null || !mayOpen(context.caller, threadId)) return [];
      const at =
        row.shared_at !== null && isoMs(row.shared_at) > isoMs(row.created_at)
          ? row.shared_at
          : row.created_at;
      return [
        {
          id: `shared-with-you:${threadId}`,
          group: "for-you",
          reason: "shared-with-you",
          at,
          actorId:
            row.shared_by !== null && row.shared_by !== context.caller.memberId
              ? row.shared_by
              : row.owner_id,
          threadId,
          threadTitle: row.title,
          threadOwnerId: row.owner_id,
          ...spaceFields(context, row.space_id ?? undefined),
          ...(row.task_id === null ? {} : { taskId: row.task_id }),
        },
      ];
    });
  });

  /** Someone else added the caller and they haven't opened the room since. */
  const addedItems: InboxSource = (context) =>
    Effect.succeed(
      context.spaces.flatMap((space): ReadonlyArray<InboxItem> => {
        const membership = space.members.find(
          (member) => member.memberId === context.caller.memberId && member.removedAt === null,
        );
        if (
          membership === undefined ||
          membership.addedBy === null ||
          membership.addedBy === context.caller.memberId ||
          !newer(membership.joinedAt, context.roomVisits.get(space.id) ?? null)
        ) {
          return [];
        }
        return [
          {
            id: `added-to-space:${space.id}:${membership.joinedAt}`,
            group: "for-you",
            reason: "added-to-space",
            at: membership.joinedAt,
            actorId: membership.addedBy,
            spaceId: space.id,
            spaceName: space.name,
          },
        ];
      }),
    );

  /** Every open Ask of every bot the caller owns. */
  const botAskItems: InboxSource = Effect.fnUntraced(function* (context) {
    const mine = (yield* botsRead(bots.listAllBots())).filter(
      (bot) => bot.ownerId === context.caller.memberId,
    );
    if (mine.length === 0) return [];
    const items: Array<InboxItem> = [];
    for (const bot of mine) {
      const jobs = new Map((yield* botsRead(bots.listJobs(bot.id))).map((job) => [job.id, job]));
      for (const ask of yield* botsRead(bots.listAsks(bot.id))) {
        if (ask.status !== "open") continue;
        const job = ask.jobId === null ? undefined : jobs.get(ask.jobId);
        items.push({
          id: `bot-ask:${ask.id}`,
          group: "needs-you",
          reason: "bot-ask",
          at: ask.createdAt,
          actorId: null,
          botId: bot.id,
          botName: bot.name,
          botColor: bot.color,
          askId: ask.id,
          excerpt: ask.question,
          ...(job === undefined
            ? {}
            : { jobId: job.id, jobNumber: job.number, jobTitle: job.title }),
        });
      }
    }
    return items;
  });

  /** Jobs the caller's bots finished or stopped in the last week. Dismissable, like For you. */
  const botJobDoneItems: InboxSource = Effect.fnUntraced(function* (context) {
    const mine = (yield* botsRead(bots.listAllBots())).filter(
      (bot) => bot.ownerId === context.caller.memberId,
    );
    if (mine.length === 0) return [];
    const since = isoMs(DateTime.formatIso(yield* DateTime.now)) - 7 * 24 * 60 * 60_000;
    const items: Array<InboxItem> = [];
    for (const bot of mine) {
      for (const job of yield* botsRead(bots.listJobs(bot.id))) {
        if (job.status !== "done" && job.status !== "stopped") continue;
        if (job.finishedAt === null || isoMs(job.finishedAt) < since) continue;
        items.push({
          id: `bot-job-done:${job.id}:${job.finishedAt}`,
          group: "for-you",
          reason: "bot-job-done",
          at: job.finishedAt,
          actorId: null,
          botId: bot.id,
          botName: bot.name,
          botColor: bot.color,
          jobId: job.id,
          jobNumber: job.number,
          jobTitle: job.title,
          excerpt: job.headline,
        });
      }
    }
    return items;
  });

  const SOURCES: ReadonlyArray<InboxSource> = [
    requestItems,
    offerItems,
    taskItems,
    mentionItems,
    pairReplyItems,
    sharedItems,
    addedItems,
    botAskItems,
    botJobDoneItems,
  ];

  /** The caller's spaces that count: not archived, and they're still in them. */
  const activeSpaces = Effect.fnUntraced(function* (memberId: MemberId) {
    return (yield* read(projections.listSpaces(memberId))).filter(
      (space) => space.archivedAt === null && isSpaceActiveMember(space, memberId),
    );
  });

  /** Every visible item and every snoozed one, newest first, and when the next one wakes. */
  const collect = Effect.fn("InboxService.collect")(function* (caller: InboxCaller) {
    const memberId = caller.memberId;
    const spaces = yield* activeSpaces(memberId);
    const visits = yield* read(
      InboxProjection.memberVisits({
        memberId,
        serverOwnerId,
        threadIds: spaces.map((space) => space.roomThreadId),
      }),
    );
    const context: InboxContext = {
      caller,
      serverOwnerId,
      spaces,
      spaceById: new Map(spaces.map((space) => [space.id, space])),
      roomVisits: new Map(
        spaces.map((space) => [space.id, visits.get(space.roomThreadId) ?? null]),
      ),
    };
    const found = (yield* Effect.forEach(SOURCES, (source) => source(context))).flat();
    const stored = new Map(
      (yield* read(InboxProjection.memberItems(memberId))).map((row) => [row.item_id, row]),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    /** The stored wake time of a task item snoozed until later, else null. */
    const snoozedUntil = (item: InboxItem) => {
      const until = stored.get(item.id)?.snoozed_until ?? null;
      return until === null || !isTaskItemId(item.id) || isoMs(until) <= now ? null : until;
    };
    const items: Array<InboxItem> = [];
    const snoozed: Array<InboxItem> = [];
    let wakeAt: number | null = null;
    for (const item of found) {
      // A bot's home thread is quiet: never list it, from any source.
      if (item.threadId !== undefined && BotThreads.homeBotId(item.threadId) !== undefined) {
        continue;
      }
      const until = snoozedUntil(item);
      if (until !== null) {
        snoozed.push({ ...item, snoozedUntil: until });
        wakeAt = Math.min(wakeAt ?? Infinity, isoMs(until));
      } else if (
        item.group === "needs-you" ||
        (stored.get(item.id)?.dismissed_at ?? null) === null
      ) {
        items.push(item);
      }
    }
    return {
      items: items.toSorted(byNewest),
      snoozed: snoozed.toSorted(byNewest),
      wakeAt,
    };
  });

  const list: InboxService["Service"]["list"] = Effect.fn("InboxService.list")(
    function* (caller, input) {
      const { items, snoozed } = yield* collect(caller);
      const group = input.group ?? "all";
      const listed = input.snoozed === true ? snoozed : items;
      const inGroup = group === "all" ? listed : listed.filter((item) => item.group === group);
      let start = 0;
      const split = input.cursor?.indexOf("|") ?? -1;
      if (input.cursor !== undefined && split > 0) {
        const at = isoMs(input.cursor.slice(0, split));
        const id = input.cursor.slice(split + 1);
        const after = inGroup.findIndex(
          (item) => isoMs(item.at) < at || (isoMs(item.at) === at && item.id < id),
        );
        start = after === -1 ? inGroup.length : after;
      }
      const limit = input.limit ?? DEFAULT_PAGE;
      const page = inGroup.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor:
          start + limit < inGroup.length && last !== undefined ? `${last.at}|${last.id}` : null,
        summary: summarize(items, snoozed),
      };
    },
  );

  const summary: InboxService["Service"]["summary"] = Effect.fn("InboxService.summary")(
    function* (caller) {
      const { items, snoozed } = yield* collect(caller);
      return summarize(items, snoozed);
    },
  );

  const subscribeSummary: InboxService["Service"]["subscribeSummary"] = (caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Taken before the first read, so no change between the two is missed.
        const after = yield* read(InboxProjection.latestEventSequence());
        const wakes = yield* Queue.sliding<void>(1);
        const wakeTimer = yield* FiberHandle.make<void, never>();
        const recompute = Effect.gen(function* () {
          const { items, snoozed, wakeAt } = yield* collect(caller);
          if (wakeAt === null) {
            yield* FiberHandle.clear(wakeTimer);
          } else {
            const delay = Math.max(0, wakeAt - DateTime.toEpochMillis(yield* DateTime.now));
            yield* FiberHandle.run(
              wakeTimer,
              Effect.sleep(Duration.millis(delay)).pipe(
                Effect.andThen(Queue.offer(wakes, undefined)),
              ),
            );
          }
          return summarize(items, snoozed);
        });
        const changes = Stream.mergeAll(
          [
            orchestrator.streamStoredEventsFrom({ afterSequence: after }).pipe(
              Stream.mapError(failed),
              Stream.filter((stored) => mayChangeInbox(stored.event)),
              Stream.as(undefined),
            ),
            Stream.fromPubSub(writes).pipe(
              Stream.filter((memberId) => memberId === caller.memberId),
              Stream.as(undefined),
            ),
            // Every bots write bumps its owner's Inbox revision (new Ask, job finished, escalation).
            bots.changes.pipe(
              Stream.filter((botOwnerId) => botOwnerId === caller.memberId),
              Stream.as(undefined),
            ),
            Stream.fromQueue(wakes),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.throttle({ cost: () => 1, units: 1, duration: SUMMARY_WINDOW }),
        );
        return Stream.concat(Stream.succeed(undefined), changes).pipe(
          Stream.mapEffect(() => recompute),
          Stream.changesWith((left, right) => left.revision === right.revision),
        );
      }),
    );

  const findItem = Effect.fn("InboxService.findItem")(function* (
    caller: InboxCaller,
    itemId: string,
  ) {
    const { items } = yield* collect(caller);
    const item = items.find((candidate) => candidate.id === itemId);
    if (item === undefined) {
      return yield* new InboxError({ reason: "not-found", message: "That item is gone." });
    }
    return item;
  });

  const dismiss: InboxService["Service"]["dismiss"] = Effect.fn("InboxService.dismiss")(
    function* (caller, input) {
      const item = yield* findItem(caller, input.itemId);
      if (INBOX_NEEDS_YOU_REASONS.has(item.reason)) {
        return yield* new InboxError({
          reason: "not-dismissable",
          message: "Needs you items leave when they're handled.",
        });
      }
      yield* read(
        InboxProjection.writeMemberItem({
          memberId: caller.memberId,
          itemId: item.id,
          dismissedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      yield* PubSub.publish(writes, caller.memberId);
      return {};
    },
  );

  const snooze: InboxService["Service"]["snooze"] = Effect.fn("InboxService.snooze")(
    function* (caller, input) {
      if (!isTaskItemId(input.itemId)) {
        return yield* new InboxError({
          reason: "not-snoozable",
          message: "Snooze the thread to snooze its item.",
        });
      }
      const item = yield* findItem(caller, input.itemId);
      yield* read(
        InboxProjection.writeMemberItem({
          memberId: caller.memberId,
          itemId: item.id,
          snoozedUntil: input.until,
        }),
      );
      yield* PubSub.publish(writes, caller.memberId);
      return {};
    },
  );

  const unsnooze: InboxService["Service"]["unsnooze"] = Effect.fn("InboxService.unsnooze")(
    function* (caller, input) {
      if (!isTaskItemId(input.itemId)) {
        return yield* new InboxError({
          reason: "not-snoozable",
          message: "Only task items snooze in the Inbox.",
        });
      }
      yield* read(
        InboxProjection.writeMemberItem({
          memberId: caller.memberId,
          itemId: input.itemId,
          snoozedUntil: null,
        }),
      );
      yield* PubSub.publish(writes, caller.memberId);
      return {};
    },
  );

  const sharedWithYou: InboxService["Service"]["sharedWithYou"] = Effect.fn(
    "InboxService.sharedWithYou",
  )(function* (caller, input) {
    const query = input.query?.trim().toLowerCase() ?? "";
    const rows = (yield* read(
      InboxProjection.sharedThreads({
        memberId: caller.memberId,
        serverOwnerId,
        byNameOnly: false,
        everyoneSeesLocal,
      }),
    )).filter(
      (row) =>
        mayOpen(caller, row.thread_id) &&
        (input.includeTaskThreads === true || row.task_id === null) &&
        (input.state === undefined || row.state === input.state) &&
        (query.length === 0 || row.title.toLowerCase().includes(query)),
    );
    // Rows come newest first, so each person's first row is their newest.
    const people = new Map<MemberId, SharedWithYouPerson>();
    for (const row of rows) {
      const person = people.get(row.owner_id);
      people.set(row.owner_id, {
        memberId: row.owner_id,
        count: (person?.count ?? 0) + 1,
        lastActivityAt: person?.lastActivityAt ?? row.last_activity_at,
      });
    }
    const rank = new Map([...people.keys()].map((memberId, index) => [memberId, index]));
    const ordered = rows
      .filter((row) => input.personId === undefined || row.owner_id === input.personId)
      .toSorted((left, right) => rank.get(left.owner_id)! - rank.get(right.owner_id)!);
    const start = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10) || 0;
    const limit = input.limit ?? DEFAULT_PAGE;
    const page = ordered.slice(start, start + limit);
    return {
      items: page.map((row): SharedWithYouItem => ({
        threadId: row.thread_id,
        title: row.title,
        ownerId: row.owner_id,
        via: row.via,
        state: row.state,
        lastActivityAt: row.last_activity_at,
        ...(row.space_id === null ? {} : { spaceId: row.space_id }),
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
      })),
      people: [...people.values()],
      nextCursor: start + limit < ordered.length ? String(start + limit) : null,
    };
  });

  const closedTasks: InboxService["Service"]["closedTasks"] = Effect.fn("InboxService.closedTasks")(
    function* (caller) {
      const spaces = yield* activeSpaces(caller.memberId);
      const tasks = yield* read(
        InboxProjection.closedTasks({
          ownerId: caller.memberId,
          spaceIds: spaces.map((space) => space.id),
          limit: MY_TASKS_CLOSED_LIMIT,
        }),
      );
      return { tasks };
    },
  );

  return InboxService.of({
    closedTasks,
    list,
    summary,
    subscribeSummary,
    dismiss,
    snooze,
    unsnooze,
    sharedWithYou,
  });
});

export const layer = Layer.effect(InboxService, make);
