import { StackActions, useNavigation } from "@react-navigation/native";
import type { Bot, BotSession, BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useBotsCommands, useBotsSnapshot, usePrimaryEnvironmentId } from "../../state/bots";
import { startOpeningEnvironmentThread } from "../../state/threads";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BotAvatar } from "./BotAvatar";
import { type BotSessionBucket, botStatusLine, botSessionRows, needsYouCount } from "./botsModel";
import { useBotSessionStates } from "./useBotSessions";

/** The Bots workspace tab: every bot with its sessions nested under it. */
export function BotsScreen() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const navigation = useNavigation();
  const { create } = useBotsCommands();
  const bottom = (workspace?.bottomClearance ?? insets.bottom) + 24;

  const createBot = async () => {
    if (environmentId === null) return;
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

  const openBot = (bot: Bot) => {
    if (environmentId === null) return;
    if (bot.homeThreadId === null) {
      navigation.dispatch(
        StackActions.push("BotHome", { environmentId: String(environmentId), botId: bot.id }),
      );
      return;
    }
    startOpeningEnvironmentThread(environmentId, bot.homeThreadId);
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: bot.homeThreadId }));
  };

  const openSession = (session: BotSession) => {
    if (environmentId === null) return;
    const sessionEnvironmentId = session.cloud?.environmentId ?? environmentId;
    startOpeningEnvironmentThread(sessionEnvironmentId, session.threadId);
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: sessionEnvironmentId,
        threadId: session.threadId,
      }),
    );
  };

  if (snapshot === null || environmentId === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row items-center justify-between px-4 pt-3 pb-2">
        <Text className="text-2xl font-t3-bold text-foreground">Bots</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New bot"
          onPress={() => void createBot()}
          className="size-10 items-center justify-center active:opacity-60"
        >
          <SymbolView name="plus" size={20} tintColorClassName="accent-primary-text" />
        </Pressable>
      </View>
      {snapshot.bots.length === 0 ? (
        <View className="flex-1 items-center justify-center p-8">
          <Text className="text-center text-sm text-foreground-muted">
            Tap + to start your first bot.
          </Text>
        </View>
      ) : (
        <FlatList
          data={snapshot.bots}
          keyExtractor={(bot) => bot.id}
          contentContainerStyle={{ paddingBottom: bottom }}
          renderItem={({ item }) => (
            <BotSection
              environmentId={environmentId}
              bot={item}
              snapshot={snapshot}
              onOpenBot={() => openBot(item)}
              onOpenSession={(session) => openSession(session)}
            />
          )}
        />
      )}
    </View>
  );
}

function BotSection(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
  readonly onOpenBot: () => void;
  readonly onOpenSession: (session: BotSession) => void;
}) {
  const { environmentId, bot, snapshot } = props;
  const nowMs = useNowMinuteMs();
  const jobs = snapshot.jobs.filter((job) => job.botId === bot.id);
  const asks = snapshot.asks.filter((ask) => ask.botId === bot.id);
  const sessions = snapshot.sessions.filter((session) => session.botId === bot.id);
  const states = useBotSessionStates({ environmentId, sessions, botName: bot.name, nowMs });
  const status = botStatusLine({ bot, asks, jobs, sessions, sessionStates: states });
  const rows = botSessionRows({ sessions, states, asks, nowMs });
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
      {rows.map((row) => (
        <Pressable
          key={row.session.threadId}
          accessibilityRole="button"
          accessibilityLabel={row.session.title}
          onPress={() => props.onOpenSession(row.session)}
          className="min-h-10 flex-row items-center gap-2 py-2 pr-4 pl-[46px] active:opacity-70"
        >
          <SessionGlyph bucket={row.bucket} />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {row.session.title}
          </Text>
          {row.session.cloud === undefined ? null : (
            <Text numberOfLines={1} className="max-w-[45%] text-xs text-foreground-muted">
              {row.bucket === "offline" ? row.state.label : row.session.cloud.label}
            </Text>
          )}
          {row.bucket === "finished" && row.state.updatedAt !== null ? (
            <Text className="text-xs tabular-nums text-foreground-muted">
              {relativeTime(row.state.updatedAt, nowMs)}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
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
