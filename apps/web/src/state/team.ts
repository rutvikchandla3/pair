import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_TEAM_MEMBERS,
  createTeamEnvironmentAtoms,
  type TeamMembers,
} from "@t3tools/client-runtime/state/team";
import { AuthAccessWriteScope, type EnvironmentId, type MemberId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
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
