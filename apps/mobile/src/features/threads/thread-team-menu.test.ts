import { SHARE_THREAD_OWNER_ONLY_REASON } from "@t3tools/client-runtime/state/sandbox";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadTeamMenu } from "../../state/team";
import { buildThreadTeamHeaderMenu, buildThreadTeamMenuItems } from "./thread-team-menu";

const menu: ThreadTeamMenu = { members: [], ownerId: null, canDelete: true, following: null };
const actions = { setFollowed: () => {}, assign: () => {}, share: () => {} };

describe("Share in the thread menus", () => {
  it.each([
    ["the owner", { allowed: true }, {}],
    [
      "anyone else",
      { allowed: false },
      { attributes: { disabled: true }, subtitle: SHARE_THREAD_OWNER_ONLY_REASON },
    ],
  ])("row menu for %s", (_name, share, expected) => {
    const item = buildThreadTeamMenuItems(menu, share).find(({ id }) => id === "share");
    expect(item).toMatchObject({ title: "Share…", ...expected });
    if (share.allowed) expect(item).not.toHaveProperty("attributes");
  });

  it("header menu for the owner and for anyone else", () => {
    const find = (allowed: boolean) =>
      buildThreadTeamHeaderMenu(menu, actions, { allowed }).items.find(({ id }) => id === "share");
    expect(find(true)).toMatchObject({ title: "Share…" });
    expect(find(true)).not.toHaveProperty("disabled");
    expect(find(false)).toMatchObject({ disabled: true, subtitle: SHARE_THREAD_OWNER_ONLY_REASON });
  });

  it("is absent for a local thread and on a solo server", () => {
    expect(buildThreadTeamMenuItems(menu).some(({ id }) => id === "share")).toBe(false);
    expect(buildThreadTeamHeaderMenu(menu, actions).items.some(({ id }) => id === "share")).toBe(
      false,
    );
  });
});
