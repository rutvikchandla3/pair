import { useAtomValue } from "@effect/atom-react";
import { threadShareOrigin } from "@t3tools/client-runtime/thread-reference";
import {
  EMPTY_TEAM_MEMBERS,
  activeTeamMembers,
  canMemberAssignThread,
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
  memberDisplayName,
  resolveThreadFollowing,
  teamViewerOf,
  type TeamMembers,
  type TeamViewer,
} from "@t3tools/client-runtime/state/team";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type MemberId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { configuredHostedAppUrl } from "../hostedPairing";
import { useEnvironmentHttpBaseUrl } from "./environments";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentCloudLaunchAtom, serverEnvironment } from "./server";
import { threadEnvironment } from "./threads";
import { useOrchestrationCommand } from "./use-orchestration-command";
import { environmentSession, readPreparedConnection, sessionHasScope } from "./session";

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

const teamGitHubFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.configValueAtom(environmentId))?.teamGitHub === true,
  ).pipe(Atom.withLabel(`team-github:${environmentId}`)),
);

/** Whether members can connect their own GitHub account on this server. */
export function useTeamGitHub(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId === null ? NOT_TEAM_ATOM : teamGitHubFamily(environmentId));
}

/** The origin a copied thread link opens on: the team server itself, else the hosted app. */
export function useThreadShareOrigin(environmentId: EnvironmentId | null): string {
  return threadShareOrigin({
    isTeamMode: useIsTeamMode(environmentId),
    httpBaseUrl: useEnvironmentHttpBaseUrl(environmentId),
    hostedAppUrl: configuredHostedAppUrl(),
  });
}

/** For menus that read on demand. Team members are kept subscribed by TeamMembersWatch. */
export function readThreadShareOrigin(environmentId: EnvironmentId): string {
  return threadShareOrigin({
    isTeamMode: appAtomRegistry.get(teamEnvironment.isTeamModeAtom(environmentId)),
    httpBaseUrl: readPreparedConnection(environmentId)?.httpBaseUrl,
    hostedAppUrl: configuredHostedAppUrl(),
  });
}

/** Settings → Team is for admins, and for anyone once the server has a second member. */
const teamSettingsVisibleFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(teamEnvironment.currentMemberIdAtom(environmentId)) !== null &&
      (sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthAccessWriteScope,
      ) ||
        get(teamEnvironment.isTeamModeAtom(environmentId))),
  ).pipe(Atom.withLabel(`team-settings-visible:${environmentId}`)),
);

// Joined ids, so subscribers re-render only when the list changes.
const teamSettingsEnvironmentIdsAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const candidates =
    primary === null || connected.includes(primary) ? connected : [primary, ...connected];
  return candidates.filter((id) => get(teamSettingsVisibleFamily(id))).join("\n");
}).pipe(Atom.withLabel("team-settings-environments"));

/** The environments whose Settings → Team this member may open; the Mac app reaches Pair Cloud's. */
export function useTeamSettingsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const key = useAtomValue(teamSettingsEnvironmentIdsAtom);
  return key === "" ? [] : (key.split("\n") as EnvironmentId[]);
}

export function useTeamSettingsVisible(): boolean {
  return useAtomValue(teamSettingsEnvironmentIdsAtom) !== "";
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

type AssignableThread = FollowableThread & { readonly source: { readonly sandboxId?: unknown } };

const assignViewerFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => ({
    members: get(teamEnvironment.membersValueAtom(environmentId)),
    memberId: get(teamEnvironment.currentMemberIdAtom(environmentId)),
    cloudLaunch: get(environmentCloudLaunchAtom(environmentId)),
  })).pipe(Atom.withLabel(`team-assign-viewer:${environmentId}`)),
);

const NO_ASSIGN_VIEWER_ATOM = Atom.make(null).pipe(Atom.withLabel("team-assign-viewer:none"));

function canAssign(
  viewer: { members: TeamMembers; memberId: MemberId | null; cloudLaunch: boolean },
  thread: AssignableThread,
): boolean {
  return canMemberAssignThread({
    members: viewer.members,
    memberId: viewer.memberId,
    ownerId: thread.source.ownerId,
    cloudThread: viewer.cloudLaunch && thread.source.sandboxId !== undefined,
  });
}

/** Whether Assign is open to the viewer: a cloud thread is its owner's to assign. */
export function useCanAssignThread(thread: AssignableThread | null): boolean {
  const viewer = useAtomValue(
    thread === null ? NO_ASSIGN_VIEWER_ATOM : assignViewerFamily(thread.environmentId),
  );
  return thread === null || viewer === null || canAssign(viewer, thread);
}

/** For menus that read on demand. Team members are kept subscribed by TeamMembersWatch. */
export function readThreadTeamMenu(thread: AssignableThread) {
  const { environmentId } = thread;
  const ownerId = thread.source.ownerId;
  const viewer = appAtomRegistry.get(assignViewerFamily(environmentId));
  const { members, memberId } = viewer;
  if (!isTeamModeMembers(members)) return undefined;
  const following = readThreadFollowing(thread);
  return {
    members: activeTeamMembers(members).map(({ id, name }) => ({ id, name })),
    ownerId: ownerId ?? null,
    canDelete: canMemberDeleteThread({ members, memberId, ownerId }),
    canAssign: canAssign(viewer, thread),
    ...(following === null ? {} : { following }),
  };
}

export function readCanDeleteThread(
  environmentId: EnvironmentId,
  ownerId: MemberId | null | undefined,
): boolean {
  return readThreadTeamMenu({ environmentId, source: { ownerId } })?.canDelete ?? true;
}
