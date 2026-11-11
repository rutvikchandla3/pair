import {
  type ThreadRepository,
  WORKSPACE_GIT_CONTROLS_UNAVAILABLE,
} from "@t3tools/client-runtime/state/workspaces";

export const WORKSPACE_WORKTREE_REASON =
  "A workspace thread starts in a new worktree of each of its repositories.";

export const WORKSPACE_REPOSITORIES_PENDING =
  "Each repository gets its own worktree when the thread starts.";

/** The read-only rows a workspace thread shows where a single repository's git controls go. */
export function workspaceRepositoryRows(
  repositories: ReadonlyArray<ThreadRepository>,
): ReadonlyArray<{ readonly key: string; readonly title: string; readonly subtitle: string }> {
  return [
    ...(repositories.length === 0
      ? [{ key: "pending", title: "Repositories", subtitle: WORKSPACE_REPOSITORIES_PENDING }]
      : repositories.map((repository) => ({
          key: repository.projectId,
          title: repository.name,
          subtitle: repository.cwd,
        }))),
    { key: "unavailable", title: "Git controls", subtitle: WORKSPACE_GIT_CONTROLS_UNAVAILABLE },
  ];
}
