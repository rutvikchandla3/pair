import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";

/**
 * Where `ProviderAdapterRegistryV2` finds the in-process `spaceAgent` adapter. The adapter
 * reaches the orchestrator through its tools, so it registers after the registry is built.
 */
export interface SpaceAgentAdapterHolder {
  current: ProviderAdapter.ProviderAdapterV2["Service"] | undefined;
}

export class SpaceAgentAdapterSlot extends Context.Reference<SpaceAgentAdapterHolder | undefined>(
  "t3/space/SpaceAgentAdapterSlot",
  { defaultValue: () => undefined },
) {}

export const makeSlot = (): SpaceAgentAdapterHolder => ({
  current: undefined,
});
