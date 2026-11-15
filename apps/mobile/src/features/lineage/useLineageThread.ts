import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { useLineageViewer } from "../../state/branch-lineage";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";

export type LineageSheetParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

/** A lineage sheet's thread from its route params, with the viewer and the account it runs on. */
export function useLineageThread(params: LineageSheetParams) {
  const ref: ScopedThreadRef = scopeThreadRef(
    EnvironmentId.make(params.environmentId),
    ThreadId.make(params.threadId),
  );
  const shell = useQuietThreadShell(ref);
  const viewer = useLineageViewer(ref.environmentId);
  const providerName = useProviderName(shell);
  return { ref, shell, viewer, providerName };
}

/** The thread's provider by name, e.g. "Claude", for "your Claude and GitHub sign-ins". */
function useProviderName(shell: EnvironmentThreadShell | null): string {
  const config = useEnvironmentServerConfig(shell?.environmentId ?? null);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === shell?.modelSelection.instanceId,
  );
  return provider === undefined ? "Claude" : resolveProviderInstanceDisplayName(provider);
}
