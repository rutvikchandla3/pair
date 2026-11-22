import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import type { ThreadRouteTarget } from "../threadRoutes";
import type { EmbedThreadSummary } from "./protocol";

/** The environment's threads a thread list would show: no subagents or side chats, none archived. */
export function embedThreadSummaries(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
): EmbedThreadSummary[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage),
    )
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      createdAt: Date.parse(thread.createdAt),
      updatedAt: Date.parse(thread.updatedAt),
      working: isThreadWorking(thread),
    }))
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

/**
 * The project a new embedded thread starts in: the one the server bootstrapped, else the one at
 * the server's working directory, else the most recently active, as the home route picks.
 */
export function resolveEmbedWorkspaceProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly bootstrapProjectId: ProjectId | null;
  readonly serverCwd: string | null;
}): EnvironmentProject | null {
  const candidates = input.projects.filter(
    (project) =>
      project.environmentId === input.environmentId &&
      project.archivedAt == null &&
      project.isScratch !== true,
  );
  return (
    candidates.find((project) => project.id === input.bootstrapProjectId) ??
    candidates.find((project) => project.workspaceRoot === input.serverCwd) ??
    sortScopedProjectsForSidebar(candidates, input.threads, "updated_at")[0] ??
    null
  );
}

/** The persisted thread on screen; a draft counts once its first message created the thread. */
export function embedShownThreadId(input: {
  readonly target: ThreadRouteTarget | null;
  readonly draftPromotedTo: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
}): ThreadId | null {
  const ref =
    input.target?.kind === "server"
      ? input.target.threadRef
      : input.target?.kind === "draft"
        ? input.draftPromotedTo
        : null;
  return ref !== null && ref.environmentId === input.environmentId ? ref.threadId : null;
}
