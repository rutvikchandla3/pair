import type {
  EnvironmentId,
  GitStackedAction,
  ProjectId,
  ProjectRoot,
  RepositoryIdentity,
  VcsStatusResult,
} from "@t3tools/contracts";

import { sourceControlClients } from "../sourceControlClients.ts";
import { resolveQuickAction } from "./gitActions.ts";
import type { EnvironmentProject } from "./models.ts";
import { ensureBrowseDirectoryPath } from "./projects.ts";

// The server enforces these rules (ProjectCommands); the client mirrors them to explain early.
export const MIN_WORKSPACE_REPOSITORIES = 2;
export const MAX_WORKSPACE_REPOSITORIES = 8;
const REPOSITORY_FOLDER_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The server ignores a workspace worktree's or cloud launch's base, since each repository starts
 * from its own default branch, but the launch schema still requires one.
 */
export const WORKSPACE_WORKTREE_BASE_REF = "HEAD";

type WithRoots = { readonly roots?: ReadonlyArray<ProjectRoot> | undefined };

/** A workspace is a project made of other projects; its own folder is not a repository. */
export function isWorkspaceProject<T extends WithRoots>(
  project: T | null | undefined,
): project is T & { readonly roots: ReadonlyArray<ProjectRoot> } {
  return project?.roots !== undefined;
}

/** The folder name the server gives a repository when the client names none. */
export function defaultWorkspaceRepositoryName(workspaceRoot: string): string {
  const name = (workspaceRoot.split(/[\\/]+/).findLast((segment) => segment.length > 0) ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" || name === "." || name === ".." ? "repository" : name;
}

/** The first workspace rule these repositories break, worded as the server words it, or null. */
export function workspaceRepositoriesProblem(
  repositories: ReadonlyArray<{ readonly name: string; readonly title: string }>,
): string | null {
  if (
    repositories.length < MIN_WORKSPACE_REPOSITORIES ||
    repositories.length > MAX_WORKSPACE_REPOSITORIES
  ) {
    return `A workspace needs ${MIN_WORKSPACE_REPOSITORIES} to ${MAX_WORKSPACE_REPOSITORIES} repositories (got ${repositories.length}).`;
  }
  const names = new Set<string>();
  for (const repository of repositories) {
    const name = repository.name.trim();
    if (!REPOSITORY_FOLDER_NAME.test(name) || name === "." || name === "..") {
      return `Folder name "${name}" for "${repository.title}" may use only letters, digits, ".", "_" and "-".`;
    }
    const key = name.toLowerCase();
    if (names.has(key)) return `Two repositories use the folder name "${name}".`;
    names.add(key);
  }
  return null;
}

/** Projects that can be a repository in a workspace on `environmentId`, in their given order. */
export function workspaceRepositoryCandidates<T extends EnvironmentProject>(
  projects: ReadonlyArray<T>,
  environmentId: EnvironmentId,
): T[] {
  return projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !isWorkspaceProject(project) &&
      project.archivedAt == null &&
      project.isScratch !== true,
  );
}

export interface ThreadRepository {
  readonly name: string;
  readonly cwd: string;
  readonly projectId: ProjectId;
}

/**
 * The repositories a thread works in. A workspace thread has one per root inside its folder,
 * and none until that folder exists; any other thread has its own checkout.
 */
export function threadRepositories(
  thread: WithRoots & { readonly projectId: ProjectId; readonly worktreePath: string | null },
  project: (WithRoots & { readonly title: string; readonly workspaceRoot: string }) | null,
): ReadonlyArray<ThreadRepository> {
  if (thread.roots !== undefined) {
    const folder = thread.worktreePath;
    if (folder === null) return [];
    return thread.roots.map((root) => ({
      name: root.name,
      cwd: `${ensureBrowseDirectoryPath(folder)}${root.name}`,
      projectId: root.projectId,
    }));
  }
  if (project === null || isWorkspaceProject(project)) return [];
  return [
    {
      name: project.title,
      cwd: thread.worktreePath ?? project.workspaceRoot,
      projectId: thread.projectId,
    },
  ];
}

/** Whether a repository holds work this thread could commit, push or open a pull request for. */
function repositoryHasChanges(status: VcsStatusResult | null): boolean {
  if (status === null || !status.isRepo) return false;
  const branch = status.branchChanges;
  return (
    status.hasWorkingTreeChanges ||
    status.aheadCount > 0 ||
    (branch !== undefined && branch.insertions + branch.deletions > 0)
  );
}

/**
 * The repository a workspace thread's git controls act on: the one the user chose while it is
 * still there, else the first with changes, else the first. `statuses` lines up with
 * `repositories`; null while a status loads.
 */
export function resolveSelectedRepository<T extends { readonly name: string }>(
  repositories: ReadonlyArray<T>,
  statuses: ReadonlyArray<VcsStatusResult | null>,
  chosen: string | null,
): T | null {
  const picked = chosen === null ? undefined : repositories.find((r) => r.name === chosen);
  if (picked !== undefined) return picked;
  const changed = repositories.findIndex((_, index) =>
    repositoryHasChanges(statuses[index] ?? null),
  );
  return repositories[changed === -1 ? 0 : changed] ?? null;
}

export interface WorkspaceRepositorySummary {
  readonly refName: string | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly hasChanges: boolean;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly state: "open" | "closed" | "merged";
  } | null;
}

/** One repository row: its branch, line counts (branch first, else working tree) and pull request. */
export function summarizeWorkspaceRepository(
  status: VcsStatusResult | null,
): WorkspaceRepositorySummary | null {
  if (status === null || !status.isRepo) return null;
  const branch = status.branchChanges;
  const tree = status.workingTree;
  const counts =
    branch !== undefined && branch.insertions + branch.deletions > 0
      ? branch
      : tree.insertions + tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    refName: status.refName,
    insertions: counts.insertions,
    deletions: counts.deletions,
    hasChanges: repositoryHasChanges(status),
    pullRequest:
      status.pr === null
        ? null
        : {
            number: status.pr.number,
            title: status.pr.title,
            url: status.pr.url,
            state: status.pr.state,
          },
  };
}

/**
 * The workspace repository a pull request link belongs to, matched on the repository's project
 * identity, or undefined when none matches.
 */
export function workspaceRepositoryForPullRequest<
  T extends { readonly repositoryIdentity?: RepositoryIdentity | null | undefined },
>(link: { readonly repository: string }, repositories: ReadonlyArray<T>): T | undefined {
  const repository = link.repository.toLowerCase();
  return repositories.find(
    (candidate) =>
      sourceControlClients.repositorySelector(candidate.repositoryIdentity)?.toLowerCase() ===
      repository,
  );
}

export interface WorkspaceGitActionStep<T> {
  readonly repository: T;
  readonly action: GitStackedAction;
}

export interface WorkspaceGitActionSkip<T> {
  readonly repository: T;
  readonly reason: string;
}

export interface WorkspaceGitActionPlan<T> {
  readonly steps: ReadonlyArray<WorkspaceGitActionStep<T>>;
  readonly skipped: ReadonlyArray<WorkspaceGitActionSkip<T>>;
}

/**
 * Each repository's own quick action, in order, for "all changed repositories". Repositories on
 * their default branch are skipped so one action never pushes to a default branch unasked.
 */
export function planWorkspaceGitActions<T>(
  entries: ReadonlyArray<{ readonly repository: T; readonly status: VcsStatusResult | null }>,
): WorkspaceGitActionPlan<T> {
  const steps: WorkspaceGitActionStep<T>[] = [];
  const skipped: WorkspaceGitActionSkip<T>[] = [];
  for (const { repository, status } of entries) {
    if (status === null) {
      skipped.push({ repository, reason: "Status isn't loaded yet." });
      continue;
    }
    if (!status.isRepo) {
      skipped.push({ repository, reason: "Not a git repository." });
      continue;
    }
    if (!repositoryHasChanges(status)) {
      skipped.push({ repository, reason: "No changes." });
      continue;
    }
    if (status.isDefaultRef) {
      skipped.push({ repository, reason: "On its default branch." });
      continue;
    }
    const quick = resolveQuickAction(status, false, false, status.hasPrimaryRemote);
    if (quick.kind === "run_action" && quick.action !== undefined) {
      steps.push({ repository, action: quick.action });
    } else if (quick.kind === "run_pull") {
      skipped.push({ repository, reason: "Behind its upstream. Pull first." });
    } else if (quick.kind === "open_pr") {
      skipped.push({ repository, reason: "Nothing new to push." });
    } else {
      skipped.push({ repository, reason: quick.hint ?? "Nothing to run." });
    }
  }
  return { steps, skipped };
}

export interface WorkspaceGitActionOutcome<T> {
  readonly finished: ReadonlyArray<WorkspaceGitActionStep<T>>;
  readonly failed: (WorkspaceGitActionStep<T> & { readonly error: string }) | null;
  readonly notRun: ReadonlyArray<WorkspaceGitActionStep<T>>;
  readonly skipped: ReadonlyArray<WorkspaceGitActionSkip<T>>;
}

/** Runs the plan's steps one at a time and stops at the first failure. */
export async function runWorkspaceGitActions<T>(input: {
  readonly plan: WorkspaceGitActionPlan<T>;
  readonly run: (
    step: WorkspaceGitActionStep<T>,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly onStart?: (step: WorkspaceGitActionStep<T>, index: number, total: number) => void;
}): Promise<WorkspaceGitActionOutcome<T>> {
  const { steps, skipped } = input.plan;
  const finished: WorkspaceGitActionStep<T>[] = [];
  for (const [index, step] of steps.entries()) {
    input.onStart?.(step, index, steps.length);
    const result = await input.run(step).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : "The git action failed.",
    }));
    if (!result.ok) {
      return {
        finished,
        failed: { ...step, error: result.error },
        notRun: steps.slice(index + 1),
        skipped,
      };
    }
    finished.push(step);
  }
  return { finished, failed: null, notRun: [], skipped };
}

/** Plain report of a fan-out that never hides a partial result. */
export function describeWorkspaceGitActionOutcome<T extends { readonly name: string }>(
  outcome: WorkspaceGitActionOutcome<T>,
): { readonly title: string; readonly description: string; readonly failed: boolean } {
  const names = (items: ReadonlyArray<{ readonly repository: T }>) =>
    items.map((item) => item.repository.name).join(", ");
  const lines: string[] = [];
  if (outcome.failed !== null) {
    lines.push(`${outcome.failed.repository.name}: ${outcome.failed.error}`);
  }
  if (outcome.finished.length > 0) lines.push(`Done: ${names(outcome.finished)}.`);
  if (outcome.notRun.length > 0) lines.push(`Not run: ${names(outcome.notRun)}.`);
  for (const skip of outcome.skipped) {
    lines.push(`Skipped ${skip.repository.name}: ${skip.reason}`);
  }
  const count = outcome.finished.length;
  return {
    title:
      outcome.failed !== null
        ? `Stopped at ${outcome.failed.repository.name}`
        : count === 0
          ? "No repositories to run"
          : `Ran on ${count} ${count === 1 ? "repository" : "repositories"}`,
    description: lines.join("\n"),
    failed: outcome.failed !== null,
  };
}
