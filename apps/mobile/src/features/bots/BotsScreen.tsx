import { StackActions, useNavigation } from "@react-navigation/native";
import type { Bot, BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { useBotsSnapshot, usePrimaryEnvironmentId } from "../../state/bots";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BotAvatar } from "./BotAvatar";
import { botSummaryLine, needsYouCount } from "./botsModel";
import { BotBriefingScreen } from "./BotBriefingScreen";
import { useBotSessionStates } from "./useBotSessions";

/** The Bots workspace tab: one bot's Briefing, a list of bots, or the first-run message. */
export function BotsScreen() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const bottom = (workspace?.bottomClearance ?? insets.bottom) + 24;

  if (snapshot === null || environmentId === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }

  if (snapshot.bots.length === 0) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        <Text className="text-center text-sm text-foreground-muted">
          Create a bot on desktop or web.
        </Text>
      </View>
    );
  }

  if (snapshot.bots.length === 1) {
    return <BotBriefingScreen environmentId={environmentId} bot={snapshot.bots[0]!} />;
  }

  return (
    <FlatList
      className="flex-1 bg-screen"
      data={snapshot.bots}
      keyExtractor={(bot) => bot.id}
      contentContainerStyle={{ paddingBottom: bottom }}
      renderItem={({ item }) => (
        <BotListRow environmentId={environmentId} bot={item} snapshot={snapshot} />
      )}
    />
  );
}

function BotListRow(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
}) {
  const { environmentId, bot, snapshot } = props;
  const navigation = useNavigation();
  const nowMs = useNowMinuteMs();
  const jobs = snapshot.jobs.filter((job) => job.botId === bot.id);
  const asks = snapshot.asks.filter((ask) => ask.botId === bot.id);
  const sessions = snapshot.sessions.filter((session) => session.botId === bot.id);
  const states = useBotSessionStates({ environmentId, sessions, botName: bot.name, nowMs });
  const needsYou = needsYouCount(asks);
  const summary = botSummaryLine({ jobCount: jobs.length, sessionStates: states, needsYou });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}, ${summary}`}
      onPress={() =>
        navigation.dispatch(StackActions.push("BotBriefing", { environmentId, botId: bot.id }))
      }
      className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
    >
      <BotAvatar bot={bot} size={36} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-base font-t3-bold text-foreground">
          {bot.name}
        </Text>
        <Text numberOfLines={1} className="text-sm text-foreground-muted">
          {summary}
        </Text>
      </View>
      {needsYou > 0 ? (
        <View className="items-center justify-center rounded-full bg-primary px-2 py-0.5">
          <Text className="text-xs font-t3-medium text-primary-foreground">{needsYou}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
