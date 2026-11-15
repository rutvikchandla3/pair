import {
  type LineageNoticeAction,
  type LineageNoticeCopy,
  lineageHolderOf,
  lineageNoticeCopy,
  offerCardCopy,
} from "@t3tools/client-runtime/branch-lineage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  LineageNotice,
  Offer,
  OfferId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowDownToLineIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  type LucideIcon,
  RotateCcwIcon,
  ServerIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
import { useLineageView, useLineageViewer } from "~/state/branchLineage";
import { useTeamMembers } from "~/state/team";
import { formatShortTimestamp } from "~/timestampFormat";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { MemberAvatar } from "../team/MemberAvatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useLineageActions } from "./useLineageActions";

const NOTICE_ICON: Record<LineageNotice["kind"], LucideIcon> = {
  "branched-off": GitBranchIcon,
  "branched-from": GitBranchIcon,
  updated: ArrowDownToLineIcon,
  "update-conflict": CircleAlertIcon,
  "update-aborted": Undo2Icon,
  "update-undone": Undo2Icon,
  "agent-told": FileTextIcon,
  offer: GitCompareArrowsIcon,
  "offer-sent": GitCompareArrowsIcon,
  applied: CheckIcon,
  declined: XIcon,
  withdrawn: XIcon,
  returned: CircleAlertIcon,
  reverted: RotateCcwIcon,
  "credited-commit": CheckIcon,
  "reverted-kept": RotateCcwIcon,
  "reverted-removed": RotateCcwIcon,
  "brought-back": RotateCcwIcon,
  "moved-machine": ServerIcon,
};

const TONE_CLASS: Record<LineageNoticeCopy["tone"], string> = {
  muted: "",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive",
};

/** View changes on an offer: the thread's Changes panel, scoped to the offer's own lines. */
function openOfferChanges(threadRef: ScopedThreadRef, offerId: OfferId): void {
  const diffOpen =
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "diff";
  useDiffPanelStore.getState().selectOffer(threadRef, offerId, !diffOpen);
  useRightPanelStore.getState().open(threadRef, "diff");
}

/** A `system_notice` with a lineage: one quiet row, or an offer's card in its source. */
export function LineageTimelineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly notice: LineageNotice;
  readonly createdAt: string;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(threadRef);
  const view = useLineageView(threadRef);
  const viewer = useLineageViewer(props.environmentId);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (shell === null) return null;
  const copy = lineageNoticeCopy(props.notice, { viewer, thread: shell.source, view });
  const time = formatShortTimestamp(props.createdAt, timestampFormat);
  const offer =
    copy.cardOfferId === null
      ? null
      : (view?.offers.find((candidate) => candidate.id === copy.cardOfferId) ?? null);
  if (offer !== null) {
    const card = offerCardCopy(offer, {
      viewer,
      sourceHolderId: lineageHolderOf(shell.source, viewer),
      sourceRunning: shell.source.activeRunId !== null,
      branchTitle:
        view?.branches.find((branch) => branch.threadId === offer.branchThreadId)?.title ?? null,
      sourceTitle: shell.title,
    });
    if (card.state === "open") {
      return <OfferCard threadRef={threadRef} offer={offer} card={card} time={time} />;
    }
    return (
      <LineageQuietRow
        threadRef={threadRef}
        kind={props.notice.kind}
        text={card.line}
        detail={null}
        tone="muted"
        time={time}
        action={null}
      />
    );
  }
  return (
    <LineageQuietRow
      threadRef={threadRef}
      kind={props.notice.kind}
      text={copy.text}
      detail={copy.detail}
      tone={copy.tone}
      time={time}
      action={copy.action}
    />
  );
}

function LineageQuietRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly kind: LineageNotice["kind"];
  readonly text: string;
  readonly detail: string | null;
  readonly tone: LineageNoticeCopy["tone"];
  readonly time: string;
  readonly action: LineageNoticeAction | null;
}) {
  const actions = useLineageActions();
  const Icon = NOTICE_ICON[props.kind];
  const { threadRef, action } = props;
  const run = (current: LineageNoticeAction) => {
    const offerId = current.offerId;
    switch (current.kind) {
      case "undoUpdate":
        return void actions.undoUpdate(threadRef);
      case "abortUpdate":
        return void actions.abortUpdate(threadRef);
      case "bringBack":
        return void actions.bringBack(threadRef);
      case "offerAgain":
        return actions.openOffer(threadRef);
      case "updateAndOfferAgain":
        return void actions.startUpdate(threadRef).then((merged) => {
          if (merged) actions.openOffer(threadRef);
        });
      case "withdraw":
        if (offerId !== null) void actions.withdraw(threadRef.environmentId, offerId);
        return;
      case "revertOffer":
        if (offerId !== null) void actions.revertOffer(threadRef.environmentId, offerId);
        return;
    }
  };
  return (
    <div
      data-lineage-row={props.kind}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1 text-xs text-muted-foreground"
    >
      <Icon aria-hidden className={cn("size-3 shrink-0", TONE_CLASS[props.tone])} />
      <span className={cn("min-w-0", props.tone === "error" && "text-destructive")}>
        {props.text}
      </span>
      {[props.detail, props.time]
        .filter((part) => part !== null && part !== "")
        .map((part) => (
          <span key={part} className="opacity-80">
            · {part}
          </span>
        ))}
      {action === null ? null : (
        <>
          <span aria-hidden>·</span>
          <Button size="xs" variant="link" onClick={() => run(action)}>
            {action.label}
          </Button>
          {action.hint === null ? null : <span className="opacity-80">{action.hint}</span>}
        </>
      )}
    </div>
  );
}

type OpenOfferCard = Extract<ReturnType<typeof offerCardCopy>, { state: "open" }>;

function OfferCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly offer: Offer;
  readonly card: OpenOfferCard;
  readonly time: string;
}) {
  const { threadRef, offer, card } = props;
  const members = useTeamMembers(threadRef.environmentId);
  const actions = useLineageActions();
  const sender = members.get(offer.senderId);
  const press = (kind: OpenOfferCard["buttons"][number]["kind"]) => {
    switch (kind) {
      case "apply":
        return void actions.apply(threadRef.environmentId, offer.id);
      case "decline":
        return void actions.decline(threadRef.environmentId, offer.id);
      case "withdraw":
        return void actions.withdraw(threadRef.environmentId, offer.id);
      case "viewChanges":
        return openOfferChanges(threadRef, offer.id);
    }
  };
  const viewChanges = card.buttons.find((button) => button.kind === "viewChanges");
  return (
    <section
      aria-label={card.header}
      data-offer-card={offer.id}
      className="my-2 flex flex-col gap-2 rounded-xl border border-info/40 bg-card p-3 text-sm"
    >
      <header className="flex min-w-0 items-center gap-2">
        <GitCompareArrowsIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />
        {sender === undefined ? null : <MemberAvatar member={sender} size="sm" />}
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{card.sender}</span>
          {card.header.slice(card.sender.length)}
        </span>
        {card.updated ? (
          <Badge variant="info" size="sm">
            updated
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">{props.time}</span>
      </header>
      {card.note === null ? null : <p className="whitespace-pre-wrap">“{card.note}”</p>}
      <ul className="flex flex-col gap-1">
        {offer.commits.map((commit) => (
          <li key={commit.sha} className="flex min-w-0 items-center gap-2">
            {sender === undefined ? null : <MemberAvatar member={sender} size="sm" />}
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {commit.sha.slice(0, 7)}
            </span>
            <span className="truncate">{commit.subject}</span>
          </li>
        ))}
      </ul>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {card.summary}
        <DiffStatLabel layout="inline" additions={offer.additions} deletions={offer.deletions} />
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          card.check.tone === "success" ? "text-success-foreground" : "text-muted-foreground",
        )}
      >
        {card.check.tone === "success" ? (
          <CheckIcon aria-hidden className="size-3" />
        ) : (
          <ClockIcon aria-hidden className="size-3" />
        )}
        {card.check.text}
      </span>
      {card.explainer === null ? null : (
        <p className="text-xs text-muted-foreground">{card.explainer}</p>
      )}
      {card.waitingFor === null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {card.buttons.map((button) => (
            <Button
              key={button.kind}
              size="xs"
              variant={button.primary ? "default" : button.kind === "decline" ? "ghost" : "outline"}
              onClick={() => press(button.kind)}
            >
              {button.kind === "apply" ? <GitCompareArrowsIcon aria-hidden /> : null}
              {button.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon aria-hidden className="size-3" />
          <span className="flex-1">{card.waitingFor}</span>
          {card.buttons
            .filter((button) => button !== viewChanges)
            .map((button) => (
              <Button
                key={button.kind}
                size="xs"
                variant="ghost"
                onClick={() => press(button.kind)}
              >
                {button.label}
              </Button>
            ))}
          {viewChanges === undefined ? null : (
            <Button size="xs" variant="ghost" onClick={() => press("viewChanges")}>
              {viewChanges.label}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
