import {
  type MemberId,
  type MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type Space,
  type SpaceAction,
  type SpaceId,
  type SpaceListResult,
  type SpaceMember,
  type SpaceMention,
  type SpaceMutation,
  type SpaceNoteItem,
  type SpaceRoomEntry,
  type SpaceSystemLine,
  type SpaceTask,
  type SpaceTaskId,
  type SpaceTaskStatus,
  type SpaceWorkspacePreview,
  type TeamClaudeKeyStatus,
  type TeamMember,
  type ThreadId,
  spaceTaskIsOpen,
} from "@t3tools/contracts";
import {
  type SpaceThreadActivity,
  type SpaceThreadActivityInput,
  spaceThreadActivity,
} from "@t3tools/shared/spaceThreadActivity";
import * as DateTime from "effect/DateTime";

import { type SpaceAgentEvent, applySpaceAgentEvent, mergeSpaceActions } from "./spaceAgent.ts";
import { teamAdmins } from "./teamClaudeKey.ts";

export type { SpaceThreadActivity };

export interface SpaceViewer {
  readonly memberId: MemberId | null;
  readonly nameOf: (memberId: MemberId) => string;
}

export type SpaceTone = "muted" | "info" | "input" | "warning" | "error" | "success";

// Stored status: people set it (docs/product/spaces.md#status).

export type SpaceTaskStatusIcon = "empty" | "half" | "three-quarter" | "check" | "x";

export interface SpaceTaskStatusInfo {
  readonly status: SpaceTaskStatus;
  readonly label: string;
  readonly icon: SpaceTaskStatusIcon;
  readonly tone: SpaceTone;
  /** The status menu's shortcut on a focused row. */
  readonly key: "1" | "2" | "3" | "4" | "5";
}

export const SPACE_TASK_STATUSES: ReadonlyArray<SpaceTaskStatusInfo> = [
  { status: "todo", label: "To do", icon: "empty", tone: "muted", key: "1" },
  { status: "in-progress", label: "In progress", icon: "half", tone: "info", key: "2" },
  { status: "in-review", label: "In review", icon: "three-quarter", tone: "success", key: "3" },
  { status: "done", label: "Done", icon: "check", tone: "success", key: "4" },
  { status: "canceled", label: "Canceled", icon: "x", tone: "muted", key: "5" },
];

export function spaceTaskStatusInfo(status: SpaceTaskStatus): SpaceTaskStatusInfo {
  return SPACE_TASK_STATUSES.find((info) => info.status === status)!;
}

/** The status a focused row's 1–5 key picks, or null for any other key. */
export function spaceTaskStatusForKey(key: string): SpaceTaskStatus | null {
  return SPACE_TASK_STATUSES.find((info) => info.key === key)?.status ?? null;
}

// Live activity: derived from a task's threads, never stored.

export type SpaceActivityGlyph =
  | "working"
  | "needs-answer"
  | "needs-approval"
  | "failed"
  | "limited"
  | "stopped";

export interface SpaceActivityView {
  /** Null for idle and for a task with no threads: muted text only. */
  readonly glyph: SpaceActivityGlyph | null;
  readonly tone: SpaceTone;
  readonly text: string;
  /** A thread waits on the viewer, or the viewer was assigned it and hasn't started. */
  readonly needsViewer: boolean;
}

export type SpaceTaskThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "ownerId" | "projectId" | "updatedAt" | "space"
> &
  SpaceThreadActivityInput;

const ACTIVITY_RANK: Record<SpaceThreadActivity["type"], number> = {
  needs: 0,
  failed: 1,
  limited: 2,
  working: 3,
  stopped: 4,
  idle: 5,
};

function memberName(memberId: MemberId, viewer: SpaceViewer, you: string): string {
  return memberId === viewer.memberId ? you : viewer.nameOf(memberId);
}

/** One thread's activity, for a thread row: "Needs Ankur", "Working", "Idle". */
export function spaceThreadActivityView(
  thread: SpaceThreadActivityInput,
  viewer: SpaceViewer,
): SpaceActivityView {
  const activity = spaceThreadActivity(thread);
  switch (activity.type) {
    case "needs": {
      const forViewer = activity.memberId !== null && activity.memberId === viewer.memberId;
      return {
        glyph: activity.reason === "answer" ? "needs-answer" : "needs-approval",
        tone: activity.reason === "answer" ? "input" : "warning",
        text: `Needs ${activity.memberId === null ? "an answer" : memberName(activity.memberId, viewer, "you")}`,
        needsViewer: forViewer,
      };
    }
    case "failed":
      return { glyph: "failed", tone: "error", text: "Failed", needsViewer: false };
    case "limited":
      return { glyph: "limited", tone: "warning", text: "Limited", needsViewer: false };
    case "working":
      return { glyph: "working", tone: "info", text: "Working", needsViewer: false };
    case "stopped":
      return { glyph: "stopped", tone: "muted", text: "Stopped", needsViewer: false };
    case "idle":
      return { glyph: null, tone: "muted", text: "Idle", needsViewer: false };
  }
}

/** The owner was given it by someone else and hasn't started: it waits on them. */
function waitsOnOwner(task: SpaceTask, threadCount: number): boolean {
  return (
    task.status === "todo" &&
    threadCount === 0 &&
    task.assignedBy !== null &&
    task.assignedBy !== task.ownerId
  );
}

/**
 * A task's line 2: the most urgent activity across its threads (needs > failed > limited >
 * working > stopped > idle), or why it has none.
 */
export function spaceTaskActivity(
  threads: ReadonlyArray<SpaceThreadActivityInput>,
  viewer: SpaceViewer,
  task: SpaceTask,
): SpaceActivityView {
  if (threads.length === 0) {
    if (viewer.memberId !== null && task.ownerId === viewer.memberId && waitsOnOwner(task, 0)) {
      return {
        glyph: null,
        tone: "warning",
        text: "Assigned to you · not started",
        needsViewer: true,
      };
    }
    const by =
      task.assignedBy !== null && task.assignedBy !== task.ownerId
        ? ` · assigned by ${memberName(task.assignedBy, viewer, "you")}`
        : "";
    return { glyph: null, tone: "muted", text: `No threads yet${by}`, needsViewer: false };
  }
  const activities = threads.map(spaceThreadActivity);
  const top = activities.reduce((best, next) =>
    ACTIVITY_RANK[next.type] < ACTIVITY_RANK[best.type] ? next : best,
  );
  const count = activities.filter((activity) => activity.type === top.type).length;
  const many = (label: string, single: string) =>
    threads.length === 1 ? single : `${threads.length} threads · ${count} ${label}`;
  switch (top.type) {
    case "needs": {
      const forViewer = top.memberId !== null && top.memberId === viewer.memberId;
      const who = top.memberId === null ? "an answer" : memberName(top.memberId, viewer, "you");
      return {
        glyph: top.reason === "answer" ? "needs-answer" : "needs-approval",
        tone: top.reason === "answer" ? "input" : "warning",
        text: `Needs ${who} · ${top.reason === "answer" ? "has a question" : "wants approval"}`,
        needsViewer: forViewer,
      };
    }
    case "failed":
      return {
        glyph: "failed",
        tone: "error",
        text: top.summary === null ? "Thread failed" : `Thread failed: ${top.summary}`,
        needsViewer: false,
      };
    case "limited":
      return {
        glyph: "limited",
        tone: "warning",
        text: many("limited", "Limited"),
        needsViewer: false,
      };
    case "working":
      return {
        glyph: "working",
        tone: "info",
        text: many("working", "Working"),
        needsViewer: false,
      };
    case "stopped":
      return {
        glyph: "stopped",
        tone: "muted",
        text: many("stopped", "Stopped"),
        needsViewer: false,
      };
    case "idle":
      return {
        glyph: null,
        tone: "muted",
        text:
          threads.length === 1
            ? "Idle"
            : `${threads.length} threads · ${threads.length === 2 ? "both" : "all"} idle`,
        needsViewer: false,
      };
  }
}

/** Threads by the task they are on; threads not on a task are left out. */
export function spaceThreadsByTask<T extends Pick<OrchestrationV2ThreadShell, "space">>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<SpaceTaskId, ReadonlyArray<T>> {
  const byTask = new Map<SpaceTaskId, T[]>();
  for (const thread of threads) {
    if (thread.space?.kind !== "task") continue;
    const list = byTask.get(thread.space.taskId);
    if (list === undefined) byTask.set(thread.space.taskId, [thread]);
    else list.push(thread);
  }
  return byTask;
}

const NO_THREADS: ReadonlyArray<never> = [];

// The Overview panel (docs/product/spaces.md#layout).

export type SpaceOverviewSectionId =
  | "needs-you"
  | "in-review"
  | "in-progress"
  | "todo"
  | "done"
  | "canceled";

export interface SpaceOverviewSection<T> {
  readonly id: SpaceOverviewSectionId;
  readonly label: string;
  readonly collapsedByDefault: boolean;
  /** Canceled is a collapsed band under the list, not a group header. */
  readonly band: boolean;
  readonly rows: ReadonlyArray<SpaceOverviewRow<T>>;
}

export interface SpaceOverviewRow<T> {
  readonly task: SpaceTask;
  readonly threads: ReadonlyArray<T>;
  readonly status: SpaceTaskStatusInfo;
  readonly activity: SpaceActivityView;
  /** The right-hand relative time: the latest change to the task or any of its threads. */
  readonly activityAt: number;
}

const OVERVIEW_SECTIONS: ReadonlyArray<Omit<SpaceOverviewSection<never>, "rows">> = [
  { id: "needs-you", label: "Needs you", collapsedByDefault: false, band: false },
  { id: "in-review", label: "In review", collapsedByDefault: false, band: false },
  { id: "in-progress", label: "In progress", collapsedByDefault: false, band: false },
  { id: "todo", label: "To do", collapsedByDefault: false, band: false },
  { id: "done", label: "Done", collapsedByDefault: true, band: false },
  { id: "canceled", label: "Canceled", collapsedByDefault: true, band: true },
];

function spaceOverviewRow<T extends SpaceTaskThread>(
  task: SpaceTask,
  threads: ReadonlyArray<T>,
  viewer: SpaceViewer,
): SpaceOverviewRow<T> {
  let activityAt = Date.parse(task.updatedAt);
  for (const thread of threads) {
    activityAt = Math.max(activityAt, DateTime.toEpochMillis(thread.updatedAt));
  }
  return {
    task,
    threads,
    status: spaceTaskStatusInfo(task.status),
    activity: spaceTaskActivity(threads, viewer, task),
    activityAt,
  };
}

/**
 * The Overview's sections in order, each most recent first; empty sections are left out. An open
 * task that needs the viewer is under Needs you only.
 */
export function groupSpaceOverview<T extends SpaceTaskThread>(
  tasks: ReadonlyArray<SpaceTask>,
  threadsByTask: ReadonlyMap<SpaceTaskId, ReadonlyArray<T>>,
  viewer: SpaceViewer,
): ReadonlyArray<SpaceOverviewSection<T>> {
  const bySection = new Map<SpaceOverviewSectionId, SpaceOverviewRow<T>[]>();
  for (const task of tasks) {
    if (task.deletedAt !== null) continue;
    const row = spaceOverviewRow(task, threadsByTask.get(task.id) ?? NO_THREADS, viewer);
    const id: SpaceOverviewSectionId =
      row.activity.needsViewer && spaceTaskIsOpen(task.status) ? "needs-you" : task.status;
    const rows = bySection.get(id);
    if (rows === undefined) bySection.set(id, [row]);
    else rows.push(row);
  }
  return OVERVIEW_SECTIONS.flatMap((section) => {
    const rows = bySection.get(section.id);
    return rows === undefined
      ? []
      : [{ ...section, rows: rows.sort((a, b) => b.activityAt - a.activityAt) }];
  });
}

// The sidebar: Assigned to me, and each space's Needs-you sub-rows.

export interface SpaceSidebarSpace<T> {
  readonly spaceId: SpaceId;
  /** Up to two tasks that need the viewer, most recent first. */
  readonly needsYou: ReadonlyArray<SpaceOverviewRow<T>>;
  /** The space's other open tasks: "N more tasks". */
  readonly more: number;
}

export interface SpaceSidebarTasks<T> {
  readonly spaces: ReadonlyMap<SpaceId, SpaceSidebarSpace<T>>;
  /** Open tasks the viewer owns, in non-archived spaces they are still in. */
  readonly assignedToMe: ReadonlyArray<SpaceTask>;
}

const SIDEBAR_NEEDS_YOU_LIMIT = 2;

export function spaceSidebarTasks<T extends SpaceTaskThread>(
  list: SpaceListResult,
  threads: ReadonlyArray<T>,
  viewer: SpaceViewer,
): SpaceSidebarTasks<T> {
  const threadsByTask = spaceThreadsByTask(threads);
  const activeSpaces = new Map(
    list.spaces
      .filter(
        (space) =>
          space.archivedAt === null &&
          space.members.some(
            (member) => member.memberId === viewer.memberId && member.removedAt === null,
          ),
      )
      .map((space) => [space.id, space]),
  );
  const rowsBySpace = new Map<SpaceId, SpaceOverviewRow<T>[]>();
  const openBySpace = new Map<SpaceId, number>();
  const assignedToMe: SpaceTask[] = [];
  for (const task of list.tasks) {
    if (task.deletedAt !== null || !spaceTaskIsOpen(task.status)) continue;
    if (!activeSpaces.has(task.spaceId)) continue;
    openBySpace.set(task.spaceId, (openBySpace.get(task.spaceId) ?? 0) + 1);
    if (viewer.memberId !== null && task.ownerId === viewer.memberId) assignedToMe.push(task);
    const row = spaceOverviewRow(task, threadsByTask.get(task.id) ?? NO_THREADS, viewer);
    if (!row.activity.needsViewer) continue;
    const rows = rowsBySpace.get(task.spaceId);
    if (rows === undefined) rowsBySpace.set(task.spaceId, [row]);
    else rows.push(row);
  }
  const spaces = new Map<SpaceId, SpaceSidebarSpace<T>>();
  for (const [spaceId, open] of openBySpace) {
    const needsYou = (rowsBySpace.get(spaceId) ?? [])
      .sort((a, b) => b.activityAt - a.activityAt)
      .slice(0, SIDEBAR_NEEDS_YOU_LIMIT);
    spaces.set(spaceId, { spaceId, needsYou, more: open - needsYou.length });
  }
  return {
    spaces,
    assignedToMe: assignedToMe.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  };
}

/** The header's avatar stack: the owner, then the others in the order they joined. */
export function orderSpaceMembers(
  space: Pick<Space, "members" | "ownerId">,
): ReadonlyArray<SpaceMember> {
  return space.members
    .filter((member) => member.removedAt === null)
    .sort((a, b) => {
      if (a.memberId === space.ownerId) return -1;
      if (b.memberId === space.ownerId) return 1;
      return Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
    });
}

export function isSpaceOwner(space: Pick<Space, "ownerId">, memberId: MemberId | null): boolean {
  return memberId !== null && space.ownerId === memberId;
}

function isActiveSpaceMember(space: Pick<Space, "members">, memberId: MemberId | null): boolean {
  return (
    memberId !== null &&
    space.members.some((member) => member.memberId === memberId && member.removedAt === null)
  );
}

/** "Kousik", or "Kousik (removed)" for an owner no longer in the space. */
export function spaceMemberLabel(
  space: Pick<Space, "members">,
  memberId: MemberId,
  viewer: SpaceViewer,
): string {
  if (memberId === viewer.memberId) return "You";
  const name = viewer.nameOf(memberId);
  const member = space.members.find((entry) => entry.memberId === memberId);
  return member !== undefined && member.removedAt !== null ? `${name} (removed)` : name;
}

// Mentions. The composer inserts tokens as "@Label"; the server never parses text, so a post
// carries only the tokens whose text is still in the draft.

export interface SpaceMentionToken {
  readonly mention: SpaceMention;
  readonly label: string;
}

export const PAIR_MENTION: SpaceMentionToken = { mention: { type: "pair" }, label: "pair" };

export interface SpaceMentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** The "@que" being typed at the caret, if any: "@" at a word start with no space after it. */
export function spaceMentionQuery(text: string, caret: number): SpaceMentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/u.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + 1);
  if (/\s/u.test(query)) return null;
  return { start: at, end: caret, query };
}

/** `@pair` first, then members whose name starts with the query; the viewer is left out. */
export function spaceMentionCandidates(
  query: string,
  space: Pick<Space, "members" | "ownerId">,
  viewer: SpaceViewer,
): ReadonlyArray<SpaceMentionToken> {
  const needle = query.toLowerCase();
  const matches = (label: string) =>
    label
      .toLowerCase()
      .split(/\s+/u)
      .some((word) => word.startsWith(needle)) || label.toLowerCase().startsWith(needle);
  const members = orderSpaceMembers(space)
    .filter((member) => member.memberId !== viewer.memberId)
    .map((member): SpaceMentionToken => ({
      mention: { type: "member", memberId: member.memberId },
      label: viewer.nameOf(member.memberId),
    }))
    .filter((token) => matches(token.label));
  return matches(PAIR_MENTION.label) ? [PAIR_MENTION, ...members] : members;
}

export function insertSpaceMention(
  text: string,
  query: SpaceMentionQuery,
  token: SpaceMentionToken,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${token.label} `;
  const rest = text.slice(query.end).replace(/^ /u, "");
  return {
    text: text.slice(0, query.start) + inserted + rest,
    caret: query.start + inserted.length,
  };
}

/** The tokens still present in the text, once each, in insertion order. */
export function resolveSpaceMentions(
  text: string,
  inserted: ReadonlyArray<SpaceMentionToken>,
): ReadonlyArray<SpaceMention> {
  const seen = new Set<string>();
  const mentions: SpaceMention[] = [];
  for (const token of inserted) {
    const key = mentionKey(token.mention);
    if (seen.has(key) || findMentionLabel(text, token.label, 0) < 0) continue;
    seen.add(key);
    mentions.push(token.mention);
  }
  return mentions;
}

function mentionKey(mention: SpaceMention): string {
  return mention.type === "pair" ? "pair" : `member:${mention.memberId}`;
}

/** Index of "@label" as a whole token at or after `from`, or -1. */
function findMentionLabel(text: string, label: string, from: number): number {
  const needle = `@${label}`;
  let index = text.indexOf(needle, from);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + needle.length] ?? "";
    if ((before === "" || /\s/u.test(before ?? "")) && !/[\p{L}\p{N}_]/u.test(after)) {
      return index;
    }
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

/** "Kousik will be notified", "Pair replies here", or null with no mentions. */
export function spaceComposerHint(
  mentions: ReadonlyArray<SpaceMention>,
  viewer: SpaceViewer,
): string | null {
  const names = mentions.flatMap((mention) =>
    mention.type === "member" && mention.memberId !== viewer.memberId
      ? [viewer.nameOf(mention.memberId)]
      : [],
  );
  const parts: string[] = [];
  if (mentions.some((mention) => mention.type === "pair")) parts.push("Pair replies here");
  if (names.length > 0) parts.push(`${joinNames(names)} will be notified`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "Kousik", "Kousik and Hanad", "Kousik, Hanad and Ankur". */
function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export type SpacePostSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly mention: SpaceMention; readonly text: string };

/** Splits a post's text so its mention tokens render as mentions; other "@" text stays text. */
export function splitSpacePostText(
  text: string,
  mentions: ReadonlyArray<SpaceMention>,
  nameOf: (memberId: MemberId) => string,
): ReadonlyArray<SpacePostSegment> {
  const tokens = mentions.map((mention) => ({
    mention,
    label: mention.type === "pair" ? PAIR_MENTION.label : nameOf(mention.memberId),
  }));
  const segments: SpacePostSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next: { index: number; token: (typeof tokens)[number] } | null = null;
    for (const token of tokens) {
      const index = findMentionLabel(text, token.label, cursor);
      if (index >= 0 && (next === null || index < next.index)) next = { index, token };
    }
    if (next === null) break;
    if (next.index > cursor) segments.push({ type: "text", text: text.slice(cursor, next.index) });
    const end = next.index + next.token.label.length + 1;
    segments.push({
      type: "mention",
      mention: next.token.mention,
      text: text.slice(next.index, end),
    });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}

function taskCount(count: number): string {
  return count === 1 ? "1 open task" : `${count} open tasks`;
}

/** A space line's words after the actor's name. Task lines read through `spaceRecordText`. */
export function spaceSystemLineText(
  line: Exclude<SpaceSystemLine, { readonly taskId: SpaceTaskId }>,
  viewer: SpaceViewer,
): string {
  const reassigned = (to: MemberId | null, tasks: number) =>
    to === null || tasks === 0
      ? ""
      : ` · gave ${taskCount(tasks)} to ${memberName(to, viewer, "you")}`;
  switch (line.type) {
    case "created":
      return "created the space";
    case "renamed":
      return `renamed the space to ${line.name}`;
    case "brief-edited":
      return "edited the Brief";
    case "repositories-changed":
      return "changed the repositories";
    case "members-added":
      return `added ${joinNames(line.memberIds.map(viewer.nameOf))}`;
    case "member-restored":
      return `added ${viewer.nameOf(line.memberId)} back`;
    case "member-removed":
      return `removed ${viewer.nameOf(line.memberId)}${reassigned(line.reassignedTo, line.tasks)}`;
    case "left":
      return `left the space${reassigned(line.reassignedTo, line.tasks)}`;
    case "owner-transferred":
      return `made ${viewer.nameOf(line.ownerId)} the owner`;
    case "archived":
      return "archived the space";
    case "unarchived":
      return "unarchived the space";
  }
}

export type SpaceTaskLine = Extract<SpaceSystemLine, { readonly taskId: SpaceTaskId }>;

export type SpaceTaskLineEntry = Extract<SpaceRoomEntry, { readonly type: "system" }> & {
  readonly line: SpaceTaskLine;
};

export function isSpaceTaskLineEntry(entry: SpaceRoomEntry): entry is SpaceTaskLineEntry {
  return entry.type === "system" && "taskId" in entry.line;
}

/** A piece of a record line; the client draws `task` as a chip and `thread` as a link. */
export type SpaceRecordSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "task"; readonly taskId: SpaceTaskId }
  | { readonly type: "thread"; readonly threadId: ThreadId; readonly text: string };

export interface SpaceRecordView {
  /** "move" leads with the arrow-in-a-circle, "undo" with ↶. */
  readonly lead: "move" | "undo" | null;
  readonly segments: ReadonlyArray<SpaceRecordSegment>;
  /** An undone move stays, muted, without its Undo. */
  readonly muted: boolean;
}

export interface SpaceRecordContext {
  readonly viewer: SpaceViewer;
  /** The thread view this renders in: its own agent reads "Agent", and it is "this thread". */
  readonly inThread: ThreadId | null;
  /** The task page this renders on: its chip reads "this". */
  readonly onTask: SpaceTaskId | null;
  readonly threadTitle: (threadId: ThreadId) => string | null;
  /** `task-status` lines that a later line undid (`spaceUndoneEntryIds`). */
  readonly undone: ReadonlySet<MessageId>;
}

export function spaceUndoneEntryIds(
  entries: ReadonlyArray<SpaceRoomEntry>,
): ReadonlySet<MessageId> {
  const undone = new Set<MessageId>();
  for (const entry of entries) {
    if (
      entry.type === "system" &&
      entry.line.type === "task-status" &&
      entry.line.undoOf !== null
    ) {
      undone.add(entry.line.undoOf);
    }
  }
  return undone;
}

/**
 * One task line in the room, on the task page or in a thread, as "[actor] moved [chip] to In
 * review · asked by Rutvik". The client appends the time and any Undo (`spaceStatusUndo`).
 */
export function spaceRecordText(
  entry: SpaceTaskLineEntry,
  ctx: SpaceRecordContext,
): SpaceRecordView {
  const { viewer } = ctx;
  const line = entry.line;
  const text = (value: string): SpaceRecordSegment => ({ type: "text", text: value });
  const chip: SpaceRecordSegment =
    ctx.onTask === line.taskId ? text("this") : { type: "task", taskId: line.taskId };
  const person = (memberId: MemberId) => memberName(memberId, viewer, "you");
  const actor = memberName(entry.actorId, viewer, "You");
  const thread = (threadId: ThreadId): ReadonlyArray<SpaceRecordSegment> =>
    ctx.inThread === threadId
      ? []
      : [text(": "), { type: "thread", threadId, text: ctx.threadTitle(threadId) ?? "a thread" }];
  const threadNoun = (threadId: ThreadId) =>
    ctx.inThread === threadId ? "this thread" : "a thread";
  const view = (segments: ReadonlyArray<SpaceRecordSegment>): SpaceRecordView => ({
    lead: null,
    segments,
    muted: false,
  });
  switch (line.type) {
    case "task-created":
      return view(
        line.ownerId === entry.actorId
          ? [text(`${actor} created `), chip]
          : [text(`${actor} created `), chip, text(` and assigned it to ${person(line.ownerId)}`)],
      );
    case "task-assigned":
      return view([text(`${actor} assigned `), chip, text(` to ${person(line.to)}`)]);
    case "task-handed-back":
      return view(
        ctx.onTask === line.taskId
          ? [text(`${actor} handed this back: ${line.reason}`)]
          : [text(`${actor} handed back `), chip, text(`: ${line.reason}`)],
      );
    case "task-edited":
      return view([text(`${actor} edited `), chip]);
    case "task-thread-added": {
      const verb =
        line.via === "start"
          ? `started ${threadNoun(line.threadId)} on `
          : line.via === "attach"
            ? `added ${threadNoun(line.threadId)} to `
            : `moved ${threadNoun(line.threadId)} to `;
      return view([text(`${actor} ${verb}`), chip, ...thread(line.threadId)]);
    }
    case "task-thread-removed":
      return view([
        text(`${actor} removed ${threadNoun(line.threadId)} from `),
        chip,
        ...thread(line.threadId),
      ]);
    case "task-status": {
      const to = spaceTaskStatusInfo(line.to).label;
      if (line.undoOf !== null) {
        const who = line.by.type === "member" ? memberName(line.by.memberId, viewer, "You") : actor;
        return {
          lead: "undo",
          segments: [text(`${who} undid this · `), chip, text(` is back to ${to}`)],
          muted: false,
        };
      }
      const mover =
        line.by.type === "member"
          ? memberName(line.by.memberId, viewer, "You")
          : line.by.type === "pair"
            ? "Pair"
            : ctx.inThread === line.by.threadId
              ? "Agent"
              : (ctx.threadTitle(line.by.threadId) ?? "Agent");
      const asked =
        line.by.type !== "member" && line.askedBy !== null
          ? ` · asked by ${person(line.askedBy)}`
          : "";
      return {
        lead: "move",
        segments: [text(`${mover} moved `), chip, text(` to ${to}${asked}`)],
        muted: ctx.undone.has(entry.id),
      };
    }
  }
}

export type SpaceStatusUndo =
  | {
      readonly state: "available";
      readonly input: {
        readonly spaceId: SpaceId;
        readonly taskId: SpaceTaskId;
        readonly entryId: MessageId;
      };
    }
  | { readonly state: "disabled"; readonly tooltip: string };

const SPACE_STATUS_CHANGED_SINCE = "Status changed since";

/**
 * Undo on an agent's or `@pair`'s status move, for any member, until the status changes again.
 * Null for a person's own move, an undone move, an archived space, or a non-member.
 */
export function spaceStatusUndo(
  entry: SpaceRoomEntry,
  task: Pick<SpaceTask, "id" | "statusVersion" | "deletedAt"> | null,
  space: Pick<Space, "id" | "members" | "archivedAt">,
  viewer: SpaceViewer,
  entries: ReadonlyArray<SpaceRoomEntry>,
): SpaceStatusUndo | null {
  if (entry.type !== "system" || entry.line.type !== "task-status") return null;
  const line = entry.line;
  if (line.by.type === "member" || line.undoOf !== null) return null;
  if (space.archivedAt !== null || !isActiveSpaceMember(space, viewer.memberId)) return null;
  if (task === null || task.id !== line.taskId || task.deletedAt !== null) return null;
  if (spaceUndoneEntryIds(entries).has(entry.id)) return null;
  if (task.statusVersion !== line.version) {
    return { state: "disabled", tooltip: SPACE_STATUS_CHANGED_SINCE };
  }
  return { state: "available", input: { spaceId: space.id, taskId: task.id, entryId: entry.id } };
}

type SpaceTaskPullRequests = Pick<OrchestrationV2ThreadShell, "pullRequests">;

/** "pair-be#471" from "interviewstreet/pair-be" and 471. */
export function spacePullRequestLabel(pullRequest: {
  readonly repository: string;
  readonly number: number;
}) {
  return `${pullRequest.repository.split("/").at(-1)}#${pullRequest.number}`;
}

/**
 * A quiet "pair-be#471 merged · Mark Done" when a thread's pull request merged after the status
 * last changed. Merging never moves status on its own.
 */
export function spaceMergedSuggestion(
  task: Pick<SpaceTask, "status" | "statusChangedAt">,
  threads: ReadonlyArray<SpaceTaskPullRequests>,
): { readonly text: string; readonly action: "Mark Done"; readonly status: "done" } | null {
  if (task.status === "done" || task.status === "canceled") return null;
  const since = Date.parse(task.statusChangedAt);
  let latest: { readonly label: string; readonly at: number } | null = null;
  for (const thread of threads) {
    for (const link of thread.pullRequests ?? []) {
      const snapshot = link.snapshot;
      if (link.source === "stack-dismissed" || snapshot?.state !== "merged") continue;
      const at = Date.parse(snapshot.mergedAt ?? snapshot.updatedAt ?? snapshot.syncedAt);
      if (!(at > since) || (latest !== null && latest.at >= at)) continue;
      latest = { label: spacePullRequestLabel(link), at };
    }
  }
  return latest === null
    ? null
    : { text: `${latest.label} merged`, action: "Mark Done", status: "done" };
}

// Where threads run (docs/product/spaces.md#repositories-and-where-threads-run).

export interface SpaceProjectRef {
  readonly id: ProjectId;
  readonly title: string;
}

/** The muted "pair-be" / "Question creation" on every thread row; null for an unknown project. */
export function spaceThreadRunsIn(
  thread: Pick<OrchestrationV2ThreadShell, "projectId">,
  projects: ReadonlyArray<SpaceProjectRef>,
): string | null {
  return projects.find((project) => project.id === thread.projectId)?.title ?? null;
}

/** New space's and Space settings' sentence under Repositories. */
export function spaceWorkspaceLine(
  preview: SpaceWorkspacePreview,
  repositoryNames: ReadonlyArray<string>,
): string {
  switch (preview.type) {
    case "project":
      return `Threads run in ${preview.title}.`;
    case "reuse":
      return `Uses the workspace ${preview.title}, which has the same repositories.`;
    case "create":
      return `Creates the workspace ${preview.title} with ${joinNames(repositoryNames)}.`;
  }
}

/** The room header's "where threads run": the name is left out when it equals the space's. */
export function spaceHeaderWorkspaceLabel(
  space: Pick<Space, "name" | "repositoryIds">,
  project: Pick<SpaceProjectRef, "title"> | null,
  repositoryNames: ReadonlyArray<string>,
): {
  readonly icon: "workspace" | "folder";
  readonly name: string | null;
  readonly repositories: string | null;
} {
  if (space.repositoryIds.length <= 1) {
    return {
      icon: "folder",
      name: project?.title ?? repositoryNames[0] ?? null,
      repositories: null,
    };
  }
  const name = project === null || project.title === space.name ? null : project.title;
  return { icon: "workspace", name, repositories: repositoryNames.join(", ") };
}

/** Add to task's confirm: who will see the thread, and how to stop sharing it. */
export function spaceAttachConfirmCopy(
  space: Pick<Space, "members" | "ownerId" | "name">,
  viewer: SpaceViewer,
  runsIn: string | null,
): { readonly description: string; readonly action: "Add and share" } {
  const others = orderSpaceMembers(space)
    .filter((member) => member.memberId !== viewer.memberId)
    .map((member) => viewer.nameOf(member.memberId));
  const who =
    others.length === 0
      ? `No one else is in ${space.name} yet.`
      : `${joinNames(others)} will see this thread. They can message its agent; turns run on your Claude account.`;
  const where = runsIn === null ? "" : ` It keeps running in ${runsIn}.`;
  return {
    description: `${who}${where} Remove it from the task to stop sharing.`,
    action: "Add and share",
  };
}

// "Ask Rutvik" for a Team Claude key (docs/product/spaces.md#the-team-claude-key).

const SPACE_ASK_ADMIN_TEXT = "can you add a Team Claude key? Settings → Team";

export interface SpaceAskAdmin {
  readonly admin: TeamMember;
  /** "Ask Rutvik". */
  readonly label: string;
  /** Composer text and its mention token: "@Rutvik can you add a Team Claude key? Settings → Team". */
  readonly draft: { readonly text: string; readonly tokens: ReadonlyArray<SpaceMentionToken> };
}

/** The space owner if they are an admin, else whoever added the key, else the first admin. */
export function spaceAskAdmin(
  space: Pick<Space, "ownerId"> | null,
  members: Iterable<TeamMember>,
  keyStatus: TeamClaudeKeyStatus | null,
): SpaceAskAdmin | null {
  const admins = teamAdmins(members);
  const admin =
    admins.find((member) => member.id === space?.ownerId) ??
    admins.find((member) => keyStatus?.state === "set" && member.id === keyStatus.addedBy) ??
    admins[0];
  if (admin === undefined) return null;
  const token: SpaceMentionToken = {
    mention: { type: "member", memberId: admin.id },
    label: admin.name,
  };
  return {
    admin,
    label: `Ask ${admin.name}`,
    draft: { text: `@${admin.name} ${SPACE_ASK_ADMIN_TEXT}`, tokens: [token] },
  };
}

/** When the viewer last opened each room, from the room shells, for `spaceAskTargetSpace`. */
export function spaceRoomVisits(
  shells: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "space" | "lastVisitedAt">>,
): ReadonlyMap<SpaceId, number> {
  const visits = new Map<SpaceId, number>();
  for (const shell of shells) {
    if (shell.space?.kind !== "room" || shell.lastVisitedAt == null) continue;
    visits.set(shell.space.spaceId, DateTime.toEpochMillis(shell.lastVisitedAt));
  }
  return visits;
}

/** Where Settings' Ask drafts: the most recently opened unarchived space shared with the admin. */
export function spaceAskTargetSpace(
  spaces: ReadonlyArray<Space>,
  viewerId: MemberId | null,
  adminId: MemberId,
  roomVisits: ReadonlyMap<SpaceId, number>,
): Space | null {
  let best: { readonly space: Space; readonly at: number } | null = null;
  for (const space of spaces) {
    if (space.archivedAt !== null) continue;
    if (!isActiveSpaceMember(space, viewerId) || !isActiveSpaceMember(space, adminId)) continue;
    const at = roomVisits.get(space.id) ?? Date.parse(space.updatedAt);
    if (best === null || at > best.at) best = { space, at };
  }
  return best?.space ?? null;
}

/** The composer's state while `@pair` has no key: Add key in place for an admin, Ask for others. */
export function spacePairOffHint(
  keyStatus: TeamClaudeKeyStatus | null,
  canManageKey: boolean,
  ask: SpaceAskAdmin | null,
): {
  readonly text: string;
  readonly action:
    | { readonly type: "add-key" }
    | { readonly type: "ask"; readonly ask: SpaceAskAdmin }
    | null;
} | null {
  if (keyStatus === null || keyStatus.state === "set") return null;
  return {
    text: SPACE_PAIR_OFF_HINT,
    action: canManageKey ? { type: "add-key" } : ask === null ? null : { type: "ask", ask },
  };
}

export const SPACE_PAIR_OFF_HINT = "@pair is off · needs a Team Claude key";
/** The mention menu's reason beside a greyed Pair. */
export const SPACE_PAIR_OFF_REASON = "Needs a Team Claude key";

// The room's live state: the `spaces.get` page, then the room thread's own events. A resync
// folds a fresh page in.

export type SpaceRoomState =
  | {
      readonly type: "member";
      readonly space: Space;
      readonly entries: ReadonlyArray<SpaceRoomEntry>;
      readonly hasMoreEntries: boolean;
      /** Every task that isn't deleted. */
      readonly tasks: ReadonlyArray<SpaceTask>;
      /** The page's threads on those tasks; merge the live shells in with `mergeSpaceThreads`. */
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
      readonly notes: ReadonlyArray<SpaceNoteItem>;
      readonly actions: ReadonlyArray<SpaceAction>;
    }
  | {
      readonly type: "not_member";
      readonly spaceId: Space["id"];
      readonly name: string;
      readonly ownerId: MemberId;
      readonly memberCount: number;
      readonly requested: boolean;
      readonly archived: boolean;
    };

export type SpaceRoomMemberState = Extract<SpaceRoomState, { readonly type: "member" }>;

/** Pages loaded with "Load earlier", ending just before the live page's first entry `anchorId`. */
export interface SpaceOlderEntries {
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly hasMore: boolean;
  readonly anchorId: SpaceRoomEntry["id"];
}

/**
 * The older pages that still join the live page. A resync or a fresh subscription can start the
 * live page later, leaving a gap Load earlier would never fill, so those pages are dropped.
 */
export function joinedSpaceOlderEntries(
  older: SpaceOlderEntries | null,
  live: ReadonlyArray<SpaceRoomEntry>,
): SpaceOlderEntries | null {
  return older !== null && live[0]?.id === older.anchorId ? older : null;
}

/** Folds a fresh page in, keeping live entries newer than its last one and newer task copies. */
export function mergeSpaceRoomView(
  current: SpaceRoomState | null,
  view: SpaceRoomState,
): SpaceRoomState {
  if (view.type === "not_member" || current === null || current.type !== "member") return view;
  const ids = new Set(view.entries.map((entry) => entry.id));
  const last = view.entries.at(-1);
  const newer = current.entries.filter(
    (entry) =>
      !ids.has(entry.id) &&
      (last === undefined || Date.parse(entry.createdAt) >= Date.parse(last.createdAt)),
  );
  // The page holds every live task; a live copy wins only where it's newer.
  const live = new Map(current.tasks.map((task) => [task.id, task]));
  const tasks = view.tasks.map((task) => {
    const copy = live.get(task.id);
    return copy !== undefined && Date.parse(copy.updatedAt) > Date.parse(task.updatedAt)
      ? copy
      : task;
  });
  return {
    ...view,
    space: newerSpace(current.space, view.space),
    entries: newer.length === 0 ? view.entries : sortEntries([...view.entries, ...newer]),
    tasks,
    actions: mergeSpaceActions(current.actions, view.actions),
  };
}

export type SpaceRoomEvent =
  | { readonly type: "space.updated"; readonly payload: Space }
  | { readonly type: "space.room-entry"; readonly payload: SpaceRoomEntry }
  | { readonly type: "space.task.updated"; readonly payload: SpaceTask }
  | SpaceAgentEvent;

const SPACE_ROOM_EVENT_TYPES: ReadonlySet<string> = new Set<SpaceRoomEvent["type"]>([
  "space.updated",
  "space.room-entry",
  "space.task.updated",
  "space.action.updated",
  "space.notes.changed",
]);

export function isSpaceRoomEvent(event: { readonly type: string }): event is SpaceRoomEvent {
  return SPACE_ROOM_EVENT_TYPES.has(event.type);
}

export function applySpaceRoomEvent(
  state: SpaceRoomMemberState,
  event: SpaceRoomEvent,
): SpaceRoomMemberState {
  switch (event.type) {
    case "space.action.updated":
    case "space.notes.changed":
      return applySpaceAgentEvent(state, event);
    case "space.updated": {
      const space = newerSpace(state.space, event.payload);
      return space === state.space ? state : { ...state, space };
    }
    case "space.task.updated": {
      const tasks = upsertSpaceTask(state.tasks, event.payload);
      return tasks === state.tasks ? state : { ...state, tasks };
    }
    case "space.room-entry": {
      const entry = event.payload;
      if (state.entries.some((existing) => existing.id === entry.id)) return state;
      const last = state.entries.at(-1);
      const entries =
        last === undefined || Date.parse(entry.createdAt) >= Date.parse(last.createdAt)
          ? [...state.entries, entry]
          : sortEntries([...state.entries, entry]);
      return { ...state, entries };
    }
  }
}

/** By id, newest `updatedAt` wins; a deleted task leaves the list. */
function upsertSpaceTask(
  tasks: ReadonlyArray<SpaceTask>,
  task: SpaceTask,
): ReadonlyArray<SpaceTask> {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0 && Date.parse(tasks[index]!.updatedAt) > Date.parse(task.updatedAt)) return tasks;
  if (task.deletedAt !== null) {
    return index < 0 ? tasks : tasks.filter((existing) => existing.id !== task.id);
  }
  if (index < 0) return [...tasks, task];
  return tasks[index] === task
    ? tasks
    : tasks.map((existing, i) => (i === index ? task : existing));
}

function newerSpace(current: Space, next: Space): Space {
  return Date.parse(next.updatedAt) >= Date.parse(current.updatedAt) ? next : current;
}

function sortEntries(entries: SpaceRoomEntry[]): SpaceRoomEntry[] {
  return entries.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Older pages loaded with `before`, prepended without repeating what the room already holds. */
export function prependSpaceEntries(
  older: ReadonlyArray<SpaceRoomEntry>,
  current: ReadonlyArray<SpaceRoomEntry>,
): ReadonlyArray<SpaceRoomEntry> {
  const ids = new Set(current.map((entry) => entry.id));
  const fresh = older.filter((entry) => !ids.has(entry.id));
  return fresh.length === 0 ? current : [...fresh, ...current];
}

/** Index of the first entry after the viewer's last visit, for the "New" divider; null if none. */
export function spaceNewDividerIndex(
  entries: ReadonlyArray<SpaceRoomEntry>,
  lastVisitedAt: string | null,
  viewerId: MemberId | null,
): number | null {
  if (lastVisitedAt === null) return null;
  const visited = Date.parse(lastVisitedAt);
  const index = entries.findIndex(
    (entry) =>
      Date.parse(entry.createdAt) > visited &&
      (entry.type === "system" ? entry.actorId : entry.authorId) !== viewerId,
  );
  return index < 0 ? null : index;
}

/** What the viewer may do in a space, matching SpaceDecisions; `canOperate` is the RPC grant. */
export interface SpaceControls {
  readonly isMember: boolean;
  readonly isOwner: boolean;
  readonly archived: boolean;
  /** Post, mention, tag `@pair`, and act on messages. */
  readonly canPost: boolean;
  /** New task, Start a thread, Add to task, the status control and status Undo. */
  readonly canCreateTask: boolean;
  readonly canEditNotes: boolean;
  /** Add members, accept requests, remove, make owner, rename, repositories. */
  readonly canManage: boolean;
  readonly canArchive: boolean;
  readonly canUnarchive: boolean;
  /** The owner must hand the space to someone else first. */
  readonly canLeave: boolean;
}

export function spaceControls(
  space: Pick<Space, "members" | "ownerId" | "archivedAt">,
  memberId: MemberId | null,
  canOperate: boolean,
): SpaceControls {
  const isMember = isActiveSpaceMember(space, memberId);
  const isOwner = isMember && space.ownerId === memberId;
  const archived = space.archivedAt !== null;
  const writable = isMember && canOperate && !archived;
  return {
    isMember,
    isOwner,
    archived,
    canPost: writable,
    canCreateTask: writable,
    canEditNotes: writable,
    canManage: writable && isOwner,
    canArchive: writable && isOwner,
    canUnarchive: isOwner && canOperate && archived,
    canLeave: isMember && canOperate && !isOwner,
  };
}

/** A task's controls (spaces.md "Who can do what"); all hidden on an archived space. */
export interface SpaceTaskControls {
  readonly isTaskOwner: boolean;
  /** Edit, Reassign: its creator or owner. */
  readonly canEdit: boolean;
  readonly canReassign: boolean;
  /** Any member; Cancel task is a status. */
  readonly canSetStatus: boolean;
  readonly canCancel: boolean;
  readonly canStartThread: boolean;
  /** Add existing thread: one of the viewer's own. */
  readonly canAttachThread: boolean;
  /** Can't take it: the owner, back to whoever assigned it. */
  readonly canHandBack: boolean;
  /** Remind: whoever assigned it, while someone else owns it. */
  readonly canRemind: boolean;
}

export function spaceTaskControls(
  task: Pick<SpaceTask, "ownerId" | "createdBy" | "assignedBy" | "status">,
  space: Pick<Space, "members" | "ownerId" | "archivedAt">,
  memberId: MemberId | null,
  canOperate: boolean,
): SpaceTaskControls {
  const writable = spaceControls(space, memberId, canOperate).canCreateTask;
  const isTaskOwner = memberId !== null && task.ownerId === memberId;
  const editor = writable && (isTaskOwner || task.createdBy === memberId);
  const assigner = task.assignedBy ?? task.createdBy;
  return {
    isTaskOwner,
    canEdit: editor,
    canReassign: editor,
    canSetStatus: writable,
    canCancel: writable && task.status !== "canceled",
    canStartThread: writable,
    canAttachThread: writable,
    canHandBack:
      writable && isTaskOwner && task.assignedBy !== null && task.assignedBy !== memberId,
    canRemind: writable && !isTaskOwner && assigner === memberId,
  };
}

/** A thread row's controls on a task, and how someone else's thread behaves. */
export interface SpaceThreadControls {
  readonly isThreadOwner: boolean;
  /** Move to another task: the thread's owner. */
  readonly canMove: boolean;
  /** Remove from task: its owner (even on an archived space), the task's owner, the space owner. */
  readonly canRemove: boolean;
  /** Someone else's thread: the model is its owner's, and Stop asks first. */
  readonly modelLocked: boolean;
  readonly stopNeedsConfirm: boolean;
}

export function spaceThreadControls(
  thread: Pick<OrchestrationV2ThreadShell, "ownerId">,
  task: Pick<SpaceTask, "ownerId">,
  space: Pick<Space, "members" | "ownerId" | "archivedAt">,
  memberId: MemberId | null,
  canOperate: boolean,
): SpaceThreadControls {
  const writable = spaceControls(space, memberId, canOperate).canCreateTask;
  const isThreadOwner = memberId !== null && thread.ownerId === memberId;
  return {
    isThreadOwner,
    canMove: writable && isThreadOwner,
    canRemove:
      (isThreadOwner && canOperate) ||
      (writable && (task.ownerId === memberId || space.ownerId === memberId)),
    modelLocked: !isThreadOwner,
    stopNeedsConfirm: !isThreadOwner,
  };
}

/**
 * The task page's task: the live room's copy, unless the `spaces.taskGet` snapshot is newer. The
 * snapshot only refetches after the room's shell revision moves, so it lags the room's events.
 */
export function spaceLiveTask(
  roomTask: SpaceTask | null,
  viewTask: SpaceTask | null,
): SpaceTask | null {
  if (roomTask === null || viewTask === null) return roomTask ?? viewTask;
  return Date.parse(viewTask.updatedAt) > Date.parse(roomTask.updatedAt) ? viewTask : roomTask;
}

/** `spaces.list` with an open room's live space and tasks, which land before the list refetches. */
export function spaceListWithRoom(
  list: SpaceListResult,
  room: SpaceRoomState | null,
): SpaceListResult {
  if (room?.type !== "member") return list;
  const spaceId = room.space.id;
  if (!list.spaces.some((space) => space.id === spaceId)) return list;
  return {
    spaces: list.spaces.map((space) => (space.id === spaceId ? room.space : space)),
    tasks: [
      ...list.tasks.filter((task) => task.spaceId !== spaceId),
      ...room.tasks.filter((task) => task.deletedAt === null && spaceTaskIsOpen(task.status)),
    ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
  };
}

/** A task's lines: the snapshot's page plus the live room's lines it hasn't fetched yet. */
export function spaceTaskEntries(
  viewEntries: ReadonlyArray<SpaceRoomEntry>,
  roomEntries: ReadonlyArray<SpaceRoomEntry>,
  taskId: SpaceTaskId,
): ReadonlyArray<SpaceRoomEntry> {
  const ids = new Set(viewEntries.map((entry) => entry.id));
  const live = roomEntries.filter(
    (entry) => isSpaceTaskLineEntry(entry) && entry.line.taskId === taskId && !ids.has(entry.id),
  );
  if (live.length === 0) return viewEntries;
  return [...viewEntries, ...live].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

/** When the task last went to its owner: the newest line assigning it to them, or creating it. */
export function spaceTaskAssignedAt(
  task: Pick<SpaceTask, "id" | "ownerId">,
  entries: ReadonlyArray<SpaceRoomEntry>,
): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (!isSpaceTaskLineEntry(entry) || entry.line.taskId !== task.id) continue;
    const line = entry.line;
    if (
      (line.type === "task-assigned" && line.to === task.ownerId) ||
      (line.type === "task-created" && line.ownerId === task.ownerId)
    ) {
      return entry.createdAt;
    }
  }
  return null;
}

/** The task page's notice while an assigned task waits, or after it was handed back. */
export function spaceTaskAssignmentNotice(
  task: SpaceTask,
  threadCount: number,
  viewer: SpaceViewer,
): { readonly type: "assigned-to-you" | "waiting" | "handed-back"; readonly text: string } | null {
  if (task.handedBack !== null && task.status === "todo" && threadCount === 0) {
    const { by, reason } = task.handedBack;
    return {
      type: "handed-back",
      text: `${memberName(by, viewer, "You")} handed this back: ${reason}`,
    };
  }
  if (!waitsOnOwner(task, threadCount)) return null;
  if (task.ownerId === viewer.memberId) {
    return {
      type: "assigned-to-you",
      text: `${viewer.nameOf(task.assignedBy!)} assigned this to you`,
    };
  }
  if (task.assignedBy === viewer.memberId) {
    return { type: "waiting", text: `Waiting for ${viewer.nameOf(task.ownerId)} to start` };
  }
  return null;
}

type ShellLike = Pick<
  OrchestrationV2ThreadShell,
  "id" | "space" | "archivedAt" | "updatedAt" | "lastVisitedAt"
>;

/** A space's unarchived threads on tasks, among the shells. */
export function spaceTaskThreadsIn<T extends ShellLike>(
  threads: ReadonlyArray<T>,
  spaceId: string,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) =>
      thread.space?.kind === "task" &&
      thread.space.spaceId === spaceId &&
      thread.archivedAt === null,
  );
}

/** The live shells win over the room page's copy, which can be older or hold one the shells left out. */
export function mergeSpaceThreads<T extends { readonly id: string }>(
  live: ReadonlyArray<T>,
  pageThreads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const liveIds = new Set(live.map((thread) => thread.id));
  const rest = pageThreads.filter((thread) => !liveIds.has(thread.id));
  return rest.length === 0 ? live : [...live, ...rest];
}

/**
 * Every unarchived thread on a task, and the rooms with activity since the viewer last opened
 * them; a room whose latest activity is the viewer's own line isn't unread.
 */
export function spaceSidebarShells<T extends ShellLike>(
  threads: ReadonlyArray<T>,
  viewerId: MemberId | null,
) {
  const taskThreads: T[] = [];
  const unreadRoomIds = new Set<string>();
  const roomIds: string[] = [];
  for (const thread of threads) {
    if (thread.space?.kind === "task" && thread.archivedAt === null) taskThreads.push(thread);
    if (thread.space?.kind !== "room") continue;
    roomIds.push(`${thread.id}@${thread.space.revision ?? ""}`);
    const updatedAt = DateTime.toEpochMillis(thread.updatedAt);
    const latest = thread.space.latestEntry;
    const ownLatest =
      latest !== undefined && latest.by === viewerId && Date.parse(latest.at) >= updatedAt;
    if (
      !ownLatest &&
      (thread.lastVisitedAt == null || updatedAt > DateTime.toEpochMillis(thread.lastVisitedAt))
    ) {
      unreadRoomIds.add(thread.id);
    }
  }
  // Changes on every space and task write (the room's revision), so `spaces.list` refetches.
  const roomsKey = roomIds.sort().join(",");
  return { taskThreads, unreadRoomIds, roomsKey };
}

// The room feed's rows: day dividers, the "New" divider, entries, and `@pair` items merged by
// time. Same author within a few minutes continues the previous post without a name line.

export interface SpaceFeedItem {
  readonly key: string;
  readonly createdAt: string;
}

export type SpaceFeedRow<P extends SpaceFeedItem = SpaceFeedItem> =
  | { readonly type: "day"; readonly key: string; readonly label: string }
  | { readonly type: "new"; readonly key: "new" }
  | {
      readonly type: "entry";
      readonly key: string;
      readonly entry: SpaceRoomEntry;
      readonly continued: boolean;
    }
  | { readonly type: "pair"; readonly key: string; readonly item: P };

const CONTINUE_WITHIN_MS = 5 * 60_000;

function spaceDayLabel(iso: string, now: Date): string {
  // @effect-diagnostics-next-line globalDate:off - local calendar days, for display
  const date = new Date(iso);
  // @effect-diagnostics-next-line globalDate:off - local calendar days, for display
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // @effect-diagnostics-next-line globalDate:off - local calendar days, for display
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function spaceFeedRows<P extends SpaceFeedItem>(
  entries: ReadonlyArray<SpaceRoomEntry>,
  pairItems: ReadonlyArray<P>,
  newIndex: number | null,
  // @effect-diagnostics-next-line globalDate:off - local calendar days, for display
  now: Date = new Date(),
): ReadonlyArray<SpaceFeedRow<P>> {
  const rows: SpaceFeedRow<P>[] = [];
  let lastDay: string | null = null;
  let previous: SpaceRoomEntry | null = null;
  let pairIndex = 0;
  const pushDay = (createdAt: string) => {
    const label = spaceDayLabel(createdAt, now);
    if (label === lastDay) return;
    lastDay = label;
    // @effect-diagnostics-next-line globalDate:off - local calendar days, for display
    const date = new Date(createdAt);
    rows.push({
      type: "day",
      key: `day:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      label,
    });
  };
  entries.forEach((entry, index) => {
    while (pairIndex < pairItems.length && pairItems[pairIndex]!.createdAt < entry.createdAt) {
      const item = pairItems[pairIndex++]!;
      pushDay(item.createdAt);
      rows.push({ type: "pair", key: `pair:${item.key}`, item });
      previous = null;
    }
    pushDay(entry.createdAt);
    if (index === newIndex) rows.push({ type: "new", key: "new" });
    const continued =
      index !== newIndex &&
      previous !== null &&
      previous.type === "post" &&
      entry.type === "post" &&
      previous.authorId === entry.authorId &&
      Date.parse(entry.createdAt) - Date.parse(previous.createdAt) < CONTINUE_WITHIN_MS &&
      rows.at(-1)?.type === "entry";
    rows.push({ type: "entry", key: entry.id, entry, continued });
    previous = entry;
  });
  for (; pairIndex < pairItems.length; pairIndex++) {
    const item = pairItems[pairIndex]!;
    pushDay(item.createdAt);
    rows.push({ type: "pair", key: `pair:${item.key}`, item });
  }
  return rows;
}

// Confirms for archive, leave, remove and transfer: the copy, the mutation, and the way back the
// toast offers once the change lands.

export type SpaceConfirm =
  | { readonly type: "archive"; readonly space: Space }
  | { readonly type: "leave"; readonly space: Space; readonly reassignTo: MemberId | null }
  | {
      readonly type: "remove";
      readonly space: Space;
      readonly memberId: MemberId;
      readonly reassignTo: MemberId | null;
    }
  | { readonly type: "transfer"; readonly space: Space; readonly memberId: MemberId };

/** Open tasks `memberId` owns; removing or leaving offers to reassign them. */
export function spaceOpenTaskCount(tasks: ReadonlyArray<SpaceTask>, memberId: MemberId): number {
  return tasks.filter(
    (task) => task.ownerId === memberId && task.deletedAt === null && spaceTaskIsOpen(task.status),
  ).length;
}

/** "Reassign them to" starts on you when removing, and on the space's owner when leaving. */
export function spaceDefaultReassignTo(
  type: "remove" | "leave",
  space: Pick<Space, "ownerId">,
  viewer: SpaceViewer,
): MemberId | null {
  return type === "leave" ? space.ownerId : viewer.memberId;
}

export interface SpaceConfirmCopy {
  readonly title: string;
  readonly description: string;
  /** "Kousik owns 2 open tasks. Reassign them to"; null with none to reassign. */
  readonly reassignLabel: string | null;
  /** What happens to their threads and tasks under the current choice. */
  readonly note: string | null;
  readonly action: string;
  readonly destructive: boolean;
}

export function spaceConfirmCopy(
  confirm: SpaceConfirm,
  viewer: SpaceViewer,
  openTasks: number,
): SpaceConfirmCopy {
  const name =
    confirm.type === "remove" || confirm.type === "transfer" ? viewer.nameOf(confirm.memberId) : "";
  switch (confirm.type) {
    case "archive":
      return {
        title: `Archive ${confirm.space.name}?`,
        description: `It becomes read-only for all ${activeMemberCount(confirm.space)} members and moves to Archived in the sidebar. Running threads keep running.`,
        reassignLabel: null,
        note: null,
        action: "Archive",
        destructive: false,
      };
    case "leave":
      return {
        title: `Leave ${confirm.space.name}?`,
        description: "You lose access to the room, tasks and notes.",
        reassignLabel: openTasks === 0 ? null : `You own ${taskCount(openTasks)}. Reassign them to`,
        note: null,
        action: "Leave",
        destructive: true,
      };
    case "remove":
      return {
        title: `Remove ${name} from ${confirm.space.name}?`,
        description: "They lose access to the room, tasks and notes.",
        reassignLabel:
          openTasks === 0 ? null : `${name} owns ${taskCount(openTasks)}. Reassign them to`,
        note: `Attached threads stay on the tasks and keep running on ${name}'s account.`,
        action: `Remove ${name}`,
        destructive: true,
      };
    case "transfer":
      return {
        title: `Make ${name} the owner?`,
        description: `${name} will manage members and settings. You stay a member.`,
        reassignLabel: null,
        note: null,
        action: "Make owner",
        destructive: false,
      };
  }
}

function activeMemberCount(space: Pick<Space, "members">): number {
  return space.members.filter((member) => member.removedAt === null).length;
}

export function spaceConfirmMutation(confirm: SpaceConfirm): SpaceMutation {
  const spaceId = confirm.space.id;
  switch (confirm.type) {
    case "archive":
      return { type: "archive", spaceId };
    case "leave":
      return confirm.reassignTo === null
        ? { type: "leave", spaceId }
        : { type: "leave", spaceId, reassignTo: confirm.reassignTo };
    case "remove":
      return confirm.reassignTo === null
        ? { type: "member.remove", spaceId, memberId: confirm.memberId }
        : {
            type: "member.remove",
            spaceId,
            memberId: confirm.memberId,
            reassignTo: confirm.reassignTo,
          };
    case "transfer":
      return { type: "owner.transfer", spaceId, ownerId: confirm.memberId };
  }
}

/**
 * The toast after the change lands, with the way back; transfer has none. Undo of a removal
 * restores membership only: reassigned tasks stay reassigned, and the toast says so.
 */
export function spaceConfirmUndo(
  confirm: SpaceConfirm,
  viewer: SpaceViewer,
  openTasks: number,
): {
  readonly title: string;
  readonly description: string | null;
  /** The toast once Undo lands; null when there is nothing to say past the title. */
  readonly restored?: string;
  readonly label: string;
  readonly failure: string;
  readonly mutation: SpaceMutation;
} | null {
  const spaceId = confirm.space.id;
  switch (confirm.type) {
    case "archive":
      return {
        title: `Archived ${confirm.space.name}`,
        description: null,
        label: "Undo",
        failure: "Could not undo",
        mutation: { type: "unarchive", spaceId },
      };
    case "remove": {
      const name = viewer.nameOf(confirm.memberId);
      const kept =
        openTasks === 0 || confirm.reassignTo === null
          ? ""
          : ` Their ${taskCount(openTasks)} stay with ${
              confirm.reassignTo === viewer.memberId ? "you" : viewer.nameOf(confirm.reassignTo)
            }.`;
      return {
        title: `${name} was removed from the space`,
        description: null,
        restored: `${name} is back.${kept}`,
        label: "Undo",
        failure: "Could not undo",
        mutation: { type: "member.add", spaceId, memberIds: [confirm.memberId], restore: true },
      };
    }
    case "leave":
      return {
        title: `Left ${confirm.space.name}`,
        description: null,
        label: "Ask to be added back",
        failure: "Could not ask to join",
        mutation: { type: "join.request", spaceId },
      };
    case "transfer":
      return null;
  }
}
