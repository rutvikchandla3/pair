import type { MemberId, OrchestrationV2SenderLabel } from "@t3tools/contracts";

export const SENDER_NOTE =
  "Several people are prompting this thread; each message names its sender.";

const UNKNOWN_SENDER = "a former member";

export function labelUserTextForProvider(
  text: string,
  label: OrchestrationV2SenderLabel | undefined,
  name: string,
): string {
  if (label === undefined) return text;
  const named = `Message from ${name}:\n\n${text}`;
  return label === "name_with_note" ? `${SENDER_NOTE}\n\n${named}` : named;
}

/** Removed members stay in `members`, so their messages keep their name. */
export function labelUserMessageForProvider(
  text: string,
  message: {
    readonly authorId?: MemberId | undefined;
    readonly senderLabel?: OrchestrationV2SenderLabel | undefined;
  },
  members: ReadonlyMap<MemberId, { readonly name: string }>,
): string {
  if (message.senderLabel === undefined) return text;
  const name = message.authorId === undefined ? undefined : members.get(message.authorId)?.name;
  return labelUserTextForProvider(text, message.senderLabel, name ?? UNKNOWN_SENDER);
}
