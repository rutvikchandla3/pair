import { spaceMark } from "@t3tools/client-runtime/spaces";
import type { Space } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const SIZE_CLASSNAMES = {
  xs: "size-3.5 rounded-[3px] text-[8px]",
  sm: "size-4 rounded-[4px] text-[9px]",
  md: "size-5 rounded-[5px] text-[11px]",
} as const;

/** A space's tile: its first letter on its own color, so rooms tell apart at a glance. */
export function SpaceMark(props: {
  readonly space: Pick<Space, "id" | "name">;
  readonly size?: keyof typeof SIZE_CLASSNAMES;
  readonly className?: string | undefined;
}) {
  const mark = spaceMark(props.space);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold text-white leading-none",
        SIZE_CLASSNAMES[props.size ?? "sm"],
        props.className,
      )}
      style={{ backgroundColor: mark.color }}
    >
      {mark.letter}
    </span>
  );
}
