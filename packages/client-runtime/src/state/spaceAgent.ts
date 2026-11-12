import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** `@pair`'s controls; their results reach the room through its stream, so nothing refetches. */
export function createSpaceAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:action",
      tag: WS_METHODS.spacesAction,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.actionId}`,
      },
    }),
    notes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:notes",
      tag: WS_METHODS.spacesNotes,
      // Each edit names the version it read, so a space's edits go one at a time.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.spaceId}`,
      },
    }),
    reply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:reply",
      tag: WS_METHODS.spacesReply,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.runId}`,
      },
    }),
  };
}
