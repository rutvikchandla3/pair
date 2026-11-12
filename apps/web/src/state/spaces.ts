import { useAtomValue } from "@effect/atom-react";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import { createSpaceEnvironmentAtoms } from "@t3tools/client-runtime/state/spaces";
import {
  type SpaceRoomState,
  type SpaceViewer,
  mergeSpaceTasks,
  spaceSidebarShells,
  spaceTasksIn,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space, SpaceId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentCloudLaunchAtom } from "./server";
import { teamEnvironment, useCurrentMemberId, useTeamMembers } from "./team";
import { environmentThreadShells } from "./threads";

export const spaceEnvironment = createSpaceEnvironmentAtoms(connectionAtomRuntime);

/** Spaces live on Pair Cloud: connected cloud-only servers where the viewer is a member. */
const spaceEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<EnvironmentId>>());
  const next = get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (id) =>
      get(environmentCloudLaunchAtom(id)) && get(teamEnvironment.currentMemberIdAtom(id)) !== null,
  );
  return previous !== undefined &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("space-environment-ids"));

export function useSpaceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(spaceEnvironmentIdsAtom);
}

export function useSpaceList(environmentId: EnvironmentId | null): ReadonlyArray<Space> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : spaceEnvironment.list({ environmentId, input: undefined }),
  );
  return query.data?.spaces ?? EMPTY_SPACES;
}

const EMPTY_SPACES: ReadonlyArray<Space> = [];
const EMPTY_TASKS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

/** The space's tasks from the live shell; held while none of them changes. */
const shellSpaceTasksFamily = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const spaceId = key.slice(separator + 1);
  let previous: ReadonlyArray<OrchestrationV2ThreadShell> = EMPTY_TASKS;
  return Atom.make((get) => {
    const next = spaceTasksIn(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
      spaceId,
    );
    if (
      next.length === previous.length &&
      next.every((thread, index) => thread === previous[index])
    )
      return previous;
    previous = next.length === 0 ? EMPTY_TASKS : next;
    return previous;
  }).pipe(Atom.withLabel(`space-shell-tasks:${key}`));
});

export function useSpaceTasks(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageTasks: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const live = useAtomValue(shellSpaceTasksFamily(`${environmentId}\u0000${spaceId}`));
  return mergeSpaceTasks(live, pageTasks);
}

export type SpaceRoomResult =
  | { readonly type: "loading" }
  | { readonly type: "error"; readonly message: string; readonly reason: string | null }
  | { readonly type: "ready"; readonly room: SpaceRoomState };

export function useSpaceRoom(environmentId: EnvironmentId, spaceId: SpaceId): SpaceRoomResult {
  const result = useAtomValue(spaceEnvironment.room({ environmentId, input: { spaceId } }));
  if (AsyncResult.isSuccess(result)) return { type: "ready", room: result.value };
  if (AsyncResult.isFailure(result)) {
    const error = Cause.squash(result.cause) as {
      readonly reason?: unknown;
      readonly message?: unknown;
    };
    return {
      type: "error",
      message: typeof error?.message === "string" ? error.message : "Could not open the space.",
      reason: typeof error?.reason === "string" ? error.reason : null,
    };
  }
  return { type: "loading" };
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

export interface SpaceSidebarShells {
  /** Every unarchived task in any space here. */
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Rooms with entries since the viewer last opened them. */
  readonly unreadRoomIds: ReadonlySet<string>;
  readonly roomsKey: string;
}

const EMPTY_SIDEBAR_SHELLS: SpaceSidebarShells = {
  tasks: EMPTY_TASKS,
  unreadRoomIds: new Set(),
  roomsKey: "",
};

/** Held while no task, room or unread flag changes, so streaming turns elsewhere don't redraw it. */
const spaceSidebarShellsFamily = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_SIDEBAR_SHELLS;
  return Atom.make((get) => {
    const next = spaceSidebarShells(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
    );
    const sameTasks =
      next.tasks.length === previous.tasks.length &&
      next.tasks.every((thread, index) => thread === previous.tasks[index]);
    const sameUnread =
      next.unreadRoomIds.size === previous.unreadRoomIds.size &&
      [...next.unreadRoomIds].every((id) => previous.unreadRoomIds.has(id));
    if (sameTasks && sameUnread && next.roomsKey === previous.roomsKey) return previous;
    previous = {
      tasks: sameTasks ? previous.tasks : next.tasks,
      unreadRoomIds: sameUnread ? previous.unreadRoomIds : next.unreadRoomIds,
      roomsKey: next.roomsKey,
    };
    return previous;
  }).pipe(Atom.withLabel(`space-sidebar-shells:${environmentId}`));
});

export function useSpaceSidebarShells(environmentId: EnvironmentId): SpaceSidebarShells {
  return useAtomValue(spaceSidebarShellsFamily(environmentId));
}
