import {
  type MemberId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  type ProviderInstanceEntry,
  brandProviderInstanceEntries,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  resolveSelectableProviderInstanceEntry,
} from "@t3tools/client-runtime/state/provider-instance-entries";
import { canSelectProviderInstance } from "@t3tools/shared/providerInstanceOwnership";

export { normalizeProviderAccentColor, shouldShowInstanceBadge };
export {
  type ProviderInstanceEntry,
  applyProviderInstanceSettings,
  brandProviderInstanceEntries,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
  resolveSelectableProviderInstanceEntry,
} from "@t3tools/client-runtime/state/provider-instance-entries";

/** Placeholder for untargetable drafts. Never persist or dispatch it; disable send until replaced. */
export const NO_PROVIDER_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("t3code_no_provider"),
  model: "",
};

/** Who is picking, in team mode only: other members' accounts stay out of their picker. */
export interface ProviderInstancePickerViewer {
  readonly memberId: MemberId;
  readonly currentInstanceId: ProviderInstanceId | undefined;
}

export function isProviderInstanceSelectableBy(
  entry: ProviderInstanceEntry,
  viewer: ProviderInstancePickerViewer | null,
): boolean {
  return (
    viewer === null ||
    canSelectProviderInstance({
      ownerMemberId: entry.ownerMemberId,
      memberId: viewer.memberId,
      currentInstanceId: viewer.currentInstanceId,
      instanceId: entry.instanceId,
    })
  );
}

export function isProviderInstancePickerVisible(
  entry: ProviderInstanceEntry,
  viewer: ProviderInstancePickerViewer | null = null,
): boolean {
  return entry.enabled && isProviderInstanceSelectableBy(entry, viewer);
}

/** Instance ids repeat across environments; lookups must stay scoped. */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<
    readonly [
      string,
      ReadonlyArray<ServerProvider>,
      Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">?,
    ]
  >,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
  for (const [environmentId, providers, settings] of providersByEnvironment) {
    const derived = deriveProviderInstanceEntries(providers);
    const entries = settings ? brandProviderInstanceEntries(derived, settings) : derived;
    byEnvironment.set(
      environmentId,
      new Map(entries.map((entry) => [entry.instanceId as string, entry] as const)),
    );
  }
  return byEnvironment;
}

export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceEntries(providers);
  return resolveSelectableProviderInstanceEntry(entries, instanceId)?.instanceId;
}

export function resolveDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  const instanceId = resolveSelectableProviderInstance(providers, selection?.instanceId);
  if (instanceId === undefined) return null;
  if (selection?.instanceId === instanceId) return selection;
  const model = getDefaultProviderInstanceModel(providers, instanceId);
  return model ? { instanceId, model } : null;
}
