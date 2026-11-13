import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { type SpaceViewer, mergeSpaceThreads } from "@t3tools/client-runtime/spaces";
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
import { createSpaceAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/spaceAgent";
import { createTeamClaudeKeyEnvironmentAtoms } from "@t3tools/client-runtime/state/team-claude-key";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceId,
  SpaceTask,
  SpaceTaskId,
  TeamClaudeKeyStatus,
} from "@t3tools/contracts";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { teamEnvironment, useTeamRoster } from "./team";
import { environmentThreadShells } from "./threads";

const spaceShells = createSpaceShellAtoms({
  label: "mobile",
  connectedEnvironmentIdsAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  currentMemberIdAtom: teamEnvironment.currentMemberIdAtom,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

export const spaceEnvironment = createSpaceEnvironmentAtoms(connectionAtomRuntime, spaceShells);

export const teamClaudeKeyEnvironment = createTeamClaudeKeyEnvironmentAtoms(connectionAtomRuntime);
export const spaceAgentEnvironment = createSpaceAgentEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SPACES: ReadonlyArray<Space> = [];
const EMPTY_TASKS: ReadonlyArray<SpaceTask> = [];
const NO_KEY_STATUS = Atom.make<TeamClaudeKeyStatus | null>(null).pipe(
  Atom.withLabel("mobile-team-claude-key:none"),
);

export function useSpaceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(spaceShells.environmentIdsAtom);
}

export function useSpaceList(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : spaceEnvironment.list({ environmentId, input: undefined }),
  );
  return {
    spaces: query.data?.spaces ?? EMPTY_SPACES,
    tasks: query.data?.tasks ?? EMPTY_TASKS,
    refresh: query.refresh,
  };
}

/** The space's task threads: the live shells over the page's copy. */
export function useSpaceThreads(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageThreads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const live = useAtomValue(spaceShells.taskThreadsAtom(`${environmentId}\u0000${spaceId}`));
  return mergeSpaceThreads(live, pageThreads);
}

export function useSpaceTaskView(
  environmentId: EnvironmentId | null,
  spaceId: SpaceId | null,
  taskId: SpaceTaskId | null,
) {
  return useEnvironmentQuery(
    environmentId === null || spaceId === null || taskId === null
      ? null
      : spaceEnvironment.taskView({ environmentId, input: { spaceId, taskId } }),
  );
}

/** The Team Claude key's status, or null while loading. */
export function useTeamClaudeKeyStatus(
  environmentId: EnvironmentId | null,
): TeamClaudeKeyStatus | null {
  useEnvironmentQuery(
    environmentId === null ? null : teamClaudeKeyEnvironment.status({ environmentId, input: {} }),
  );
  return useAtomValue(
    environmentId === null
      ? NO_KEY_STATUS
      : teamClaudeKeyEnvironment.statusValueAtom(environmentId),
  );
}

export function useCanManageTeamClaudeKey(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(teamClaudeKeyEnvironment.set.permissionAtom(environmentId));
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
