import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useBotsSnapshot } from "../../state/bots";
import { startOpeningEnvironmentThread } from "../../state/threads";

type Params = { readonly environmentId: string; readonly botId: string };

/**
 * Lands a bot's deep link and "starting" taps on its home thread, waiting while the bot's first
 * turn creates it.
 */
export function BotHomeRouteScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const snapshot = useBotsSnapshot(environmentId);
  const navigation = useNavigation();
  const bot = snapshot?.bots.find((candidate) => candidate.id === props.route.params.botId) ?? null;
  const threadId = bot?.homeThreadId ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces this route with the bot's home thread once its first turn has created it
  useEffect(() => {
    if (threadId === null) return;
    startOpeningEnvironmentThread(environmentId, threadId);
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
  }, [environmentId, threadId, navigation]);

  if (bot === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        {snapshot === null ? (
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        ) : (
          <Text className="text-sm text-foreground-muted">This bot isn’t on this environment.</Text>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-3 bg-screen p-8">
      <AppActivityIndicator colorClassName="accent-icon-muted" />
      <Text className="text-sm text-foreground-muted">{bot.name} is starting…</Text>
    </View>
  );
}
