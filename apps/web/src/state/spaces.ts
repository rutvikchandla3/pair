import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import {
  type SpaceRoomResult,
  type SpaceSidebarShells,
  createSpaceEnvironmentAtoms,
  createSpaceShellAtoms,
  spaceRoomResultOf,
} from "@t3tools/client-runtime/state/spaces";
import {
  type SpaceRoomState,
  type SpaceViewer,
  mergeSpaceThreads,
  spaceListWithRoom,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceId,
  SpaceListResult,
  SpaceTaskId,
} from "@t3tools/contracts";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";
import { useProjects } from "./entities";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { teamEnvironment, useCurrentMemberId, useTeamMembers } from "./team";
import { environmentThreadShells } from "./threads";

const spaceShells = createSpaceShellAtoms({
  label: "web",
  connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  currentMemberIdAtom: teamEnvironment.currentMemberIdAtom,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

export const spaceEnvironment = createSpaceEnvironmentAtoms(connectionAtomRuntime, spaceShells);

export function useSpaceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(spaceShells.environmentIdsAtom);
}

const EMPTY_LIST: SpaceListResult = { spaces: [], tasks: [] };

/** `spaces.list`: every space the viewer can see here, and their tasks. */
export function useSpaceListResult(environmentId: EnvironmentId | null): SpaceListResult {
  const query = useEnvironmentQuery(
    environmentId === null ? null : spaceEnvironment.list({ environmentId, input: undefined }),
  );
  return query.data ?? EMPTY_LIST;
}

const NO_ROOM: Atom.Atom<AsyncResult.AsyncResult<SpaceRoomState, unknown>> = Atom.make(
  AsyncResult.initial(),
);

/** The list, with the open room's live tasks over it; `spaceId` only where the room is mounted. */
export function useSpaceListWithOpenRoom(
  environmentId: EnvironmentId,
  spaceId: SpaceId | null,
): SpaceListResult {
  const list = useSpaceListResult(environmentId);
  const room = spaceRoomResultOf(
    useAtomValue(
      spaceId === null ? NO_ROOM : spaceEnvironment.room({ environmentId, input: { spaceId } }),
    ),
  );
  return spaceListWithRoom(list, room.type === "ready" ? room.room : null);
}

export function useSpaceList(environmentId: EnvironmentId | null): ReadonlyArray<Space> {
  return useSpaceListResult(environmentId).spaces;
}

/** The space's threads on tasks: the live shells, then the room page's copies they lack. */
export function useSpaceTaskThreads(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageThreads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const live = useAtomValue(spaceShells.taskThreadsAtom(`${environmentId}\u0000${spaceId}`));
  return mergeSpaceThreads(live, pageThreads);
}

export function useSpaceTaskView(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  taskId: SpaceTaskId,
) {
  return useEnvironmentQuery(
    spaceEnvironment.taskView({ environmentId, input: { spaceId, taskId } }),
  );
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

/** This environment's unarchived projects: repositories and workspaces, as pickers list them. */
export function useSpaceProjects(environmentId: EnvironmentId): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  return projects.filter(
    (project) =>
      project.environmentId === environmentId && project.archivedAt == null && !project.isScratch,
  );
}

/** The space's repositories' names, in the order picked; unknown ones are left out. */
export function spaceRepositoryNames(
  space: Pick<Space, "repositoryIds">,
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "title">>,
): ReadonlyArray<string> {
  return space.repositoryIds.flatMap((id) => {
    const project = projects.find((candidate) => candidate.id === id);
    return project === undefined ? [] : [project.title];
  });
}
