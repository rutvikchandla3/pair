import { vcsActionLabelText } from "@t3tools/client-runtime/state/vcs";
import { useMessages } from "gt-react-native";
import { useMemo } from "react";

import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useBranches } from "./queries";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useVcsActionState } from "./use-vcs-action-state";
import type { GitRepositoryTarget } from "./thread-git-target";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadGitTarget } from "./use-selected-thread-git-target";
import { workspaceRunLabel } from "./use-selected-thread-workspace";

/** Git state for the selected thread's own folder, or for `repository` when given. */
export function useSelectedThreadGitState(repository?: GitRepositoryTarget) {
  const messages = useMessages();
  const { selectedThread } = useThreadSelection();
  const target = useSelectedThreadGitTarget();
  const workspaceRun = target.workspace?.run ?? null;
  const selectedThreadCwd = repository?.cwd ?? target.cwd;

  const gitActionState = useVcsActionState({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
  });
  const sourceControlDiscovery = useEnvironmentQuery(
    selectedThread === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: selectedThread.environmentId,
          input: {},
        }),
  );

  const selectedThreadBranchTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
    query: null,
  };
  const selectedThreadBranchState = useBranches(selectedThreadBranchTarget);
  const selectedThreadBranches = useMemo(
    () =>
      dedupeRemoteBranchesWithLocalMatches(selectedThreadBranchState.data?.refs ?? []).filter(
        (branch) => !branch.isRemote,
      ),
    [selectedThreadBranchState.data?.refs],
  );

  return {
    // "All changed repositories" keeps every control busy until its last repository finishes.
    gitOperationLabel:
      workspaceRun === null
        ? vcsActionLabelText(gitActionState, messages)
        : workspaceRunLabel(workspaceRun),
    sourceControlDiscovery,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
