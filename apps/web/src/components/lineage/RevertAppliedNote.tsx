import { revertAcrossApplyNote } from "@t3tools/client-runtime/branch-lineage";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "~/state/entities";
import { useLineageView, useLineageViewer } from "~/state/branchLineage";

/** Revert to a turn names the teammates' applied changes it also discards. */
export function RevertAppliedNote(props: {
  readonly threadRef: ScopedThreadRef;
  readonly restoresTo: string;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  // Only a thread offers have reached has applied changes to lose.
  const hasLineage = shell?.source.branchLink != null;
  const view = useLineageView(hasLineage ? props.threadRef : null);
  const viewer = useLineageViewer(props.threadRef.environmentId);
  const note = view === null ? null : revertAcrossApplyNote(view, props.restoresTo, viewer);
  if (note === null) return null;
  return <span className="mt-2 block font-medium text-destructive">{note}</span>;
}
