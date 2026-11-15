import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowDownToLineIcon, GitCompareArrowsIcon } from "lucide-react";
import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { registerCommands } from "~/shortcuts/dispatcher";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { useLineageChip } from "./LineageChip";
import { useLineageActions } from "./useLineageActions";

/** Update from source and Offer changes, offered only while each has work to do. */
function useLineageWork(threadRef: ScopedThreadRef | null) {
  const chip = useLineageChip(threadRef);
  const actions = useLineageActions();
  const update = threadRef === null ? undefined : chip?.actions.find((a) => a.kind === "update");
  const offer = threadRef === null ? undefined : chip?.actions.find((a) => a.kind === "offer");
  return { threadRef, update, offer, actions };
}

/** `thread.updateFromSource` and `thread.offerChanges` on the open thread. */
export function LineageThreadShortcuts({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { update, offer, actions } = useLineageWork(threadRef);
  const canUpdate = update !== undefined;
  const canOffer = offer !== undefined;
  const runUpdate = useStableCallback(() => void actions.startUpdate(threadRef));
  const runOffer = useStableCallback(() => actions.openOffer(threadRef));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the thread's lineage keybindings with the app's keyboard dispatcher
  useEffect(
    () =>
      registerCommands({
        "thread.updateFromSource": (event) => {
          if (!canUpdate) return false;
          event.preventDefault();
          if (!event.repeat) runUpdate();
        },
        "thread.offerChanges": (event) => {
          if (!canOffer) return false;
          event.preventDefault();
          if (!event.repeat) runOffer();
        },
      }),
    [canUpdate, canOffer, runUpdate, runOffer],
  );
  return null;
}

/** The palette's Update from source and Offer changes for the active thread. */
export function useLineagePaletteItems(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const { update, offer, actions } = useLineageWork(threadRef);
  if (threadRef === null) return [];
  const items: CommandPaletteActionItem[] = [];
  if (update !== undefined) {
    items.push({
      kind: "action",
      value: "action:lineage-update",
      searchTerms: ["update", "source", "merge", "branch", "lineage"],
      title: "Update from source",
      description: update.label,
      shortcutCommand: "thread.updateFromSource",
      icon: <ArrowDownToLineIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await actions.startUpdate(threadRef);
      },
    });
  }
  if (offer !== undefined) {
    items.push({
      kind: "action",
      value: "action:lineage-offer",
      searchTerms: ["offer", "changes", "apply", "branch", "lineage"],
      title: "Offer changes",
      description: offer.label,
      shortcutCommand: "thread.offerChanges",
      icon: <GitCompareArrowsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        actions.openOffer(threadRef);
      },
    });
  }
  return items;
}
