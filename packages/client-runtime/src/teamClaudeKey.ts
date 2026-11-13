import type { MemberId, TeamClaudeKeyStatus, TeamMember } from "@t3tools/contracts";

/** Active admins by join order. The server counts its owner as an admin. */
export function teamAdmins(members: Iterable<TeamMember>): ReadonlyArray<TeamMember> {
  return [...members]
    .filter((member) => member.removedAt === null && (member.role === "admin" || member.isOwner))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function teamClaudeKeyIsSet(status: TeamClaudeKeyStatus | null | undefined): boolean {
  return status?.state === "set";
}

/** "Not set" / "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 2m ago". */
export function teamClaudeKeyStatusText(
  status: TeamClaudeKeyStatus,
  nameOf: (memberId: MemberId) => string,
  now: number,
): string {
  const details = teamClaudeKeyDetailsText(status, nameOf, now);
  return details === null ? "Not set" : `Set · ${details}`;
}

/** "sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 2m ago", for a row that badges Set itself. */
export function teamClaudeKeyDetailsText(
  status: TeamClaudeKeyStatus,
  nameOf: (memberId: MemberId) => string,
  now: number,
): string | null {
  if (status.state === "unset") return null;
  // @effect-diagnostics-next-line globalDate:off - a calendar day, for display
  const added = new Date(status.addedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const parts = [`sk-ant-…${status.last4}`, `added by ${nameOf(status.addedBy)}, ${added}`];
  if (status.lastUsedAt !== null)
    parts.push(`last used ${ago(Date.parse(status.lastUsedAt), now)}`);
  return parts.join(" · ");
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
