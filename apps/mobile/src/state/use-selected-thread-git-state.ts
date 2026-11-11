import { useMemo } from "react";

import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useBranches } from "./queries";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useVcsActionState } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadGitTarget } from "./use-selected-thread-git-target";
import { workspaceRunLabel } from "./use-selected-thread-workspace";

export function useSelectedThreadGitState() {
  const { selectedThread } = useThreadSelection();
  const target = useSelectedThreadGitTarget();
  const workspaceRun = target.workspace?.run ?? null;

  const gitActionState = useVcsActionState({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: target.cwd,
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
    cwd: target.cwd,
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
      workspaceRun === null ? gitActionState.currentLabel : workspaceRunLabel(workspaceRun),
    sourceControlDiscovery,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
