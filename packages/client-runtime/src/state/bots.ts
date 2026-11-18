import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Bots for one environment: the whole snapshot from `bots.subscribe`, then each change, plus one
 * command per mutation. Mount the snapshot for one environment with `input: undefined`.
 */
export function createBotsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:bots:snapshot",
    tag: WS_METHODS.botsSubscribe,
  });

  return {
    snapshot,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:create",
      tag: WS_METHODS.botsCreate,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:update",
      tag: WS_METHODS.botsUpdate,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:pause",
      tag: WS_METHODS.botsPause,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:resume",
      tag: WS_METHODS.botsResume,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:delete",
      tag: WS_METHODS.botsDelete,
    }),
    markSeen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:mark-seen",
      tag: WS_METHODS.botsMarkSeen,
    }),
    createJob: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:create-job",
      tag: WS_METHODS.botsCreateJob,
    }),
    stopJob: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:stop-job",
      tag: WS_METHODS.botsStopJob,
    }),
    reopenJob: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:reopen-job",
      tag: WS_METHODS.botsReopenJob,
    }),
    answerAsk: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:answer-ask",
      tag: WS_METHODS.botsAnswerAsk,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.askId}`,
      },
    }),
    rememberAsk: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:remember-ask",
      tag: WS_METHODS.botsRememberAsk,
    }),
    correctDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:correct-decision",
      tag: WS_METHODS.botsCorrectDecision,
    }),
    handBackSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:hand-back-session",
      tag: WS_METHODS.botsHandBackSession,
    }),
    updateNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:update-note",
      tag: WS_METHODS.botsUpdateNote,
    }),
    deleteNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:delete-note",
      tag: WS_METHODS.botsDeleteNote,
    }),
  };
}
