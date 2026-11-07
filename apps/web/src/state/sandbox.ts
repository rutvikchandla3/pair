import { createSandboxEnvironmentAtoms } from "@t3tools/client-runtime/state/sandbox";

import { connectionAtomRuntime } from "../connection/runtime";
import { teamEnvironment } from "./team";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime, {
  team: teamEnvironment,
});
