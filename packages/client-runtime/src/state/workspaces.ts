import type { EnvironmentId, ProjectId, ProjectRoot } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { ensureBrowseDirectoryPath } from "./projects.ts";

// The server enforces these rules (ProjectCommands); the client mirrors them to explain early.
export const MIN_WORKSPACE_REPOSITORIES = 2;
export const MAX_WORKSPACE_REPOSITORIES = 8;
const REPOSITORY_FOLDER_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The server ignores a workspace worktree's base, since each repository starts from its own
 * default branch, but the launch schema still requires one.
 */
export const WORKSPACE_WORKTREE_BASE_REF = "HEAD";

export const WORKSPACE_GIT_CONTROLS_UNAVAILABLE =
  "Git controls for a workspace's repositories aren't available yet.";

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
