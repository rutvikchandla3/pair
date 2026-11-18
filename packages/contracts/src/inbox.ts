import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  MemberId,
  NonNegativeInt,
  PositiveInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { BotAskId, BotId, BotJobId } from "./bots.ts";
import { SpaceId, SpaceTask, SpaceTaskId, SpaceTaskStatus } from "./space.ts";

export const INBOX_PAGE_LIMIT = 100;
export const MY_TASKS_CLOSED_LIMIT = 50;
export const SHARED_WITH_YOU_PAGE_LIMIT = 100;

/** Needs you: counted. For you: listed, not counted. */
export const InboxGroup = Schema.Literals(["needs-you", "for-you"]);
export type InboxGroup = typeof InboxGroup.Type;

export const InboxItemReason = Schema.Literals([
  "approval",
  "question",
  "task-assigned",
  "task-handed-back",
  "offer",
  "mention",
  "pair-reply",
  "shared-with-you",
  "added-to-space",
  /** A bot's question to you. */
  "bot-ask",
  /** A bot finished or stopped a job. */
  "bot-job-done",
]);
export type InboxItemReason = typeof InboxItemReason.Type;

export const INBOX_NEEDS_YOU_REASONS: ReadonlySet<InboxItemReason> = new Set([
  "approval",
  "question",
  "task-assigned",
  "task-handed-back",
  "offer",
  "bot-ask",
]);

/** Flat and optional, so a reason a client doesn't know is dropped from its list, not an error. */
export const InboxItem = Schema.Struct({
  /** Stable across reads, e.g. `approval:<threadId>:<requestId>`; Done and Snooze key on it. */
  id: TrimmedNonEmptyString,
  group: InboxGroup,
  reason: InboxItemReason,
  at: IsoDateTime,
  /** Who it's from: the assigner, the mentioner, the sharer. Null for an agent's request. */
  actorId: Schema.NullOr(MemberId),
  threadId: Schema.optionalKey(ThreadId),
  threadTitle: Schema.optionalKey(Schema.String),
  threadOwnerId: Schema.optionalKey(MemberId),
  spaceId: Schema.optionalKey(SpaceId),
  spaceName: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(SpaceTaskId),
  taskTitle: Schema.optionalKey(Schema.String),
  taskStatus: Schema.optionalKey(SpaceTaskStatus),
  /** The approval's command, the question, the mention's or reply's text, a hand-back reason. */
  excerpt: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(RuntimeRequestId),
  offerId: Schema.optionalKey(TrimmedNonEmptyString),
  snoozedUntil: Schema.optionalKey(IsoDateTime),
  /**
   * Bot items, and requests from a bot's sessions that it hasn't answered for 10 minutes (or
   * while it's paused) carry the bot and job so rows can show the bot's avatar.
   */
  botId: Schema.optionalKey(BotId),
  botName: Schema.optionalKey(Schema.String),
  botColor: Schema.optionalKey(Schema.String),
  askId: Schema.optionalKey(BotAskId),
  jobId: Schema.optionalKey(BotJobId),
  jobNumber: Schema.optionalKey(PositiveInt),
  jobTitle: Schema.optionalKey(Schema.String),
});
export type InboxItem = typeof InboxItem.Type;

export const InboxSpaceCount = Schema.Struct({
  spaceId: SpaceId,
  needsYou: NonNegativeInt,
});
export type InboxSpaceCount = typeof InboxSpaceCount.Type;

/** `revision` changes whenever the caller's visible items do, For you included. */
export const InboxSummary = Schema.Struct({
  needsYou: NonNegativeInt,
  bySpace: Schema.Array(InboxSpaceCount),
  revision: NonNegativeInt,
  /** Task items snoozed until later. Absent from servers that predate it. */
  snoozed: Schema.optionalKey(NonNegativeInt),
});
export type InboxSummary = typeof InboxSummary.Type;

export const InboxListInput = Schema.Struct({
  group: Schema.optionalKey(Schema.Literals(["all", "needs-you", "for-you"])),
  /** Opaque; from a previous page's `nextCursor`. */
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(INBOX_PAGE_LIMIT))),
  /** Only the task items snoozed until later, each with `snoozedUntil`. */
  snoozed: Schema.optionalKey(Schema.Boolean),
});
export type InboxListInput = typeof InboxListInput.Type;

/** Newest first. */
export const InboxListResult = Schema.Struct({
  items: ForwardCompatibleArray(InboxItem),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  summary: InboxSummary,
});
export type InboxListResult = typeof InboxListResult.Type;

export const InboxItemInput = Schema.Struct({ itemId: TrimmedNonEmptyString });
export type InboxItemInput = typeof InboxItemInput.Type;

/** Task items only: a thread's item snoozes the thread through `thread.snooze`. */
export const InboxSnoozeInput = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  until: IsoDateTime,
});
export type InboxSnoozeInput = typeof InboxSnoozeInput.Type;

/** My tasks' Done and Canceled: the caller's newest closed tasks; open ones come from `spaces.list`. */
export const MyTasksClosedResult = Schema.Struct({
  tasks: Schema.Array(SpaceTask),
});
export type MyTasksClosedResult = typeof MyTasksClosedResult.Type;

export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  reason: Schema.Literals(["not-found", "not-dismissable", "not-snoozable", "failed"]),
  message: Schema.String,
}) {}

export const SharedWithYouState = Schema.Literals(["working", "needs-someone", "idle", "settled"]);
export type SharedWithYouState = typeof SharedWithYouState.Type;

export const SharedWithYouListInput = Schema.Struct({
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(SHARED_WITH_YOU_PAGE_LIMIT)),
  ),
  personId: Schema.optionalKey(MemberId),
  state: Schema.optionalKey(SharedWithYouState),
  /** Matches thread titles, case-insensitively. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Threads on a space task live in their task; this lists them here too. */
  includeTaskThreads: Schema.optionalKey(Schema.Boolean),
});
export type SharedWithYouListInput = typeof SharedWithYouListInput.Type;

export const SharedWithYouItem = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  ownerId: MemberId,
  /** Shared with the caller by name, or through Everyone on the team. */
  via: Schema.Literals(["name", "team"]),
  state: SharedWithYouState,
  lastActivityAt: IsoDateTime,
  spaceId: Schema.optionalKey(SpaceId),
  taskId: Schema.optionalKey(SpaceTaskId),
});
export type SharedWithYouItem = typeof SharedWithYouItem.Type;

/** One row per person with shared threads under the filters, newest activity first. */
export const SharedWithYouPerson = Schema.Struct({
  memberId: MemberId,
  count: NonNegativeInt,
  lastActivityAt: IsoDateTime,
});
export type SharedWithYouPerson = typeof SharedWithYouPerson.Type;

/** Rows are grouped by person (in `people` order), then by last activity. */
export const SharedWithYouListResult = Schema.Struct({
  items: Schema.Array(SharedWithYouItem),
  people: Schema.Array(SharedWithYouPerson),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type SharedWithYouListResult = typeof SharedWithYouListResult.Type;
