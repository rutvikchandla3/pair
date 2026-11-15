import { menuItemsForCloudThread } from "@t3tools/client-runtime/branch-lineage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useLineageViewer } from "../../state/branch-lineage";
import { useQuietThreadShell } from "../../state/entities";
import {
  type LineageMenuItemId,
  lineageMenuItems,
  lineageShareRestriction,
} from "./lineagePresentation";
import { useLineageActions } from "./useLineageActions";

const ICONS: Readonly<Record<LineageMenuItemId, string>> = {
  branchOff: "arrow.triangle.branch",
  update: "arrow.down",
  offer: "arrow.up",
  moveToOwnMachine: "cloud",
};

/**
 * Branch off…, Update, Offer and Move to my own machine, first in the thread's Team menu; Share
 * waits for Move to my own machine on someone else's.
 */
export function useLineageMenu(thread: EnvironmentThreadShell | null) {
  const viewer = useLineageViewer(thread?.environmentId ?? null);
  const actions = useLineageActions();
  const items: ReadonlyArray<AppBarMenuItem> =
    thread === null || viewer === null
      ? []
      : lineageMenuItems(thread.source, viewer).map((item) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          return {
            id: `lineage:${item.id}`,
            title: item.title,
            icon: ICONS[item.id],
            ...(item.subtitle === null ? {} : { subtitle: item.subtitle }),
            onPress: () => {
              switch (item.id) {
                case "branchOff":
                  return actions.open("ThreadBranchOff", ref);
                case "update":
                  return actions.open("ThreadUpdate", ref);
                case "offer":
                  return actions.open("ThreadOffer", ref);
                case "moveToOwnMachine":
                  return actions.moveToOwnMachine(ref, thread.title);
              }
            },
          };
        });
  const shareRestriction =
    thread === null || viewer === null ? null : lineageShareRestriction(thread.source, viewer);
  return (menu: AppBarMenu | null): AppBarMenu | null => {
    if (menu === null || (items.length === 0 && shareRestriction === null)) return menu;
    const rest =
      shareRestriction === null
        ? menu.items
        : menu.items.map((item) =>
            item.id === "share" && "onPress" in item
              ? { ...item, disabled: true, subtitle: shareRestriction }
              : item,
          );
    return { ...menu, items: [...items, ...rest] };
  };
}

/** Fork stays the owner's tool on a cloud thread; local threads keep it for everyone. */
export function useCanForkThread(ref: ScopedThreadRef): boolean {
  const shell = useQuietThreadShell(ref);
  const viewer = useLineageViewer(ref.environmentId);
  if (shell === null || viewer === null) return true;
  const items = menuItemsForCloudThread(shell.source, viewer);
  return items === null || items.some((item) => item.id === "fork");
}
