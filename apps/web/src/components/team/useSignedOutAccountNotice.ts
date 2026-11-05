import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { providerInstanceOwner } from "@t3tools/shared/providerInstanceOwnership";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useTeamAttribution } from "~/state/team";

/** The run-failure line for a thread on another member's signed-out account; null otherwise. */
export function useSignedOutAccountNotice(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
): string | null {
  const team = useTeamAttribution(environmentId);
  const instance = useEnvironmentSettings(environmentId, (settings) =>
    instanceId === null
      ? null
      : {
          owner: providerInstanceOwner(settings, instanceId),
          displayName: settings.providerInstances[instanceId]?.displayName ?? instanceId,
        },
  );
  const signedOut = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId),
    (providers) =>
      providers?.find((provider) => provider.instanceId === instanceId)?.auth.status ===
      "unauthenticated",
  );
  const owner = instance?.owner;
  if (!team.isTeamMode || !signedOut || owner === undefined || owner === team.currentMemberId) {
    return null;
  }
  const ownerName = team.nameOf(owner);
  return `${instance?.displayName} is signed out. Ask ${ownerName} to sign in again, or switch this thread to another provider.`;
}
