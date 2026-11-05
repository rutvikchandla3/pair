import type {
  MemberId,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2SenderLabel,
} from "@t3tools/contracts";

export interface HumanAuthorship {
  readonly authorId?: MemberId;
  readonly senderLabel?: OrchestrationV2SenderLabel;
  /** Present only when this message adds a new human author. */
  readonly humanAuthorIds?: ReadonlyArray<MemberId>;
}

/**
 * Labels are decided when the message is dispatched: a thread with one human
 * author never labels, so single-member servers send exactly the typed text.
 */
export function decideHumanAuthorship(
  thread: Pick<OrchestrationV2AppThread, "humanAuthorIds">,
  command: Pick<
    Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    | "createdBy"
    | "actorId"
    | "context"
    | "notification"
    | "delegatedCompletion"
    | "scheduledTaskId"
    | "senderThreadId"
  >,
): HumanAuthorship {
  const authorId = command.actorId;
  if (
    command.createdBy !== "user" ||
    authorId === undefined ||
    command.context?.guest !== undefined ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.scheduledTaskId !== undefined ||
    command.senderThreadId !== undefined
  ) {
    return {};
  }
  const current = thread.humanAuthorIds ?? [];
  const isNew = !current.includes(authorId);
  const next = isNew ? [...current, authorId] : current;
  const senderLabel: OrchestrationV2SenderLabel | undefined =
    next.length < 2 ? undefined : current.length < 2 ? "name_with_note" : "name";
  return {
    authorId,
    ...(senderLabel === undefined ? {} : { senderLabel }),
    ...(isNew ? { humanAuthorIds: next } : {}),
  };
}

export function authorshipFields(authorship: {
  readonly authorId?: MemberId | undefined;
  readonly senderLabel?: OrchestrationV2SenderLabel | undefined;
}): Pick<HumanAuthorship, "authorId" | "senderLabel"> {
  return {
    ...(authorship.authorId === undefined ? {} : { authorId: authorship.authorId }),
    ...(authorship.senderLabel === undefined ? {} : { senderLabel: authorship.senderLabel }),
  };
}
