import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_TEAM_MEMBERS,
  activeTeamMembers,
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
  memberDisplayName,
  resolveThreadFollowing,
  teamOwnerOf,
  teamViewerOf,
  type TeamThread,
  type TeamViewer,
} from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, MemberId, TeamMember, ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";

import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { serverEnvironment } from "./server";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

/** What attribution labels need: nothing renders unless `isTeamMode`. */
export function useTeamAttribution(environmentId: EnvironmentId) {
  const members = useAtomValue(teamEnvironment.membersValueAtom(environmentId));
  const isTeamMode = useAtomValue(teamEnvironment.isTeamModeAtom(environmentId));
  const currentMemberId = useAtomValue(teamEnvironment.currentMemberIdAtom(environmentId));
  return {
    isTeamMode,
    currentMemberId,
    members,
    nameOf: (id: MemberId) => memberDisplayName(members, id),
  };
}

const NOT_TEAM_MODE_ATOM = Atom.make(false).pipe(Atom.withLabel("mobile-team-mode:none"));

export function useIsTeamMode(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? NOT_TEAM_MODE_ATOM : teamEnvironment.isTeamModeAtom(environmentId),
  );
}

const NO_TEAM_VIEWERS: ReadonlyMap<EnvironmentId, TeamViewer> = new Map();

/** Team mode, me and the owner per connected environment; single-member environments are absent. */
export const teamViewersAtom = Atom.make((get) => {
  const viewers = new Map<EnvironmentId, TeamViewer>();
  for (const id of get(connectedEnvironmentIdsAtom)) {
    const viewer = teamViewerOf(
      get(teamEnvironment.membersValueAtom(id)),
      get(teamEnvironment.currentMemberIdAtom(id)),
    );
    if (viewer !== null) viewers.set(id, viewer);
  }
  return viewers.size === 0 ? NO_TEAM_VIEWERS : viewers;
}).pipe(Atom.withLabel("mobile-team-viewers"));

export function useTeamViewers(): ReadonlyMap<EnvironmentId, TeamViewer> {
  return useAtomValue(teamViewersAtom);
}

/** The viewer in a team-mode environment whose server accepts follows; null hides Follow. */
const followViewerFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(serverEnvironment.configValueAtom(environmentId))?.threadFollow === true
      ? teamViewerOf(
          get(teamEnvironment.membersValueAtom(environmentId)),
          get(teamEnvironment.currentMemberIdAtom(environmentId)),
        )
      : null,
  ).pipe(Atom.withLabel("mobile-team-follow-viewer")),
);

export interface ThreadTeamMenu {
  readonly members: ReadonlyArray<Pick<TeamMember, "id" | "name">>;
  readonly ownerId: MemberId | null;
  readonly canDelete: boolean;
  readonly following: boolean | null;
}

type TeamThreadRef = TeamThread & { readonly environmentId: EnvironmentId };

const NO_MEMBERS_ATOM = Atom.make(EMPTY_TEAM_MEMBERS).pipe(Atom.withLabel("mobile-team:none"));
const NO_MEMBER_ID_ATOM = Atom.make<MemberId | null>(null).pipe(
  Atom.withLabel("mobile-team-member-id:none"),
);
const NO_VIEWER_ATOM = Atom.make<TeamViewer | null>(null).pipe(
  Atom.withLabel("mobile-team-viewer:none"),
);

/** The roster and the signed-in member, for an environment that may not be chosen yet. */
export function useTeamRoster(environmentId: EnvironmentId | null) {
  const members = useAtomValue(
    environmentId === null ? NO_MEMBERS_ATOM : teamEnvironment.membersValueAtom(environmentId),
  );
  const me = useAtomValue(
    environmentId === null ? NO_MEMBER_ID_ATOM : teamEnvironment.currentMemberIdAtom(environmentId),
  );
  return { members, me };
}

/** Follow, Assign and Delete availability for a thread's menu; null outside team mode. */
export function useThreadTeamMenu(thread: TeamThreadRef | null): ThreadTeamMenu | null {
  const environmentId = thread?.environmentId ?? null;
  const members = useAtomValue(
    environmentId === null ? NO_MEMBERS_ATOM : teamEnvironment.membersValueAtom(environmentId),
  );
  const memberId = useAtomValue(
    environmentId === null ? NO_MEMBER_ID_ATOM : teamEnvironment.currentMemberIdAtom(environmentId),
  );
  const followViewer = useAtomValue(
    environmentId === null ? NO_VIEWER_ATOM : followViewerFamily(environmentId),
  );
  if (thread === null || !isTeamModeMembers(members)) return null;
  const ownerId = thread.source.ownerId;
  const active = activeTeamMembers(members);
  return {
    members: active.map(({ id, name }) => ({ id, name })),
    // A thread with no recorded owner belongs to the server owner.
    ownerId: ownerId ?? active.find((member) => member.isOwner)?.id ?? null,
    canDelete: canMemberDeleteThread({ members, memberId, ownerId }),
    following: resolveThreadFollowing(thread, followViewer),
  };
}

/** The teammate who owns the thread in team mode; null for mine and on solo servers. */
export function useThreadOwner(
  thread: TeamThreadRef | null,
): Pick<TeamMember, "name" | "color"> | null {
  const viewers = useTeamViewers();
  if (thread === null) return null;
  const viewer = viewers.get(thread.environmentId);
  return viewer === undefined ? null : teamOwnerOf(viewer, thread.source.ownerId);
}

type ThreadTarget = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

function alertFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success") return;
  const error = Cause.squash(result.cause);
  Dialog.alert(
    title,
    error instanceof Error && error.message.trim().length > 0 ? error.message : "Try again.",
  );
}

/** Follow, Unfollow and Assign through the shared thread commands; a failure shows an alert. */
export function useThreadTeamActions() {
  const options = { reportFailure: false };
  const follow = useAtomCommand(threadEnvironment.follow, options);
  const unfollow = useAtomCommand(threadEnvironment.unfollow, options);
  const setOwner = useAtomCommand(threadEnvironment.setOwner, options);
  return {
    setFollowed: async (thread: ThreadTarget, following: boolean) =>
      alertFailure(
        following ? "Could not follow thread" : "Could not unfollow thread",
        await (following ? follow : unfollow)({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
      ),
    assign: async (thread: ThreadTarget, ownerId: MemberId) =>
      alertFailure(
        "Could not assign thread",
        await setOwner({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ownerId },
        }),
      ),
  };
}
