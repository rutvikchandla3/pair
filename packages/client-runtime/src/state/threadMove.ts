import { WS_METHODS } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { moveThreadToLocal } from "../operations/commands.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

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
  };
}
