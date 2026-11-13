import { WS_METHODS, type EnvironmentId, type TeamClaudeKeyStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createTeamClaudeKeyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  /** The status, then each change. Mount it for one environment with `input: {}`. */
  const status = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team-claude-key:status",
    tag: WS_METHODS.teamClaudeKeySubscribe,
  });

  const statusValueFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): TeamClaudeKeyStatus | null =>
      Option.getOrNull(AsyncResult.value(get(status({ environmentId, input: {} })))),
    ).pipe(Atom.withLabel(`team-claude-key-status-value:${environmentId}`)),
  );

  return {
    status,
    /** The status, or null while loading or on error. */
    statusValueAtom: (environmentId: EnvironmentId) => statusValueFamily(environmentId),
    /** Admins only; `permissionAtom` says whether to offer Add key / Replace. */
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-claude-key:set",
      tag: WS_METHODS.teamClaudeKeySet,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-claude-key:remove",
      tag: WS_METHODS.teamClaudeKeyRemove,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}
