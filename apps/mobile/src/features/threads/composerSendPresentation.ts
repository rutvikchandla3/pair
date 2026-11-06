import {
  alternateComposerDispatchAction,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";

import type { FollowUpBehavior } from "../../lib/followUpBehavior";

export interface ComposerSendPresentation {
  readonly label: string;
  readonly icon:
    | "arrow.up"
    | "tray.and.arrow.up"
    | "checkmark"
    | "list.number"
    | "arrow.turn.left.up";
  readonly action: ActiveTurnComposerAction | null;
  readonly alternate: ActiveTurnComposerAction | null;
  readonly offersFollowUpChoice: boolean;
  /** On another member's turn: what Send does there, shown above the composer. */
  readonly othersTurnHint: string | null;
  /** On another member's turn: the subtitle of the Steer now alternate. */
  readonly steerSubtitle: string | null;
}

const ACTION_LABEL: Record<ActiveTurnComposerAction, string> = {
  queue: "Queue",
  steer: "Steer",
  restart: "Restart",
};

export function resolveComposerSendPresentation(input: {
  readonly editingQueuedMessage: boolean;
  readonly running: boolean;
  readonly canSteer: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  readonly deliveryDeferred: boolean;
  /** Who started the running turn, when it is another member's. */
  readonly othersTurnName: string | null;
}): ComposerSendPresentation {
  if (input.editingQueuedMessage) {
    return {
      label: "Update queued message",
      icon: "checkmark",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
      othersTurnHint: null,
      steerSubtitle: null,
    };
  }
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? "Queue" : "Send",
      icon: input.deliveryDeferred ? "tray.and.arrow.up" : "arrow.up",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
      othersTurnHint: null,
      steerSubtitle: null,
    };
  }
  const othersTurn = input.othersTurnName;
  // Another member's turn queues whatever the setting; steering it is the explicit alternate.
  const action: ActiveTurnComposerAction =
    input.canSteer && othersTurn === null ? input.followUpBehavior : "queue";
  const alternate = alternateComposerDispatchAction(action);
  return {
    label: ACTION_LABEL[action],
    icon: action === "steer" ? "arrow.turn.left.up" : "list.number",
    action,
    alternate: input.canSteer ? alternate : null,
    offersFollowUpChoice: input.canSteer,
    othersTurnHint:
      othersTurn === null
        ? null
        : input.canSteer
          ? `Queues after ${othersTurn}'s turn. Hold Send to steer now.`
          : `Queues after ${othersTurn}'s turn.`,
    steerSubtitle: othersTurn === null ? null : `Interrupt ${othersTurn}'s turn`,
  };
}
