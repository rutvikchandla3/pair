import { useAtomValue } from "@effect/atom-react";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import {
  type SpaceRoomResult,
  type SpaceSidebarShells,
  createSpaceEnvironmentAtoms,
  createSpaceShellAtoms,
  spaceRoomResultOf,
} from "@t3tools/client-runtime/state/spaces";
import { type SpaceViewer, mergeSpaceTasks } from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space, SpaceId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { teamEnvironment, useCurrentMemberId, useTeamMembers } from "./team";
import { environmentThreadShells } from "./threads";

export const spaceEnvironment = createSpaceEnvironmentAtoms(connectionAtomRuntime);

const spaceShells = createSpaceShellAtoms({
  label: "web",
  connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  currentMemberIdAtom: teamEnvironment.currentMemberIdAtom,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

export function useSpaceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(spaceShells.environmentIdsAtom);
}

export function useSpaceList(environmentId: EnvironmentId | null): ReadonlyArray<Space> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : spaceEnvironment.list({ environmentId, input: undefined }),
  );
  return query.data?.spaces ?? EMPTY_SPACES;
}

const EMPTY_SPACES: ReadonlyArray<Space> = [];

export function useSpaceTasks(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageTasks: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const live = useAtomValue(spaceShells.tasksAtom(`${environmentId}\u0000${spaceId}`));
  return mergeSpaceTasks(live, pageTasks);
}

export function useSpaceRoom(environmentId: EnvironmentId, spaceId: SpaceId): SpaceRoomResult {
  return spaceRoomResultOf(
    useAtomValue(spaceEnvironment.room({ environmentId, input: { spaceId } })),
  );
}

export function useSpaceOlderEntries(environmentId: EnvironmentId, spaceId: SpaceId) {
  return useAtomValue(spaceEnvironment.olderEntries(`${environmentId}:${spaceId}`));
}

/** The viewer, with names from the team roster, for the shared wording helpers. */
export function useSpaceViewer(environmentId: EnvironmentId | null): SpaceViewer {
  const members = useTeamMembers(environmentId);
  const memberId = useCurrentMemberId(environmentId);
  return { memberId, nameOf: (id) => memberDisplayName(members, id) };
}

export function useCanOperateSpaces(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(spaceEnvironment.post.permissionAtom(environmentId));
}

export function useSpaceSidebarShells(environmentId: EnvironmentId): SpaceSidebarShells {
  return useAtomValue(spaceShells.sidebarShellsAtom(environmentId));
}
