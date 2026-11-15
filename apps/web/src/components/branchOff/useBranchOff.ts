import {
  type LineageViewer,
  canBranchOff,
  lineageHolderOf,
} from "@t3tools/client-runtime/branch-lineage";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useLineageViewer } from "../../state/branchLineage";
import { useQuietThreadShell } from "../../state/entities";
import { useIsTeamMode } from "../../state/team";

/** The lineage viewer where a team works; null on solo servers, where Branch off isn't shown. */
export function useBranchOffViewer(environmentId: EnvironmentId | null): LineageViewer | null {
  const viewer = useLineageViewer(environmentId);
  return useIsTeamMode(environmentId) ? viewer : null;
}

/** Whether Branch off is offered on the thread, for components that render it. */
export function useCanBranchOff(threadRef: ScopedThreadRef | null): boolean {
  const viewer = useBranchOffViewer(threadRef?.environmentId ?? null);
  const shell = useQuietThreadShell(threadRef);
  return viewer !== null && shell !== null && canBranchOff(shell.source, viewer);
}

/** Fork reuses the holder's checkout, so on a team's cloud thread it is the holder's alone. */
export function useForkAllowed(threadRef: ScopedThreadRef | null): boolean {
  const viewer = useBranchOffViewer(threadRef?.environmentId ?? null);
  const shell = useQuietThreadShell(threadRef);
  if (viewer === null || shell === null || shell.source.sandboxId === undefined) return true;
  return lineageHolderOf(shell.source, viewer) === viewer.memberId;
}
