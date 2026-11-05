import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_TEAM_MEMBERS,
  activeTeamMembers,
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
  type TeamMembers,
} from "@t3tools/client-runtime/state/team";
import { AuthAccessWriteScope, type EnvironmentId, type MemberId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentScope } from "./session";

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

const NO_MEMBERS_ATOM = Atom.make(EMPTY_TEAM_MEMBERS).pipe(Atom.withLabel("team-members:none"));
const NO_ID_ATOM = Atom.make<MemberId | null>(null).pipe(Atom.withLabel("team-member-id:none"));
const NOT_TEAM_ATOM = Atom.make(false).pipe(Atom.withLabel("team-mode:none"));

export function useTeamMembers(environmentId: EnvironmentId | null): TeamMembers {
  return useAtomValue(
    environmentId === null ? NO_MEMBERS_ATOM : teamEnvironment.membersValueAtom(environmentId),
  );
}

export function useCurrentMemberId(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null ? NO_ID_ATOM : teamEnvironment.currentMemberIdAtom(environmentId),
  );
}

export function useIsTeamMode(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? NOT_TEAM_ATOM : teamEnvironment.isTeamModeAtom(environmentId),
  );
}

/** Settings → Team is for admins, and for anyone once the server has a second member. */
export function useTeamSettingsVisible(): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const knowsTeams = useCurrentMemberId(environmentId) !== null;
  const canWriteAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const isTeamMode = useIsTeamMode(environmentId);
  return knowsTeams && (canWriteAccess || isTeamMode);
}

const FORMER_MEMBER_NAME = "Former member";

/** A member the roster no longer lists (never known, or purged) reads as a former member. */
function memberDisplayName(members: TeamMembers, id: MemberId): string {
  return members.get(id)?.name ?? FORMER_MEMBER_NAME;
}

/** What attribution labels need: nothing renders unless `isTeamMode`. */
export function useTeamAttribution(environmentId: EnvironmentId | null) {
  const members = useTeamMembers(environmentId);
  const isTeamMode = useIsTeamMode(environmentId);
  const currentMemberId = useCurrentMemberId(environmentId);
  return {
    isTeamMode,
    currentMemberId,
    members,
    nameOf: (id: MemberId) => memberDisplayName(members, id),
  };
}

/** For menus that read on demand. Team members are kept subscribed by TeamMembersWatch. */
export function readThreadTeamMenu(
  environmentId: EnvironmentId,
  ownerId: MemberId | null | undefined,
) {
  const members = appAtomRegistry.get(teamEnvironment.membersValueAtom(environmentId));
  if (!isTeamModeMembers(members)) return undefined;
  const memberId = appAtomRegistry.get(teamEnvironment.currentMemberIdAtom(environmentId));
  return {
    members: activeTeamMembers(members).map(({ id, name }) => ({ id, name })),
    ownerId: ownerId ?? null,
    canDelete: canMemberDeleteThread({ members, memberId, ownerId }),
  };
}

export function readCanDeleteThread(
  environmentId: EnvironmentId,
  ownerId: MemberId | null | undefined,
): boolean {
  return readThreadTeamMenu(environmentId, ownerId)?.canDelete ?? true;
}
