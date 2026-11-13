import { useAtomValue } from "@effect/atom-react";
import { createSpaceAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/spaceAgent";
import { createTeamClaudeKeyEnvironmentAtoms } from "@t3tools/client-runtime/state/team-claude-key";
import type { EnvironmentId, TeamClaudeKeyStatus } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const spaceAgentEnvironment = createSpaceAgentEnvironmentAtoms(connectionAtomRuntime);

const NO_STATUS = Atom.make<TeamClaudeKeyStatus | null>(null).pipe(
  Atom.withLabel("web-team-claude-key:none"),
);

export const teamClaudeKeyEnvironment = createTeamClaudeKeyEnvironmentAtoms(connectionAtomRuntime);

/** The Team Claude key's status, live; null while it loads. */
export function useTeamClaudeKeyStatus(
  environmentId: EnvironmentId | null,
): TeamClaudeKeyStatus | null {
  return useAtomValue(
    environmentId === null ? NO_STATUS : teamClaudeKeyEnvironment.statusValueAtom(environmentId),
  );
}

export function useCanManageTeamClaudeKey(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(teamClaudeKeyEnvironment.set.permissionAtom(environmentId));
}
