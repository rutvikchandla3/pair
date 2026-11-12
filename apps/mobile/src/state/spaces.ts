import { useAtomValue } from "@effect/atom-react";
import { type SpaceViewer, mergeSpaceTasks } from "@t3tools/client-runtime/spaces";
import {
  type SpaceRoomResult,
  type SpaceSidebarShells,
  createSpaceEnvironmentAtoms,
  createSpaceShellAtoms,
  spaceRoomResultOf,
} from "@t3tools/client-runtime/state/spaces";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space, SpaceId } from "@t3tools/contracts";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { teamEnvironment, useTeamRoster } from "./team";
import { environmentThreadShells } from "./threads";

export const spaceEnvironment = createSpaceEnvironmentAtoms(connectionAtomRuntime);

const spaceShells = createSpaceShellAtoms({
  label: "mobile",
  connectedEnvironmentIdsAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  currentMemberIdAtom: teamEnvironment.currentMemberIdAtom,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

const EMPTY_SPACES: ReadonlyArray<Space> = [];

export function useSpaceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(spaceShells.environmentIdsAtom);
}

export function useSpaceList(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : spaceEnvironment.list({ environmentId, input: undefined }),
  );
  return { spaces: query.data?.spaces ?? EMPTY_SPACES, refresh: query.refresh };
}

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

export function useSpaceViewer(environmentId: EnvironmentId | null): SpaceViewer {
  const { members, me } = useTeamRoster(environmentId);
  return { memberId: me, nameOf: (id) => memberDisplayName(members, id) };
}

export function useCanOperateSpaces(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(spaceEnvironment.post.permissionAtom(environmentId));
}

export function useSpaceSidebarShells(environmentId: EnvironmentId): SpaceSidebarShells {
  return useAtomValue(spaceShells.sidebarShellsAtom(environmentId));
}

/** Alerts a failed space command with the server's reason; true when it landed. */
export function reportSpaceResult(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  Dialog.alert(
    title,
    error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
  );
  return false;
}
