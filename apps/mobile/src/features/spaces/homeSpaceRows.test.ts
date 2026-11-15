import { MemberId, ProjectId, type Space, SpaceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type HomeTeamItem,
  homeMoreLabel,
  homeTeamItems,
  moveSpaceInOrder,
  rememberSpaceOrder,
} from "./homeSpaceRows";

const me = MemberId.make("member:me");

const space = (index: number, overrides: Partial<Space> = {}): Space => {
  const joinedAt = `2026-11-${String(index).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id: SpaceId.make(`spc_${String(index).padStart(20, "0")}`),
    roomThreadId: ThreadId.make(`thread:room-${index}`),
    name: `Space ${index}`,
    brief: "",
    repositoryIds: [ProjectId.make("project:a")],
    projectId: ProjectId.make("project:a"),
    ownerId: me,
    members: [{ memberId: me, joinedAt, addedBy: null, removedAt: null }],
    joinRequests: [],
    createdBy: me,
    createdAt: joinedAt,
    updatedAt: joinedAt,
    archivedAt: null,
    archivedBy: null,
    ...overrides,
  };
};

const describeItem = (item: HomeTeamItem): string => {
  switch (item.type) {
    case "place":
      return item.count === null ? item.key : `${item.key} ${item.count}`;
    case "space":
    case "archived-space":
      return `${item.type === "space" ? "" : "archived "}${item.row.space.name}${
        item.row.needsYou > 0 ? ` ${item.row.needsYou}` : item.row.unread ? " ·" : ""
      }`;
    case "more":
      return `${homeMoreLabel(item)} (${item.needsYou})`;
    default:
      return item.type;
  }
};

describe("homeTeamItems", () => {
  // Spaces 1-7 active, 8 archived; the user ordered 1-7 ascending.
  const spaces = [
    ...[1, 2, 3, 4, 5, 6, 7].map((index) => space(index)),
    space(8, { archivedAt: "2026-11-10T00:00:00.000Z" }),
  ];
  const order = [1, 2, 3, 4, 5, 6, 7].map((index) => spaces[index - 1]!.id);
  const summary = {
    needsYou: 5,
    bySpace: [
      { spaceId: spaces[0]!.id, needsYou: 2 },
      { spaceId: spaces[6]!.id, needsYou: 3 },
    ],
    revision: 1,
  };
  const input = {
    teamMode: true,
    spaces,
    order,
    summary,
    // Space 2's room is unread; Space 1's is too, but its count wins over the dot.
    unreadRoomIds: new Set<string>([spaces[0]!.roomThreadId, spaces[1]!.roomThreadId]),
    viewerId: me,
    expanded: false,
  };

  it("leads with the three places, then five spaces and N more carrying the hidden count", () => {
    expect(homeTeamItems(input).map(describeItem)).toEqual([
      "inbox 5",
      "my-tasks",
      "shared-with-you",
      "spaces-header",
      "Space 1 2",
      "Space 2 ·",
      "Space 3",
      "Space 4",
      "Space 5",
      "2 more (3)",
    ]);
  });

  it("expands in place to the rest and the archived spaces under their own header", () => {
    expect(
      homeTeamItems({ ...input, expanded: true })
        .map(describeItem)
        .slice(9),
    ).toEqual(["Show less (3)", "Space 6", "Space 7 3", "archived-header", "archived Space 8"]);
  });

  it("puts spaces missing from the order on top, latest joined first", () => {
    const names = homeTeamItems({ ...input, order: order.slice(2) })
      .filter((item) => item.type === "space")
      .map(describeItem);
    expect(names).toEqual(["Space 2 ·", "Space 1 2", "Space 3", "Space 4", "Space 5"]);
  });

  it("offers Archived alone when nothing active is hidden, and no places on solo servers", () => {
    const few = [space(1), space(2, { archivedAt: "2026-11-10T00:00:00.000Z" })];
    expect(
      homeTeamItems({ ...input, teamMode: false, spaces: few, summary: null }).map(describeItem),
    ).toEqual(["spaces-header", "Space 1 ·", "Archived (0)"]);
    expect(
      homeTeamItems({ ...input, spaces: [], summary: null, unreadRoomIds: new Set() }).map(
        describeItem,
      ),
    ).toEqual(["inbox 0", "my-tasks", "shared-with-you", "spaces-header", "spaces-empty"]);
  });
});

describe("space order", () => {
  it("remembers what was shown, keeps unseen ids, and is a no-op once remembered", () => {
    const stored = ["b", "gone"];
    const next = rememberSpaceOrder(stored, ["new", "b"]);
    expect(next).toEqual(["new", "b", "gone"]);
    expect(rememberSpaceOrder(next, ["new", "b"])).toBe(next);
  });

  it("moves a space one place among the shown spaces, never past either end", () => {
    const shown = ["a", "b", "c"];
    expect(moveSpaceInOrder(shown, shown, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveSpaceInOrder(shown, shown, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveSpaceInOrder(shown, shown, "a", -1)).toBe(shown);
    expect(moveSpaceInOrder(shown, shown, "c", 1)).toBe(shown);
  });
});
