import type { EnvironmentId, MemberId, TeamMember, TeamStreamEvent } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  createEnvironmentQueryAtomFamily,
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

export function activeTeamMembers(members: TeamMembers): ReadonlyArray<TeamMember> {
  return [...members.values()].filter((member) => member.removedAt === null);
}

export function isTeamModeMembers(members: TeamMembers): boolean {
  return activeTeamMembers(members).length > 1;
}

/** The server's delete rule, so clients can disable Delete up front: owner or admin, in team mode. */
export function canMemberDeleteThread(input: {
  readonly members: TeamMembers;
  readonly memberId: MemberId | null;
  readonly ownerId: MemberId | null | undefined;
}): boolean {
  if (input.memberId === null || !isTeamModeMembers(input.members)) return true;
  return (
    input.members.get(input.memberId)?.role === "admin" ||
    (input.ownerId != null && input.ownerId === input.memberId)
  );
}

const FORMER_MEMBER_NAME = "Former member";

/** A member the roster no longer lists (never known, or purged) reads as a former member. */
export function memberDisplayName(members: TeamMembers, id: MemberId): string {
  return members.get(id)?.name ?? FORMER_MEMBER_NAME;
}

/** Up to two letters for an initials avatar: first and last word, else a single word's first two. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1
      ? [words[0], words[words.length - 1]].map((word) => Array.from(word ?? "")[0] ?? "")
      : Array.from(words[0] ?? "").slice(0, 2);
  return letters.join("").toUpperCase();
}

/** Who "me" and the server owner are in one team-mode environment. */
export interface TeamViewer {
  readonly memberId: MemberId;
  readonly ownerId: MemberId | null;
  readonly members: TeamMembers;
}

export function teamViewerOf(members: TeamMembers, memberId: MemberId | null): TeamViewer | null {
  if (memberId === null || !isTeamModeMembers(members)) return null;
  let ownerId: MemberId | null = null;
  for (const member of members.values()) if (member.isOwner) ownerId = member.id;
  return { memberId, ownerId, members };
}

export const FORMER_MEMBER = { name: FORMER_MEMBER_NAME, color: "#6b7280" } as const;

/** The member who owns a thread when it is not the viewer; null for the viewer's own threads. */
export function teamOwnerOf(
  viewer: TeamViewer,
  ownerId: MemberId | null | undefined,
): Pick<TeamMember, "name" | "color"> | null {
  const effectiveOwnerId = ownerId ?? viewer.ownerId;
  if (effectiveOwnerId === null || effectiveOwnerId === viewer.memberId) return null;
  return viewer.members.get(effectiveOwnerId) ?? FORMER_MEMBER;
}

export type TeamThread = {
  readonly source: { readonly ownerId?: MemberId | null | undefined };
  readonly pinnedAt?: string | null | undefined;
  readonly followedAt?: string | null | undefined;
};

/** A thread with no recorded owner belongs to the server owner. */
export function sidebarThreadOwnerId(thread: TeamThread, team: TeamViewer): MemberId | null {
  return thread.source.ownerId ?? team.ownerId;
}

export function isSidebarThreadMine(thread: TeamThread, team: TeamViewer): boolean {
  return (
    sidebarThreadOwnerId(thread, team) === team.memberId ||
    // Pins and follows are per member, so either one on someone else's thread makes it mine.
    thread.pinnedAt != null ||
    thread.followedAt != null
  );
}

/** Null hides Follow: solo mode, a server without it, or the viewer owns the thread. */
export function resolveThreadFollowing(
  thread: TeamThread,
  team: TeamViewer | null | undefined,
): boolean | null {
  if (!team || sidebarThreadOwnerId(thread, team) === team.memberId) return null;
  return thread.followedAt != null;
}

/** Where a non-snoozed thread lists in team mode: someone else's settled thread is not listed. */
export function resolveTeamThreadSection(
  thread: TeamThread,
  viewer: TeamViewer,
  state: { readonly settled: boolean },
): "mine" | "team" | "hidden" {
  if (isSidebarThreadMine(thread, viewer)) return "mine";
  return state.settled ? "hidden" : "team";
}

function timestampMs(value: string | null | undefined): number {
  const parsed = value == null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Newest activity first: the latest message, run, or update. */
export function sortTeamThreadsByActivity<
  T extends Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "latestUserMessageAt" | "latestRun" | "updatedAt"
  >,
>(threads: readonly T[]): T[] {
  const activityAt = (thread: T) =>
    Math.max(
      timestampMs(thread.latestUserMessageAt),
      timestampMs(thread.latestRun?.completedAt),
      timestampMs(thread.latestRun?.startedAt),
      timestampMs(thread.updatedAt),
    );
  const timestamps = new Map(threads.map((thread) => [thread, activityAt(thread)]));
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/** The teammate who wrote a user message; undefined for my own, solo, and non-member senders. */
export function otherMessageAuthorId(input: {
  readonly isTeamMode: boolean;
  readonly currentMemberId: MemberId | null;
  readonly message: { readonly authorId?: MemberId | undefined };
  readonly attribution: string | null;
}): MemberId | undefined {
  return input.isTeamMode &&
    input.attribution === null &&
    input.message.authorId !== undefined &&
    input.message.authorId !== input.currentMemberId
    ? input.message.authorId
    : undefined;
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

  // Keyed by an ISO string: query keys are JSON, which would turn a DateTime into a string.
  const usageSinceFamily = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:team:usage",
    idleTtlMs: 0,
    execute: (input: { readonly since: string }) =>
      request(WS_METHODS.teamUsage, { since: DateTime.makeUnsafe(input.since) }),
  });
  const teamUsageAtom = (environmentId: EnvironmentId, since: string) =>
    usageSinceFamily({ environmentId, input: { since } });

  return {
    teamMembersAtom,
    teamUsageAtom,
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
    mutateProviderAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:provider-accounts-mutate",
      tag: WS_METHODS.teamProviderAccountsMutate,
    }),
    startGitHubLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:github-link-start",
      tag: WS_METHODS.teamGitHubLinkStart,
    }),
    waitForGitHubLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:github-link-wait",
      tag: WS_METHODS.teamGitHubLinkWait,
    }),
    cancelGitHubLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:github-link-cancel",
      tag: WS_METHODS.teamGitHubLinkCancel,
    }),
    disconnectGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:github-disconnect",
      tag: WS_METHODS.teamGitHubDisconnect,
    }),
  };
}
