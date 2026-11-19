import type { Bot, RunId } from "@t3tools/contracts";

/** ChatView rendering a bot's home thread (docs/product/bots.md). */
export interface BotChatOptions {
  /** The composer reads "Message <name>"; the empty chat is the bot's face and greeting. */
  readonly identity: Pick<Bot, "name" | "color" | "shape" | "voice" | "charter">;
  /** Scroll the chat to this turn's last message; a new nonce scrolls again. */
  readonly focus: { readonly runId: RunId; readonly nonce: number } | null;
}
