import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsSearchTargetId } from "./settingsLayout";

/**
 * Folds power-user rows at the end of a section. `targetIds` names the search targets inside, so a
 * search jump opens the fold before its row mounts.
 */
export function AdvancedSettings({
  targetIds,
  summary,
  children,
}: {
  readonly targetIds: ReadonlyArray<string>;
  /** What the folded rows change from their defaults, so an override shows while folded. */
  readonly summary?: string | null;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  if (seenSearchTargetId !== searchTargetId) {
    setSeenSearchTargetId(searchTargetId);
    if (searchTargetId !== null && targetIds.includes(searchTargetId)) setOpen(true);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-1.5 rounded-b-xl px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-panel-open:rounded-none sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        Advanced
        {summary ? (
          <span className="min-w-0 truncate font-normal group-data-panel-open:hidden">
            {summary}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
          {children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
