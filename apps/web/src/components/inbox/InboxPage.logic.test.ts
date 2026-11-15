import { type InboxItem, SpaceId, SpaceTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inboxItemTarget, inboxSnoozeKind, moveInboxSelection } from "./InboxPage.logic";

const SPACE = SpaceId.make("spc_00000000000000000001");
const TASK = SpaceTaskId.make("stk_00000000000000000001");
const THREAD = ThreadId.make("thread-1");

const item = (overrides: Partial<InboxItem>): InboxItem => ({
  id: "item",
  group: "needs-you",
  reason: "approval",
  at: "2026-11-15T10:00:00.000Z",
  actorId: null,
  ...overrides,
});

describe("inbox item actions", () => {
  it.each([
    ["approval", { reason: "approval", threadId: THREAD }, "thread", "thread"],
    ["offer", { reason: "offer", threadId: THREAD }, "thread", "thread"],
    [
      "shared thread",
      { group: "for-you", reason: "shared-with-you", threadId: THREAD },
      "thread",
      "thread",
    ],
    [
      "assigned task, even with a thread",
      { reason: "task-assigned", spaceId: SPACE, taskId: TASK, threadId: THREAD },
      "task",
      "task",
    ],
    ["mention", { group: "for-you", reason: "mention", spaceId: SPACE }, "room", null],
    [
      "added to a space",
      { group: "for-you", reason: "added-to-space", spaceId: SPACE },
      "room",
      null,
    ],
    ["a thread item whose thread is gone", { reason: "question" }, null, null],
  ] as const)("%s: Enter opens its %s, h snoozes its %s", (_name, overrides, target, snooze) => {
    const entry = item(overrides);
    expect(inboxItemTarget(entry)?.kind ?? null).toBe(target);
    expect(inboxSnoozeKind(entry)).toBe(snooze);
  });

  it("j and k hold at the ends and start from the top without a selection", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(moveInboxSelection(items, "a", 1)).toBe("b");
    expect(moveInboxSelection(items, "b", 1)).toBe("b");
    expect(moveInboxSelection(items, "a", -1)).toBe("a");
    expect(moveInboxSelection(items, "gone", 1)).toBe("a");
    expect(moveInboxSelection([], null, 1)).toBeNull();
  });
});
