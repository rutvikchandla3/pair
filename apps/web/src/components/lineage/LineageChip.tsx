import {
  gitButtonLineageWarning,
  type LineageAction,
  type LineageChipCopy,
  lineageChipCopy,
  lineagePopoverRows,
} from "@t3tools/client-runtime/branch-lineage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  GitCompareArrowsIcon,
} from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { useLineageBranchCount, useLineageView, useLineageViewer } from "~/state/branchLineage";
import { useTeamMembers } from "~/state/team";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useLineageActions } from "./useLineageActions";

/** G1's draft route; the path is built here so this compiles before the route exists. */
function branchOffPath(ref: ScopedThreadRef): string {
  return `/${encodeURIComponent(ref.environmentId)}/branch-off/${encodeURIComponent(ref.threadId)}`;
}

/** The chip's copy for a thread, or null when it has no lineage the viewer can see. */
export function useLineageChip(ref: ScopedThreadRef | null): LineageChipCopy | null {
  const shell = useQuietThreadShell(ref);
  const branches = useLineageBranchCount(ref);
  const viewer = useLineageViewer(ref?.environmentId ?? null);
  if (ref === null || shell === null) return null;
  return lineageChipCopy(shell.source, Array.from({ length: branches }), viewer);
}

const ACTION_ICON = {
  update: ArrowDownToLineIcon,
  offer: GitCompareArrowsIcon,
  branchOff: GitBranchPlusIcon,
  startFromMain: null,
  settle: null,
} as const;

function useRunLineageAction(ref: ScopedThreadRef) {
  const actions = useLineageActions();
  const { settleThread } = useThreadActions();
  const router = useRouter();
  return (action: LineageAction) => {
    switch (action.kind) {
      case "update":
        return void actions.startUpdate(ref);
      case "offer":
        return actions.openOffer(ref);
      case "branchOff":
        return router.history.push(branchOffPath(ref));
      case "startFromMain":
        return void actions.startFromMain(ref);
      case "settle":
        return void settleThread(ref).then((result) =>
          toastCommandFailure("Failed to settle thread", result),
        );
    }
  };
}

/** The header meta line's ⑂ chip, its popover, and a shipped or settled branch's way out. */
export function LineageChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const chip = useLineageChip(threadRef);
  const runAction = useRunLineageAction(threadRef);
  const [open, setOpen] = useState(false);
  if (chip === null) return null;
  // Shipped, settled and all-applied branches show their way out beside the chip.
  const inline = chip.actions.filter(
    (action) => action.kind === "startFromMain" || action.kind === "settle",
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-lineage-chip={chip.role}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Badge variant="outline" size="sm" render={<button type="button" />} />}
          aria-label={`Lineage: ${chip.text}`}
          className="min-w-0 cursor-pointer"
        >
          <GitBranchIcon
            aria-hidden
            data-accent={chip.accent ? "true" : undefined}
            className={cn(chip.accent && "text-info-foreground")}
          />
          <span className="truncate">{chip.text}</span>
          <ChevronDownIcon aria-hidden className="opacity-60" />
        </PopoverTrigger>
        <PopoverPopup align="start" padding="compact" width="lg">
          {open ? (
            <LineagePopoverBody
              threadRef={threadRef}
              chip={chip}
              onAction={(action) => {
                setOpen(false);
                runAction(action);
              }}
              onNavigate={() => setOpen(false)}
            />
          ) : null}
        </PopoverPopup>
      </Popover>
      {inline.map((action) => (
        <Button key={action.kind} size="xs" variant="ghost-muted" onClick={() => runAction(action)}>
          {action.label}
        </Button>
      ))}
    </span>
  );
}

function LineagePopoverBody({
  threadRef,
  chip,
  onAction,
  onNavigate,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly chip: LineageChipCopy;
  readonly onAction: (action: LineageAction) => void;
  readonly onNavigate: () => void;
}) {
  const view = useLineageView(threadRef);
  const viewer = useLineageViewer(threadRef.environmentId);
  const members = useTeamMembers(threadRef.environmentId);
  const shells = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(threadRef.environmentId),
  );
  const navigate = useNavigate();
  const popover = view === null ? null : lineagePopoverRows(view, shells, viewer);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="px-1 text-muted-foreground">{popover?.heading ?? "Loading…"}</p>
      {popover?.rows.map((row) => {
        const member = row.ownerId === null ? undefined : members.get(row.ownerId);
        const canGo = row.canOpen && !row.isThisThread;
        const body = (
          <>
            {member === undefined ? (
              <span aria-hidden className="size-5 shrink-0" />
            ) : (
              <MemberAvatar member={member} size="sm" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate font-medium text-foreground">{row.title}</span>
                {row.isThisThread ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">this thread</span>
                ) : null}
              </span>
              <span className="truncate text-muted-foreground">
                {[row.meta, row.where].filter((part) => part !== null && part !== "").join(" · ")}
              </span>
            </span>
            {row.counts === null ? null : (
              <span className="shrink-0 text-muted-foreground">{row.counts}</span>
            )}
          </>
        );
        const rowClass = cn(
          "flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-start",
          row.role === "branch" && "ps-4",
          row.isThisThread && "bg-accent/60",
        );
        return canGo ? (
          <button
            key={row.threadId}
            type="button"
            className={cn(rowClass, "cursor-pointer hover:bg-accent")}
            onClick={() => {
              onNavigate();
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(threadRef.environmentId, row.threadId),
                ),
              });
            }}
          >
            {body}
          </button>
        ) : (
          <div key={row.threadId} className={rowClass}>
            {body}
          </div>
        );
      })}
      {chip.actions.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1.5 border-t px-1 pt-2">
          {chip.actions.map((action) => {
            const Icon = ACTION_ICON[action.kind];
            return (
              <Button
                key={action.kind}
                size="xs"
                variant={action.kind === "offer" ? "secondary" : "outline"}
                onClick={() => onAction(action)}
              >
                {Icon === null ? null : <Icon aria-hidden />}
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** A branch with commits to offer gets one header button: Offer to Kousik. */
export function LineageOfferButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const chip = useLineageChip(threadRef);
  const actions = useLineageActions();
  const offer = chip?.actions.find((action) => action.kind === "offer");
  if (offer === undefined) return null;
  return (
    <Button size="xs" variant="secondary" onClick={() => actions.openOffer(threadRef)}>
      <GitCompareArrowsIcon aria-hidden />
      {offer.label}
    </Button>
  );
}

/** In a branch the git button leads with Offer, and Push and Create PR sit behind a warning. */
export function useLineageGitLead(threadRef: ScopedThreadRef | null) {
  const chip = useLineageChip(threadRef);
  const shell = useQuietThreadShell(threadRef);
  const viewer = useLineageViewer(threadRef?.environmentId ?? null);
  if (threadRef === null || shell === null) return null;
  const warning = gitButtonLineageWarning(shell.source, viewer);
  const offer = chip?.actions.find((action) => action.kind === "offer") ?? null;
  const count = shell.source.branchLink?.source?.toOffer ?? 0;
  if (warning === null && offer === null) return null;
  return {
    offer:
      offer === null
        ? null
        : { label: offer.label, detail: `${count} ${count === 1 ? "commit" : "commits"}` },
    warning,
  };
}
