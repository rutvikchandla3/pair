import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  resolveSelectedRepository,
  type ThreadRepository,
} from "@t3tools/client-runtime/state/workspaces";
import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useWorkspaceRepositoryStore } from "../workspaceRepositoryStore";
import { vcsEnvironment } from "./vcs";

const NO_STATUSES = Atom.make<ReadonlyArray<VcsStatusResult | null>>([]).pipe(
  Atom.withLabel("web-workspace-repositories:none"),
);

export interface WorkspaceRepositoriesState {
  readonly threadRef: ScopedThreadRef;
  readonly repositories: ReadonlyArray<ThreadRepository>;
  /** Live statuses in repository order; null while one loads. */
  readonly statuses: ReadonlyArray<VcsStatusResult | null>;
  /** Null until the thread's folder exists. */
  readonly selected: ThreadRepository | null;
}

/**
 * A workspace thread's repositories with their live statuses and the one its git controls act
 * on. Mount it only where the thread is on screen: each repository holds a status subscription.
 */
export function useWorkspaceRepositories(
  threadRef: ScopedThreadRef | null,
  repositories: ReadonlyArray<ThreadRepository> | null,
): WorkspaceRepositoriesState | null {
  const cwds = repositories?.map((repository) => repository.cwd) ?? [];
  const statuses = useAtomValue(
    threadRef === null || cwds.length === 0
      ? NO_STATUSES
      : vcsEnvironment.statuses({ environmentId: threadRef.environmentId, cwds }),
  );
  const chosen = useWorkspaceRepositoryStore((state) =>
    threadRef === null ? null : (state.byThreadKey[scopedThreadKey(threadRef)] ?? null),
  );
  if (threadRef === null || repositories === null) return null;
  return {
    threadRef,
    repositories,
    statuses,
    selected: resolveSelectedRepository(repositories, statuses, chosen),
  };
}

export function selectWorkspaceRepository(threadRef: ScopedThreadRef, name: string): void {
  useWorkspaceRepositoryStore.getState().select(threadRef, name);
}
