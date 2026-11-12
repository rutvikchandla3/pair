import * as Schema from "effect/Schema";

import {
  MemberId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  Space,
  SpaceBrief,
  SpaceId,
  SpaceMention,
  SpaceName,
  SpacePairBilling,
  SpaceRoomEntry,
  SpaceTaskBase,
} from "./space.ts";

export const SPACE_ROOM_PAGE_LIMIT = 200;

export class SpaceError extends Schema.TaggedError<SpaceError>()("SpaceError", {
  reason: Schema.Literals([
    "not-found",
    "already-exists",
    "not-member",
    "not-owner",
    "archived",
    "not-archived",
    "owner-cannot-leave",
    "not-a-target-member",
    "already-requested",
    "no-request",
    "quote-not-found",
    "not-a-task",
    "task-started",
    "not-task-creator",
    "not-task-owner",
    "own-task",
    "failed",
  ]),
  message: Schema.String,
}) {}

export const SpaceListResult = Schema.Struct({ spaces: Schema.Array(Space) });
export type SpaceListResult = typeof SpaceListResult.Type;

export const SpaceGetInput = Schema.Struct({
  spaceId: SpaceId,
  /** Older room entries, before this one; omitted for the newest page. */
  before: Schema.optionalKey(MessageId),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(SPACE_ROOM_PAGE_LIMIT))),
});
export type SpaceGetInput = typeof SpaceGetInput.Type;

/** A member sees the space; anyone else sees only enough to ask to join. */
export const SpaceView = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("member"),
    space: Space,
    entries: Schema.Array(SpaceRoomEntry),
    hasMoreEntries: Schema.Boolean,
    /** The space's tasks, newest first, as the viewer may open them. */
    tasks: Schema.Array(OrchestrationV2ThreadShell),
  }),
  Schema.Struct({
    type: Schema.Literal("not_member"),
    spaceId: SpaceId,
    name: SpaceName,
    ownerId: MemberId,
    requested: Schema.Boolean,
    archived: Schema.Boolean,
  }),
]);
export type SpaceView = typeof SpaceView.Type;

const SpaceRef = { spaceId: SpaceId } as const;

export const SpaceMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    name: SpaceName,
    brief: SpaceBrief,
    projectId: ProjectId,
    memberIds: Schema.Array(MemberId),
    pairBilling: Schema.optionalKey(SpacePairBilling),
    /** The room thread's model; `@pair` replies may pick their own. */
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    ...SpaceRef,
    name: Schema.optionalKey(SpaceName),
    brief: Schema.optionalKey(SpaceBrief),
    projectId: Schema.optionalKey(ProjectId),
    pairBilling: Schema.optionalKey(SpacePairBilling),
  }),
  Schema.Struct({ type: Schema.Literal("archive"), ...SpaceRef }),
  Schema.Struct({ type: Schema.Literal("unarchive"), ...SpaceRef }),
  /** `restore` is Undo of a removal. Accepting a join request is an add. */
  Schema.Struct({
    type: Schema.Literal("member.add"),
    ...SpaceRef,
    memberIds: Schema.Array(MemberId),
    restore: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("member.remove"), ...SpaceRef, memberId: MemberId }),
  Schema.Struct({ type: Schema.Literal("owner.transfer"), ...SpaceRef, ownerId: MemberId }),
  Schema.Struct({ type: Schema.Literal("leave"), ...SpaceRef }),
  Schema.Struct({ type: Schema.Literal("join.request"), ...SpaceRef }),
  Schema.Struct({ type: Schema.Literal("join.cancel"), ...SpaceRef }),
]);
export type SpaceMutation = typeof SpaceMutation.Type;

/** The space after the change; null when the caller can no longer see it (they left). */
export const SpaceMutationResult = Schema.Struct({ space: Schema.NullOr(Space) });
export type SpaceMutationResult = typeof SpaceMutationResult.Type;

export const SpacePostInput = Schema.Struct({
  ...SpaceRef,
  /** The client's id, so a retry is not posted twice. */
  messageId: MessageId,
  text: TrimmedNonEmptyString,
  mentions: Schema.Array(SpaceMention),
  quoteEntryId: Schema.optionalKey(MessageId),
});
export type SpacePostInput = typeof SpacePostInput.Type;

export const SpacePostResult = Schema.Struct({ entry: SpaceRoomEntry });
export type SpacePostResult = typeof SpacePostResult.Type;

export const SpaceTaskAction = Schema.Union([
  /** Assigned to the caller, it starts at once; to someone else, it waits for them. */
  Schema.Struct({
    type: Schema.Literal("create"),
    ...SpaceRef,
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    ownerId: MemberId,
    modelSelection: ModelSelection,
    base: SpaceTaskBase,
    runtimeMode: Schema.optionalKey(RuntimeMode),
    interactionMode: Schema.optionalKey(ProviderInteractionMode),
  }),
  /** The owner starts it on their own account, with the model they pick. */
  Schema.Struct({
    type: Schema.Literal("start"),
    threadId: ThreadId,
    modelSelection: Schema.optionalKey(ModelSelection),
  }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    threadId: ThreadId,
    title: Schema.optionalKey(TrimmedNonEmptyString),
    description: Schema.optionalKey(TrimmedNonEmptyString),
    base: Schema.optionalKey(SpaceTaskBase),
  }),
  /** "Can't take it": back to its creator, with a line in the room. */
  Schema.Struct({
    type: Schema.Literal("hand-back"),
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("remind"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("reassign"), threadId: ThreadId, ownerId: MemberId }),
]);
export type SpaceTaskAction = typeof SpaceTaskAction.Type;

export const SpaceTaskResult = Schema.Struct({
  threadId: ThreadId,
  /** Set once the task's first turn was asked for. */
  started: Schema.Boolean,
  sequence: Schema.optionalKey(NonNegativeInt),
});
export type SpaceTaskResult = typeof SpaceTaskResult.Type;
