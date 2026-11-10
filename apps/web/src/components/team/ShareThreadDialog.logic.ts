import { activeTeamMembers, type TeamMembers } from "@t3tools/client-runtime/state/team";
import {
  SANDBOX_ACCESS_MEMBER_LIMIT,
  type MemberId,
  type SandboxAccessAudience,
  type TeamMember,
} from "@t3tools/contracts";

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
