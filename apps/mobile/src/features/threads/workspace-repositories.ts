import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  summarizeWorkspaceRepository,
  type ThreadRepository,
} from "@t3tools/client-runtime/state/workspaces";
import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";

export const WORKSPACE_WORKTREE_REASON =
  "A workspace thread starts in a new worktree of each of its repositories.";

export const WORKSPACE_CLOUD_REASON = "Each repository starts from its default branch.";

const WORKSPACE_REPOSITORIES_PENDING =
  "Each repository gets its own worktree when the thread starts.";

export const WORKSPACE_STEP_LABELS: Record<GitStackedAction, string> = {
  commit: "Commit",
  push: "Push",
  create_pr: "Push and open a pull request",
  commit_push: "Commit and push",
  commit_push_pr: "Commit, push and open a pull request",
};

export interface WorkspaceRepositoryRow {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  /** Null for the row that stands in before the thread's folder exists. */
  readonly name: string | null;
  readonly selected: boolean;
}

/** One row per repository: its branch, line counts and pull request; the selected one marked. */
export function workspaceRepositoryRows(workspace: {
  readonly repositories: ReadonlyArray<ThreadRepository>;
  readonly statuses: ReadonlyArray<VcsStatusResult | null>;
  readonly selected: ThreadRepository | null;
}): ReadonlyArray<WorkspaceRepositoryRow> {
  if (workspace.repositories.length === 0) {
    return [
      {
        key: "pending",
        title: "Repositories",
        subtitle: WORKSPACE_REPOSITORIES_PENDING,
        name: null,
        selected: false,
      },
    ];
  }
  return workspace.repositories.map((repository, index) => {
    const summary = summarizeWorkspaceRepository(workspace.statuses[index] ?? null);
    const parts = [summary?.refName ?? (summary === null ? "Checking status" : "Detached HEAD")];
    if (summary !== null && summary.insertions + summary.deletions > 0) {
      parts.push(`+${formatDiffCount(summary.insertions)} −${formatDiffCount(summary.deletions)}`);
    }
    if (summary?.pullRequest) {
      parts.push(`#${summary.pullRequest.number} ${summary.pullRequest.state}`);
    }
    return {
      key: repository.name,
      title: repository.name,
      subtitle: parts.join(" · "),
      name: repository.name,
      selected: workspace.selected?.name === repository.name,
    };
  });
}
