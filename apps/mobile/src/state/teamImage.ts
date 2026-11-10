import { createTeamImageAtoms } from "@t3tools/client-runtime/state/team-image";

import { connectionAtomRuntime } from "../connection/runtime";

export const teamImageEnvironment = createTeamImageAtoms(connectionAtomRuntime);
