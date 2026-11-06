import type { MemberId, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

export function providerInstanceOwner(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId,
): MemberId | undefined {
  return settings.providerInstances[instanceId]?.ownerMemberId;
}

/**
 * A member's own instance may be newly chosen only by that member. Staying on a thread's current
 * instance, or leaving it, is always allowed.
 */
export function canSelectProviderInstance(input: {
  readonly ownerMemberId: MemberId | undefined;
  readonly memberId: MemberId | undefined;
  readonly currentInstanceId: ProviderInstanceId | undefined;
  readonly instanceId: ProviderInstanceId;
}): boolean {
  return (
    input.ownerMemberId === undefined ||
    input.instanceId === input.currentInstanceId ||
    input.ownerMemberId === input.memberId
  );
}
