import {
  PROVIDER_DISPLAY_NAMES,
  SANDBOX_ACCESS_MEMBER_LIMIT,
  type MemberId,
  type ProviderInstanceId,
  type SandboxAccessAudience,
  type SandboxId,
  type ServerSettings,
  type TeamMember,
  type ThreadId,
} from "@t3tools/contracts";

import { activeTeamMembers, type TeamMembers } from "./team.ts";

export const SHARE_FAILURE_TITLE = "Could not change who can open this thread";

/** Under an open Team shelf with nothing on it. */
export const TEAM_SHELF_EMPTY_LABEL = "Threads teammates share with you show up here.";

export const THREAD_ACCESS_REVOKED_MESSAGE = "You no longer have access to this thread.";
/** It never says which, or whose. */
export const THREAD_PRIVATE_OR_GONE_MESSAGE =
  "This thread is private, or it no longer exists. Ask its owner to share it with you.";

export interface ShareAccess {
  readonly audience: SandboxAccessAudience;
  readonly memberIds: ReadonlyArray<MemberId>;
}

export type ShareChange =
  | { readonly kind: "add"; readonly memberIds: ReadonlyArray<MemberId> }
  | { readonly kind: "remove"; readonly memberId: MemberId }
  | { readonly kind: "audience"; readonly audience: SandboxAccessAudience };

/** A change sent and not yet seen back on the thread's shell; `access` is what was sent. */
export interface PendingShare {
  readonly id: number;
  readonly access: ShareAccess;
  readonly confirmed: boolean;
}

/** Active members the owner can still add, matched on name and GitHub username. */
export function shareCandidates(
  members: TeamMembers,
  input: {
    readonly ownerId: MemberId | null;
    readonly listed: ReadonlyArray<MemberId>;
    readonly query: string;
  },
): ReadonlyArray<TeamMember> {
  const needle = input.query.trim().toLowerCase();
  return activeTeamMembers(members).filter(
    (member) =>
      member.id !== input.ownerId &&
      !input.listed.includes(member.id) &&
      (member.name.toLowerCase().includes(needle) ||
        (member.github?.login.toLowerCase().includes(needle) ?? false)),
  );
}

export function applyShareChange(access: ShareAccess, change: ShareChange): ShareAccess {
  switch (change.kind) {
    case "add":
      return {
        ...access,
        memberIds: [
          ...access.memberIds,
          ...change.memberIds.filter((id) => !access.memberIds.includes(id)),
        ],
      };
    case "remove":
      return { ...access, memberIds: access.memberIds.filter((id) => id !== change.memberId) };
    case "audience":
      return { ...access, audience: change.audience };
  }
}

export function sameShareAccess(left: ShareAccess, right: ShareAccess): boolean {
  return (
    left.audience === right.audience &&
    left.memberIds.length === right.memberIds.length &&
    left.memberIds.every((id) => right.memberIds.includes(id))
  );
}

export function shareCapMessage(teamName: string): string {
  return `A thread can be shared with up to ${SANDBOX_ACCESS_MEMBER_LIMIT} people. Choose Everyone on ${teamName} instead.`;
}

export function exceedsShareCap(access: ShareAccess): boolean {
  return access.memberIds.length > SANDBOX_ACCESS_MEMBER_LIMIT;
}

/** Drops what the shell already shows: everything up to the newest confirmed change it matches. */
export function unsettledShares(
  server: ShareAccess,
  pending: ReadonlyArray<PendingShare>,
): ReadonlyArray<PendingShare> {
  const settled = pending.findLastIndex(
    (entry) => entry.confirmed && sameShareAccess(entry.access, server),
  );
  return pending.slice(settled + 1);
}

/** The newest change sent wins, so rows move as soon as the owner acts. */
export function visibleShareAccess(
  server: ShareAccess,
  pending: ReadonlyArray<PendingShare>,
): ShareAccess {
  return unsettledShares(server, pending).at(-1)?.access ?? server;
}

/**
 * Removing a member who owns threads on the machine takes those from them too, so it asks first.
 * Under Everyone on the team they keep access, so it does not.
 */
export function removalWarning(input: {
  readonly access: ShareAccess;
  readonly member: Pick<TeamMember, "id" | "name">;
  readonly threadOwnerIds: ReadonlyArray<MemberId | null>;
}): string | null {
  if (input.access.audience === "team") return null;
  const owned = input.threadOwnerIds.filter((id) => id === input.member.id).length;
  if (owned === 0) return null;
  return owned === 1
    ? `${input.member.name} has a thread on this machine and will lose access to it too.`
    : `${input.member.name} has ${owned} threads on this machine and will lose access to them too.`;
}

export function shareAudienceLabel(audience: SandboxAccessAudience, teamName: string): string {
  return audience === "team" ? `Everyone on ${teamName}` : "Only people added";
}

/** The other threads on the machine, and the provider account when it is the owner's own. */
export function shareMachineContext(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly sandboxId?: SandboxId | undefined;
    readonly ownerId?: MemberId | null | undefined;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly sandboxId: SandboxId;
  readonly ownerThreadId: ThreadId | undefined;
  readonly ownerId: MemberId | null;
  readonly providerInstances: ServerSettings["providerInstances"];
}) {
  const onMachine = input.threads.filter((thread) => thread.sandboxId === input.sandboxId);
  const ownerThread = onMachine.find((thread) => thread.id === input.ownerThreadId);
  const related = onMachine.filter((thread) => thread.id !== input.ownerThreadId);
  const instance =
    ownerThread === undefined ? undefined : input.providerInstances[ownerThread.providerInstanceId];
  const ownAccountProvider =
    instance === undefined || input.ownerId === null || instance.ownerMemberId !== input.ownerId
      ? null
      : (PROVIDER_DISPLAY_NAMES[instance.driver] ?? instance.displayName ?? null);
  return {
    relatedThreadOwnerIds: related.map((thread) => thread.ownerId ?? null),
    ownAccountProvider,
  };
}

/** What sharing reaches. It names the provider only on the owner's own account. */
export function shareTrustSentence(input: {
  readonly audience: SandboxAccessAudience;
  readonly teamName: string;
  readonly ownAccountProvider: string | null;
  readonly relatedCount: number;
}): string {
  const lead =
    input.audience === "team"
      ? `Everyone on ${input.teamName} can open this thread, including people who join later. They`
      : "People you add";
  const provider =
    input.ownAccountProvider === null ? "the provider" : `your ${input.ownAccountProvider}`;
  const related =
    input.relatedCount === 0
      ? ""
      : input.relatedCount === 1
        ? " Sharing also covers its side chat or fork."
        : ` Sharing also covers its ${input.relatedCount} side chats and forks.`;
  return `${lead} can prompt this thread and use its terminal. That reaches ${provider} sign-in and git token on its machine.${related}`;
}
