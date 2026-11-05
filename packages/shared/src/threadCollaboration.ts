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
