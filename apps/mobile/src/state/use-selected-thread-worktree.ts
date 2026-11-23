import {
  type ThreadRepository,
  isWorkspaceProject,
  threadRepositories,
} from "@t3tools/client-runtime/state/workspaces";

import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: selectedThread?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd:
      selectedThreadWorktreePath ??
      (selectedThread?.source.sandboxId === undefined
        ? (selectedThreadProject?.workspaceRoot ?? null)
        : null),
  };
}

/**
 * A workspace thread's repositories, empty until its folder of worktrees exists; null for a
 * thread in one repository, whose git controls apply to its own checkout.
 */
export function useSelectedThreadRepositories(): ReadonlyArray<ThreadRepository> | null {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadWorktreePath } = useSelectedThreadWorktree();
  if (
    selectedThread === null ||
    (selectedThread.roots === undefined && !isWorkspaceProject(selectedThreadProject))
  ) {
    return null;
  }
  return threadRepositories(
    { ...selectedThread, worktreePath: selectedThreadWorktreePath },
    selectedThreadProject,
  );
}
