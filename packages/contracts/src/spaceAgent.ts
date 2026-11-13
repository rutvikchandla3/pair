import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MemberId,
  MessageId,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { SpaceActionId, SpaceId, SpacePairVia, SpaceTaskId, SpaceTaskStatus } from "./space.ts";

export const SPACE_NOTES_MAX_ITEMS = 30;
const SPACE_NOTE_MAX_LENGTH = 240;
export const SPACE_NOTE_MAX_SOURCES = 3;
export const SPACE_NOTE_TOMBSTONE_DAYS = 90;
export const SPACE_ACTION_PROPOSAL_TTL_HOURS = 24;

/** Room threads run only on this in-process driver; no picker lists it. */
export const SPACE_AGENT_DRIVER = ProviderDriverKind.make("spaceAgent");
export const SPACE_AGENT_INSTANCE_ID = ProviderInstanceId.make("spaceAgent");
export const SPACE_AGENT_DEFAULT_MODEL = "claude-opus-5-5";

export const SpaceNoteId = TrimmedNonEmptyString.pipe(Schema.brand("SpaceNoteId"));
export type SpaceNoteId = typeof SpaceNoteId.Type;

export const SpaceWriter = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pair"), askedBy: MemberId, runId: RunId }),
  Schema.Struct({ type: Schema.Literal("member"), memberId: MemberId }),
]);
export type SpaceWriter = typeof SpaceWriter.Type;

/** Decisions, Open questions, How we work. */
export const SpaceNoteSection = Schema.Literals(["decision", "question", "practice"]);
export type SpaceNoteSection = typeof SpaceNoteSection.Type;

/** A person's message in the room, or in a task of the space. */
export const SpaceNoteSource = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  authorId: MemberId,
  at: IsoDateTime,
});
export type SpaceNoteSource = typeof SpaceNoteSource.Type;

export const SpaceNoteText = TrimmedNonEmptyString.check(Schema.isMaxLength(SPACE_NOTE_MAX_LENGTH));

export const SpaceNoteItem = Schema.Struct({
  id: SpaceNoteId,
  spaceId: SpaceId,
  section: SpaceNoteSection,
  text: SpaceNoteText,
  sources: Schema.Array(SpaceNoteSource),
  /** Questions only: who should answer. */
  answerer: Schema.optionalKey(MemberId),
  createdBy: SpaceWriter,
  lastEditedBy: SpaceWriter,
  version: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpaceNoteItem = typeof SpaceNoteItem.Type;

/** A note a person removed: Pair may not re-add it from these sources unless the trigger asks. */
export const SpaceNoteTombstone = Schema.Struct({
  noteId: SpaceNoteId,
  spaceId: SpaceId,
  section: SpaceNoteSection,
  text: SpaceNoteText,
  sourceMessageIds: Schema.Array(MessageId),
  removedBy: MemberId,
  removedAt: IsoDateTime,
});
export type SpaceNoteTombstone = typeof SpaceNoteTombstone.Type;

/** One change to the notes; every edit and removal names the version it read. */
export const SpaceNoteChange = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    section: SpaceNoteSection,
    text: SpaceNoteText,
    sourceIds: Schema.Array(MessageId),
    answerer: Schema.optionalKey(MemberId),
    /** The trigger asked to bring back a note a person removed. */
    restoreRemoved: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    op: Schema.Literal("edit"),
    noteId: SpaceNoteId,
    version: PositiveInt,
    section: Schema.optionalKey(SpaceNoteSection),
    text: Schema.optionalKey(SpaceNoteText),
    /** Added to the item's sources; the newest three are kept. */
    sourceIds: Schema.optionalKey(Schema.Array(MessageId)),
    answerer: Schema.optionalKey(Schema.NullOr(MemberId)),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), noteId: SpaceNoteId, version: PositiveInt }),
]);
export type SpaceNoteChange = typeof SpaceNoteChange.Type;

/** What a person or Pair asks `SpaceTasks`/`SpaceNotes` to do. */
export const SpaceActionRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task.create"),
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    ownerId: MemberId,
    /** Starts it on the tagger's own account; only when the tagger owns it. */
    start: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("task.status"),
    taskId: SpaceTaskId,
    status: SpaceTaskStatus,
  }),
  /** Always on the tagger's own account. */
  Schema.Struct({
    type: Schema.Literal("thread.start"),
    taskId: SpaceTaskId,
    text: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.message"),
    threadId: ThreadId,
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("notes.edit"), changes: Schema.Array(SpaceNoteChange) }),
]);
export type SpaceActionRequest = typeof SpaceActionRequest.Type;

export const SpaceNoteChangeRecord = Schema.Struct({
  noteId: SpaceNoteId,
  op: Schema.Literals(["add", "edit", "remove"]),
  section: SpaceNoteSection,
  text: SpaceNoteText,
  beforeVersion: Schema.NullOr(PositiveInt),
  afterVersion: Schema.NullOr(PositiveInt),
  /** "Changed Rutvik's note": a person made the last edit before this one. */
  changedMemberNote: Schema.NullOr(MemberId),
});
export type SpaceNoteChangeRecord = typeof SpaceNoteChangeRecord.Type;

/** What the action did; records render from this, never from the reply's text. */
export const SpaceActionOutcome = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task.created"),
    taskId: SpaceTaskId,
    /** The thread it started; null when it started none. */
    threadId: Schema.NullOr(ThreadId),
    ownerId: MemberId,
    title: TrimmedNonEmptyString,
    started: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("task.status.moved"),
    taskId: SpaceTaskId,
    title: TrimmedNonEmptyString,
    from: SpaceTaskStatus,
    to: SpaceTaskStatus,
    /** The `task-status` room line; Undo goes through `spaces.task` `status.undo`. */
    entryId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.started"),
    taskId: SpaceTaskId,
    threadId: ThreadId,
    title: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.message.queued"),
    threadId: ThreadId,
    ownerId: MemberId,
    title: TrimmedNonEmptyString,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("notes.changed"),
    changes: Schema.Array(SpaceNoteChangeRecord),
  }),
]);
export type SpaceActionOutcome = typeof SpaceActionOutcome.Type;

/** The thread a message proposal targets, as it saw it; Confirm runs only if it still looks the same. */
export const SpaceActionTaskSnapshot = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  ownerId: MemberId,
  latestRunId: Schema.NullOr(RunId),
  updatedAt: IsoDateTime,
});
export type SpaceActionTaskSnapshot = typeof SpaceActionTaskSnapshot.Type;

/**
 * `proposed`: a confirm card waiting for the tagger. `stale`: the task changed before Confirm.
 * A proposal past `expiresAt` reads as expired (`spaceActionView` in `@t3tools/shared`).
 */
export const SpaceActionState = Schema.Literals([
  "proposed",
  "done",
  "cancelled",
  "stale",
  "expired",
  "undone",
]);
export type SpaceActionState = typeof SpaceActionState.Type;

/** A record, confirm card or receipt in the room; one row per action. */
export const SpaceAction = Schema.Struct({
  id: SpaceActionId,
  spaceId: SpaceId,
  request: SpaceActionRequest,
  /** The tagger when Pair acts, else the person acting; only they confirm or undo. */
  actorId: MemberId,
  via: Schema.NullOr(SpacePairVia),
  state: SpaceActionState,
  outcome: Schema.NullOr(SpaceActionOutcome),
  proposal: Schema.NullOr(
    Schema.Struct({
      snapshot: SpaceActionTaskSnapshot,
      /** The power the card relies on, named before anyone uses it. */
      permission: Schema.Literals(["space-member", "admin"]),
      expiresAt: IsoDateTime,
    }),
  ),
  /** Set once undone: notes items that changed since and were left alone. */
  undo: Schema.NullOr(
    Schema.Struct({ by: MemberId, at: IsoDateTime, notUndone: Schema.Array(SpaceNoteId) }),
  ),
  resolvedBy: Schema.NullOr(MemberId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpaceAction = typeof SpaceAction.Type;

export const SpaceNotesChange = Schema.Struct({
  spaceId: SpaceId,
  noteId: SpaceNoteId,
  before: Schema.NullOr(SpaceNoteItem),
  after: Schema.NullOr(SpaceNoteItem),
  writer: SpaceWriter,
  actionId: Schema.NullOr(SpaceActionId),
  /** Set when a person removed the item. */
  tombstone: Schema.NullOr(SpaceNoteTombstone),
});
export type SpaceNotesChange = typeof SpaceNotesChange.Type;
