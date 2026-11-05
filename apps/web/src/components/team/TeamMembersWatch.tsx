import { useConnectedEnvironmentIds } from "~/state/environments";
import { useTeamMembers } from "~/state/team";
import type { EnvironmentId } from "@t3tools/contracts";

function WatchEnvironmentMembers({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useTeamMembers(environmentId);
  return null;
}

/** Holds each connected environment's member stream open for menus that read it on demand. */
export function TeamMembersWatch() {
  return useConnectedEnvironmentIds().map((environmentId) => (
    <WatchEnvironmentMembers key={environmentId} environmentId={environmentId} />
  ));
}
