import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MemberId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const SpaceId = TrimmedNonEmptyString.check(Schema.isPattern(/^spc_[0-9a-f]{20}$/)).pipe(
  Schema.brand("SpaceId"),
);
export type SpaceId = typeof SpaceId.Type;

const SPACE_NAME_MAX_LENGTH = 80;
const SPACE_BRIEF_MAX_LENGTH = 20_000;
const SPACE_POST_MAX_LENGTH = 20_000;

export const SpaceName = TrimmedNonEmptyString.check(Schema.isMaxLength(SPACE_NAME_MAX_LENGTH));
export const SpaceBrief = Schema.String.check(Schema.isMaxLength(SPACE_BRIEF_MAX_LENGTH));

/** A removed member stays listed with `removedAt`, so Undo restores their original `joinedAt`. */
export const SpaceMember = Schema.Struct({
  memberId: MemberId,
  joinedAt: IsoDateTime,
  addedBy: Schema.NullOr(MemberId),
  removedAt: Schema.NullOr(IsoDateTime),
});
export type SpaceMember = typeof SpaceMember.Type;

export const SpaceJoinRequest = Schema.Struct({
  memberId: MemberId,
  requestedAt: IsoDateTime,
});
export type SpaceJoinRequest = typeof SpaceJoinRequest.Type;

export const SPACE_MAX_REPOSITORIES = 8;
export const SpaceRepositoryIds = Schema.Array(ProjectId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SPACE_MAX_REPOSITORIES),
);

export const SpaceMembershipChange = Schema.Struct({
  added: Schema.Array(MemberId),
  removed: Schema.Array(MemberId),
});
export type SpaceMembershipChange = typeof SpaceMembershipChange.Type;

/** Lives on the room thread's stream; `roomThreadId` is that thread. */
export const Space = Schema.Struct({
  id: SpaceId,
  roomThreadId: ThreadId,
  name: SpaceName,
  brief: SpaceBrief,
  /** 1..8 repository projects, in the order picked. */
  repositoryIds: SpaceRepositoryIds,
  /** Where new threads run by default: the one repository, or the resolved workspace. */
  projectId: ProjectId,
  ownerId: MemberId,
  members: Schema.Array(SpaceMember),
  joinRequests: Schema.Array(SpaceJoinRequest),
  createdBy: MemberId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  archivedBy: Schema.NullOr(MemberId),
});
export type Space = typeof Space.Type;

/** Tokens the composer inserts; the server never parses mentions out of text. */
export const SpaceMention = Schema.Union([
  Schema.Struct({ type: Schema.Literal("member"), memberId: MemberId }),
  Schema.Struct({ type: Schema.Literal("pair") }),
]);
export type SpaceMention = typeof SpaceMention.Type;

export const SpaceActionId = TrimmedNonEmptyString.pipe(Schema.brand("SpaceActionId"));
export type SpaceActionId = typeof SpaceActionId.Type;

/** Pair acting for the tagger, within one reply: the run and the post that tagged it. */
export const SpacePairVia = Schema.Struct({ runId: RunId, roomMessageId: MessageId });
export type SpacePairVia = typeof SpacePairVia.Type;

/**
 * Where a thread's cloud checkout starts: a new branch from `baseRef`, or an existing one. No
 * `baseRef` is the repository's default branch; a workspace always starts from its default branches.
 */
export const SpaceTaskBase = Schema.Struct({
  baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  existingBranch: Schema.optionalKey(Schema.Literal(true)),
  /** "Continue pair-be#482": `branch` is that pull request's head. */
  pullRequest: Schema.optionalKey(
    Schema.Struct({ number: PositiveInt, url: Schema.optionalKey(TrimmedNonEmptyString) }),
  ),
});
export type SpaceTaskBase = typeof SpaceTaskBase.Type;

export const SpaceTaskHandBack = Schema.Struct({
  by: MemberId,
  reason: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type SpaceTaskHandBack = typeof SpaceTaskHandBack.Type;

export const SpaceTaskId = TrimmedNonEmptyString.check(Schema.isPattern(/^stk_[0-9a-f]{20}$/)).pipe(
  Schema.brand("SpaceTaskId"),
);
export type SpaceTaskId = typeof SpaceTaskId.Type;

export const SpaceTaskStatus = Schema.Literals([
  "todo",
  "in-progress",
  "in-review",
  "done",
  "canceled",
]);
export type SpaceTaskStatus = typeof SpaceTaskStatus.Type;

export const SpaceTaskTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const SpaceTaskDescription = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));

/** Who moved a status: a person, a thread's agent, or `@pair`. */
export const SpaceStatusActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("member"), memberId: MemberId }),
  Schema.Struct({ type: Schema.Literal("agent"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("pair"), runId: RunId, actionId: SpaceActionId }),
]);
export type SpaceStatusActor = typeof SpaceStatusActor.Type;

/** Lives on the room thread's stream. Threads point at it (`ThreadSpace`), so it lists none. */
export const SpaceTask = Schema.Struct({
  id: SpaceTaskId,
  spaceId: SpaceId,
  title: SpaceTaskTitle,
  description: SpaceTaskDescription,
  ownerId: MemberId,
  createdBy: MemberId,
  createdAt: IsoDateTime,
  /** Who last gave it to `ownerId`; null when the owner took it themselves. */
  assignedBy: Schema.NullOr(MemberId),
  status: SpaceTaskStatus,
  /** +1 on every status write, Undo included; an Undo applies only while it still matches. */
  statusVersion: PositiveInt,
  statusChangedAt: IsoDateTime,
  statusChangedBy: SpaceStatusActor,
  handedBack: Schema.NullOr(SpaceTaskHandBack),
  remindedAt: Schema.NullOr(IsoDateTime),
  /** Set when `@pair` created it; that action's Undo deletes the task. */
  via: Schema.NullOr(SpacePairVia),
  updatedAt: IsoDateTime,
  /** Only `@pair`'s created-task Undo deletes; people cancel instead. */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type SpaceTask = typeof SpaceTask.Type;

export function spaceTaskIsOpen(status: SpaceTaskStatus): boolean {
  return status === "todo" || status === "in-progress" || status === "in-review";
}

export const ThreadSpaceRoom = Schema.Struct({
  kind: Schema.Literal("room"),
  spaceId: SpaceId,
  /** Bumped by every space and task write, so each member's sidebar refetches `spaces.list`. */
  revision: Schema.optionalKey(IsoDateTime),
  /** Who wrote the room's latest line, and when; a member's own line isn't unread. */
  latestEntry: Schema.optionalKey(Schema.Struct({ by: MemberId, at: IsoDateTime })),
});

/** A thread's place in a space: its room, or a link to one of its tasks. */
export const ThreadSpace = Schema.Union([
  ThreadSpaceRoom,
  Schema.Struct({
    kind: Schema.Literal("task"),
    spaceId: SpaceId,
    taskId: SpaceTaskId,
    linkedBy: MemberId,
    linkedAt: IsoDateTime,
    /** "started this thread on" vs "added this thread to". */
    via: Schema.Literals(["start", "attach"]),
  }),
]);
export type ThreadSpace = typeof ThreadSpace.Type;
export type ThreadSpaceTask = Extract<ThreadSpace, { readonly kind: "task" }>;

/** Lines from before v2 carry neither; read them as "nothing reassigned". */
const SpaceReassignFields = {
  reassignedTo: Schema.NullOr(MemberId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  tasks: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
} as const;

export const SpaceSystemLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("created") }),
  Schema.Struct({ type: Schema.Literal("renamed"), name: SpaceName }),
  Schema.Struct({ type: Schema.Literal("brief-edited") }),
  Schema.Struct({
    type: Schema.Literal("repositories-changed"),
    repositoryIds: Schema.Array(ProjectId),
    projectId: ProjectId,
  }),
  Schema.Struct({ type: Schema.Literal("members-added"), memberIds: Schema.Array(MemberId) }),
  Schema.Struct({ type: Schema.Literal("member-restored"), memberId: MemberId }),
  Schema.Struct({
    type: Schema.Literal("member-removed"),
    memberId: MemberId,
    ...SpaceReassignFields,
  }),
  Schema.Struct({ type: Schema.Literal("left"), ...SpaceReassignFields }),
  Schema.Struct({ type: Schema.Literal("owner-transferred"), ownerId: MemberId }),
  Schema.Struct({ type: Schema.Literal("archived") }),
  Schema.Struct({ type: Schema.Literal("unarchived") }),
  Schema.Struct({ type: Schema.Literal("task-created"), taskId: SpaceTaskId, ownerId: MemberId }),
  Schema.Struct({
    type: Schema.Literal("task-handed-back"),
    taskId: SpaceTaskId,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("task-assigned"),
    taskId: SpaceTaskId,
    from: Schema.NullOr(MemberId),
    to: MemberId,
  }),
  /** Title or description. */
  Schema.Struct({ type: Schema.Literal("task-edited"), taskId: SpaceTaskId }),
  /** The entry's `actorId` is the mover, or the asker for an agent's or `@pair`'s move. */
  Schema.Struct({
    type: Schema.Literal("task-status"),
    taskId: SpaceTaskId,
    from: SpaceTaskStatus,
    to: SpaceTaskStatus,
    by: SpaceStatusActor,
    askedBy: Schema.NullOr(MemberId),
    /** The task's `statusVersion` after this move. */
    version: PositiveInt,
    /** Set on an Undo: the line it undid. */
    undoOf: Schema.NullOr(MessageId),
  }),
  Schema.Struct({
    type: Schema.Literal("task-thread-added"),
    taskId: SpaceTaskId,
    threadId: ThreadId,
    threadOwnerId: MemberId,
    via: Schema.Literals(["start", "attach", "move"]),
  }),
  Schema.Struct({
    type: Schema.Literal("task-thread-removed"),
    taskId: SpaceTaskId,
    threadId: ThreadId,
    threadOwnerId: MemberId,
  }),
]);
export type SpaceSystemLine = typeof SpaceSystemLine.Type;

/** Who wrote a post: a person in a client, or an agent or API token (never triggers `@pair`). */
export const SpacePostAuthorKind = Schema.Literals(["user", "agent"]);
export type SpacePostAuthorKind = typeof SpacePostAuthorKind.Type;

export const SpaceRoomEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("post"),
    id: MessageId,
    spaceId: SpaceId,
    authorId: MemberId,
    authorKind: SpacePostAuthorKind,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(SPACE_POST_MAX_LENGTH)),
    mentions: Schema.Array(SpaceMention),
    /** An inline quote-reply; there are no side threads. */
    quote: Schema.optionalKey(
      Schema.Struct({ entryId: MessageId, authorId: MemberId, text: Schema.String }),
    ),
    /** True when this post queued a `@pair` reply. */
    pairRequested: Schema.Boolean,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    id: MessageId,
    spaceId: SpaceId,
    actorId: MemberId,
    line: SpaceSystemLine,
    createdAt: IsoDateTime,
  }),
]);
export type SpaceRoomEntry = typeof SpaceRoomEntry.Type;

export const SPACE_QUOTE_MAX_LENGTH = 280;

export function isSpaceActiveMember(space: Pick<Space, "members">, memberId: MemberId): boolean {
  return space.members.some((member) => member.memberId === memberId && member.removedAt === null);
}

/** Null when the change adds and removes no one. */
export function spaceMembershipChange(
  before: Pick<Space, "members"> | null,
  after: Pick<Space, "members">,
): SpaceMembershipChange | null {
  const was = new Set(before === null ? [] : spaceActiveMemberIds(before));
  const now = new Set(spaceActiveMemberIds(after));
  const added = [...now].filter((memberId) => !was.has(memberId));
  const removed = [...was].filter((memberId) => !now.has(memberId));
  return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

export function spaceActiveMemberIds(space: Pick<Space, "members">): ReadonlyArray<MemberId> {
  return space.members.filter((member) => member.removedAt === null).map((m) => m.memberId);
}
