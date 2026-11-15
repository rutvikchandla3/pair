import { lineageHolderOf, resolvingRowCopy } from "@t3tools/client-runtime/branch-lineage";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";

import { useQuietThreadShell } from "~/state/entities";
import { useLineageViewer } from "~/state/branchLineage";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { useLineageActions } from "./useLineageActions";

function AbortUpdateButton({
  threadRef,
  label,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly label: string;
}) {
  const actions = useLineageActions();
  return (
    <Button size="xs" variant="outline" onClick={() => void actions.abortUpdate(threadRef)}>
      {label}
    </Button>
  );
}

/**
 * Pinned above the composer while an Update's conflict is open. The composer stays usable: the
 * agent is told which files have markers.
 */
export function useLineageResolvingBanner(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const shell = useQuietThreadShell(threadRef);
  const viewer = useLineageViewer(threadRef?.environmentId ?? null);
  const source = shell?.source.branchLink?.source ?? null;
  if (threadRef === null || shell === null || source?.updateInProgress == null) return null;
  const copy = resolvingRowCopy(source.updateInProgress, source.title);
  const holds =
    viewer.memberId !== null && lineageHolderOf(shell.source, viewer) === viewer.memberId;
  return {
    id: `lineage-resolving:${threadRef.environmentId}:${threadRef.threadId}`,
    variant: "warning",
    icon: <CircleAlertIcon />,
    title: (
      <span>
        {copy.text}
        {copy.paths.length === 0 ? null : (
          <>
            {" · "}
            <span className="font-mono">{copy.paths.join(", ")}</span>
          </>
        )}
      </span>
    ),
    ...(holds
      ? { actions: <AbortUpdateButton threadRef={threadRef} label={copy.action.label} /> }
      : {}),
  };
}
