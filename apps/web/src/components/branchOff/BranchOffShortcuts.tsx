import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { registerCommands } from "~/shortcuts/dispatcher";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { branchOffRoute } from "./branchOffTarget";
import { useCanBranchOff } from "./useBranchOff";

/** `thread.branchOff` on the open thread, where Branch off is offered. */
export function BranchOffThreadShortcut({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const canBranchOff = useCanBranchOff(threadRef);
  const open = useStableCallback(() => void navigate(branchOffRoute(threadRef)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the thread's Branch off keybinding with the app's keyboard dispatcher
  useEffect(
    () =>
      registerCommands({
        "thread.branchOff": (event) => {
          if (!canBranchOff) return false;
          event.preventDefault();
          if (!event.repeat) open();
        },
      }),
    [canBranchOff, open],
  );
  return null;
}

/** The palette's Branch off for the active thread, where it is offered. */
export function useBranchOffPaletteItems(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const canBranchOff = useCanBranchOff(threadRef);
  if (threadRef === null || !canBranchOff) return [];
  return [
    {
      kind: "action",
      value: "action:branch-off",
      searchTerms: ["branch off", "branch", "own", "work on my own", "lineage", "fork"],
      title: "Branch off…",
      description: "Your own thread, branch and worktree from this thread's latest",
      shortcutCommand: "thread.branchOff",
      icon: <GitBranchIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate(branchOffRoute(threadRef));
      },
    },
  ];
}
