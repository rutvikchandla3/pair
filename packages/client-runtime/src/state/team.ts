import type { EnvironmentId, MemberId, TeamMember, TeamStreamEvent } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

export type TeamMembers = ReadonlyMap<MemberId, TeamMember>;

export const EMPTY_TEAM_MEMBERS: TeamMembers = new Map();

export function applyTeamStreamEvent(current: TeamMembers, event: TeamStreamEvent): TeamMembers {
  switch (event._tag) {
    case "snapshot":
      return new Map(event.members.map((member) => [member.id, member]));
    case "upserted":
      return new Map(current).set(event.member.id, event.member);
  }
}

function activeTeamMembers(members: TeamMembers): ReadonlyArray<TeamMember> {
  return [...members.values()].filter((member) => member.removedAt === null);
}

export function isTeamModeMembers(members: TeamMembers): boolean {
  return activeTeamMembers(members).length > 1;
}

export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);

  const membersFamily = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team:members",
    tag: WS_METHODS.teamSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          () => EMPTY_TEAM_MEMBERS,
          (current, event) => {
            const next = applyTeamStreamEvent(current, event);
            return [next, [next]];
          },
        ),
      ),
  });
  const teamMembersAtom = (environmentId: EnvironmentId) =>
    membersFamily({ environmentId, input: {} });

  const currentMemberIdAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): MemberId | null =>
        get(sessions.sessionStateValueAtom(environmentId))?.memberId ?? null,
    ).pipe(Atom.withLabel(`environment-current-member-id:${environmentId}`)),
  );

  // A session without a member id is on a server that predates teams and has no stream to follow.
  const membersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): TeamMembers => {
      if (get(currentMemberIdAtom(environmentId)) === null) return EMPTY_TEAM_MEMBERS;
      return Option.getOrElse(
        AsyncResult.value(get(teamMembersAtom(environmentId))),
        () => EMPTY_TEAM_MEMBERS,
      );
    }).pipe(Atom.withLabel(`environment-team-members-value:${environmentId}`)),
  );

  const currentMemberAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): TeamMember | null => {
      const memberId = get(currentMemberIdAtom(environmentId));
      return memberId === null
        ? null
        : (get(membersValueAtom(environmentId)).get(memberId) ?? null);
    }).pipe(Atom.withLabel(`environment-current-member:${environmentId}`)),
  );

  const isTeamModeAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => isTeamModeMembers(get(membersValueAtom(environmentId)))).pipe(
      Atom.withLabel(`environment-team-mode:${environmentId}`),
    ),
  );

  return {
    teamMembersAtom,
    membersValueAtom,
    currentMemberIdAtom,
    currentMemberAtom,
    isTeamModeAtom,
    inviteMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:invite",
      tag: WS_METHODS.teamInvite,
    }),
    createSignInLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:sign-in-link",
      tag: WS_METHODS.teamSignInLink,
    }),
    updateMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update",
      tag: WS_METHODS.teamUpdate,
    }),
    setMemberRole: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:set-role",
      tag: WS_METHODS.teamSetRole,
    }),
    removeMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:remove",
      tag: WS_METHODS.teamRemove,
    }),
    updateSelf: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-self",
      tag: WS_METHODS.teamUpdateSelf,
    }),
  };
}
