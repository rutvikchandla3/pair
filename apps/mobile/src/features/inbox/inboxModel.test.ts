import {
  type InboxItem,
  MemberId,
  type SharedWithYouItem,
  SpaceId,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canMarkInboxItemDone,
  inboxItemSnooze,
  inboxItemTarget,
  inboxSections,
  sharedWithYouRows,
} from "./inboxModel";

const at = "2026-11-01T10:00:00.000Z";
const threadId = ThreadId.make("thread:a");
const spaceId = SpaceId.make("spc_00000000000000000001");
const taskId = SpaceTaskId.make("stk_00000000000000000001");

const item = (overrides: Partial<InboxItem>): InboxItem => ({
  id: "item",
  group: "needs-you",
  reason: "approval",
  at,
  actorId: null,
  ...overrides,
});

describe("inboxSections", () => {
  it("groups Needs you before For you, keeps order, and leaves out an empty group", () => {
    const items = [
      item({ id: "mention", group: "for-you", reason: "mention" }),
      item({ id: "approval" }),
      item({ id: "task", reason: "task-assigned" }),
    ];
    expect(
      inboxSections(items).map((section) => [section.label, section.items.map((i) => i.id)]),
    ).toEqual([
      ["Needs you", ["approval", "task"]],
      ["For you", ["mention"]],
    ]);
    expect(inboxSections(items.slice(1)).map((section) => section.group)).toEqual(["needs-you"]);
  });
});

describe("Inbox item actions", () => {
  it.each([
    [
      "approval answers in place, no snooze",
      item({ reason: "approval", threadId, spaceId, taskId }),
      { type: "request", threadId },
      null,
      false,
    ],
    [
      "question answers in place",
      item({ reason: "question", threadId }),
      { type: "request", threadId },
      null,
      false,
    ],
    [
      "an assigned task opens the task and snoozes itself",
      item({ reason: "task-assigned", spaceId, taskId }),
      { type: "task", spaceId, taskId },
      { type: "task" },
      false,
    ],
    [
      "an offer opens and snoozes its thread",
      item({ reason: "offer", threadId }),
      { type: "thread", threadId },
      { type: "thread", threadId },
      false,
    ],
    [
      "a share is Done-able and snoozes its thread",
      item({ group: "for-you", reason: "shared-with-you", threadId }),
      { type: "thread", threadId },
      { type: "thread", threadId },
      true,
    ],
    [
      "a mention opens its room and has nothing to snooze",
      item({ group: "for-you", reason: "mention", spaceId, threadId }),
      { type: "room", spaceId },
      null,
      true,
    ],
    ["an item naming nothing opens nothing", item({ reason: "approval" }), null, null, false],
  ])("%s", (_label, input, target, snooze, done) => {
    expect(inboxItemTarget(input)).toEqual(target);
    expect(inboxItemSnooze(input)).toEqual(snooze);
    expect(canMarkInboxItemDone(input)).toBe(done);
  });
});

describe("sharedWithYouRows", () => {
  const meera = MemberId.make("member:meera");
  const hanad = MemberId.make("member:hanad");
  const shared = (id: string, ownerId: MemberId): SharedWithYouItem => ({
    threadId: ThreadId.make(id),
    title: id,
    ownerId,
    via: "name",
    state: "idle",
    lastActivityAt: at,
  });

  it("puts each person's header before their threads, in the server's person order", () => {
    const rows = sharedWithYouRows(
      [shared("a", meera), shared("b", hanad), shared("c", meera)],
      [
        { memberId: hanad, count: 4, lastActivityAt: at },
        { memberId: meera, count: 2, lastActivityAt: at },
      ],
    );
    expect(
      rows.map((row) => (row.type === "person" ? `${row.memberId} ${row.count}` : row.item.title)),
    ).toEqual(["member:hanad 4", "b", "member:meera 2", "a", "c"]);
  });
});
