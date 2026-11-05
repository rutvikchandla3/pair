import type { TeamMember } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const SIZE_CLASSNAMES = {
  sm: "size-5 text-3xs",
  md: "size-8 text-xs",
} as const;

function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1
      ? [words[0], words[words.length - 1]].map((word) => Array.from(word ?? "")[0] ?? "")
      : Array.from(words[0] ?? "").slice(0, 2);
  return letters.join("").toUpperCase();
}

export function MemberAvatar({
  member,
  size = "md",
  away = false,
  className,
}: {
  readonly member: Pick<TeamMember, "name" | "color">;
  readonly size?: keyof typeof SIZE_CLASSNAMES;
  /** Connected but without recent input: drawn hollow in the member's color. */
  readonly away?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={away ? `${member.name} (away)` : member.name}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none",
        away ? "border-[1.5px] bg-background" : "text-white",
        SIZE_CLASSNAMES[size],
        className,
      )}
      style={
        away
          ? { borderColor: member.color, color: member.color }
          : { backgroundColor: member.color }
      }
    >
      <span aria-hidden>{memberInitials(member.name)}</span>
    </span>
  );
}
