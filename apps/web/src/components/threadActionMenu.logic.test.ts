import { MemberId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("offers assign and gates delete only on a server with a team", () => {
    const ana = MemberId.make("member-ana");
    const ben = MemberId.make("member-ben");
    const members = [
      { id: ana, name: "Ana" },
      { id: ben, name: "Ben" },
    ];
    const solo = buildThreadActionMenuItems(baseState);
    expect(solo.some((item) => item.id === "assign")).toBe(false);
    expect(solo.find((item) => item.id === "delete")).toEqual({
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    });

    const owned = buildThreadActionMenuItems({
      ...baseState,
      team: { members, ownerId: ben, canDelete: true },
    });
    expect(
      owned.find((item) => item.id === "assign")?.children?.map((c) => [c.id, c.checked]),
    ).toEqual([
      [`assign:${ana}`, false],
      [`assign:${ben}`, true],
    ]);
    expect(owned.find((item) => item.id === "delete")?.disabled).toBeUndefined();

    const notOwner = buildThreadActionMenuItems({
      ...baseState,
      team: { members, ownerId: null, canDelete: false },
    });
    expect(notOwner.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(notOwner.find((item) => item.id === "assign")?.children?.some((c) => c.checked)).toBe(
      false,
    );
  });
});
