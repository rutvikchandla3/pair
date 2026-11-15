import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type LineageNoticeAction,
  type LineageNoticeCopy,
  type LineageViewer,
  type OfferCardButtonKind,
  lineageHolderOf,
  lineageNoticeCopy,
  offerCardCopy,
} from "@t3tools/client-runtime/branch-lineage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  LineageNotice,
  LineageView,
  Offer,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useLineageView, useLineageViewer } from "../../state/branch-lineage";
import { useQuietThreadShell } from "../../state/entities";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { DiffCounts } from "./OfferChangesSheet";
import { useLineageActions } from "./useLineageActions";

const TONE_TEXT: Readonly<Record<LineageNoticeCopy["tone"], string>> = {
  muted: "text-foreground-muted",
  success: "text-adaptive-emerald-600-400",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
};

/**
 * A lineage `system_notice` in the timeline: a quiet one-liner with its action link, or in a
 * source, the offer card. Without a team viewer it reads the server's own `message`.
 */
export function ThreadLineageNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly notice: LineageNotice;
  readonly message: string;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(ref);
  const viewer = useLineageViewer(props.environmentId);
  const view = useLineageView(ref);
  if (shell === null || viewer === null) {
    return <NoticeLine text={props.message} tone="muted" />;
  }
  const copy = lineageNoticeCopy(props.notice, { viewer, thread: shell.source, view });
  const offer =
    copy.cardOfferId === null
      ? null
      : (view?.offers.find((candidate) => candidate.id === copy.cardOfferId) ?? null);
  if (offer !== null && view !== null) {
    return <OfferCard threadRef={ref} shell={shell} viewer={viewer} view={view} offer={offer} />;
  }
  return <NoticeRow threadRef={ref} copy={copy} />;
}

function NoticeRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly copy: LineageNoticeCopy;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const actions = useLineageActions();
  const { copy, threadRef } = props;
  const run = (action: LineageNoticeAction) => {
    switch (action.kind) {
      case "undoUpdate":
        return void actions.undoUpdate(threadRef);
      case "abortUpdate":
        return void actions.abortUpdate(threadRef);
      case "bringBack":
        return void actions.bringBack(threadRef);
      case "offerAgain":
        return actions.open("ThreadOffer", threadRef);
      case "updateAndOfferAgain":
        return actions.open("ThreadUpdate", threadRef);
      case "withdraw":
        if (action.offerId !== null) void actions.withdraw(threadRef, action.offerId);
        return;
      case "revertOffer":
        if (action.offerId !== null) actions.revertOffer(threadRef, action.offerId, action.label);
        return;
    }
  };
  const linked = copy.threadId;
  const action = copy.action;
  return (
    <NoticeLine
      text={copy.text}
      tone={copy.tone}
      detail={copy.detail}
      onPressText={
        linked === null
          ? undefined
          : () =>
              openLinkedThread({
                environmentId: String(threadRef.environmentId),
                threadId: String(linked),
              })
      }
      action={action === null ? null : { ...action, onPress: () => run(action) }}
    />
  );
}

function NoticeLine(props: {
  readonly text: string;
  readonly tone: LineageNoticeCopy["tone"];
  readonly detail?: string | null;
  readonly onPressText?: (() => void) | undefined;
  readonly action?: (LineageNoticeAction & { readonly onPress: () => void }) | null;
}) {
  const body = (
    <Text className={cn("text-xs", TONE_TEXT[props.tone])}>
      {props.text}
      {props.detail ? <Text className="text-foreground-muted"> · {props.detail}</Text> : null}
    </Text>
  );
  return (
    <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 py-2">
      <SymbolView name="arrow.triangle.branch" size={12} tintColorClassName="accent-icon-muted" />
      {props.onPressText === undefined ? (
        <View className="shrink">{body}</View>
      ) : (
        <Pressable accessibilityRole="link" className="shrink" onPress={props.onPressText}>
          {body}
        </Pressable>
      )}
      {props.action ? (
        <Text className="text-xs text-foreground-muted">
          ·{" "}
          <Text
            accessibilityRole="button"
            className="font-t3-medium text-primary-text"
            onPress={props.action.onPress}
          >
            {props.action.label}
          </Text>
          {props.action.hint ? ` ${props.action.hint}` : ""}
        </Text>
      ) : null}
    </View>
  );
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** An offer in its source: Apply or Decline for the holder, View changes for everyone. */
function OfferCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly viewer: LineageViewer;
  readonly view: LineageView;
  readonly offer: Offer;
}) {
  const { offer, threadRef } = props;
  const actions = useLineageActions();
  const openLinkedThread = useOpenLinkedThread();
  const [busy, setBusy] = useState<string | null>(null);
  const branchTitle =
    props.view.branches.find((branch) => branch.threadId === offer.branchThreadId)?.title ?? null;
  const copy = offerCardCopy(offer, {
    viewer: props.viewer,
    sourceHolderId: lineageHolderOf(props.shell.source, props.viewer),
    sourceRunning: props.shell.source.activeRunId !== null,
    branchTitle,
    sourceTitle: props.shell.title,
  });
  const openBranch = () =>
    openLinkedThread({
      environmentId: String(threadRef.environmentId),
      threadId: String(offer.branchThreadId),
    });
  if (copy.state === "closed") {
    return <NoticeLine text={copy.line} tone="muted" onPressText={openBranch} />;
  }
  const press = (kind: OfferCardButtonKind) => {
    if (kind === "viewChanges") return actions.openOfferChanges(threadRef, offer.id);
    const run =
      kind === "apply" ? actions.apply : kind === "decline" ? actions.decline : actions.withdraw;
    setBusy(kind);
    void run(threadRef, offer.id).finally(() => setBusy(null));
  };
  return (
    <View className="my-2 gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
      <View className="flex-row items-start gap-2.5">
        <View className="pt-0.5">
          <SymbolView
            name="arrow.triangle.branch"
            size={15}
            tintColorClassName="accent-adaptive-indigo-600-300"
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-start gap-2">
            <Text className="min-w-0 flex-1 text-sm text-foreground">
              <Text className="font-t3-bold">{copy.sender}</Text>
              {copy.header.slice(copy.sender.length).split(" from ")[0]}
              {copy.updated ? <Text className="text-foreground-muted"> · updated</Text> : null}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {TIME_FORMAT.format(Date.parse(offer.updatedAt))}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            <Text accessibilityRole="link" onPress={openBranch}>
              from {branchTitle ?? "a thread you can't open"}
            </Text>
            {" · "}
            {copy.summary} <DiffCounts additions={offer.additions} deletions={offer.deletions} />
          </Text>
        </View>
      </View>
      {copy.note !== null ? <Text className="text-sm text-foreground">“{copy.note}”</Text> : null}
      <View className="flex-row items-center gap-1.5">
        {copy.check.tone === "success" ? (
          <SymbolView
            name="checkmark"
            size={11}
            tintColorClassName="accent-adaptive-emerald-600-400"
          />
        ) : null}
        <Text
          className={cn(
            "shrink text-xs",
            copy.check.tone === "success"
              ? "text-adaptive-emerald-600-400"
              : "text-foreground-muted",
          )}
        >
          {copy.check.text}
        </Text>
      </View>
      {copy.explainer !== null ? (
        <Text className="text-xs text-foreground-muted">{copy.explainer}</Text>
      ) : null}
      {copy.waitingFor !== null ? (
        <Text className="text-xs text-foreground-muted">{copy.waitingFor}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {copy.buttons.map((button) => (
          <Button
            key={button.kind}
            label={button.label}
            tone={button.primary ? "primary" : button.kind === "decline" ? "text" : "secondary"}
            size="compact"
            loading={busy === button.kind}
            disabled={busy !== null}
            onPress={() => press(button.kind)}
          />
        ))}
      </View>
    </View>
  );
}
