import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  readonly canEdit: boolean;
  readonly canSend: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
  readonly isEditing: boolean;
  /** Why Send now and Remove are off: another member's message on their turn's thread. */
  readonly controlLockedReason: string | null;
  /** Why Edit is off for the same reason. */
  readonly editLockedReason: string | null;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canSendNow: boolean;
  /** Something else holds the composer, such as an open question. */
  readonly editBlocked?: boolean;
  readonly isEditing?: boolean;
  /** A guest's message keeps the guest's words; the owner can cancel it, not rewrite it. */
  readonly isGuestMessage?: boolean;
  readonly text: string;
  /** On a team, what the shared queue rule lets me do with another member's message. */
  readonly lock?: {
    readonly starterName: string;
    readonly canEdit: boolean;
    readonly canControl: boolean;
  } | null;
}): ThreadQueueRowControls {
  const mutationEnabled = !input.busy;
  const isEditing = input.isEditing === true;
  const lock = input.lock ?? null;
  const controlLockedReason =
    lock?.canControl === false ? `Only ${lock.starterName} or the owner can change this` : null;
  const editLockedReason =
    controlLockedReason ??
    (lock?.canEdit === false ? `Only ${lock.starterName} can edit this message` : null);

  return {
    canDismiss: !input.busy && controlLockedReason === null,
    // Re-opening the row already in the composer would reload it and throw
    // away whatever has been typed since.
    canEdit:
      mutationEnabled &&
      !isEditing &&
      input.isGuestMessage !== true &&
      input.editBlocked !== true &&
      editLockedReason === null,
    canSend:
      mutationEnabled &&
      (input.canPromoteToSteer || input.canSendNow) &&
      !isEditing &&
      controlLockedReason === null,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    // Editing and sending keep the original text so quoted citations stay linked.
    displayText: isAttachmentOnlyBootstrapPrompt(input.text)
      ? ""
      : assistantCitationsToPlainText(input.text),
    isEditing,
    controlLockedReason,
    editLockedReason,
  };
}

export function buildCancelQueuedRunCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: {
      runId: input.runId,
      threadId: input.threadId,
    },
  };
}
