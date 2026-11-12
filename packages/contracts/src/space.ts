import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MemberId,
  MessageId,
  PositiveInt,
  ProjectId,
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

/** Whose Claude account pays for `@pair` replies. */
export const SpacePairBilling = Schema.Union([
  Schema.Struct({ type: Schema.Literal("team") }),
  Schema.Struct({ type: Schema.Literal("member"), memberId: MemberId }),
]);
export type SpacePairBilling = typeof SpacePairBilling.Type;

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
  projectId: ProjectId,
  ownerId: MemberId,
  members: Schema.Array(SpaceMember),
  joinRequests: Schema.Array(SpaceJoinRequest),
  pairBilling: SpacePairBilling,
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

/** Where a task's cloud checkout starts: a new branch from `baseRef`, or an existing one. */
export const SpaceTaskBase = Schema.Struct({
  baseRef: TrimmedNonEmptyString,
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

/** A thread's place in a space: its room, or one of its tasks. */
export const ThreadSpace = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("room"),
    spaceId: SpaceId,
    /** The space's `updatedAt`, so a member's shell changes when it is renamed or archived. */
    revision: Schema.optionalKey(IsoDateTime),
    /** Who wrote the room's latest line, and when; a member's own line isn't unread. */
    latestEntry: Schema.optionalKey(Schema.Struct({ by: MemberId, at: IsoDateTime })),
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    spaceId: SpaceId,
    createdBy: MemberId,
    description: TrimmedNonEmptyString,
    base: SpaceTaskBase,
    handedBack: Schema.optionalKey(SpaceTaskHandBack),
    remindedAt: Schema.optionalKey(IsoDateTime),
  }),
]);
export type ThreadSpace = typeof ThreadSpace.Type;
export type ThreadSpaceTask = Extract<ThreadSpace, { readonly kind: "task" }>;

export const SpaceSystemLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("created") }),
  Schema.Struct({ type: Schema.Literal("renamed"), name: SpaceName }),
  Schema.Struct({ type: Schema.Literal("brief-edited") }),
  Schema.Struct({ type: Schema.Literal("project-changed"), projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("billing-changed"), pairBilling: SpacePairBilling }),
  Schema.Struct({ type: Schema.Literal("members-added"), memberIds: Schema.Array(MemberId) }),
  Schema.Struct({ type: Schema.Literal("member-restored"), memberId: MemberId }),
  Schema.Struct({ type: Schema.Literal("member-removed"), memberId: MemberId }),
  Schema.Struct({ type: Schema.Literal("left") }),
  Schema.Struct({ type: Schema.Literal("owner-transferred"), ownerId: MemberId }),
  Schema.Struct({ type: Schema.Literal("archived") }),
  Schema.Struct({ type: Schema.Literal("unarchived") }),
  Schema.Struct({ type: Schema.Literal("task-created"), threadId: ThreadId, ownerId: MemberId }),
  Schema.Struct({
    type: Schema.Literal("task-handed-back"),
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
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
