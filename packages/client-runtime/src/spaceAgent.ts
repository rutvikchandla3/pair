import {
  type MemberId,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
  type ProviderInstanceConfig,
  type RunId,
  type Space,
  type SpaceAction,
  type SpaceNoteItem,
  type SpaceNoteSection,
  type SpaceNotesChange,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Who reads the wording: the viewer's id, and team names for everyone else. */
interface Viewer {
  readonly memberId: MemberId | null;
  readonly nameOf: (memberId: MemberId) => string;
}

// ── Live notes and actions on the room stream ───────────────────────────

export interface SpaceAgentRoomState {
  readonly notes: ReadonlyArray<SpaceNoteItem>;
  readonly actions: ReadonlyArray<SpaceAction>;
}

export type SpaceAgentEvent =
  | { readonly type: "space.action.updated"; readonly payload: SpaceAction }
  | { readonly type: "space.notes.changed"; readonly payload: SpaceNotesChange };

/** Folds one event in; returns `state` itself when it changes nothing. */
export function applySpaceAgentEvent<S extends SpaceAgentRoomState>(
  state: S,
  event: SpaceAgentEvent,
): S {
  if (event.type === "space.action.updated") {
    const actions = upsertSpaceAction(state.actions, event.payload);
    return actions === state.actions ? state : { ...state, actions };
  }
  const change = event.payload;
  const index = state.notes.findIndex((note) => note.id === change.noteId);
  const current = index < 0 ? null : state.notes[index]!;
  if (change.after === null) {
    // A removal of an older version than the one held lost to a later edit.
    if (current === null || (change.before !== null && current.version > change.before.version)) {
      return state;
    }
    return { ...state, notes: state.notes.filter((note) => note.id !== change.noteId) };
  }
  if (current !== null && current.version >= change.after.version) return state;
  const notes =
    current === null
      ? [...state.notes, change.after]
      : state.notes.map((note, i) => (i === index ? change.after! : note));
  return { ...state, notes };
}

/** A fresh page's actions, with any live update newer than the page's copy kept. */
export function mergeSpaceActions(
  live: ReadonlyArray<SpaceAction>,
  page: ReadonlyArray<SpaceAction>,
): ReadonlyArray<SpaceAction> {
  let merged = page;
  for (const action of live) merged = upsertSpaceAction(merged, action);
  return merged;
}

function upsertSpaceAction(
  actions: ReadonlyArray<SpaceAction>,
  action: SpaceAction,
): ReadonlyArray<SpaceAction> {
  const index = actions.findIndex((existing) => existing.id === action.id);
  if (index < 0) {
    const last = actions.at(-1);
    const next = [...actions, action];
    return last === undefined || last.createdAt <= action.createdAt
      ? next
      : next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  if (actions[index]!.updatedAt > action.updatedAt) return actions;
  return actions.map((existing, i) => (i === index ? action : existing));
}

// ── Replies: the room thread's runs ─────────────────────────────────────

export type SpacePairReplyStatus =
  | "queued"
  | "replying"
  | "done"
  | "failed"
  /** The key or budget hit a limit; the room's queue holds until Retry or the reset. */
  | "limited"
  | "stopped"
  | "cancelled";

export interface SpacePairReply {
  readonly runId: RunId;
  /** The post that tagged `@pair`; retries of it share it. */
  readonly triggerId: MessageId;
  readonly taggerId: MemberId | null;
  readonly status: SpacePairReplyStatus;
  readonly queueHeld: boolean;
  readonly failure: string | null;
  readonly resetAt: string | null;
  /** Pair's assistant text items, in order; their text streams on its own. */
  readonly textItemIds: ReadonlyArray<string>;
  /** When the reply started, for its place in the feed; null while queued. */
  readonly startedAt: string | null;
}

export interface SpacePairRoom {
  /** The latest reply to each tagged post. */
  readonly byTrigger: ReadonlyMap<MessageId, SpacePairReply>;
  /** The reply Pair is working on, if any. */
  readonly replying: SpacePairReply | null;
  /** Replies that started, oldest first. */
  readonly replies: ReadonlyArray<SpacePairReply>;
}

type ProjectionTurnItem = Pick<OrchestrationV2TurnItem, "id" | "runId" | "ordinal"> &
  (
    | { readonly type: "error"; readonly failure: OrchestrationV2ProviderFailure }
    | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "error"> }
  );

export interface SpacePairProjection {
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "userMessageId" | "status" | "queueHeld" | "startedAt"
    >
  >;
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "authorId">>;
  readonly turnItems: ReadonlyArray<ProjectionTurnItem>;
}

const EMPTY_SPACE_PAIR_ROOM: SpacePairRoom = {
  byTrigger: new Map(),
  replying: null,
  replies: [],
};

/** Strips a retry's suffix, as the server's `spaceReplyTrigger` does. */
function spaceReplyTriggerId(messageId: MessageId): MessageId {
  return messageId.replace(/:retry:\d+$/u, "") as MessageId;
}

export function spacePairRoom(projection: SpacePairProjection | null): SpacePairRoom {
  if (projection === null || projection.runs.length === 0) return EMPTY_SPACE_PAIR_ROOM;
  const authors = new Map(projection.messages.map((message) => [message.id, message.authorId]));
  const itemsByRun = new Map<string, ProjectionTurnItem[]>();
  for (const item of projection.turnItems) {
    if (item.runId === null) continue;
    if (item.type !== "assistant_message" && item.type !== "error") continue;
    const items = itemsByRun.get(item.runId);
    if (items === undefined) itemsByRun.set(item.runId, [item]);
    else items.push(item);
  }
  const byTrigger = new Map<MessageId, SpacePairReply>();
  const replies: SpacePairReply[] = [];
  let replying: SpacePairReply | null = null;
  const runs = [...projection.runs].sort((a, b) => a.ordinal - b.ordinal);
  for (const run of runs) {
    const items = [...(itemsByRun.get(run.id) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const error = items.findLast((item) => item.type === "error");
    const failure = error?.type === "error" ? error.failure : null;
    const reply: SpacePairReply = {
      runId: run.id,
      triggerId: spaceReplyTriggerId(run.userMessageId),
      taggerId:
        authors.get(run.userMessageId) ??
        authors.get(spaceReplyTriggerId(run.userMessageId)) ??
        null,
      status: replyStatus(run, failure),
      queueHeld: run.queueHeld === true,
      failure: run.status === "failed" ? (failure?.message ?? "Something went wrong.") : null,
      resetAt: run.status === "failed" ? (failure?.resetAt ?? null) : null,
      textItemIds: items.filter((item) => item.type === "assistant_message").map((item) => item.id),
      startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    };
    byTrigger.set(reply.triggerId, reply);
    if (reply.status === "replying") replying = reply;
    if (reply.startedAt !== null) replies.push(reply);
  }
  return { byTrigger, replying, replies };
}

function replyStatus(
  run: Pick<OrchestrationV2Run, "status">,
  failure: { readonly class: string } | null,
): SpacePairReplyStatus {
  switch (run.status) {
    case "preparing":
    case "queued":
      return "queued";
    case "starting":
    case "running":
    case "waiting":
      return "replying";
    case "completed":
      return "done";
    case "failed":
      return failure?.class === "usage_limit" ? "limited" : "failed";
    case "interrupted":
      return "stopped";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
  }
}

export interface SpacePairStatusLine {
  readonly text: string;
  readonly tone: "muted" | "error";
  readonly control: "cancel" | "stop" | "retry" | null;
}

/**
 * The line under a tagged post while Pair hasn't finished with it. Controls are for the tagger
 * and the space owner, as the server allows.
 */
export function spacePairStatusLine(
  reply: SpacePairReply | undefined,
  room: SpacePairRoom,
  space: Pick<Space, "ownerId">,
  viewer: Viewer,
  formatTime: (iso: string) => string,
): SpacePairStatusLine | null {
  if (reply === undefined) return null;
  const mayControl =
    viewer.memberId !== null &&
    (viewer.memberId === reply.taggerId || viewer.memberId === space.ownerId);
  const who = (memberId: MemberId | null) =>
    memberId === null ? "someone" : memberId === viewer.memberId ? "you" : viewer.nameOf(memberId);
  const control = (value: SpacePairStatusLine["control"]) => (mayControl ? value : null);
  switch (reply.status) {
    case "queued": {
      const ahead = room.replying;
      return {
        text: reply.queueHeld
          ? "Queued · Pair's replies wait until Retry or the reset"
          : ahead === null
            ? "Queued"
            : `Queued · Pair is answering ${who(ahead.taggerId)} first`,
        tone: "muted",
        control: control("cancel"),
      };
    }
    case "replying":
      return {
        text: `Pair is replying to ${who(reply.taggerId)}`,
        tone: "muted",
        control: control("stop"),
      };
    case "failed":
    case "limited":
      return {
        text: `Pair couldn't reply: ${reply.failure ?? "Something went wrong."}${
          reply.resetAt === null ? "" : ` · Resets ${formatTime(reply.resetAt)}`
        }`,
        tone: "error",
        control: control("retry"),
      };
    case "stopped":
      return { text: "Reply stopped", tone: "muted", control: control("retry") };
    case "cancelled":
      return { text: "Cancelled. Pair won't reply", tone: "muted", control: null };
    case "done":
      return null;
  }
}

// ── The feed: replies with their records, cards and receipts ────────────

export interface SpacePairFeedItem {
  readonly key: string;
  /** Where the item sits among the room's entries. */
  readonly createdAt: string;
  readonly reply: SpacePairReply | null;
  readonly actions: ReadonlyArray<SpaceAction>;
}

/**
 * Each started reply with the actions it took, oldest first. Actions render from their records,
 * never from the reply's text; one whose reply this client doesn't hold stands alone.
 */
export function spacePairFeedItems(
  room: SpacePairRoom,
  actions: ReadonlyArray<SpaceAction>,
): ReadonlyArray<SpacePairFeedItem> {
  const byRun = new Map<string, SpaceAction[]>();
  const loose: SpaceAction[] = [];
  const started = new Set(room.replies.map((reply) => reply.runId));
  for (const action of actions) {
    const runId = action.via?.runId;
    if (runId === undefined || !started.has(runId)) {
      loose.push(action);
      continue;
    }
    const list = byRun.get(runId);
    if (list === undefined) byRun.set(runId, [action]);
    else list.push(action);
  }
  const items: SpacePairFeedItem[] = room.replies.map((reply) => ({
    key: reply.runId,
    createdAt: reply.startedAt!,
    reply,
    actions: byRun.get(reply.runId) ?? [],
  }));
  for (const action of loose) {
    items.push({ key: action.id, createdAt: action.createdAt, reply: null, actions: [action] });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── One action: a record, receipt or confirm card ───────────────────────

export type SpaceActionView =
  | {
      readonly kind: "confirm";
      readonly taskId: ThreadId;
      readonly title: string;
      readonly text: string;
      readonly ownerName: string;
      /** The tagger answers; everyone else reads "Waiting for …". */
      readonly canAnswer: boolean;
      readonly waitingFor: string;
      readonly asAdmin: boolean;
    }
  | {
      readonly kind: "record";
      readonly lead: string;
      readonly taskId: ThreadId | null;
      readonly title: string | null;
      readonly detail: string;
      readonly quote: string | null;
      readonly canUndo: boolean;
    }
  | {
      readonly kind: "receipt";
      readonly lines: ReadonlyArray<string>;
      readonly detail: string;
      readonly canUndo: boolean;
    }
  | {
      readonly kind: "closed";
      readonly text: string;
      readonly taskId: ThreadId | null;
      readonly title: string | null;
      /** Fills the tagger's composer; nothing is sent until they send it. */
      readonly askAgain: string | null;
    };

export interface SpaceActionContext {
  readonly viewer: Viewer;
  readonly now: number;
  /** Whether a task has started; null once it is gone or the viewer can't see it. */
  readonly taskStarted: (threadId: ThreadId) => boolean | null;
}

export function spaceActionView(action: SpaceAction, context: SpaceActionContext): SpaceActionView {
  const { viewer } = context;
  const isActor = viewer.memberId === action.actorId;
  const name = (memberId: MemberId, you: string) =>
    memberId === viewer.memberId ? you : viewer.nameOf(memberId);
  const askedBy = `asked by ${name(action.actorId, "you")}`;
  const request = action.request;
  const done = action.outcome !== null && action.outcome.type !== "notes.changed";
  const title = done
    ? (action.outcome as { readonly title: string }).title
    : (action.proposal?.snapshot.title ?? (request.type === "task.create" ? request.title : null));
  const taskId = done
    ? (action.outcome as { readonly threadId: ThreadId }).threadId
    : request.type === "task.message"
      ? request.taskId
      : null;
  const askAgain =
    isActor && request.type === "task.message"
      ? `@pair message ${title ?? "the task"}: ${request.text}`
      : null;
  const expired =
    action.state === "expired" ||
    (action.state === "proposed" &&
      action.proposal !== null &&
      Date.parse(action.proposal.expiresAt) <= context.now);

  if (expired) {
    return {
      kind: "closed",
      text: "This request expired. Nothing was sent",
      taskId,
      title,
      askAgain,
    };
  }
  switch (action.state) {
    case "proposed": {
      if (request.type !== "task.message" || action.proposal === null) break;
      const owner = action.proposal.snapshot.ownerId;
      return {
        kind: "confirm",
        taskId: request.taskId,
        title: action.proposal.snapshot.title,
        text: request.text,
        ownerName: name(owner, "you"),
        canAnswer: isActor,
        waitingFor: viewer.nameOf(action.actorId),
        asAdmin: action.proposal.permission === "admin",
      };
    }
    case "cancelled":
      return {
        kind: "closed",
        text: `${name(action.resolvedBy ?? action.actorId, "You")} cancelled. Nothing changed`,
        taskId: null,
        title: null,
        askAgain: null,
      };
    case "stale":
      return {
        kind: "closed",
        text: `changed before ${name(action.actorId, "you")} answered. Nothing was sent`,
        taskId,
        title,
        askAgain,
      };
    case "undone": {
      const by = action.undo === null ? action.actorId : action.undo.by;
      const kept = action.undo?.notUndone.length ?? 0;
      return {
        kind: "closed",
        text: `${name(by, "You")} undid this${
          action.outcome?.type === "task.created"
            ? ". The task was deleted"
            : action.outcome?.type === "task.message.queued"
              ? ". The message was removed"
              : kept > 0
                ? ` · ${kept === 1 ? "1 note" : `${kept} notes`} changed since, not undone`
                : ""
        }`,
        taskId: action.outcome?.type === "task.created" ? null : taskId,
        title: action.outcome?.type === "task.created" ? null : title,
        askAgain: null,
      };
    }
    case "done":
      break;
  }
  const outcome = action.outcome;
  if (outcome === null) {
    return { kind: "closed", text: "Nothing changed", taskId: null, title: null, askAgain: null };
  }
  if (outcome.type === "notes.changed") {
    return {
      kind: "receipt",
      lines: outcome.changes.map((change) => {
        const verb =
          change.op === "add"
            ? "Added to notes"
            : change.op === "edit"
              ? "Updated a note"
              : "Removed from notes";
        const theirs =
          change.changedMemberNote === null
            ? ""
            : ` · Changed ${name(change.changedMemberNote, "your")}${
                change.changedMemberNote === viewer.memberId ? "" : "'s"
              } note`;
        return `${verb}: “${change.text}”${theirs}`;
      }),
      detail: askedBy,
      canUndo: isActor && action.state === "done",
    };
  }
  const forWhom = `for ${name(outcome.ownerId, "you")}`;
  if (outcome.type === "task.created") {
    const started = context.taskStarted(outcome.threadId);
    return {
      kind: "record",
      lead: "Pair created",
      taskId: outcome.threadId,
      title: outcome.title,
      detail: `${forWhom} · ${askedBy}`,
      quote: null,
      // Undo deletes the task, so it goes once its owner starts it.
      canUndo: isActor && started === false && !outcome.started,
    };
  }
  return {
    kind: "record",
    lead: "Pair messaged",
    taskId: outcome.threadId,
    title: outcome.title,
    detail: `${forWhom} · ${askedBy}`,
    quote: request.type === "task.message" ? request.text : null,
    canUndo: isActor,
  };
}

// ── Notes panel ─────────────────────────────────────────────────────────

const SPACE_NOTE_SECTIONS: ReadonlyArray<{
  readonly id: SpaceNoteSection;
  readonly label: string;
}> = [
  { id: "decision", label: "Decisions" },
  { id: "question", label: "Open questions" },
  { id: "practice", label: "How we work" },
];

export function groupSpaceNotes(notes: ReadonlyArray<SpaceNoteItem>): ReadonlyArray<{
  readonly id: SpaceNoteSection;
  readonly label: string;
  readonly notes: ReadonlyArray<SpaceNoteItem>;
}> {
  return SPACE_NOTE_SECTIONS.flatMap((section) => {
    const items = notes
      .filter((note) => note.section === section.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return items.length === 0 ? [] : [{ ...section, notes: items }];
  });
}

/** "Hanad · added by Pair" / "edited by you": who the note came from and who last touched it. */
export function spaceNoteByline(note: SpaceNoteItem, viewer: Viewer): string {
  const name = (memberId: MemberId, you: string) =>
    memberId === viewer.memberId ? you : viewer.nameOf(memberId);
  const sources = [...new Set(note.sources.map((source) => source.authorId))].map((id) =>
    name(id, "You"),
  );
  const edited = note.lastEditedBy;
  const touched =
    note.version === 1
      ? edited.type === "pair"
        ? "added by Pair"
        : `added by ${name(edited.memberId, "you")}`
      : edited.type === "pair"
        ? "edited by Pair"
        : `edited by ${name(edited.memberId, "you")}`;
  const answerer =
    note.section === "question" && note.answerer !== undefined
      ? `${name(note.answerer, "You")} to answer`
      : null;
  return [answerer, sources.join(", "), touched]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

// ── The team key ────────────────────────────────────────────────────────

/**
 * Whether a server-owned Claude instance holds an API key, the way the server picks the key for
 * `@pair`. Members see the variable redacted, so its presence is enough.
 */
export function hasSpaceTeamClaudeKey(
  instances: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
): boolean {
  return Object.values(instances ?? {}).some(
    (instance) =>
      instance.driver === "claudeAgent" &&
      instance.ownerMemberId === undefined &&
      instance.enabled !== false &&
      instance.environment?.some(
        (variable) =>
          variable.name === "ANTHROPIC_API_KEY" &&
          (typeof variable.value !== "string" ||
            variable.value.trim().length > 0 ||
            variable.valueRedacted === true),
      ) === true,
  );
}

export const SPACE_PAIR_NEEDS_KEY_HINT =
  "@pair needs a Team Claude key. An admin can add one in Settings.";
