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

  it("disables archive, turning into a project and continuing in cloud while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
      continueInCloud: { label: "a turn is running" },
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "continue-in-cloud")).toMatchObject({
      label: "Continue in cloud (a turn is running)",
      disabled: true,
    });
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
    expect(solo.some((item) => item.id === "follow" || item.id === "unfollow")).toBe(false);
    expect(solo.find((item) => item.id === "delete")).toEqual({
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    });

    const owned = buildThreadActionMenuItems({
      ...baseState,
      team: { members, ownerId: ben, canDelete: true, canAssign: true },
    });
    expect(
      owned.find((item) => item.id === "assign")?.children?.map((c) => [c.id, c.checked]),
    ).toEqual([
      [`assign:${ana}`, false],
      [`assign:${ben}`, true],
    ]);
    expect(owned.find((item) => item.id === "delete")?.disabled).toBeUndefined();
    // The owner has no Follow; Unfollow would be a dead end for them.
    expect(owned.some((item) => item.id === "follow" || item.id === "unfollow")).toBe(false);

    const follow = (following: boolean) =>
      buildThreadActionMenuItems({
        ...baseState,
        team: { members, ownerId: ben, canDelete: false, canAssign: true, following },
      }).map((item) => item.id);
    expect(follow(false)).toContain("follow");
    expect(follow(true)).toContain("unfollow");
    expect(follow(false).indexOf("follow")).toBe(follow(false).indexOf("assign") + 1);

    const notOwner = buildThreadActionMenuItems({
      ...baseState,
      team: { members, ownerId: null, canDelete: false, canAssign: true },
    });
    expect(notOwner.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(notOwner.find((item) => item.id === "assign")?.children?.some((c) => c.checked)).toBe(
      false,
    );
    const copyChildren = (items: typeof solo) =>
      items.find((item) => item.id === "copy")?.children?.map((child) => child.id);
    expect(solo.some((item) => item.id.startsWith("machine:"))).toBe(false);
    expect(copyChildren(solo)).toContain("copy-path");

    const member = buildThreadActionMenuItems({
      ...baseState,
      team: { members, ownerId: ben, canDelete: false, canAssign: true },
      machine: {
        actions: ["wake", "sleep", "retry", "discard"],
        ownerOnlyDenied: ["sleep", "discard"],
      },
    });
    const machineRows = member.filter((item) => item.id.startsWith("machine:"));
    expect(machineRows.map((item) => [item.id, item.label, item.disabled ?? false])).toEqual([
      ["machine:wake", "Wake machine", false],
      ["machine:sleep", "Sleep now (owner or admin only)", true],
      ["machine:retry", "Retry machine", false],
      ["machine:discard", "Discard machine (owner or admin only)", true],
    ]);
    expect(member.findIndex((item) => item.id === "machine:wake")).toBe(
      member.findIndex((item) => item.id === "mark-unread") + 1,
    );
    expect(copyChildren(member)).not.toContain("copy-path");
  });

  it("shows Assign to… disabled with its reason on a cloud thread the viewer does not own", () => {
    const assign = (canAssign: boolean, canOperate = true) => {
      const item = buildThreadActionMenuItems({
        ...baseState,
        canOperate,
        team: { members: [], ownerId: null, canDelete: true, canAssign },
      }).find((candidate) => candidate.id === "assign");
      return [item?.label, item?.disabled ?? false];
    };
    expect(assign(true)).toEqual(["Assign to…", false]);
    expect(assign(false)).toEqual(["Assign to… (owner only)", true]);
  });

  it("offers Share… under Assign to… on a team's cloud thread, disabled for anyone but its owner", () => {
    const team = { members: [], ownerId: null, canDelete: true, canAssign: true };
    const share = (state: Partial<ThreadActionMenuState>) => {
      const items = buildThreadActionMenuItems({ ...baseState, ...state });
      const index = items.findIndex((item) => item.id === "share");
      const item = items[index];
      return item === undefined
        ? null
        : [item.label, item.disabled ?? false, items[index - 1]?.id ?? null];
    };
    expect(share({ team, share: { allowed: true } })).toEqual(["Share…", false, "assign"]);
    expect(share({ team, share: { allowed: false } })).toEqual([
      "Share… (owner only)",
      true,
      "assign",
    ]);
    // A local thread, or a cloud thread on a solo server, has no share state.
    expect(share({ team })).toBeNull();
    expect(share({})).toBeNull();
    expect(share({ team, share: { allowed: true }, canOperate: false })?.[1]).toBe(true);
  });

  it("offers Continue locally after the machine actions, disabled with why", () => {
    const ids = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).map((item) => item.id);
    expect(ids(baseState)).not.toContain("continue-locally");

    const machine = { actions: ["sleep" as const], ownerOnlyDenied: [] };
    const ready = buildThreadActionMenuItems({
      ...baseState,
      machine,
      continueLocally: { disabledLabel: null },
    });
    const item = ready.find((candidate) => candidate.id === "continue-locally");
    expect(ready.indexOf(item!)).toBe(ready.findIndex((c) => c.id === "machine:sleep") + 1);
    expect([item?.label, item?.disabled, item?.separatorBefore]).toEqual([
      "Continue locally",
      undefined,
      undefined,
    ]);

    // Alone after Mark unread, it starts its own group.
    const busy = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      continueLocally: { disabledLabel: "turn running" },
    }).find((candidate) => candidate.id === "continue-locally");
    expect([busy?.label, busy?.disabled, busy?.separatorBefore]).toEqual([
      "Continue locally (turn running)",
      true,
      true,
    ]);
  });
});
