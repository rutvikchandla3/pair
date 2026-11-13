import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  type SpaceActionTarget,
  type SpacePairFeedItem,
  type SpacePairReply,
  type SpacePairRoom,
  spaceActionView,
  spacePairStatusLine,
} from "@t3tools/client-runtime/spaceAgent";
import { type SpaceViewer, isSpaceTaskLineEntry } from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  ScopedThreadRef,
  Space,
  SpaceAction,
  SpaceRoomEntry,
  SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { PairMark } from "../../components/PairMark";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useNowAfter } from "../../lib/clock";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { reportSpaceResult, spaceAgentEnvironment } from "../../state/spaces";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { SpaceStatusUndoButton, SpaceTaskChip } from "./SpaceRecordLine";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(Date.parse(iso));

export interface SpacePairFeedContext {
  readonly environmentId: EnvironmentId;
  readonly roomRef: ScopedThreadRef;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly pairRoom: SpacePairRoom;
  /** The room's entries, for a status move's Undo. */
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly taskOf: (taskId: SpaceTaskId) => SpaceTask | null;
  readonly threadIdsOf: (taskId: SpaceTaskId) => ReadonlyArray<ThreadId>;
  readonly threadTitle: (threadId: ThreadId) => string | null;
  readonly onAskAgain: (text: string) => void;
}

const MUTED = "text-xs text-foreground-muted";

function ActionTarget(props: {
  readonly context: SpacePairFeedContext;
  readonly target: SpaceActionTarget | null;
  readonly title: string | null;
}) {
  const navigation = useNavigation();
  const { context, target } = props;
  if (target === null) {
    return props.title === null ? null : (
      <Text className="text-xs font-t3-medium text-foreground">{props.title}</Text>
    );
  }
  if (target.kind === "task") {
    const task = context.taskOf(target.taskId);
    return (
      <SpaceTaskChip
        environmentId={context.environmentId}
        spaceId={context.space.id}
        taskId={target.taskId}
        task={task ?? undefined}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        navigation.dispatch(
          StackActions.push("Thread", {
            environmentId: context.environmentId,
            threadId: target.threadId,
          }),
        )
      }
      className="active:opacity-70"
    >
      <Text className="text-xs font-t3-medium text-foreground-secondary underline">
        {props.title ?? context.threadTitle(target.threadId) ?? "a thread"}
      </Text>
    </Pressable>
  );
}

/** One record, receipt or confirm card; a card collapses to a line once answered. */
function SpaceActionRow(props: {
  readonly action: SpaceAction;
  readonly context: SpacePairFeedContext;
}) {
  const { action, context } = props;
  const run = useAtomCommand(spaceAgentEnvironment.action, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // A confirm card turns into "expired" when its deadline passes, without a refresh.
  const expiresAt = action.state === "proposed" ? action.proposal?.expiresAt : undefined;
  const now = useNowAfter(expiresAt === undefined ? null : Date.parse(expiresAt));
  const view = spaceActionView(action, {
    viewer: context.viewer,
    now,
    archived: context.space.archivedAt !== null,
    taskOf: (taskId) => {
      const task = context.taskOf(taskId);
      return task === null ? null : { task, threadIds: context.threadIdsOf(taskId) };
    },
  });
  const send = async (input: Parameters<typeof run>[0]["input"], label: string) => {
    setBusy(true);
    const result = await run({ environmentId: context.environmentId, input });
    setBusy(false);
    reportSpaceResult(label, result);
  };
  const time = <Text className={MUTED}>· {formatTime(action.updatedAt)}</Text>;
  const undoButton = (
    <Button
      label="Undo"
      tone="text"
      size="compact"
      disabled={busy}
      onPress={() => void send({ type: "undo", actionId: action.id }, "Could not undo")}
    />
  );

  switch (view.kind) {
    case "confirm":
      return (
        <View className="gap-2 rounded-2xl border border-border-subtle bg-card p-3">
          <View className="flex-row flex-wrap items-center gap-1">
            <ActionTarget
              context={context}
              target={{ kind: "thread", threadId: view.threadId }}
              title={view.title}
            />
            <Text className={MUTED}>· for {view.ownerName}</Text>
          </View>
          <Text className="text-base font-t3-medium text-foreground">
            Send this to {view.title}?
          </Text>
          <View className="border-l-2 border-border-subtle pl-2">
            <Text className="text-sm text-foreground-muted">{view.text}</Text>
          </View>
          <Text className={MUTED}>
            It waits behind the thread's current work and never interrupts it. Undo removes it while
            it's queued.{view.asAdmin ? " You can send it as a team admin." : ""}
          </Text>
          {view.canAnswer ? (
            <View className="flex-row flex-wrap items-center gap-2">
              <Button
                label="Send message"
                tone="primary"
                size="compact"
                disabled={busy}
                onPress={() =>
                  void send(
                    { type: "answer", actionId: action.id, answer: "confirm" },
                    "Could not send",
                  )
                }
              />
              <Button
                label="Cancel"
                size="compact"
                disabled={busy}
                onPress={() =>
                  void send(
                    { type: "answer", actionId: action.id, answer: "cancel" },
                    "Could not cancel",
                  )
                }
              />
              <Text className={MUTED}>Only you can answer this</Text>
            </View>
          ) : (
            <Text className={MUTED}>Waiting for {view.waitingFor}</Text>
          )}
        </View>
      );
    case "record":
      return (
        <View className="gap-0.5">
          <View className="flex-row flex-wrap items-center gap-x-1 gap-y-1">
            <Text className={MUTED}>{view.lead}</Text>
            <ActionTarget context={context} target={view.target} title={view.title} />
            <Text className={MUTED}>{view.detail}</Text>
            {time}
            {view.canUndo ? undoButton : null}
            {view.statusEntryId === null ? null : (
              <StatusMoveUndo context={context} entryId={view.statusEntryId} />
            )}
          </View>
          {view.quote === null ? null : (
            <View className="border-l-2 border-border-subtle pl-2">
              <Text numberOfLines={2} className={MUTED}>
                {view.quote}
              </Text>
            </View>
          )}
        </View>
      );
    case "receipt":
      return (
        <View className="gap-0.5">
          {view.lines.map((line) => (
            <Text key={line} className={MUTED}>
              {line}
            </Text>
          ))}
          <View className="flex-row flex-wrap items-center gap-x-1">
            <Text className={MUTED}>{view.detail}</Text>
            {time}
            {view.canUndo ? undoButton : null}
          </View>
        </View>
      );
    case "closed": {
      const askAgain = view.askAgain;
      return (
        <View className="flex-row flex-wrap items-center gap-x-1 gap-y-1">
          <ActionTarget context={context} target={view.target} title={view.title} />
          <Text className={MUTED}>{view.text}</Text>
          {time}
          {askAgain === null ? null : (
            <Button
              label="Ask again"
              tone="text"
              size="compact"
              onPress={() => context.onAskAgain(askAgain)}
            />
          )}
        </View>
      );
    }
  }
}

/** Pair's status move: Undo through its `task-status` line, like an agent's. */
function StatusMoveUndo(props: {
  readonly context: SpacePairFeedContext;
  readonly entryId: string;
}) {
  const { context } = props;
  const entry = context.entries.find((candidate) => candidate.id === props.entryId);
  if (entry === undefined || entry.type !== "system" || !isSpaceTaskLineEntry(entry)) return null;
  return (
    <SpaceStatusUndoButton
      environmentId={context.environmentId}
      space={context.space}
      entry={entry}
      task={context.taskOf(entry.line.taskId)}
      entries={context.entries}
      viewer={context.viewer}
    />
  );
}

function SpacePairText(props: { readonly roomRef: ScopedThreadRef; readonly itemId: string }) {
  const text = useAtomValue(
    environmentThreadDetails.assistantMessageTextAtom(props.roomRef, props.itemId),
  );
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  if (text === null || text.length === 0) return null;
  return (
    <SelectableMarkdownText
      markdown={text}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(href) => void openLink(href)}
    />
  );
}

/** Pair's reply: its streamed text, then the records of what it did. */
export function SpacePairFeedRow(props: {
  readonly item: SpacePairFeedItem;
  readonly context: SpacePairFeedContext;
}) {
  const { item, context } = props;
  const reply = item.reply;
  return (
    <View className="flex-row gap-3 px-4 pt-3 pb-0.5">
      <View className="size-8 items-center justify-center rounded-full bg-subtle">
        <PairMark size={16} />
      </View>
      <View className="min-w-0 flex-1 gap-1.5">
        <View className="flex-row flex-wrap items-baseline gap-x-2">
          <Text className="text-sm font-t3-medium text-foreground">Pair</Text>
          <Text className={MUTED}>agent</Text>
          {reply?.taggerId == null ? null : (
            <Text className={MUTED}>
              replying to{" "}
              {reply.taggerId === context.viewer.memberId
                ? "you"
                : context.viewer.nameOf(reply.taggerId)}
            </Text>
          )}
          <Text className={MUTED}>{formatTime(item.createdAt)}</Text>
        </View>
        {reply === null
          ? null
          : reply.textItemIds.map((itemId) => (
              <SpacePairText key={itemId} roomRef={context.roomRef} itemId={itemId} />
            ))}
        {item.actions.map((action) => (
          <SpaceActionRow key={action.id} action={action} context={context} />
        ))}
      </View>
    </View>
  );
}

/** Under a post that tagged `@pair`: queued, replying, failed, stopped or cancelled. */
export function SpacePairStatus(props: {
  readonly reply: SpacePairReply | undefined;
  readonly context: SpacePairFeedContext;
}) {
  const { context, reply } = props;
  const control = useAtomCommand(spaceAgentEnvironment.reply, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const line = spacePairStatusLine(
    reply,
    context.pairRoom,
    context.space,
    context.viewer,
    formatTime,
  );
  if (line === null || reply === undefined) return null;
  const act = async (action: "cancel" | "stop" | "retry") => {
    setBusy(true);
    const result = await control({
      environmentId: context.environmentId,
      input: { spaceId: context.space.id, runId: reply.runId, action },
    });
    setBusy(false);
    reportSpaceResult(
      action === "retry"
        ? "Could not retry"
        : action === "stop"
          ? "Could not stop"
          : "Could not cancel",
      result,
    );
  };
  const lineControl = line.control;
  return (
    <View className="flex-row flex-wrap items-center gap-x-1">
      <Text
        className={cn(
          "text-xs",
          line.tone === "error" ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {line.text}
      </Text>
      {lineControl === null ? null : (
        <Button
          label={lineControl === "retry" ? "Retry" : lineControl === "stop" ? "Stop" : "Cancel"}
          tone="text"
          size="compact"
          disabled={busy}
          onPress={() => void act(lineControl)}
        />
      )}
    </View>
  );
}
