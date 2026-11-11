import { useProject } from "./entities";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useSelectedThreadWorkspace } from "./use-selected-thread-workspace";
import { useThreadSelection } from "./use-thread-selection";

/**
 * Where the selected thread's git controls act: its checkout, or for a workspace thread the
 * selected repository with that repository's own project. The workspace folder itself never.
 */
export function useSelectedThreadGitTarget() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const workspace = useSelectedThreadWorkspace();
  const repository = workspace?.selected ?? null;
  const repositoryProject = useProject(
    selectedThread === null || repository === null
      ? null
      : { environmentId: selectedThread.environmentId, projectId: repository.projectId },
  );
  if (workspace === null) {
    return {
      workspace,
      repository,
      cwd: selectedThreadCwd,
      rootCwd: selectedThreadProject?.workspaceRoot ?? null,
      project: selectedThreadProject,
    };
  }
  return {
    workspace,
    repository,
    cwd: repository?.cwd ?? null,
    rootCwd: repository?.cwd ?? null,
    project: repository === null ? null : repositoryProject,
  };
}
