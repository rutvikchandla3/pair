import type { MemberId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import type { ThreadTeamMenu } from "../../state/team";

const ASSIGN_PREFIX = "assign:";

/** Follow or Unfollow where it applies, then Assign to… listing the active members. */
export function buildThreadTeamMenuItems(menu: ThreadTeamMenu): MenuAction[] {
  return [
    ...(menu.following === null
      ? []
      : [
          menu.following
            ? { id: "unfollow", title: "Unfollow", image: "bell.slash" }
            : { id: "follow", title: "Follow", image: "bell" },
        ]),
    {
      id: "assign",
      title: "Assign to…",
      image: "person.crop.circle",
      subactions: menu.members.map((member) => ({
        id: `${ASSIGN_PREFIX}${member.id}`,
        title: member.name,
        state: member.id === menu.ownerId ? "on" : "off",
      })),
    },
  ];
}

/** The member a menu event assigns the thread to; null for other events and the current owner. */
export function resolveThreadAssignMenuSelection(
  event: string,
  menu: ThreadTeamMenu | null,
): MemberId | null {
  if (menu === null || !event.startsWith(ASSIGN_PREFIX)) return null;
  const member = menu.members.find(({ id }) => id === event.slice(ASSIGN_PREFIX.length));
  return member === undefined || member.id === menu.ownerId ? null : member.id;
}

/** The thread header's Team menu: the same Follow and Assign entries as the row menu. */
export function buildThreadTeamHeaderMenu(
  menu: ThreadTeamMenu,
  actions: {
    readonly setFollowed: (following: boolean) => void;
    readonly assign: (ownerId: MemberId) => void;
  },
): AppBarMenu {
  return {
    title: "Team",
    icon: "person.2",
    items: [
      ...(menu.following === null
        ? []
        : [
            {
              id: menu.following ? "unfollow" : "follow",
              title: menu.following ? "Unfollow" : "Follow",
              icon: menu.following ? "bell.slash" : "bell",
              onPress: () => actions.setFollowed(!menu.following),
            },
          ]),
      {
        id: "assign",
        title: "Assign to…",
        icon: "person.crop.circle",
        items: menu.members.map((member) => ({
          id: `${ASSIGN_PREFIX}${member.id}`,
          title: member.name,
          selected: member.id === menu.ownerId,
          onPress: () => {
            if (member.id !== menu.ownerId) actions.assign(member.id);
          },
        })),
      },
    ],
  };
}
