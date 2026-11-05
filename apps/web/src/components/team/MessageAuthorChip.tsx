import type { TeamMember } from "@t3tools/contracts";

import { MemberAvatar } from "./MemberAvatar";

/** Names a teammate above their message; the viewer's own messages never get one. */
export function MessageAuthorChip({
  member,
  name,
}: {
  readonly member: Pick<TeamMember, "name" | "color"> | null;
  readonly name: string;
}) {
  return (
    <p className="me-1 flex items-center gap-1.5 text-2xs text-muted-foreground" aria-hidden>
      {member !== null ? <MemberAvatar member={member} size="sm" /> : null}
      {name}
    </p>
  );
}
