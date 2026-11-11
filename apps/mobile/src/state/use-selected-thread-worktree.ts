import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type ThreadRepository,
  isWorkspaceProject,
  threadRepositories,
} from "@t3tools/client-runtime/state/workspaces";
import * as Option from "effect/Option";

import { useProject, useQuietThreadShell } from "./entities";
import { useEnvironmentThread } from "./threads";
import { useSelectedThreadWorktreePath, useThreadWorktreePath } from "./use-thread-detail";
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

/**
 * Resolves a thread's cwd the way the selected thread's does, for a thread that is not the
 * current route's: the shell, or the loaded detail when the shell is missing, picks the project.
 */
export function useThreadCwd(ref: ScopedThreadRef | null): string | null {
  const shell = useQuietThreadShell(ref);
  const detailState = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  const detailThread = Option.getOrNull(detailState.data)?.thread ?? null;
  const detailWorktreePath = useThreadWorktreePath(ref);
  const projectId = shell?.projectId ?? detailThread?.projectId ?? null;
  const project = useProject(
    ref === null || projectId === null ? null : { environmentId: ref.environmentId, projectId },
  );
  const worktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: shell?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });
  // A cloud thread's files are on its machine; until it has a worktree there is nothing to read.
  const cloud = (shell?.source.sandboxId ?? detailThread?.sandboxId) !== undefined;
  return worktreePath ?? (cloud ? null : (project?.workspaceRoot ?? null));
}
