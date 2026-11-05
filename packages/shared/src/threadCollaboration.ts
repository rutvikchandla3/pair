import type {
  MemberId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@t3tools/contracts";

/**
 * The member whose turn a run is: the author of the message that started it, else the thread's
 * holder, so agent, scheduled and notification runs belong to whoever holds the thread.
 */
export function runStarterId(input: {
  readonly run: Pick<OrchestrationV2Run, "userMessageId">;
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "authorId">>;
  readonly holderId: MemberId;
}): MemberId {
  return (
    input.messages.find((message) => message.id === input.run.userMessageId)?.authorId ??
    input.holderId
  );
}

/**
 * On a team, only a queued message's author may edit its text, while its author or the thread's
 * holder may send, start, reorder or remove it. Solo servers and actorless commands allow all.
 */
export function canChangeQueuedRun(input: {
  readonly action: "edit" | "control";
  readonly actorId: MemberId | undefined;
  readonly holderId: MemberId;
  readonly starterId: MemberId;
  readonly teamMode: boolean;
}): boolean {
  if (!input.teamMode || input.actorId === undefined) return true;
  return (
    input.actorId === input.starterId ||
    (input.action === "control" && input.actorId === input.holderId)
  );
}
