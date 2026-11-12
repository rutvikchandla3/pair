import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const chiefOfStaffCommands = {
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:chief-of-staff:start",
    tag: WS_METHODS.chiefOfStaffStart,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:chief-of-staff:stop",
    tag: WS_METHODS.chiefOfStaffStop,
  }),
  // A command, not a query: listing boots a provider process, so the settings page asks once.
  listVoices: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:chief-of-staff:list-voices",
    tag: WS_METHODS.chiefOfStaffListVoices,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
  }),
};
