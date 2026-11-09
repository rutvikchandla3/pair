import { createThreadMoveAtoms } from "@t3tools/client-runtime/state/threadMove";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadMoveEnvironment = createThreadMoveAtoms(connectionAtomRuntime);
