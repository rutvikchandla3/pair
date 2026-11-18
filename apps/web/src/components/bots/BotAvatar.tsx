import type { Bot } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { botColor } from "./bots.logic";

const SIZES = {
  sm: { px: 16, font: 9, radius: 5 },
  md: { px: 24, font: 11, radius: 8 },
  lg: { px: 32, font: 15, radius: 10 },
} as const;

export type BotAvatarSize = keyof typeof SIZES;

/** A bot's coloured rounded square with its initial. */
export function BotAvatar(props: {
  readonly bot: Pick<Bot, "name" | "color">;
  readonly size?: BotAvatarSize;
  readonly className?: string;
}) {
  const size = SIZES[props.size ?? "md"];
  const initial = props.bot.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium text-white",
        props.className,
      )}
      style={{
        width: size.px,
        height: size.px,
        fontSize: size.font,
        borderRadius: size.radius,
        backgroundColor: botColor(props.bot as Bot),
      }}
    >
      {initial}
    </span>
  );
}
