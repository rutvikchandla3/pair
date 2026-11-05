import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_TEAM_MEMBERS,
  activeTeamMembers,
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
  type TeamMembers,
} from "@t3tools/client-runtime/state/team";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type MemberId,
  type ScopedThreadRef,
  type TeamMember,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { resolveThreadFollowing } from "../components/Sidebar.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "./environments";
import { serverEnvironment } from "./server";
import { threadEnvironment } from "./threads";
import { useOrchestrationCommand } from "./use-orchestration-command";
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

/** Who "me" and the server owner are in one team-mode environment. */
export interface TeamViewer {
  readonly memberId: MemberId;
  readonly ownerId: MemberId | null;
  readonly members: TeamMembers;
}

function teamViewerOf(members: TeamMembers, memberId: MemberId | null): TeamViewer | null {
  if (memberId === null || !isTeamModeMembers(members)) return null;
  let ownerId: MemberId | null = null;
  for (const member of members.values()) if (member.isOwner) ownerId = member.id;
  return { memberId, ownerId, members };
}

const FORMER_MEMBER = { name: FORMER_MEMBER_NAME, color: "#6b7280" } as const;

/** The member who owns a thread when it is not the viewer; null for the viewer's own threads. */
export function teamOwnerOf(
  viewer: TeamViewer,
  ownerId: MemberId | null | undefined,
): Pick<TeamMember, "name" | "color"> | null {
  const effectiveOwnerId = ownerId ?? viewer.ownerId;
  if (effectiveOwnerId === null || effectiveOwnerId === viewer.memberId) return null;
  return viewer.members.get(effectiveOwnerId) ?? FORMER_MEMBER;
}

/** Team mode, me and the owner are per environment; single-member environments are absent. */
const teamViewersFamily = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) => {
    const viewers = new Map<EnvironmentId, TeamViewer>();
    for (const id of environmentIdsKey === ""
      ? []
      : (environmentIdsKey.split("\n") as EnvironmentId[])) {
      const viewer = teamViewerOf(
        get(teamEnvironment.membersValueAtom(id)),
        get(teamEnvironment.currentMemberIdAtom(id)),
      );
      if (viewer !== null) viewers.set(id, viewer);
    }
    return viewers;
  }).pipe(Atom.withLabel("team-viewers")),
);

export function useTeamViewers(
  environmentIds: readonly EnvironmentId[],
): ReadonlyMap<EnvironmentId, TeamViewer> {
  return useAtomValue(teamViewersFamily(environmentIds.join("\n")));
}

const NO_VIEWER_ATOM = Atom.make<TeamViewer | null>(null).pipe(Atom.withLabel("team-viewer:none"));

/** The viewer in a team-mode environment whose server accepts follows; null hides Follow. */
const followViewerFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(serverEnvironment.configValueAtom(environmentId))?.threadFollow === true
      ? teamViewerOf(
          get(teamEnvironment.membersValueAtom(environmentId)),
          get(teamEnvironment.currentMemberIdAtom(environmentId)),
        )
      : null,
  ).pipe(Atom.withLabel("team-follow-viewer")),
);

type FollowableThread = Parameters<typeof resolveThreadFollowing>[0] & {
  readonly environmentId: EnvironmentId;
};

/** Whether the viewer follows the thread, or null where Follow does not apply. */
export function useThreadFollowing(thread: FollowableThread | null): boolean | null {
  const viewer = useAtomValue(
    thread === null ? NO_VIEWER_ATOM : followViewerFamily(thread.environmentId),
  );
  return thread === null ? null : resolveThreadFollowing(thread, viewer);
}

function readThreadFollowing(thread: FollowableThread): boolean | null {
  return resolveThreadFollowing(
    thread,
    appAtomRegistry.get(followViewerFamily(thread.environmentId)),
  );
}

/** Follows or unfollows a thread; a failure shows a toast. */
export function useSetThreadFollowed() {
  const follow = useOrchestrationCommand(threadEnvironment.follow, { label: "follow thread" });
  const unfollow = useOrchestrationCommand(threadEnvironment.unfollow, {
    label: "unfollow thread",
  });
  return (threadRef: ScopedThreadRef, following: boolean) =>
    (following ? follow : unfollow)({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
}

/** For menus that read on demand. Team members are kept subscribed by TeamMembersWatch. */
export function readThreadTeamMenu(thread: FollowableThread) {
  const { environmentId } = thread;
  const ownerId = thread.source.ownerId;
  const members = appAtomRegistry.get(teamEnvironment.membersValueAtom(environmentId));
  if (!isTeamModeMembers(members)) return undefined;
  const memberId = appAtomRegistry.get(teamEnvironment.currentMemberIdAtom(environmentId));
  const following = readThreadFollowing(thread);
  return {
    members: activeTeamMembers(members).map(({ id, name }) => ({ id, name })),
    ownerId: ownerId ?? null,
    canDelete: canMemberDeleteThread({ members, memberId, ownerId }),
    ...(following === null ? {} : { following }),
  };
}

export function readCanDeleteThread(
  environmentId: EnvironmentId,
  ownerId: MemberId | null | undefined,
): boolean {
  return readThreadTeamMenu({ environmentId, source: { ownerId } })?.canDelete ?? true;
}
