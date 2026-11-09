import { createSandboxEnvironmentAtoms } from "@t3tools/client-runtime/state/sandbox";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { cloudAvailability } from "@t3tools/shared/sandbox";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { teamEnvironment } from "./team";
import { environmentThreadShells } from "./threads";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime, {
  team: teamEnvironment,
  threadShells: environmentThreadShells,
});

/** Read at event time, for shortcuts. */
export function readCloudAvailable(projectRef: ScopedProjectRef): boolean {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId);
  return cloudAvailability(
    config?.settings ?? null,
    projectRef.projectId,
    config?.environment.capabilities.cloudLaunch === true,
  ).available;
}
