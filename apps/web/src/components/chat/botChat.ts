import type { RunId } from "@t3tools/contracts";

/** ChatView rendering a bot's home thread (docs/product/bots.md). */
export interface BotChatOptions {
  /** The composer reads "Message <name>"; the empty chat asks "What should <name> take on?". */
  readonly name: string;
  /** Scroll the chat to this turn's last message; a new nonce scrolls again. */
  readonly focus: { readonly runId: RunId; readonly nonce: number } | null;
}
