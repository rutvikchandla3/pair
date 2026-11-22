import { sidebarSpaceRows } from "@t3tools/client-runtime/inbox";
import {
  EnvironmentId,
  MemberId,
  ProjectId,
  type Space,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  teamEnvironmentIds: [] as ReadonlyArray<string>,
  inboxCount: 0,
}));

vi.mock(import("../../state/inbox"), async (original) => ({
  ...(await original()),
  useTeamEnvironmentIds: (() => state.teamEnvironmentIds) as never,
  useInboxNeedsYouTotal: (() => state.inboxCount) as never,
}));
vi.mock(import("../../state/spaces"), async (original) => ({
  ...(await original()),
  // The per-environment space list has its own test below.
  useSpaceEnvironmentIds: (() => []) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => () => Promise.resolve({ _tag: "Success", value: {} })) as never,
}));

import { SidebarSpaceList, SidebarSpaces } from "./SidebarSpaces";

const ENVIRONMENT = EnvironmentId.make("env-team");
const ME = MemberId.make("member-me");
const AT = "2026-11-01T10:00:00.000Z";

function setup(input: {
  readonly teamEnvironmentIds: ReadonlyArray<string>;
  readonly count: number;
}) {
  state.teamEnvironmentIds = input.teamEnvironmentIds;
  state.inboxCount = input.count;
}

const space = (index: number, overrides: Partial<Space> = {}): Space => ({
  id: SpaceId.make(`spc_${String(index).padStart(20, "0")}`),
  roomThreadId: ThreadId.make(`thread:room-${index}`),
  name: `Space ${index}`,
  brief: "",
  repositoryIds: [ProjectId.make("project:a")],
  projectId: ProjectId.make("project:a"),
  ownerId: ME,
  members: [{ memberId: ME, joinedAt: AT, addedBy: null, removedAt: null }],
  joinRequests: [],
  createdBy: ME,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  archivedBy: null,
  ...overrides,
});

describe("SidebarSpaces", () => {
  it("shows Inbox with its count, My tasks and Shared with you in team mode", async () => {
    setup({ teamEnvironmentIds: [ENVIRONMENT], count: 4 });
    await using screen = await render(<SidebarSpaces />);

    await expect.element(screen.getByRole("link", { name: /Inbox/ })).toBeVisible();
    await expect.element(screen.getByLabelText("4 need you")).toHaveTextContent("4");
    await expect.element(screen.getByRole("link", { name: "My tasks" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Shared with you" })).toBeVisible();
  });

  it("shows nothing solo", async () => {
    setup({ teamEnvironmentIds: [], count: 0 });
    await using screen = await render(<SidebarSpaces />);

    expect(screen.container.textContent).toBe("");
  });
});

describe("SidebarSpaceList", () => {
  it("shows five spaces, then N more with their count, and Archived inside the expansion", async () => {
    setup({ teamEnvironmentIds: [ENVIRONMENT], count: 0 });
    const spaces = [1, 2, 3, 4, 5, 6, 7].map((index) => space(index));
    const archived = space(8, { archivedAt: AT, archivedBy: ME });
    const rows = sidebarSpaceRows(
      [...spaces, archived],
      spaces.map((entry) => entry.id),
      { needsYou: 3, bySpace: [{ spaceId: spaces[6]!.id, needsYou: 3 }], revision: 1 },
      new Set([spaces[0]!.roomThreadId]),
      ME,
    );
    await using screen = await render(
      <SidebarSpaceList
        environmentId={ENVIRONMENT}
        rows={rows}
        selectedSpaceId={spaces[1]!.id}
        canOperate
        viewerId={ME}
        onReorder={() => undefined}
      />,
    );

    for (const index of [1, 2, 3, 4, 5]) {
      await expect
        .element(screen.getByRole("link", { name: new RegExp(`^Space ${index}`) }))
        .toBeVisible();
    }
    await expect
      .element(screen.getByRole("link", { name: "Space 2" }))
      .toHaveAttribute("aria-current", "page");
    await expect
      .element(screen.getByRole("link", { name: /Space 1/ }).getByText("Space 1", { exact: true }))
      .toBeVisible();
    expect(screen.getByLabelText("Unread").elements()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Space 6" }).elements()).toHaveLength(0);
    expect(screen.getByText("Archived").elements()).toHaveLength(0);

    const more = screen.getByRole("button", { name: /2 more/ });
    // The hidden spaces' Needs you total follows the label.
    await expect.element(more).toHaveTextContent("2 more3");
    await userEvent.click(more);

    await expect.element(screen.getByRole("link", { name: "Space 6" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: /Space 7/ })).toBeVisible();
    await expect.element(screen.getByLabelText("3 need you")).toBeVisible();
    await expect.element(screen.getByText("Archived")).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Space 8" })).toBeVisible();
  });
});
