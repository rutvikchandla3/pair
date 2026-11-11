import { useAtomValue } from "@effect/atom-react";
import {
  planWorkspaceGitActions,
  resolveSelectedRepository,
  type ThreadRepository,
  type WorkspaceGitActionPlan,
} from "@t3tools/client-runtime/state/workspaces";
import type { VcsStatusResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadRepositories } from "./use-selected-thread-worktree";
import { useThreadSelection } from "./use-thread-selection";
import { vcsEnvironment } from "./vcs";

/** The "all changed repositories" step in flight. */
interface WorkspaceRun {
  readonly name: string;
  readonly cwd: string;
  readonly index: number;
  readonly total: number;
}

const NO_STATUSES = Atom.make<ReadonlyArray<VcsStatusResult | null>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-repositories:none"),
);
const NO_CHOICE = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-repository:none"),
);
const NO_RUN = Atom.make<WorkspaceRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-run:none"),
);

const chosenRepositoryAtom = Atom.family((threadKey: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:workspace-repository:${threadKey}`),
  ),
);

const workspaceRunAtom = Atom.family((threadKey: string) =>
  Atom.make<WorkspaceRun | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:workspace-run:${threadKey}`),
  ),
);

export interface SelectedThreadWorkspace {
  readonly threadKey: string;
  readonly repositories: ReadonlyArray<ThreadRepository>;
  /** Live statuses in repository order; null while one loads. */
  readonly statuses: ReadonlyArray<VcsStatusResult | null>;
  /** The repository the git controls act on; null until the thread's folder exists. */
  readonly selected: ThreadRepository | null;
  readonly run: WorkspaceRun | null;
}

/**
 * The selected workspace thread's repositories with their live statuses, or null for a thread in
 * one repository. Each repository holds a status subscription while a caller is mounted.
 */
export function useSelectedThreadWorkspace(): SelectedThreadWorkspace | null {
  const { selectedThread } = useThreadSelection();
  const repositories = useSelectedThreadRepositories();
  const threadKey =
    selectedThread === null || repositories === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const cwds = repositories?.map((repository) => repository.cwd) ?? [];
  const statuses = useAtomValue(
    selectedThread === null || cwds.length === 0
      ? NO_STATUSES
      : vcsEnvironment.statuses({ environmentId: selectedThread.environmentId, cwds }),
  );
  const chosen = useAtomValue(threadKey === null ? NO_CHOICE : chosenRepositoryAtom(threadKey));
  const run = useAtomValue(threadKey === null ? NO_RUN : workspaceRunAtom(threadKey));
  if (threadKey === null || repositories === null) return null;
  return {
    threadKey,
    repositories,
    statuses,
    selected: resolveSelectedRepository(repositories, statuses, chosen),
    run,
  };
}

export function selectWorkspaceRepository(threadKey: string, name: string): void {
  appAtomRegistry.set(chosenRepositoryAtom(threadKey), name);
}

export function setWorkspaceRun(threadKey: string, run: WorkspaceRun | null): void {
  appAtomRegistry.set(workspaceRunAtom(threadKey), run);
}

export function workspaceRunLabel(run: WorkspaceRun): string {
  return `Running in ${run.name} (${run.index + 1} of ${run.total})`;
}

export function workspaceGitPlan(
  workspace: Pick<SelectedThreadWorkspace, "repositories" | "statuses">,
): WorkspaceGitActionPlan<ThreadRepository> {
  return planWorkspaceGitActions(
    workspace.repositories.map((repository, index) => ({
      repository,
      status: workspace.statuses[index] ?? null,
    })),
  );
}
