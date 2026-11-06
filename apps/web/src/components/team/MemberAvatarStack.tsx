import { cn } from "~/lib/utils";
import type { PresentMember } from "@t3tools/client-runtime/state/presence";
import { MemberAvatar } from "./MemberAvatar";

/** Overlapping avatars, then "+n" for the rest. */
export function MemberAvatarStack({
  members,
  max = 3,
  size = "sm",
  className,
}: {
  readonly members: ReadonlyArray<PresentMember>;
  readonly max?: number;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  if (members.length === 0) return null;
  const shown = members.slice(0, max);
  const hidden = members.length - shown.length;
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      {shown.map((member, index) => (
        <MemberAvatar
          key={member.id}
          member={member}
          away={member.away}
          size={size}
          className={cn("ring-2 ring-background", index > 0 && "-ml-1")}
        />
      ))}
      {hidden > 0 ? (
        <span className="ml-1 text-muted-foreground text-xs tabular-nums">+{hidden}</span>
      ) : null}
    </span>
  );
}
