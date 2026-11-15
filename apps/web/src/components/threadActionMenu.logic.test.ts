import type { CloudThreadMenuItem } from "@t3tools/client-runtime/branch-lineage";
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

  it("disables archive, turning into a project, continuing in cloud and forking to a new machine while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
      continueInCloud: { label: "a turn is running" },
      forkToMachine: { blocker: "Wait for the turn to finish." },
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "continue-in-cloud")).toMatchObject({
      label: "Continue in cloud (a turn is running)",
      disabled: true,
    });
    expect(items.find((item) => item.id === "fork-to-machine")).toMatchObject({
      label: "Fork to new machine (Wait for the turn to finish)",
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

  it("leads a team's cloud thread with Branch off and Side chat, and keeps Fork the holder's", () => {
    const item = (
      id: CloudThreadMenuItem["id"],
      label: string,
      fields: Partial<CloudThreadMenuItem> = {},
    ): CloudThreadMenuItem => ({
      id,
      label,
      detail: null,
      disabled: false,
      disabledReason: null,
      readOnly: false,
      group: "thread",
      ...fields,
    });
    const team = { members: [], ownerId: null, canDelete: true, canAssign: true };
    const menu = (cloud: ReadonlyArray<CloudThreadMenuItem>, allowed: boolean) =>
      buildThreadActionMenuItems({
        ...baseState,
        team,
        share: { allowed },
        spaceTask: { canMove: true, canRemove: true },
        forkToMachine: { blocker: null },
        cloud,
      });
    const summary = (items: ReturnType<typeof menu>) =>
      items
        .filter((entry) =>
          [
            "branch-off",
            "side-chat",
            "share",
            "space-move-task",
            "fork-to-machine",
            "move-to-own-machine",
          ].includes(entry.id),
        )
        .map((entry) => [entry.id, entry.label, entry.disabled ?? false]);

    // Someone else's thread: Side chat is read-only, and Fork is not offered.
    const theirs = menu(
      [
        item("branchOff", "Branch off…"),
        item("sideChat", "Side chat", { readOnly: true }),
        item("share", "Share… (owner only)", { disabled: true }),
        item("assign", "Assign to… (owner only)", { disabled: true }),
      ],
      false,
    );
    expect(theirs[0]?.id).toBe("branch-off");
    expect(summary(theirs)).toEqual([
      ["branch-off", "Branch off…", false],
      ["side-chat", "Side chat (read-only)", false],
      ["share", "Share… (owner only)", true],
      ["space-move-task", "Move to another task…", false],
    ]);

    // The holder keeps Fork.
    const own = menu(
      [
        item("branchOff", "Branch off…"),
        item("sideChat", "Side chat"),
        item("share", "Share…"),
        item("assign", "Assign to…"),
        item("fork", "Fork"),
      ],
      true,
    );
    expect(summary(own)).toEqual([
      ["branch-off", "Branch off…", false],
      ["side-chat", "Side chat", false],
      ["share", "Share…", false],
      ["space-move-task", "Move to another task…", false],
      ["fork-to-machine", "Fork to new machine…", false],
    ]);

    // A branch on someone else's machine shares and moves only after Move to my own machine.
    const reason = "On Kousik's machine, sharing follows Kousik's list.";
    const onTheirMachine = menu(
      [
        item("sideChat", "Side chat"),
        item("share", "Share…", { disabled: true, disabledReason: reason }),
        item("assign", "Assign to…"),
        item("fork", "Fork"),
        item("moveToOwnMachine", "Move to my own machine"),
      ],
      true,
    );
    expect(summary(onTheirMachine)).toEqual([
      ["side-chat", "Side chat", false],
      ["share", "Share… (on Kousik's machine, sharing follows Kousik's list)", true],
      [
        "space-move-task",
        "Move to another task… (on Kousik's machine, sharing follows Kousik's list)",
        true,
      ],
      ["move-to-own-machine", "Move to my own machine…", false],
      ["fork-to-machine", "Fork to new machine…", false],
    ]);
  });

  it("offers Move and Remove only on a thread on a space task, disabled without the right", () => {
    const space = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state })
        .filter((item) => item.id === "space-move-task" || item.id === "space-remove-task")
        .map((item) => [item.id, item.disabled ?? false]);
    expect(space({})).toEqual([]);
    expect(space({ spaceTask: { canMove: true, canRemove: false } })).toEqual([
      ["space-move-task", false],
      ["space-remove-task", true],
    ]);
    expect(space({ spaceTask: { canMove: true, canRemove: true }, canOperate: false })).toEqual([
      ["space-move-task", true],
      ["space-remove-task", true],
    ]);
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
