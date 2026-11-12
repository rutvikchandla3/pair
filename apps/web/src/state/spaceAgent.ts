import { useAtomValue } from "@effect/atom-react";
import { createSpaceAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/spaceAgent";
import { hasSpaceTeamClaudeKey } from "@t3tools/client-runtime/spaceAgent";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const spaceAgentEnvironment = createSpaceAgentEnvironmentAtoms(connectionAtomRuntime);

/** Whether `@pair` can reply here; true until the server's settings arrive, so it never flashes. */
export function useSpaceTeamClaudeKey(environmentId: EnvironmentId): boolean {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null || settings === undefined
    ? true
    : hasSpaceTeamClaudeKey(settings.providerInstances);
}
