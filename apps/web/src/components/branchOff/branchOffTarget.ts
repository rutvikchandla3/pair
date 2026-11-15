import {
  type CloudThreadMenuItem,
  type LineageViewer,
  menuItemsForCloudThread,
} from "@t3tools/client-runtime/branch-lineage";
import { memberDisplayName, teamViewerOf } from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { teamEnvironment } from "../../state/team";
import { environmentThreadShells } from "../../state/threads";

/** The lineage viewer where a team works, read at event time; null on solo servers. */
export function readBranchOffViewer(environmentId: EnvironmentId): LineageViewer | null {
  const viewer = teamViewerOf(
    appAtomRegistry.get(teamEnvironment.membersValueAtom(environmentId)),
    appAtomRegistry.get(teamEnvironment.currentMemberIdAtom(environmentId)),
  );
  if (viewer === null) return null;
  return {
    memberId: viewer.memberId,
    serverOwnerId: viewer.ownerId,
    nameOf: (id) => memberDisplayName(viewer.members, id),
  };
}

/** The ⋯ menu's cloud items for a team's cloud thread; null keeps the menu as it is. */
export function readCloudThreadMenu(
  threadRef: ScopedThreadRef,
): ReadonlyArray<CloudThreadMenuItem> | null {
  const viewer = readBranchOffViewer(threadRef.environmentId);
  const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef));
  if (viewer === null || shell === null) return null;
  return menuItemsForCloudThread(shell.source, viewer);
}

/** The draft's location: `/branch-off/<env>/<source>`. */
export function branchOffRoute(threadRef: ScopedThreadRef) {
  return {
    to: "/branch-off/$environmentId/$sourceThreadId",
    params: { environmentId: threadRef.environmentId, sourceThreadId: threadRef.threadId },
  } as const;
}
