import type { Bot } from "@t3tools/contracts";
import { botGreeting } from "@t3tools/client-runtime/bot-identity";

import { BotAvatar } from "../bots/BotAvatar";

/** A bot's empty chat introduces it: its face, a one-line greeting in its voice, and its role. */
export function BotEmptyChat(props: {
  readonly bot: Pick<Bot, "name" | "color" | "shape" | "voice" | "charter">;
}) {
  const role = props.bot.charter.trim();
  return (
    <div className="flex max-w-[560px] flex-col items-center gap-2 text-center">
      <BotAvatar bot={props.bot} size="xl" />
      <h2 className="mt-1 text-balance font-semibold text-foreground text-xl">
        {botGreeting(props.bot.name, props.bot.voice)}
      </h2>
      {role === "" ? null : <p className="text-muted-foreground text-xs">{role}</p>}
      <p className="mt-1 max-w-[520px] text-muted-foreground text-sm">
        Give it work in any of your projects or on this machine. It starts sessions, answers their
        questions the way you would, and asks you only what it can't decide.
      </p>
    </div>
  );
}
