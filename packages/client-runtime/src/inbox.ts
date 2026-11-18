import type {
  InboxItem,
  InboxSummary,
  MemberId,
  SharedWithYouPerson,
  SharedWithYouState,
  Space,
  SpaceId,
  SpaceTask,
  SpaceTaskId,
  SpaceTaskStatus,
} from "@t3tools/contracts";

import {
  type SpaceOverviewRow,
  type SpaceTaskThread,
  type SpaceViewer,
  groupSpaceOverview,
} from "./spaces.ts";

// Inbox, My tasks, Shared with you and the sidebar's space rows (docs/product/spaces-redesign.md
// Part 1), shared by web and mobile.

export interface InboxRowCopy {
  /** What it is and who: "Meera assigned you Trial banner copy". */
  readonly title: string;
  /** Where it lives: "Question creation › Trial banner copy · your thread". */
  readonly detail: string;
}

const who = (memberId: MemberId | null, viewer: SpaceViewer) =>
  memberId === null ? "Someone" : viewer.nameOf(memberId);

function inboxTitle(item: InboxItem, viewer: SpaceViewer): string {
  const task = item.taskTitle ?? "a task";
  switch (item.reason) {
    case "approval":
      return item.excerpt === undefined ? "Approve a request" : `Approve \`${item.excerpt}\``;
    case "question":
      return item.excerpt === undefined ? "Answer a question" : `Answer: ${item.excerpt}`;
    case "task-assigned":
      return `${who(item.actorId, viewer)} assigned you ${task}`;
    case "task-handed-back":
      return `${who(item.actorId, viewer)} handed back ${task}`;
    case "offer":
      return `${who(item.actorId, viewer)} offers ${item.excerpt ?? "changes"} to ${
        item.threadTitle ?? "your thread"
      }`;
    case "mention":
      return `${who(item.actorId, viewer)} mentioned you`;
    case "pair-reply":
      return "Pair replied to you";
    case "shared-with-you":
      return `${who(item.actorId, viewer)} shared ${item.threadTitle ?? "a thread"}`;
    case "added-to-space":
      return `${who(item.actorId, viewer)} added you to ${item.spaceName ?? "a space"}`;
    case "bot-ask":
      return item.excerpt ?? "A question for you";
    case "bot-job-done":
      return `${item.jobTitle ?? "A job"} is done`;
  }
}

/** Row copy for one Inbox item. Rows keyed on a thread name its owner; yours reads "your thread". */
export function inboxRowCopy(item: InboxItem, viewer: SpaceViewer): InboxRowCopy {
  const botDetail = (...parts: ReadonlyArray<string | undefined>): string =>
    parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
  if (item.reason === "bot-ask" || item.reason === "bot-job-done") {
    return {
      title: inboxTitle(item, viewer),
      detail: botDetail(item.botName, item.reason === "bot-ask" ? item.jobTitle : undefined),
    };
  }
  const place =
    item.spaceName !== undefined && item.taskTitle !== undefined
      ? `${item.spaceName} › ${item.taskTitle}`
      : (item.spaceName ?? item.threadTitle ?? null);
  const owner =
    item.threadOwnerId === undefined
      ? null
      : item.threadOwnerId === viewer.memberId
        ? "your thread"
        : viewer.nameOf(item.threadOwnerId);
  return {
    title: inboxTitle(item, viewer),
    detail: [place, owner].filter((part): part is string => part !== null).join(" · "),
  };
}

const MY_TASK_GROUP_ORDER: ReadonlyArray<SpaceTaskStatus> = [
  "in-progress",
  "in-review",
  "todo",
  "done",
  "canceled",
];

const SPACE_TASK_STATUS_LABEL: Readonly<Record<SpaceTaskStatus, string>> = {
  "in-progress": "In progress",
  "in-review": "In review",
  todo: "To do",
  done: "Done",
  canceled: "Canceled",
};

export interface MyTaskGroup {
  readonly status: SpaceTaskStatus;
  readonly label: string;
  /** Done and Canceled start collapsed. */
  readonly collapsed: boolean;
  readonly tasks: ReadonlyArray<SpaceTask>;
}

export interface MyTaskSection {
  /** Null when not grouped by space. */
  readonly space: Space | null;
  readonly groups: ReadonlyArray<MyTaskGroup>;
}

function taskGroups(tasks: ReadonlyArray<SpaceTask>): ReadonlyArray<MyTaskGroup> {
  return MY_TASK_GROUP_ORDER.flatMap((status) => {
    const inGroup = tasks
      .filter((task) => task.status === status)
      .sort((a, b) => Date.parse(b.statusChangedAt) - Date.parse(a.statusChangedAt));
    return inGroup.length === 0
      ? []
      : [
          {
            status,
            label: SPACE_TASK_STATUS_LABEL[status],
            collapsed: status === "done" || status === "canceled",
            tasks: inGroup,
          },
        ];
  });
}

/**
 * My tasks: the tasks the viewer owns in spaces they are still in and that aren't archived,
 * grouped by status (In progress first), optionally per space in the given space order.
 * `closedTasks` (from `myTasks.listClosed`) fill Done and Canceled; where the two reads disagree
 * on a task, its newer status wins.
 */
export function myTaskSections(input: {
  readonly spaces: ReadonlyArray<Space>;
  readonly tasks: ReadonlyArray<SpaceTask>;
  readonly closedTasks?: ReadonlyArray<SpaceTask>;
  readonly memberId: MemberId;
  readonly groupBySpace: boolean;
}): ReadonlyArray<MyTaskSection> {
  const active = input.spaces.filter(
    (space) =>
      space.archivedAt === null &&
      space.members.some((m) => m.memberId === input.memberId && m.removedAt === null),
  );
  const activeIds = new Set(active.map((space) => space.id));
  const byId = new Map<SpaceTaskId, SpaceTask>();
  for (const task of [...input.tasks, ...(input.closedTasks ?? [])]) {
    const seen = byId.get(task.id);
    if (seen === undefined || task.statusVersion > seen.statusVersion) byId.set(task.id, task);
  }
  const mine = [...byId.values()].filter(
    (task) =>
      task.ownerId === input.memberId && task.deletedAt === null && activeIds.has(task.spaceId),
  );
  if (!input.groupBySpace) {
    return mine.length === 0 ? [] : [{ space: null, groups: taskGroups(mine) }];
  }
  return active.flatMap((space) => {
    const tasks = mine.filter((task) => task.spaceId === space.id);
    return tasks.length === 0 ? [] : [{ space, groups: taskGroups(tasks) }];
  });
}

/** My tasks' rows: the Overview's two lines for each task, in the given order. */
export function myTaskRows<T extends SpaceTaskThread>(
  tasks: ReadonlyArray<SpaceTask>,
  threadsByTask: ReadonlyMap<SpaceTaskId, ReadonlyArray<T>>,
  viewer: SpaceViewer,
): ReadonlyArray<SpaceOverviewRow<T>> {
  const rows = new Map(
    groupSpaceOverview(tasks, threadsByTask, viewer)
      .flatMap((section) => section.rows)
      .map((row) => [row.task.id, row]),
  );
  return tasks.flatMap((task) => rows.get(task.id) ?? []);
}

export const SHARED_WITH_YOU_STATE_LABEL: Readonly<Record<SharedWithYouState, string>> = {
  working: "Working",
  "needs-someone": "Needs someone",
  idle: "Idle",
  settled: "Settled",
};

export const SHARED_WITH_YOU_STATE_OPTIONS: ReadonlyArray<{
  readonly value: SharedWithYouState;
  readonly label: string;
}> = (["working", "needs-someone", "idle", "settled"] as const).map((value) => ({
  value,
  label: SHARED_WITH_YOU_STATE_LABEL[value],
}));

/** The person filter's options, in the list's group order. */
export function sharedWithYouPersonOptions(
  people: ReadonlyArray<SharedWithYouPerson>,
  viewer: SpaceViewer,
): ReadonlyArray<{ readonly value: MemberId; readonly label: string; readonly count: number }> {
  return people.map((person) => ({
    value: person.memberId,
    label: viewer.nameOf(person.memberId),
    count: person.count,
  }));
}

const SIDEBAR_VISIBLE_SPACES = 5;

export interface SidebarSpaceRow {
  readonly space: Space;
  /** Its share of the Inbox's Needs you count. */
  readonly needsYou: number;
  /** The grey dot: an unread room with nothing waiting on the viewer. */
  readonly unread: boolean;
}

export interface SidebarSpaceRows {
  readonly visible: ReadonlyArray<SidebarSpaceRow>;
  /** Behind "N more", in order; `hidden.length` is N. */
  readonly hidden: ReadonlyArray<SidebarSpaceRow>;
  /** The hidden spaces' total Needs you. */
  readonly hiddenNeedsYou: number;
  /** Under the Archived sub-header inside the expansion; never counted in N. */
  readonly archived: ReadonlyArray<SidebarSpaceRow>;
}

/**
 * The sidebar's space rows: the first five in the user's order, then "N more". Spaces missing
 * from `order` (new ones, ones the user was just added to) go to the top, the viewer's latest
 * join first.
 */
export function sidebarSpaceRows(
  spaces: ReadonlyArray<Space>,
  order: ReadonlyArray<SpaceId>,
  summary: InboxSummary | null,
  unreadRoomIds: ReadonlySet<string>,
  viewerId: MemberId | null,
): SidebarSpaceRows {
  const counts = new Map(summary?.bySpace.map((entry) => [entry.spaceId, entry.needsYou]) ?? []);
  const rowOf = (space: Space): SidebarSpaceRow => {
    const needsYou = counts.get(space.id) ?? 0;
    return { space, needsYou, unread: needsYou === 0 && unreadRoomIds.has(space.roomThreadId) };
  };
  const joinedAt = (space: Space) => {
    const member = space.members.find((entry) => entry.memberId === viewerId);
    return Date.parse(member?.joinedAt ?? space.createdAt);
  };
  const rank = new Map(order.map((spaceId, index) => [spaceId, index]));
  const active = spaces.filter((space) => space.archivedAt === null);
  const fresh = active
    .filter((space) => !rank.has(space.id))
    .sort((a, b) => joinedAt(b) - joinedAt(a));
  const ordered = active
    .filter((space) => rank.has(space.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rows = [...fresh, ...ordered].map(rowOf);
  const hidden = rows.slice(SIDEBAR_VISIBLE_SPACES);
  return {
    visible: rows.slice(0, SIDEBAR_VISIBLE_SPACES),
    hidden,
    hiddenNeedsYou: hidden.reduce((total, row) => total + row.needsYou, 0),
    archived: spaces
      .filter((space) => space.archivedAt !== null)
      .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!))
      .map(rowOf),
  };
}
