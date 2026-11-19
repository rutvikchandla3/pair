import { StackActions, useNavigation } from "@react-navigation/native";
import type { Bot, BotSession, BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { FlatList, Platform, Pressable, View, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ENVIRONMENT_MACHINE_SYMBOLS,
  EnvironmentMachineSymbol,
} from "../../components/EnvironmentMachineSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { retryBotsSnapshot, useBotsCommands, useBotsEnvironments } from "../../state/bots";
import { startOpeningEnvironmentThread } from "../../state/threads";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BotAvatar } from "./BotAvatar";
import {
  type BotsEnvironmentEntry,
  type BotSessionBucket,
  type BotSessionRow,
  botsScreenModel,
  botStatusLine,
  botSessionRows,
  needsYouCount,
} from "./botsModel";
import { useBotSessionStates } from "./useBotSessions";

type BotsListRow =
  | { readonly kind: "header"; readonly entry: BotsEnvironmentEntry }
  | {
      readonly kind: "bot";
      readonly entry: BotsEnvironmentEntry;
      readonly snapshot: BotsSnapshot;
      readonly bot: Bot;
    };

/** The Bots workspace tab: every linked server's bots, each with its sessions nested under it. */
export function BotsScreen() {
  const { catalogReady, entries } = useBotsEnvironments();
  const model = botsScreenModel(entries, catalogReady);
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const navigation = useNavigation();
  const { create } = useBotsCommands();
  // UIKit insets the list by its column's safe area, which this context can report as 0.
  const columnSafeBottom = useNativeColumnLayoutMetrics()?.safeArea.bottom;
  const bottomSafeArea =
    Platform.OS === "ios" ? (columnSafeBottom ?? insets.bottom) : insets.bottom;
  const listBottomPadding =
    Math.max(bottomSafeArea, workspace?.bottomClearance ?? insets.bottom) +
    24 -
    (Platform.OS === "ios" ? bottomSafeArea : 0);

  const createBot = async (environmentId: EnvironmentId) => {
    const result = await create({
      environmentId,
      input: { charter: "", starter: "default" },
    });
    if (result._tag !== "Success") {
      Dialog.alert("Could not create the bot", "Try again.");
      return;
    }
    navigation.dispatch(
      StackActions.push("BotHome", {
        environmentId: String(environmentId),
        botId: result.value.id,
      }),
    );
  };

  const openBot = (environmentId: EnvironmentId, bot: Bot) => {
    if (bot.homeThreadId === null) {
      navigation.dispatch(
        StackActions.push("BotHome", { environmentId: String(environmentId), botId: bot.id }),
      );
      return;
    }
    startOpeningEnvironmentThread(environmentId, bot.homeThreadId);
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: bot.homeThreadId }));
  };

  const openSession = (environmentId: EnvironmentId, session: BotSession) => {
    const sessionEnvironmentId = session.cloud?.environmentId ?? environmentId;
    startOpeningEnvironmentThread(sessionEnvironmentId, session.threadId);
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: sessionEnvironmentId,
        threadId: session.threadId,
      }),
    );
  };

  if (model.view === "spinner") {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }

  const rows = model.groups.flatMap((group): BotsListRow[] => {
    const { entry } = group;
    const header: BotsListRow[] = group.showHeader ? [{ kind: "header", entry }] : [];
    const snapshot = entry.snapshot;
    if (snapshot === null) return header;
    return [
      ...header,
      ...group.bots.map((bot) => ({ kind: "bot" as const, entry, snapshot, bot })),
    ];
  });
  const newBotButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New bot"
      accessibilityState={{ disabled: model.createMode === "none" }}
      disabled={model.createMode === "none"}
      onPress={
        model.createMode === "direct"
          ? () => void createBot(model.createTargets[0]!.environmentId)
          : undefined
      }
      className={
        model.createMode === "none"
          ? "size-10 items-center justify-center opacity-40"
          : "size-10 items-center justify-center active:opacity-60"
      }
    >
      <SymbolView name="plus" size={20} tintColorClassName="accent-primary-text" />
    </Pressable>
  );

  const titleRow = (
    <View className="flex-row items-center justify-between px-4 pt-3 pb-2">
      <Text className="text-2xl font-t3-bold text-foreground">Bots</Text>
      {model.createMode === "menu" ? (
        <Menu
          actions={model.createTargets.map((target) => ({
            id: target.environmentId,
            title: target.label,
            image: ENVIRONMENT_MACHINE_SYMBOLS[target.machineKind],
          }))}
          onPressAction={({ nativeEvent }) => {
            const target = model.createTargets.find(
              (candidate) => candidate.environmentId === nativeEvent.event,
            );
            if (target !== undefined) void createBot(target.environmentId);
          }}
        >
          {newBotButton}
        </Menu>
      ) : (
        newBotButton
      )}
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      <FlatList
        data={rows}
        keyExtractor={(row) =>
          row.kind === "header"
            ? `header:${row.entry.environmentId}`
            : `bot:${row.entry.environmentId}:${row.bot.id}`
        }
        renderScrollComponent={Platform.OS === "ios" ? renderBotsScrollView : undefined}
        // The workspace header is transparent on iOS; UIKit insets the list below it.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingBottom: listBottomPadding }}
        ListHeaderComponent={titleRow}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center p-8">
            <Text className="text-center text-sm text-foreground-muted">
              Tap + to start your first bot.
            </Text>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <EnvironmentHeader entry={item.entry} />
          ) : (
            <BotSection
              environmentId={item.entry.environmentId}
              bot={item.bot}
              snapshot={item.snapshot}
              canArchive={item.entry.canArchive}
              onOpenBot={() => openBot(item.entry.environmentId, item.bot)}
              onOpenSession={(session) => openSession(item.entry.environmentId, session)}
            />
          )
        }
      />
    </View>
  );
}

function renderBotsScrollView(props: ScrollViewProps) {
  // UIKit's scroll-edge material under the header takes the scroll view's own color.
  return <NativeScrollView {...props} className="bg-screen" />;
}

/** Names the server a group of bots lives on, and says when its bots can't be shown. */
function EnvironmentHeader(props: { readonly entry: BotsEnvironmentEntry }) {
  const { entry } = props;
  const label = (
    <>
      <EnvironmentMachineSymbol
        kind={entry.machineKind}
        size={13}
        tintColorClassName="accent-icon-muted"
      />
      <Text numberOfLines={1} className="shrink text-sm text-foreground-muted">
        {entry.label}
      </Text>
    </>
  );
  if (entry.status === "failed") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.label}, Couldn't load bots`}
        accessibilityHint="Double-tap to retry"
        onPress={() => retryBotsSnapshot(entry.environmentId)}
        className="min-h-10 flex-row items-center gap-1.5 px-4 pt-4 pb-1 active:opacity-70"
      >
        {label}
        <ConnectionStatusDot state="error" pulse={false} size={6} />
        <Text numberOfLines={1} className="shrink text-sm text-foreground-muted">
          Couldn't load bots. Tap to retry.
        </Text>
      </Pressable>
    );
  }
  const offline = entry.status === "offline";
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={offline ? `${entry.label}, Offline` : entry.label}
      className="min-h-10 flex-row items-center gap-1.5 px-4 pt-4 pb-1"
    >
      {label}
      {offline ? <Text className="text-sm text-foreground-muted">Offline</Text> : null}
    </View>
  );
}

function BotSection(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
  readonly canArchive: boolean;
  readonly onOpenBot: () => void;
  readonly onOpenSession: (session: BotSession) => void;
}) {
  const { environmentId, bot, snapshot } = props;
  const nowMs = useNowMinuteMs();
  const jobs = snapshot.jobs.filter((job) => job.botId === bot.id);
  const asks = snapshot.asks.filter((ask) => ask.botId === bot.id);
  const sessions = snapshot.sessions.filter((session) => session.botId === bot.id);
  const states = useBotSessionStates({ environmentId, sessions, jobs, botName: bot.name, nowMs });
  const status = botStatusLine({ bot, asks, jobs, sessions, sessionStates: states });
  const { rows, earlier, archived } = botSessionRows({ sessions, states, jobs, asks, nowMs });
  const [expanded, setExpanded] = useState(false);
  const { archiveJob } = useBotsCommands();
  const setArchived = async (row: BotSessionRow, value: boolean) => {
    const result = await archiveJob({
      environmentId,
      input: { jobId: row.session.jobId, archived: value },
    });
    if (result._tag === "Failure") {
      Dialog.alert(
        value ? "Could not archive the job" : "Could not unarchive the job",
        "Try again.",
      );
    }
  };
  const renderRow = (row: BotSessionRow, isArchived: boolean) => (
    <SessionRow
      key={row.session.threadId}
      row={row}
      nowMs={nowMs}
      archived={isArchived}
      canArchive={props.canArchive}
      onOpen={() => props.onOpenSession(row.session)}
      onArchive={(value) => void setArchived(row, value)}
    />
  );
  const needsYou = needsYouCount(asks);
  const role = bot.charter.trim();
  const subtitle = status.tone === "idle" && role !== "" ? role : status.text;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${bot.name}, ${subtitle}`}
        onPress={props.onOpenBot}
        className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
      >
        <BotAvatar bot={bot} size={36} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base font-t3-bold text-foreground">
            {bot.name}
          </Text>
          <Text
            numberOfLines={1}
            className={
              status.tone === "input"
                ? "text-sm font-t3-medium text-primary-text"
                : "text-sm text-foreground-muted"
            }
          >
            {subtitle}
          </Text>
        </View>
        {needsYou > 0 ? (
          <View className="items-center justify-center rounded-full bg-primary px-2 py-0.5">
            <Text className="text-xs font-t3-medium text-primary-foreground">{needsYou}</Text>
          </View>
        ) : null}
      </Pressable>
      {rows.map((row) => renderRow(row, false))}
      {earlier.length === 0 && archived.length === 0 ? null : (
        <>
          {expanded ? (
            <>
              {earlier.map((row) => renderRow(row, false))}
              {earlier.length > 0 && archived.length > 0 ? (
                <Text className="pt-2 pr-4 pb-1 pl-[46px] text-xs text-foreground-muted">
                  Archived
                </Text>
              ) : null}
              {archived.map((row) => renderRow(row, true))}
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            className="min-h-10 flex-row items-center gap-2 py-2 pr-4 pl-[46px] active:opacity-70"
          >
            <SymbolView
              name={expanded ? "chevron.down" : "chevron.right"}
              size={12}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="text-sm text-foreground-muted">
              {earlier.length > 0
                ? expanded
                  ? "Hide earlier"
                  : `${earlier.length} earlier`
                : expanded
                  ? "Hide archived"
                  : "Archived"}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function SessionRow(props: {
  readonly row: BotSessionRow;
  readonly nowMs: number;
  readonly archived: boolean;
  readonly canArchive: boolean;
  readonly onOpen: () => void;
  readonly onArchive: (archived: boolean) => void;
}) {
  const { row } = props;
  const action = !props.canArchive
    ? null
    : row.jobArchived
      ? { id: "unarchive", title: "Unarchive job", image: "archivebox" }
      : row.jobFinished
        ? { id: "archive", title: "Archive job", image: "archivebox" }
        : null;
  const pressable = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.session.title}
      accessibilityHint={action === null ? undefined : "Long-press for more actions"}
      accessibilityActions={
        action === null ? undefined : [{ name: action.id, label: action.title }]
      }
      onAccessibilityAction={({ nativeEvent }) => {
        if (action !== null && nativeEvent.actionName === action.id) {
          props.onArchive(!row.jobArchived);
        }
      }}
      onPress={props.onOpen}
      className="min-h-10 flex-row items-center gap-2 py-2 pr-4 pl-[46px] active:opacity-70"
    >
      <SessionGlyph bucket={row.bucket} />
      <Text
        numberOfLines={1}
        className={
          props.archived
            ? "min-w-0 flex-1 text-sm text-foreground-muted"
            : "min-w-0 flex-1 text-sm text-foreground"
        }
      >
        {row.session.title}
      </Text>
      {row.session.cloud === undefined ? null : (
        <Text numberOfLines={1} className="max-w-[45%] text-xs text-foreground-muted">
          {row.bucket === "offline" ? row.state.label : row.session.cloud.label}
        </Text>
      )}
      {row.bucket === "finished" && row.state.updatedAt !== null ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          {relativeTime(row.state.updatedAt, props.nowMs)}
        </Text>
      ) : null}
    </Pressable>
  );
  if (action === null) return pressable;
  return (
    <Menu
      shouldOpenOnLongPress
      actions={[action]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === action.id) props.onArchive(!row.jobArchived);
      }}
    >
      {pressable}
    </Menu>
  );
}

function SessionGlyph(props: { readonly bucket: BotSessionBucket }) {
  switch (props.bucket) {
    case "needs-you":
      return (
        <SymbolView name="questionmark.bubble" size={14} tintColorClassName="accent-primary-text" />
      );
    case "working":
      return <SymbolView name="circle.dashed" size={14} tintColorClassName="accent-icon-muted" />;
    case "offline":
      return <SymbolView name="icloud.slash" size={14} tintColorClassName="accent-icon-muted" />;
    case "failed":
      return (
        <SymbolView
          name="exclamationmark.circle"
          size={14}
          tintColorClassName="accent-danger-foreground"
        />
      );
    case "finished":
      return (
        <SymbolView name="checkmark.circle" size={14} tintColorClassName="accent-icon-muted" />
      );
  }
}
