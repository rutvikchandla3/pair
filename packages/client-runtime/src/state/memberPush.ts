import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** A team server's own push: registers or forgets this device's Expo token for the member. */
export function createMemberPushCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:member-push:register",
      tag: WS_METHODS.pushRegister,
    }),
    unregister: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:member-push:unregister",
      tag: WS_METHODS.pushUnregister,
    }),
  };
}
