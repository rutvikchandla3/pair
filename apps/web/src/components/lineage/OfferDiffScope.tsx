import type { OfferId, ScopedThreadRef } from "@t3tools/contracts";

import { branchLineageEnvironment, useLineageView, useLineageViewer } from "~/state/branchLineage";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

/** The Changes panel scoped to an offer: its patch, and how the scope reads. */
export function useOfferDiffScope(threadRef: ScopedThreadRef | null, offerId: OfferId | null) {
  const query = useEnvironmentQuery(
    threadRef === null || offerId === null
      ? null
      : branchLineageEnvironment.offerDiff({
          environmentId: threadRef.environmentId,
          input: { offerId },
        }),
  );
  const view = useLineageView(offerId === null ? null : threadRef);
  const viewer = useLineageViewer(threadRef?.environmentId ?? null);
  const offer = view?.offers.find((candidate) => candidate.id === offerId) ?? null;
  const mine = offer !== null && offer.senderId === viewer.memberId;
  const sender = offer === null ? null : mine ? "you" : viewer.nameOf(offer.senderId);
  const commits = offer === null ? null : offer.commits.length;
  return {
    query,
    patch: query.data === null ? undefined : query.data.files.map((file) => file.patch).join(""),
    label:
      sender === null
        ? "Offered changes"
        : `Offered by ${sender}${commits === null ? "" : ` · ${commits} ${commits === 1 ? "commit" : "commits"}`}`,
    linesNote: sender === null ? null : mine ? "only your lines" : `only ${sender}'s lines`,
  };
}

/** "This thread" | "Offered by Hanad · 2 commits", in place of the scope menu. */
export function OfferDiffScopeHeader(props: {
  readonly label: string;
  readonly linesNote: string | null;
  readonly onThisThread: () => void;
}) {
  return (
    <div role="group" aria-label="Diff scope" className="flex min-w-0 items-center gap-1">
      <Button size="xs" variant="ghost-muted" onClick={props.onThisThread}>
        This thread
      </Button>
      <Button size="xs" variant="secondary" aria-pressed="true">
        <span className="truncate">{props.label}</span>
      </Button>
      {props.linesNote === null ? null : (
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">{props.linesNote}</span>
      )}
    </div>
  );
}
