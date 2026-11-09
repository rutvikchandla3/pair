import { WS_METHODS } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { moveThreadToLocal } from "../operations/commands.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

// Shared with mobile, so the copy names no control (checkbox or switch) and no "here".
export const CONTINUE_IN_CLOUD_LABEL = "Continue in cloud";
export const CONTINUE_IN_CLOUD_BUSY_LABEL = "Continuing in cloud…";
export const MOVE_STAYS_NOTE =
  "Ignored files such as .env and node_modules, earlier turns' diffs, terminals and running processes stay behind. The project's setup script can recreate ignored files in the cloud.";
export const MOVE_EXCLUDE_NOTE =
  "A file you leave out goes as last committed, or not at all if it's new.";
export const MOVE_IN_PROGRESS_NOTE = "This thread is already moving to the cloud.";
/** Files exist but are all left out, so "clean" would be wrong. */
export const moveNothingToUpload = (branch: string) =>
  `Nothing to upload. The cloud thread starts from ${branch} on origin.`;

/** Moves between a member's own server and Pair Cloud, sent to the member's own server. */
export function createThreadMoveAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
) {
  return {
    toLocal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-move:to-local",
      tag: WS_METHODS.threadMoveToLocal,
      execute: moveThreadToLocal,
    }),
    // The working tree changes under an agent, so every open reads it again.
    preview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-move:preview",
      tag: WS_METHODS.threadMovePreview,
      staleTimeMs: 0,
    }),
    toCloud: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-move:to-cloud",
      tag: WS_METHODS.threadMoveToCloud,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
  };
}
