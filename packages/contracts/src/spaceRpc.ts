import * as Schema from "effect/Schema";

import {
  MemberId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  Space,
  SpaceActionId,
  SpaceBrief,
  SpaceId,
  SpaceMention,
  SpaceName,
  SpaceRepositoryIds,
  SpaceRoomEntry,
  SpaceTask,
  SpaceTaskBase,
  SpaceTaskDescription,
  SpaceTaskId,
  SpaceTaskStatus,
  SpaceTaskTitle,
} from "./space.ts";
import { SpaceAction, SpaceNoteChange, SpaceNoteItem } from "./spaceAgent.ts";

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
    "not-task-creator",
    "not-task-owner",
    "own-task",
    "action-not-found",
    "not-tagger",
    "action-closed",
    "not-undoable",
    "notes-full",
    "note-not-found",
    "note-stale",
    "bad-source",
    "removed-source",
    "over-limit",
    "not-allowed",
    "reply-not-found",
    "no-account",
    "not-thread-owner",
    "not-linkable",
    "too-many-repositories",
    "failed",
  ]),
  message: Schema.String,
}) {}

/** `tasks`: the open tasks of the caller's non-archived spaces, for the sidebar. */
export const SpaceListResult = Schema.Struct({
  spaces: Schema.Array(Space),
  tasks: Schema.Array(SpaceTask),
});
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
    /** Every task that isn't deleted; `space.task.updated` events update them. */
    tasks: Schema.Array(SpaceTask),
    /** The threads on those tasks that the viewer may open. */
    threads: Schema.Array(OrchestrationV2ThreadShell),
    /** Pair's notes; `space.notes.changed` events update them. */
    notes: Schema.Array(SpaceNoteItem),
    /** Records, confirm cards and receipts, newest last; `space.action.updated` updates them. */
    actions: Schema.Array(SpaceAction),
  }),
  Schema.Struct({
    type: Schema.Literal("not_member"),
    spaceId: SpaceId,
    name: SpaceName,
    ownerId: MemberId,
    memberCount: NonNegativeInt,
    requested: Schema.Boolean,
    archived: Schema.Boolean,
  }),
]);
export type SpaceView = typeof SpaceView.Type;

export const SpaceTaskGetInput = Schema.Struct({ spaceId: SpaceId, taskId: SpaceTaskId });
export type SpaceTaskGetInput = typeof SpaceTaskGetInput.Type;

export const SPACE_TASK_ENTRY_LIMIT = 100;

export const SpaceTaskView = Schema.Struct({
  task: SpaceTask,
  threads: Schema.Array(OrchestrationV2ThreadShell),
  /** This task's room lines, the newest `SPACE_TASK_ENTRY_LIMIT`, oldest first. */
  entries: Schema.Array(SpaceRoomEntry),
});
export type SpaceTaskView = typeof SpaceTaskView.Type;

export const SpaceWorkspacePreviewInput = Schema.Struct({
  repositoryIds: SpaceRepositoryIds,
  spaceName: SpaceName,
  workspaceName: Schema.optionalKey(TrimmedNonEmptyString),
  /** Space settings; omitted in New space. */
  spaceId: Schema.optionalKey(SpaceId),
});
export type SpaceWorkspacePreviewInput = typeof SpaceWorkspacePreviewInput.Type;

/** Where the space's threads will run: one repository, a matching workspace, or a new one. */
export const SpaceWorkspacePreview = Schema.Union([
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectId, title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reuse"), projectId: ProjectId, title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("create"), title: Schema.String }),
]);
export type SpaceWorkspacePreview = typeof SpaceWorkspacePreview.Type;

const SpaceRef = { spaceId: SpaceId } as const;
const SpaceTaskRef = { spaceId: SpaceId, taskId: SpaceTaskId } as const;

export const SpaceMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    name: SpaceName,
    brief: SpaceBrief,
    repositoryIds: SpaceRepositoryIds,
    /** The new workspace's name when 2+ repositories match none; the space's name by default. */
    workspaceName: Schema.optionalKey(TrimmedNonEmptyString),
    memberIds: Schema.Array(MemberId),
    /** The room thread's model; `@pair` replies may pick their own. */
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    ...SpaceRef,
    name: Schema.optionalKey(SpaceName),
    brief: Schema.optionalKey(SpaceBrief),
    repositoryIds: Schema.optionalKey(SpaceRepositoryIds),
    workspaceName: Schema.optionalKey(TrimmedNonEmptyString),
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
  /** `reassignTo` takes the removed member's open tasks. */
  Schema.Struct({
    type: Schema.Literal("member.remove"),
    ...SpaceRef,
    memberId: MemberId,
    reassignTo: Schema.optionalKey(MemberId),
  }),
  Schema.Struct({ type: Schema.Literal("owner.transfer"), ...SpaceRef, ownerId: MemberId }),
  Schema.Struct({
    type: Schema.Literal("leave"),
    ...SpaceRef,
    reassignTo: Schema.optionalKey(MemberId),
  }),
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

/** A new thread on a task, on the caller's own account. */
export const SpaceThreadStart = Schema.Struct({
  /** Runs in: a repository or a workspace. */
  projectId: ProjectId,
  modelSelection: ModelSelection,
  base: SpaceTaskBase,
  /** The first message; the task's description, verbatim, by default. */
  text: Schema.optionalKey(TrimmedNonEmptyString),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type SpaceThreadStart = typeof SpaceThreadStart.Type;

export const SpaceTaskAction = Schema.Union([
  /** With `start`, a thread starts too; with no usable account the task is still created. */
  Schema.Struct({
    type: Schema.Literal("create"),
    ...SpaceRef,
    title: SpaceTaskTitle,
    description: SpaceTaskDescription,
    ownerId: MemberId,
    status: Schema.optionalKey(SpaceTaskStatus),
    start: Schema.optionalKey(SpaceThreadStart),
  }),
  Schema.Struct({ type: Schema.Literal("start"), ...SpaceTaskRef, ...SpaceThreadStart.fields }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    ...SpaceTaskRef,
    title: Schema.optionalKey(SpaceTaskTitle),
    description: Schema.optionalKey(SpaceTaskDescription),
  }),
  Schema.Struct({ type: Schema.Literal("reassign"), ...SpaceTaskRef, ownerId: MemberId }),
  /** "Can't take it": back to whoever assigned it, with a line in the room. */
  Schema.Struct({
    type: Schema.Literal("hand-back"),
    ...SpaceTaskRef,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("remind"), ...SpaceTaskRef }),
  Schema.Struct({ type: Schema.Literal("status"), ...SpaceTaskRef, status: SpaceTaskStatus }),
  /** Undo an agent's or `@pair`'s move; `entryId` is its `task-status` line. */
  Schema.Struct({ type: Schema.Literal("status.undo"), ...SpaceTaskRef, entryId: MessageId }),
  /** Add the caller's thread to a task, move it to another, or remove it (`target: null`). */
  Schema.Struct({
    type: Schema.Literal("thread.link"),
    threadId: ThreadId,
    target: Schema.NullOr(Schema.Struct(SpaceTaskRef)),
  }),
]);
export type SpaceTaskAction = typeof SpaceTaskAction.Type;

export const SpaceTaskResult = Schema.Struct({
  /** The task after the change; null after a link removal. */
  task: Schema.NullOr(SpaceTask),
  threadId: Schema.optionalKey(ThreadId),
  /** Set once a thread's first turn was asked for. */
  started: Schema.Boolean,
  sequence: Schema.optionalKey(NonNegativeInt),
});
export type SpaceTaskResult = typeof SpaceTaskResult.Type;

/**
 * Answer a confirm card or Undo a record. The tagger may undo messages and notes; any member may
 * undo a created task. Status Undo is `spaces.task` `status.undo`, not this.
 */
export const SpaceActionInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("answer"),
    actionId: SpaceActionId,
    answer: Schema.Literals(["confirm", "cancel"]),
  }),
  Schema.Struct({ type: Schema.Literal("undo"), actionId: SpaceActionId }),
]);
export type SpaceActionInput = typeof SpaceActionInput.Type;

export const SpaceActionResult = Schema.Struct({ action: SpaceAction });
export type SpaceActionResult = typeof SpaceActionResult.Type;

/** A person edits the notes directly; human edits win over Pair's. */
export const SpaceNotesEditInput = Schema.Struct({
  spaceId: SpaceId,
  changes: Schema.Array(SpaceNoteChange),
});
export type SpaceNotesEditInput = typeof SpaceNotesEditInput.Type;

export const SpaceNotesEditResult = Schema.Struct({ notes: Schema.Array(SpaceNoteItem) });
export type SpaceNotesEditResult = typeof SpaceNotesEditResult.Type;

/** A `@pair` reply's controls: the tagger or the space owner. */
export const SpaceReplyInput = Schema.Struct({
  spaceId: SpaceId,
  runId: RunId,
  action: Schema.Literals(["cancel", "retry", "stop"]),
});
export type SpaceReplyInput = typeof SpaceReplyInput.Type;
