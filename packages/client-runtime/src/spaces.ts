import type {
  MemberId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceMember,
  SpaceMention,
  SpaceAction,
  SpaceNoteItem,
  SpacePairBilling,
  SpaceRoomEntry,
  SpaceSystemLine,
} from "@t3tools/contracts";
import {
  type SpaceTaskState,
  type SpaceTaskStateInput,
  spaceTaskState,
} from "@t3tools/shared/spaceTaskState";
import * as DateTime from "effect/DateTime";

import { type SpaceAgentEvent, applySpaceAgentEvent, mergeSpaceActions } from "./spaceAgent.ts";

export type { SpaceTaskState };

/** The status icons in docs/product/spaces-prototype/README.md#status-icons. */
export type SpaceTaskIcon =
  | "not-started"
  | "working"
  | "needs-answer"
  | "needs-approval"
  | "failed"
  | "limited"
  | "stopped"
  | "in-review"
  | "done";

export type SpaceTaskTone = "muted" | "info" | "input" | "warning" | "error" | "success";

export interface SpaceTaskStatus {
  readonly state: SpaceTaskState;
  readonly icon: SpaceTaskIcon;
  readonly tone: SpaceTaskTone;
  /** "Needs you", "Needs Kousik", "In review". */
  readonly label: string;
  /** The task waits on the viewer: a question or approval for them, or theirs to start. */
  readonly needsViewer: boolean;
}

export interface SpaceViewer {
  readonly memberId: MemberId | null;
  readonly nameOf: (memberId: MemberId) => string;
}

export type SpaceTaskThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "ownerId" | "updatedAt" | "space"
> &
  SpaceTaskStateInput;

/** Wraps the shared classifier so every client words and colours a status the same way. */
export function spaceTaskStatus(thread: SpaceTaskThread, viewer: SpaceViewer): SpaceTaskStatus {
  const state = spaceTaskState(thread);
  const ownedByViewer = viewer.memberId !== null && thread.ownerId === viewer.memberId;
  switch (state.type) {
    case "not-started":
      return {
        state,
        icon: "not-started",
        tone: "muted",
        label: "Not started",
        needsViewer: ownedByViewer,
      };
    case "working":
      return { state, icon: "working", tone: "info", label: "Working", needsViewer: false };
    case "needs": {
      const needed = state.memberId;
      const forViewer = needed !== null && needed === viewer.memberId;
      const who = forViewer ? "you" : needed === null ? "an answer" : viewer.nameOf(needed);
      return {
        state,
        icon: state.reason === "answer" ? "needs-answer" : "needs-approval",
        tone: state.reason === "answer" ? "input" : "warning",
        label: `Needs ${who}`,
        needsViewer: forViewer,
      };
    }
    case "failed":
      return { state, icon: "failed", tone: "error", label: "Failed", needsViewer: false };
    case "limited":
      return { state, icon: "limited", tone: "warning", label: "Limited", needsViewer: false };
    case "stopped":
      return { state, icon: "stopped", tone: "muted", label: "Stopped", needsViewer: false };
    case "in-review":
      return { state, icon: "in-review", tone: "success", label: "In review", needsViewer: false };
    case "done":
      return { state, icon: "done", tone: "success", label: "Done", needsViewer: false };
  }
}

/** "you", "Kousik", or "Kousik (removed)" for someone no longer in the space. */
function spaceMemberLabel(
  space: Pick<Space, "members"> | null,
  memberId: MemberId,
  viewer: SpaceViewer,
): string {
  if (memberId === viewer.memberId) return "you";
  const name = viewer.nameOf(memberId);
  const member = space?.members.find((entry) => entry.memberId === memberId);
  return member !== undefined && member.removedAt !== null ? `${name} (removed)` : name;
}

/** The muted second line of a task row: "for you · assigned by Rutvik". */
export function spaceTaskDetail(
  thread: SpaceTaskThread,
  status: SpaceTaskStatus,
  space: Pick<Space, "members"> | null,
  viewer: SpaceViewer,
): string {
  const parts: string[] = [];
  if (thread.ownerId != null) parts.push(`for ${spaceMemberLabel(space, thread.ownerId, viewer)}`);
  const placement = thread.space?.kind === "task" ? thread.space : null;
  switch (status.state.type) {
    case "not-started":
      if (placement?.handedBack !== undefined) {
        parts.push(`handed back: ${placement.handedBack.reason}`);
      } else if (placement !== null && placement.createdBy !== thread.ownerId) {
        parts.push(`assigned by ${spaceMemberLabel(space, placement.createdBy, viewer)}`);
      }
      break;
    case "needs":
      parts.push(status.state.reason === "answer" ? "has a question" : "wants approval");
      break;
    case "failed":
    case "limited":
    case "stopped":
      parts.push(status.label.toLowerCase());
      break;
    default:
      break;
  }
  return parts.join(" · ");
}

export type SpaceOverviewSectionId =
  | "needs-you"
  | "in-progress"
  | "not-started"
  | "in-review"
  | "done";

export const SPACE_OVERVIEW_SECTIONS: ReadonlyArray<{
  readonly id: SpaceOverviewSectionId;
  readonly label: string;
  readonly collapsedByDefault: boolean;
}> = [
  { id: "needs-you", label: "Needs you", collapsedByDefault: false },
  { id: "in-progress", label: "In progress", collapsedByDefault: false },
  { id: "not-started", label: "Not started", collapsedByDefault: false },
  { id: "in-review", label: "In review", collapsedByDefault: false },
  { id: "done", label: "Done", collapsedByDefault: true },
];

function spaceOverviewSectionOf(status: SpaceTaskStatus): SpaceOverviewSectionId {
  if (status.state.type === "needs" && status.needsViewer) return "needs-you";
  switch (status.state.type) {
    case "not-started":
      return "not-started";
    case "in-review":
      return "in-review";
    case "done":
      return "done";
    default:
      return "in-progress";
  }
}

export interface SpaceOverviewRow<T> {
  readonly thread: T;
  readonly status: SpaceTaskStatus;
}

/** The Overview's sections in order, each newest first; empty sections are left out. */
export function groupSpaceOverview<T extends SpaceTaskThread>(
  threads: ReadonlyArray<T>,
  viewer: SpaceViewer,
): ReadonlyArray<{
  readonly id: SpaceOverviewSectionId;
  readonly label: string;
  readonly collapsedByDefault: boolean;
  readonly rows: ReadonlyArray<SpaceOverviewRow<T>>;
}> {
  const bySection = new Map<SpaceOverviewSectionId, SpaceOverviewRow<T>[]>();
  for (const thread of [...threads].sort(byUpdatedAtDesc)) {
    const status = spaceTaskStatus(thread, viewer);
    const id = spaceOverviewSectionOf(status);
    const rows = bySection.get(id) ?? [];
    rows.push({ thread, status });
    bySection.set(id, rows);
  }
  return SPACE_OVERVIEW_SECTIONS.flatMap((section) => {
    const rows = bySection.get(section.id);
    return rows === undefined ? [] : [{ ...section, rows }];
  });
}

/** What a sidebar sub-row and Assigned to me show: tasks waiting on the viewer, newest first. */
export function spaceTasksNeedingViewer<T extends SpaceTaskThread>(
  threads: ReadonlyArray<T>,
  viewer: SpaceViewer,
): ReadonlyArray<SpaceOverviewRow<T>> {
  return [...threads]
    .sort(byUpdatedAtDesc)
    .map((thread) => ({ thread, status: spaceTaskStatus(thread, viewer) }))
    .filter((row) => row.status.needsViewer);
}

function byUpdatedAtDesc(
  a: Pick<SpaceTaskThread, "updatedAt">,
  b: Pick<SpaceTaskThread, "updatedAt">,
) {
  return DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt);
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

export function spacePairBillingLabel(billing: SpacePairBilling, viewer: SpaceViewer): string {
  if (billing.type === "team") return "Team Claude key";
  return billing.memberId === viewer.memberId
    ? "your Claude account"
    : `${viewer.nameOf(billing.memberId)}'s Claude account`;
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

/** "Kousik will be notified", "Pair replies here · Team Claude key", or null with no mentions. */
export function spaceComposerHint(
  mentions: ReadonlyArray<SpaceMention>,
  space: Pick<Space, "pairBilling">,
  viewer: SpaceViewer,
): string | null {
  const names = mentions.flatMap((mention) =>
    mention.type === "member" && mention.memberId !== viewer.memberId
      ? [viewer.nameOf(mention.memberId)]
      : [],
  );
  const parts: string[] = [];
  if (mentions.some((mention) => mention.type === "pair")) {
    parts.push(`Pair replies here · ${spacePairBillingLabel(space.pairBilling, viewer)}`);
  }
  if (names.length > 0) parts.push(`${joinNames(names)} will be notified`);
  return parts.length === 0 ? null : parts.join(" · ");
}

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

/** A system line's words after the actor's name; task lines put the task chip after them. */
export function spaceSystemLineText(line: SpaceSystemLine, viewer: SpaceViewer): string {
  switch (line.type) {
    case "created":
      return "created the space";
    case "renamed":
      return `renamed the space to ${line.name}`;
    case "brief-edited":
      return "edited the Brief";
    case "project-changed":
      return "changed the project";
    case "billing-changed":
      return `set @pair to run on ${spacePairBillingLabel(line.pairBilling, viewer)}`;
    case "members-added":
      return `added ${joinNames(line.memberIds.map(viewer.nameOf))}`;
    case "member-restored":
      return `added ${viewer.nameOf(line.memberId)} back`;
    case "member-removed":
      return `removed ${viewer.nameOf(line.memberId)}`;
    case "left":
      return "left the space";
    case "owner-transferred":
      return `made ${viewer.nameOf(line.ownerId)} the owner`;
    case "archived":
      return "archived the space";
    case "unarchived":
      return "unarchived the space";
    case "task-created":
      return "created";
    case "task-handed-back":
      return "handed back";
  }
}

// The room's live state: the `spaces.get` page, then `space.room-entry` and `space.updated`
// events from the room thread's stream. A resync folds a fresh page in.

export type SpaceRoomState =
  | {
      readonly type: "member";
      readonly space: Space;
      readonly entries: ReadonlyArray<SpaceRoomEntry>;
      readonly hasMoreEntries: boolean;
      readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
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

type SpaceRoomView =
  | (Omit<SpaceRoomMemberState, "type"> & { readonly type: "member" })
  | Extract<SpaceRoomState, { readonly type: "not_member" }>;

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

/** Folds a fresh page in, keeping live entries newer than its last one. */
export function mergeSpaceRoomView(
  current: SpaceRoomState | null,
  view: SpaceRoomView,
): SpaceRoomState {
  if (view.type === "not_member" || current === null || current.type !== "member") return view;
  const ids = new Set(view.entries.map((entry) => entry.id));
  const last = view.entries.at(-1);
  const newer = current.entries.filter(
    (entry) =>
      !ids.has(entry.id) &&
      (last === undefined || Date.parse(entry.createdAt) >= Date.parse(last.createdAt)),
  );
  return {
    ...view,
    space: newerSpace(current.space, view.space),
    entries: newer.length === 0 ? view.entries : sortEntries([...view.entries, ...newer]),
    actions: mergeSpaceActions(current.actions, view.actions),
  };
}

export type SpaceRoomEvent =
  | { readonly type: "space.updated"; readonly payload: Space }
  | { readonly type: "space.room-entry"; readonly payload: SpaceRoomEntry }
  | SpaceAgentEvent;

export function applySpaceRoomEvent(
  state: SpaceRoomMemberState,
  event: SpaceRoomEvent,
): SpaceRoomMemberState {
  if (event.type === "space.action.updated" || event.type === "space.notes.changed") {
    return applySpaceAgentEvent(state, event);
  }
  if (event.type === "space.updated") {
    const space = newerSpace(state.space, event.payload);
    return space === state.space ? state : { ...state, space };
  }
  const entry = event.payload;
  if (state.entries.some((existing) => existing.id === entry.id)) return state;
  const last = state.entries.at(-1);
  const entries =
    last === undefined || Date.parse(entry.createdAt) >= Date.parse(last.createdAt)
      ? [...state.entries, entry]
      : sortEntries([...state.entries, entry]);
  return { ...state, entries };
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
  readonly canCreateTask: boolean;
  readonly canEditNotes: boolean;
  /** Add members, accept requests, remove, make owner, rename, project, who pays. */
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
  const isMember =
    memberId !== null &&
    space.members.some((member) => member.memberId === memberId && member.removedAt === null);
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

/** The task screen's controls before and after it starts (spaces.md "Tasks"). */
export interface SpaceTaskControls {
  readonly started: boolean;
  readonly isTaskOwner: boolean;
  /** Start, Runs on, Assign to…, Can't take it. */
  readonly canStart: boolean;
  /** Remind, Reassign, Edit: the creator of a task someone else owns. */
  readonly canNudge: boolean;
  /** Someone else's task: the model is the owner's, and Stop asks first. */
  readonly modelLocked: boolean;
  readonly stopNeedsConfirm: boolean;
}

export function spaceTaskControls(
  thread: SpaceTaskThread,
  space: Pick<Space, "members" | "ownerId" | "archivedAt">,
  memberId: MemberId | null,
  canOperate: boolean,
): SpaceTaskControls {
  const started = spaceTaskState(thread).type !== "not-started";
  const isTaskOwner = memberId !== null && thread.ownerId === memberId;
  const member = spaceControls(space, memberId, canOperate).isMember && canOperate;
  const createdBy = thread.space?.kind === "task" ? thread.space.createdBy : null;
  return {
    started,
    isTaskOwner,
    canStart: !started && isTaskOwner && canOperate,
    canNudge: !started && member && !isTaskOwner && createdBy === memberId,
    modelLocked: !isTaskOwner,
    stopNeedsConfirm: started && !isTaskOwner,
  };
}

type ShellLike = Pick<
  OrchestrationV2ThreadShell,
  "id" | "space" | "archivedAt" | "updatedAt" | "lastVisitedAt"
>;

/** A space's unarchived tasks among the shells. */
export function spaceTasksIn<T extends ShellLike>(
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

/** The live shells win over the room page's copy, which can be older or hold a settled task the shells left out. */
export function mergeSpaceTasks<T extends { readonly id: string }>(
  live: ReadonlyArray<T>,
  pageTasks: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const liveIds = new Set(live.map((thread) => thread.id));
  const rest = pageTasks.filter((thread) => !liveIds.has(thread.id));
  return rest.length === 0 ? live : [...live, ...rest];
}

/**
 * Every unarchived space task, and the rooms with activity since the viewer last opened them; a
 * room whose latest activity is the viewer's own line isn't unread.
 */
export function spaceSidebarShells<T extends ShellLike>(
  threads: ReadonlyArray<T>,
  viewerId: MemberId | null,
) {
  const tasks: T[] = [];
  const unreadRoomIds = new Set<string>();
  const roomIds: string[] = [];
  for (const thread of threads) {
    if (thread.space?.kind === "task" && thread.archivedAt === null) tasks.push(thread);
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
  // Changes when a space is shared, renamed, archived or left, so the list can refetch.
  const roomsKey = roomIds.sort().join(",");
  return { tasks, unreadRoomIds, roomsKey };
}
