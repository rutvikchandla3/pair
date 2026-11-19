import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";

const LISTED_LIMIT = 8;

export function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/** Skip checks without descriptors; reject duplicate IDs because consumers disagree on precedence. */
export function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

const capped = (items: ReadonlyArray<string>): string =>
  items.length <= LISTED_LIMIT
    ? items.join(", ")
    : `${items.slice(0, LISTED_LIMIT).join(", ")} and ${items.length - LISTED_LIMIT} more`;

const instanceName = (provider: Pick<ServerProvider, "instanceId" | "displayName">): string =>
  provider.displayName === undefined
    ? provider.instanceId
    : `${provider.displayName} (${provider.instanceId})`;

/**
 * Why `selection` can't start a thread here, worded for an agent to fix the call: each refusal
 * names the instances or models that would work. Null when it can.
 */
export function modelSelectionProblem(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly adapterInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly selection: ModelSelection;
}): string | null {
  const { providers, adapterInstanceIds, selection } = input;
  const runnable = providers.filter(
    (provider) =>
      providerConstraints(provider, adapterInstanceIds.has(provider.instanceId)).length === 0,
  );
  const alternatives =
    runnable.length === 0
      ? "No provider instance here can run threads."
      : `Ones that can run: ${capped(runnable.map(instanceName))}.`;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) {
    return `No provider instance "${selection.instanceId}" here. ${alternatives}`;
  }
  const constraints = providerConstraints(provider, adapterInstanceIds.has(provider.instanceId));
  if (constraints.length > 0) {
    return `${instanceName(provider)} can't run here: ${constraints.join(" ")} ${alternatives}`;
  }
  // As delegate_task: an instance that lists no models takes any id.
  const model = provider.models.find(
    (candidate) =>
      candidate.slug === selection.model || candidate.aliases?.includes(selection.model) === true,
  );
  if (model === undefined && provider.models.length > 0) {
    const current = provider.models.filter((candidate) => candidate.isLegacy !== true);
    const listed = (current.length > 0 ? current : provider.models).map((candidate) =>
      candidate.name === candidate.slug ? candidate.slug : `${candidate.slug} (${candidate.name})`,
    );
    return `${instanceName(provider)} has no model "${selection.model}". Its models: ${capped(listed)}.`;
  }
  // Threads keep options their model doesn't declare (another version, a delegated parent's), and
  // the launch passes them through as before; only declared ones are checked.
  const descriptors = model?.capabilities?.optionDescriptors;
  const options = selection.options ?? [];
  const duplicates = invalidOptionSelections(options, undefined);
  const invalid =
    duplicates.length > 0
      ? duplicates
      : invalidOptionSelections(
          options.filter(
            (option) =>
              descriptors === undefined ||
              descriptors.some((descriptor) => descriptor.id === option.id),
          ),
          descriptors,
        );
  if (invalid.length > 0) {
    return `${selection.model} on ${provider.displayName ?? provider.instanceId} rejected options: ${invalid.join(" ")}`;
  }
  return null;
}

/** Whether a refusal, possibly prefixed by a forwarder, came from `modelSelectionProblem`. */
export const isModelSelectionRefusal = (message: string): boolean =>
  /No provider instance "|\) can't run here: |\) has no model "| rejected options: /.test(message);
