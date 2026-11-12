import {
  isSpaceActiveMember,
  type MemberId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2SpaceCommand,
  type Space,
  SPACE_ACTION_PROPOSAL_TTL_HOURS,
  SPACE_NOTE_MAX_SOURCES,
  SPACE_NOTE_TOMBSTONE_DAYS,
  SPACE_NOTES_MAX_ITEMS,
  type SpaceAction,
  SpaceActionId,
  type SpaceActionTaskSnapshot,
  type SpaceNoteChange,
  type SpaceNoteChangeRecord,
  type SpaceNoteId,
  type SpaceNoteItem,
  type SpaceNoteSource,
  type SpaceNoteTombstone,
  type SpaceNotesChange,
  type SpacePairVia,
  type SpaceWriter,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { SpaceRefusal } from "./SpaceDecisions.ts";

export type SpaceAgentCommand = Extract<
  OrchestrationV2SpaceCommand,
  {
    readonly type:
      | "space.action.propose"
      | "space.action.cancel"
      | "space.action.started"
      | "space.action.undo"
      | "space.notes.edit"
      | "space.reply.retry";
  }
>;

/** Keyed by the post that tagged Pair, so a Retry of the reply finds what it already did. */
export const spaceActionIdFor = (roomMessageId: MessageId, key: string) =>
  SpaceActionId.make(`space-action:${roomMessageId}:${key}`);

/** One notes receipt per reply; every `space_notes_edit` call in it adds to the same one. */
export const spaceNotesReceiptId = (roomMessageId: MessageId) =>
  spaceActionIdFor(roomMessageId, "notes");

/** A retried reply's room-thread message; the post's id with a suffix. */
export const spaceRetryMessageId = (postId: MessageId, retry: number) =>
  MessageId.make(`${postId}:retry:${retry}`);

/** The post a room-thread user message answers: its own id, or a retry's base id. */
export const spaceReplyTrigger = (messageId: MessageId) =>
  MessageId.make(messageId.replace(/:retry:\d+$/, ""));

const hoursLater = (iso: string, hours: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { hours }));

const refuse = (reason: SpaceRefusal) => ({ _tag: "Refuse" as const, reason });

/** A person-written message in the room or in one of the space's tasks; else not a source. */
export interface SpaceSourceLookup {
  readonly source: SpaceNoteSource;
  readonly byPerson: boolean;
}

export interface NotesEditInput {
  readonly space: Space;
  readonly actorId: MemberId;
  readonly via: SpacePairVia | null;
  readonly changes: ReadonlyArray<SpaceNoteChange>;
  readonly notes: ReadonlyArray<SpaceNoteItem>;
  readonly tombstones: ReadonlyArray<SpaceNoteTombstone>;
  readonly sources: ReadonlyMap<MessageId, SpaceSourceLookup>;
  /** This reply's receipt so far, when Pair edits. */
  readonly receipt: SpaceAction | null;
  readonly newNoteId: (index: number) => SpaceNoteId;
  readonly now: string;
}

export type NotesEditDecision =
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | {
      readonly _tag: "Accept";
      readonly changes: ReadonlyArray<SpaceNotesChange>;
      readonly receipt: SpaceAction | null;
    };

/** §5 of spaces-agent.md: caps, 1–3 person sources, versions, tombstones; all or nothing. */
export function decideNotesEdit(input: NotesEditInput): NotesEditDecision {
  const { space, actorId, via, now } = input;
  if (!isSpaceActiveMember(space, actorId)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (input.changes.length === 0) return refuse("not-allowed");
  const writer: SpaceWriter =
    via === null
      ? { type: "member", memberId: actorId }
      : { type: "pair", askedBy: actorId, runId: via.runId };
  const receiptId = via === null ? null : spaceNotesReceiptId(via.roomMessageId);
  const items = new Map(input.notes.map((item) => [item.id, item]));
  const tombstoneCutoff = DateTime.formatIso(
    DateTime.subtract(DateTime.makeUnsafe(now), { days: SPACE_NOTE_TOMBSTONE_DAYS }),
  );
  const liveTombstones = input.tombstones.filter((t) => t.removedAt > tombstoneCutoff);
  const out: Array<SpaceNotesChange> = [];
  const records: Array<SpaceNoteChangeRecord> = [];

  const resolveSources = (ids: ReadonlyArray<MessageId>) => {
    const resolved: Array<SpaceNoteSource> = [];
    for (const id of new Set(ids)) {
      const found = input.sources.get(id);
      if (found === undefined || !found.byPerson) return null;
      resolved.push(found.source);
    }
    return resolved;
  };
  const humanEditor = (item: SpaceNoteItem) =>
    via !== null && item.lastEditedBy.type === "member" ? item.lastEditedBy.memberId : null;

  for (const [index, change] of input.changes.entries()) {
    if (change.op === "add") {
      if (change.sourceIds.length === 0 || change.sourceIds.length > SPACE_NOTE_MAX_SOURCES) {
        return refuse("bad-source");
      }
      const sources = resolveSources(change.sourceIds);
      if (sources === null) return refuse("bad-source");
      if (
        via !== null &&
        change.restoreRemoved !== true &&
        liveTombstones.some(
          (t) =>
            t.section === change.section &&
            t.sourceMessageIds.some((id) => change.sourceIds.includes(id)),
        )
      ) {
        return refuse("removed-source");
      }
      const item: SpaceNoteItem = {
        id: input.newNoteId(index),
        spaceId: space.id,
        section: change.section,
        text: change.text,
        sources,
        ...(change.section === "question" && change.answerer !== undefined
          ? { answerer: change.answerer }
          : {}),
        createdBy: writer,
        lastEditedBy: writer,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      items.set(item.id, item);
      out.push(noteChange(space, item.id, null, item, writer, receiptId, null));
      records.push(record(item, "add", null, 1, null));
      continue;
    }
    const before = items.get(change.noteId);
    if (before === undefined) return refuse("note-not-found");
    if (before.version !== change.version) return refuse("note-stale");
    if (change.op === "remove") {
      items.delete(before.id);
      const tombstone: SpaceNoteTombstone | null =
        via === null
          ? {
              noteId: before.id,
              spaceId: space.id,
              section: before.section,
              text: before.text,
              sourceMessageIds: before.sources.map((source) => source.messageId),
              removedBy: actorId,
              removedAt: now,
            }
          : null;
      out.push(noteChange(space, before.id, before, null, writer, receiptId, tombstone));
      records.push(record(before, "remove", before.version, null, humanEditor(before)));
      continue;
    }
    const added = change.sourceIds === undefined ? [] : resolveSources(change.sourceIds);
    if (added === null) return refuse("bad-source");
    const section = change.section ?? before.section;
    const sources = [
      ...before.sources.filter((s) => !added.some((a) => a.messageId === s.messageId)),
      ...added,
    ].slice(-SPACE_NOTE_MAX_SOURCES);
    const answerer =
      section !== "question"
        ? undefined
        : change.answerer === null
          ? undefined
          : (change.answerer ?? before.answerer);
    const { answerer: _previous, ...rest } = before;
    const after: SpaceNoteItem = {
      ...rest,
      section,
      text: change.text ?? before.text,
      sources,
      ...(answerer === undefined ? {} : { answerer }),
      lastEditedBy: writer,
      version: before.version + 1,
      updatedAt: now,
    };
    items.set(after.id, after);
    out.push(noteChange(space, after.id, before, after, writer, receiptId, null));
    records.push(record(after, "edit", before.version, after.version, humanEditor(before)));
  }
  if (items.size > SPACE_NOTES_MAX_ITEMS) return refuse("notes-full");
  if (via === null || receiptId === null) return { _tag: "Accept", changes: out, receipt: null };

  const previous = input.receipt;
  if (previous !== null && previous.actorId !== actorId) return refuse("not-tagger");
  const previousRecords =
    previous?.outcome?.type === "notes.changed" && previous.state === "done"
      ? previous.outcome.changes
      : [];
  const merged = mergeRecords(previousRecords, records);
  const requested =
    previous?.request.type === "notes.edit"
      ? [...previous.request.changes, ...input.changes]
      : input.changes;
  const receipt: SpaceAction = {
    id: receiptId,
    spaceId: space.id,
    request: { type: "notes.edit", changes: requested },
    actorId,
    via,
    state: "done",
    outcome: { type: "notes.changed", changes: merged },
    proposal: null,
    undo: null,
    resolvedBy: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  return { _tag: "Accept", changes: out, receipt };
}

/** Later changes to the same item keep the first `beforeVersion`, so Undo restores the start. */
const mergeRecords = (
  previous: ReadonlyArray<SpaceNoteChangeRecord>,
  next: ReadonlyArray<SpaceNoteChangeRecord>,
): ReadonlyArray<SpaceNoteChangeRecord> => {
  const byId = new Map(previous.map((r) => [r.noteId, r]));
  for (const change of next) {
    const first = byId.get(change.noteId);
    byId.set(
      change.noteId,
      first === undefined
        ? change
        : {
            ...change,
            op: first.op === "add" ? (change.op === "remove" ? "remove" : "add") : change.op,
            beforeVersion: first.beforeVersion,
            changedMemberNote: first.changedMemberNote ?? change.changedMemberNote,
          },
    );
  }
  return [...byId.values()];
};

const record = (
  item: SpaceNoteItem,
  op: SpaceNoteChangeRecord["op"],
  beforeVersion: number | null,
  afterVersion: number | null,
  changedMemberNote: MemberId | null,
): SpaceNoteChangeRecord => ({
  noteId: item.id,
  op,
  section: item.section,
  text: item.text,
  beforeVersion,
  afterVersion,
  changedMemberNote,
});

const noteChange = (
  space: Space,
  noteId: SpaceNoteId,
  before: SpaceNoteItem | null,
  after: SpaceNoteItem | null,
  writer: SpaceWriter,
  actionId: SpaceAction["id"] | null,
  tombstone: SpaceNoteTombstone | null,
): SpaceNotesChange => ({ spaceId: space.id, noteId, before, after, writer, actionId, tombstone });

/**
 * Undo of a notes receipt: each item goes back to what it was before the reply, unless it changed
 * since. Removed items come back from the `before` the change event kept.
 */
export function decideNotesUndo(input: {
  readonly action: SpaceAction;
  readonly notes: ReadonlyArray<SpaceNoteItem>;
  /** The item as the reply first found it, from its `space.notes.changed` history. */
  readonly beforeById: ReadonlyMap<SpaceNoteId, SpaceNoteItem | null>;
  readonly actorId: MemberId;
  readonly now: string;
}):
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | {
      readonly _tag: "Accept";
      readonly changes: ReadonlyArray<SpaceNotesChange>;
      readonly notUndone: ReadonlyArray<SpaceNoteId>;
    } {
  const { action, now } = input;
  if (action.outcome?.type !== "notes.changed") return refuse("not-undoable");
  const current = new Map(input.notes.map((item) => [item.id, item]));
  const writer: SpaceWriter = { type: "member", memberId: input.actorId };
  const changes: Array<SpaceNotesChange> = [];
  const notUndone: Array<SpaceNoteId> = [];
  for (const change of action.outcome.changes) {
    const now_ = current.get(change.noteId) ?? null;
    const untouched =
      change.afterVersion === null ? now_ === null : now_?.version === change.afterVersion;
    if (!untouched) {
      notUndone.push(change.noteId);
      continue;
    }
    const original = input.beforeById.get(change.noteId) ?? null;
    const restored: SpaceNoteItem | null =
      original === null
        ? null
        : {
            ...original,
            lastEditedBy: writer,
            version: Math.max(original.version, now_?.version ?? 0) + 1,
            updatedAt: now,
          };
    changes.push({
      spaceId: action.spaceId,
      noteId: change.noteId,
      before: now_,
      after: restored,
      writer,
      actionId: action.id,
      tombstone: null,
    });
  }
  return { _tag: "Accept", changes, notUndone };
}

export const spaceTaskSnapshot = (task: {
  readonly id: ThreadId;
  readonly title: string;
  readonly ownerId?: MemberId | null | undefined;
  readonly latestRunId: SpaceActionTaskSnapshot["latestRunId"];
  readonly updatedAt: string;
}): SpaceActionTaskSnapshot | null =>
  task.ownerId == null || task.title.trim().length === 0
    ? null
    : {
        threadId: task.id,
        title: task.title as SpaceActionTaskSnapshot["title"],
        ownerId: task.ownerId,
        latestRunId: task.latestRunId,
        updatedAt: task.updatedAt,
      };

/** A proposal past its 24 hours reads as expired; nothing needs to sweep it. */
export const spaceActionExpired = (action: SpaceAction, now: string) =>
  action.state === "proposed" && action.proposal !== null && action.proposal.expiresAt <= now;

export function decidePropose(input: {
  readonly command: Extract<SpaceAgentCommand, { readonly type: "space.action.propose" }>;
  readonly space: Space;
  readonly existing: SpaceAction | null;
  readonly snapshot: SpaceActionTaskSnapshot | null;
  readonly taskSpaceId: Space["id"] | null;
  readonly now: string;
}):
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | { readonly _tag: "NoOp" }
  | { readonly _tag: "Accept"; readonly action: SpaceAction } {
  const { command, space, now } = input;
  if (input.existing !== null) return { _tag: "NoOp" };
  if (!isSpaceActiveMember(space, command.actorId)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (command.request.type !== "task.message") return refuse("not-allowed");
  if (input.taskSpaceId !== space.id || input.snapshot === null) return refuse("not-a-task");
  if (input.snapshot.latestRunId === null) return refuse("unstarted");
  if (input.snapshot.ownerId === command.actorId) return refuse("own-task");
  return {
    _tag: "Accept",
    action: {
      id: command.actionId,
      spaceId: space.id,
      request: command.request,
      actorId: command.actorId,
      via: command.via,
      state: "proposed",
      outcome: null,
      proposal: {
        snapshot: input.snapshot,
        permission: "space-member",
        expiresAt: hoursLater(now, SPACE_ACTION_PROPOSAL_TTL_HOURS),
      },
      undo: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Pair's message into a task: done at once on the tagger's task, or carrying out a confirm card. */
export function decidePairTaskMessage(input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  readonly space: Space | null;
  readonly taskSpaceId: Space["id"] | null;
  readonly snapshot: SpaceActionTaskSnapshot | null;
  readonly existing: SpaceAction | null;
  readonly now: string;
}):
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  /** The card can't run any more; record why, and send nothing. */
  | { readonly _tag: "Close"; readonly action: SpaceAction }
  | { readonly _tag: "Send"; readonly action: SpaceAction } {
  const { command, space, snapshot, existing, now } = input;
  const via = command.via?.pair;
  const actorId = command.actorId;
  if (via === undefined || actorId === undefined || command.spaceActionId === undefined) {
    return refuse("not-allowed");
  }
  if (space === null || input.taskSpaceId !== space.id || snapshot === null) {
    return refuse("not-a-task");
  }
  if (!isSpaceActiveMember(space, actorId)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (snapshot.latestRunId === null) return refuse("unstarted");
  const done = (base: SpaceAction): SpaceAction => ({
    ...base,
    state: "done",
    outcome: {
      type: "task.message.queued",
      threadId: snapshot.threadId,
      ownerId: snapshot.ownerId,
      title: snapshot.title,
      messageId: command.messageId,
    },
    resolvedBy: existing === null ? null : actorId,
    updatedAt: now,
  });
  if (existing === null) {
    if (snapshot.ownerId !== actorId) return refuse("not-allowed");
    return {
      _tag: "Send",
      action: done({
        id: command.spaceActionId,
        spaceId: space.id,
        request: { type: "task.message", taskId: snapshot.threadId, text: command.text as never },
        actorId,
        via,
        state: "done",
        outcome: null,
        proposal: null,
        undo: null,
        resolvedBy: null,
        createdAt: now,
        updatedAt: now,
      }),
    };
  }
  if (existing.actorId !== actorId) return refuse("not-tagger");
  if (existing.state !== "proposed" || existing.proposal === null) return refuse("action-closed");
  if (existing.request.type !== "task.message" || existing.request.text !== command.text) {
    return refuse("not-allowed");
  }
  const close = (state: SpaceAction["state"]) => ({
    _tag: "Close" as const,
    action: { ...existing, state, resolvedBy: actorId, updatedAt: now },
  });
  if (spaceActionExpired(existing, now)) return close("expired");
  const was = existing.proposal.snapshot;
  if (
    was.threadId !== snapshot.threadId ||
    was.ownerId !== snapshot.ownerId ||
    was.latestRunId !== snapshot.latestRunId
  ) {
    return close("stale");
  }
  return { _tag: "Send", action: done(existing) };
}

/** Pair's task, recorded in the commit that creates it; one per reply in M1 (§14.6). */
export function decideTaskCreateAction(input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;
  readonly space: Space;
  readonly ownerId: MemberId;
  /** Tasks Pair already created for this reply's post, other than this one. */
  readonly othersThisReply: number;
  readonly now: string;
}):
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | { readonly _tag: "Accept"; readonly action: SpaceAction } {
  const { command, space, now } = input;
  const via = command.via?.pair;
  if (
    via === undefined ||
    command.spaceActionId === undefined ||
    command.actorId === undefined ||
    command.space?.kind !== "task"
  ) {
    return refuse("not-allowed");
  }
  if (input.othersThisReply > 0) return refuse("over-limit");
  return {
    _tag: "Accept",
    action: {
      id: command.spaceActionId,
      spaceId: space.id,
      request: {
        type: "task.create",
        title: command.title,
        description: command.space.description as never,
        ownerId: input.ownerId,
        ...(input.ownerId === command.actorId ? { start: true } : {}),
      },
      actorId: command.actorId,
      via,
      state: "done",
      outcome: {
        type: "task.created",
        threadId: command.threadId,
        ownerId: input.ownerId,
        title: command.title,
        // `space.action.started` sets it once the start has gone through.
        started: false,
      },
      proposal: null,
      undo: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Undo of a task or message record: records it once its inverse command has committed. */
export function decideRecordUndo(input: {
  readonly action: SpaceAction;
  readonly actorId: MemberId;
  /** Whether the inverse is in effect: the task deleted, or the queued message removed. */
  readonly reverted: boolean;
  readonly now: string;
}):
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | { readonly _tag: "Accept"; readonly action: SpaceAction } {
  const { action, actorId, now } = input;
  if (action.actorId !== actorId) return refuse("not-tagger");
  if (action.state !== "done") return refuse("not-undoable");
  if (!input.reverted) return refuse("not-undoable");
  return {
    _tag: "Accept",
    action: {
      ...action,
      state: "undone",
      undo: { by: actorId, at: now, notUndone: [] },
      updatedAt: now,
    },
  };
}
