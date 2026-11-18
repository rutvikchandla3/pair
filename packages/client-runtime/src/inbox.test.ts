import {
  BotId,
  type InboxItem,
  MemberId,
  ProjectId,
  type Space,
  SpaceId,
  type SpaceTask,
  SpaceTaskId,
  type SpaceTaskStatus,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inboxRowCopy, myTaskRows, myTaskSections, sidebarSpaceRows } from "./inbox.ts";

const me = MemberId.make("member:kousik");
const meera = MemberId.make("member:meera");
const names: Record<string, string> = { [me]: "Kousik", [meera]: "Meera" };
const viewer = { memberId: me, nameOf: (memberId: MemberId) => names[memberId] ?? "?" };
const at = "2026-11-01T10:00:00.000Z";

const space = (index: number, overrides: Partial<Space> = {}): Space => ({
  id: SpaceId.make(`spc_${String(index).padStart(20, "0")}`),
  roomThreadId: ThreadId.make(`thread:room-${index}`),
  name: `Space ${index}`,
  brief: "",
  repositoryIds: [ProjectId.make("project:a")],
  projectId: ProjectId.make("project:a"),
  ownerId: meera,
  members: [
    { memberId: meera, joinedAt: at, addedBy: null, removedAt: null },
    { memberId: me, joinedAt: at, addedBy: meera, removedAt: null },
  ],
  joinRequests: [],
  createdBy: meera,
  createdAt: `2026-11-0${index}T00:00:00.000Z`,
  updatedAt: at,
  archivedAt: null,
  archivedBy: null,
  ...overrides,
});

const item = (overrides: Partial<InboxItem>): InboxItem => ({
  id: "item",
  group: "needs-you",
  reason: "approval",
  at,
  actorId: null,
  ...overrides,
});

describe("inboxRowCopy", () => {
  it.each([
    [
      item({
        reason: "approval",
        excerpt: "pnpm db:migrate",
        threadTitle: "Migrate",
        threadOwnerId: me,
      }),
      "Approve `pnpm db:migrate`",
      "Migrate · your thread",
    ],
    [
      item({
        reason: "task-assigned",
        actorId: meera,
        spaceName: "Question creation",
        taskTitle: "Trial banner copy",
      }),
      "Meera assigned you Trial banner copy",
      "Question creation › Trial banner copy",
    ],
    [
      item({ reason: "mention", group: "for-you", actorId: meera, spaceName: "Billing v3" }),
      "Meera mentioned you",
      "Billing v3",
    ],
    [
      item({ reason: "pair-reply", group: "for-you", spaceName: "Billing v3" }),
      "Pair replied to you",
      "Billing v3",
    ],
    [
      item({
        reason: "shared-with-you",
        group: "for-you",
        actorId: meera,
        threadTitle: "Perf budget for /questions",
        threadOwnerId: meera,
      }),
      "Meera shared Perf budget for /questions",
      "Perf budget for /questions · Meera",
    ],
    [
      item({ reason: "added-to-space", group: "for-you", actorId: meera, spaceName: "Billing v3" }),
      "Meera added you to Billing v3",
      "Billing v3",
    ],
    [
      item({
        reason: "bot-ask",
        botId: BotId.make("bot-1"),
        botName: "Atlas",
        excerpt: "Per member or per API token?",
        jobTitle: "Rate limit threads API",
      }),
      "Per member or per API token?",
      "Atlas · Rate limit threads API",
    ],
    [
      item({
        reason: "bot-job-done",
        group: "for-you",
        botId: BotId.make("bot-1"),
        botName: "Atlas",
        jobNumber: 12,
        jobTitle: "Sidebar drag flicker",
      }),
      "Sidebar drag flicker is done",
      "Atlas",
    ],
  ])("names the reason and where it lives: %#", (input, title, detail) => {
    expect(inboxRowCopy(input, viewer)).toEqual({ title, detail });
  });
});

const task = (id: number, status: SpaceTaskStatus, spaceId: SpaceId, ownerId = me): SpaceTask => ({
  id: SpaceTaskId.make(`stk_${String(id).padStart(20, "0")}`),
  spaceId,
  title: `Task ${id}`,
  description: "Do it",
  ownerId,
  createdBy: meera,
  createdAt: at,
  assignedBy: meera,
  status,
  statusVersion: 1,
  statusChangedAt: `2026-11-01T10:0${id}:00.000Z`,
  statusChangedBy: { type: "member", memberId: meera },
  handedBack: null,
  remindedAt: null,
  via: null,
  updatedAt: at,
  deletedAt: null,
});

describe("myTaskSections", () => {
  const one = space(1);
  const two = space(2);
  const archived = space(3, { archivedAt: at, archivedBy: meera });
  const tasks = [
    task(1, "todo", one.id),
    task(2, "in-progress", two.id),
    task(3, "done", one.id),
    task(4, "in-progress", one.id),
    task(5, "todo", one.id, meera),
    task(6, "todo", archived.id),
  ];

  it("groups the viewer's tasks by status, In progress first, with Done collapsed", () => {
    const [section] = myTaskSections({
      spaces: [one, two, archived],
      tasks,
      memberId: me,
      groupBySpace: false,
    });
    expect(
      section?.groups.map((group) => [
        group.label,
        group.collapsed,
        group.tasks.map((t) => t.title),
      ]),
    ).toEqual([
      ["In progress", false, ["Task 4", "Task 2"]],
      ["To do", false, ["Task 1"]],
      ["Done", true, ["Task 3"]],
    ]);
    // Rows keep the group's order, not the Overview's.
    expect(
      myTaskRows(section!.groups[0]!.tasks, new Map(), viewer).map((row) => row.task.title),
    ).toEqual(["Task 4", "Task 2"]);
  });

  it("splits by space when grouped by space", () => {
    const sections = myTaskSections({
      spaces: [two, one, archived],
      tasks,
      memberId: me,
      groupBySpace: true,
    });
    expect(sections.map((s) => [s.space?.name, s.groups.map((g) => g.status)])).toEqual([
      ["Space 2", ["in-progress"]],
      ["Space 1", ["in-progress", "todo", "done"]],
    ]);
  });

  it("adds the closed tasks to Done and Canceled, the newer status winning a task in both", () => {
    const reopened = { ...task(4, "in-progress", one.id), statusVersion: 3 };
    const [section] = myTaskSections({
      spaces: [one],
      tasks: [reopened],
      closedTasks: [
        { ...task(4, "done", one.id), statusVersion: 2 },
        task(7, "canceled", one.id),
        task(8, "done", archived.id),
      ],
      memberId: me,
      groupBySpace: false,
    });
    expect(section?.groups.map((group) => [group.label, group.collapsed, group.tasks])).toEqual([
      ["In progress", false, [reopened]],
      ["Canceled", true, [task(7, "canceled", one.id)]],
    ]);
  });
});

describe("sidebarSpaceRows", () => {
  it("shows five in the user's order, new spaces on top by when you joined, then N more", () => {
    const joined = (index: number, joinedAt: string) =>
      space(index, {
        members: [
          { memberId: meera, joinedAt: at, addedBy: null, removedAt: null },
          { memberId: me, joinedAt, addedBy: meera, removedAt: null },
        ],
      });
    const spaces = [1, 2, 3, 4, 5, 6].map((index) => space(index));
    // Created first but joined last, so it leads the spaces missing from the order.
    const addedLately = joined(7, "2026-11-10T00:00:00.000Z");
    const createdLately = {
      ...joined(9, "2026-11-08T00:00:00.000Z"),
      createdAt: "2026-11-09T00:00:00.000Z",
    };
    const archived = space(8, { archivedAt: at, archivedBy: meera });
    const order = spaces.map((entry) => entry.id);
    const rows = sidebarSpaceRows(
      [createdLately, ...spaces, addedLately, archived],
      order,
      {
        needsYou: 4,
        bySpace: [
          { spaceId: spaces[0]!.id, needsYou: 2 },
          { spaceId: spaces[5]!.id, needsYou: 2 },
        ],
        revision: 1,
      },
      new Set([spaces[1]!.roomThreadId, spaces[0]!.roomThreadId]),
      me,
    );
    expect(rows.visible.map((row) => [row.space.name, row.needsYou, row.unread])).toEqual([
      ["Space 7", 0, false],
      ["Space 9", 0, false],
      ["Space 1", 2, false],
      ["Space 2", 0, true],
      ["Space 3", 0, false],
    ]);
    expect(rows.hidden.map((row) => row.space.name)).toEqual(["Space 4", "Space 5", "Space 6"]);
    expect(rows.hiddenNeedsYou).toBe(2);
    expect(rows.archived.map((row) => row.space.name)).toEqual(["Space 8"]);
  });
});
