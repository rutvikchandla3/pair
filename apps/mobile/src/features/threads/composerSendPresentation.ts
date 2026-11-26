import {
  alternateComposerDispatchAction,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

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
  queue: msg("Queue", { $context: "verb, sends the message after the current turn" }),
  steer: msg("Steer", { $context: "verb, sends the message into the running turn" }),
  restart: msg("Restart", { $context: "verb, restarts the turn with the message" }),
};

export function resolveComposerSendPresentation(
  input: {
    readonly editingQueuedMessage: boolean;
    readonly running: boolean;
    readonly canSteer: boolean;
    readonly followUpBehavior: FollowUpBehavior;
    readonly deliveryDeferred: boolean;
    /** Who started the running turn, when it is another member's. */
    readonly othersTurnName?: string | null;
  },
  resolve: MessageResolver = m,
): ComposerSendPresentation {
  if (input.editingQueuedMessage) {
    return {
      label: resolve(msg("Update queued message")),
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
      label: input.deliveryDeferred
        ? resolve(ACTION_LABEL.queue)
        : resolve(msg("Send", { $context: "verb, sends the message" })),
      icon: input.deliveryDeferred ? "tray.and.arrow.up" : "arrow.up",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
      othersTurnHint: null,
      steerSubtitle: null,
    };
  }
  const othersTurn = input.othersTurnName ?? null;
  // Another member's turn queues whatever the setting; steering it is the explicit alternate.
  const action: ActiveTurnComposerAction =
    input.canSteer && othersTurn === null ? input.followUpBehavior : "queue";
  const alternate = alternateComposerDispatchAction(action);
  return {
    label: resolve(ACTION_LABEL[action]),
    icon: action === "steer" ? "arrow.turn.left.up" : "list.number",
    action,
    alternate: input.canSteer ? alternate : null,
    offersFollowUpChoice: input.canSteer,
    othersTurnHint:
      othersTurn === null
        ? null
        : input.canSteer
          ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
            `Queues after ${othersTurn}'s turn. Hold Send to steer now.`
          : // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
            `Queues after ${othersTurn}'s turn.`,
    steerSubtitle: othersTurn === null ? null : `Interrupt ${othersTurn}'s turn`,
  };
}
