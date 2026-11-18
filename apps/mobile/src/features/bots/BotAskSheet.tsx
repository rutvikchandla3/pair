import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useBotsCommands, useBotsSnapshot } from "../../state/bots";
import { SpaceSheetFrame } from "../spaces/SpaceSheetFrame";
import { reportBotsResult } from "./BotBriefingScreen";

type Params = {
  readonly environmentId: string;
  readonly askId: string;
};

/** One Ask, answered in place: a suggestion, your own words, or let the bot decide. */
export function BotAskSheet(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const snapshot = useBotsSnapshot(environmentId);
  const navigation = useNavigation();
  const { answerAsk, rememberAsk } = useBotsCommands();
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const ask = snapshot?.asks.find((candidate) => candidate.id === props.route.params.askId);
  const job =
    ask?.jobId === null || ask?.jobId === undefined
      ? undefined
      : snapshot?.jobs.find((candidate) => candidate.id === ask.jobId);
  const close = () => navigation.goBack();

  const run = async (action: () => Promise<Parameters<typeof reportBotsResult>[1]>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (reportBotsResult("Could not answer", result)) close();
  };

  const answerWith = (kind: "option" | "text" | "bot-decides", value?: string) => {
    if (ask === undefined) return;
    void run(() =>
      answerAsk({
        environmentId,
        input: {
          askId: ask.id,
          kind,
          ...(value === undefined ? {} : { answer: value }),
          remember: kind === "text" ? remember : false,
        },
      }),
    );
  };

  return (
    <SpaceSheetFrame
      header={{
        title: `${snapshot?.bots.find((bot) => bot.id === ask?.botId)?.name ?? "Bot"} asks`,
        onClose: close,
      }}
      footer={
        ask !== undefined && ask.status === "open" ? (
          <Button
            label="Let Atlas decide"
            tone="text"
            fullWidth
            disabled={busy}
            onPress={() => answerWith("bot-decides")}
          />
        ) : undefined
      }
    >
      {ask === undefined ? (
        <View className="items-center py-8">
          {snapshot === null ? (
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          ) : (
            <Text className="text-sm text-foreground-muted">This Ask is no longer open.</Text>
          )}
        </View>
      ) : (
        <>
          <Text className="text-xs text-foreground-muted">
            {job === undefined ? "A job" : `J-${job.number} · ${job.title}`}
          </Text>
          <Text className="text-lg font-t3-bold text-foreground">{ask.question}</Text>
          {ask.why === "" ? null : (
            <Text numberOfLines={4} className="text-sm text-foreground-secondary">
              {ask.why}
            </Text>
          )}
          {ask.status === "answered" ? (
            <View className="gap-3">
              <Text className="text-sm text-foreground">
                Answered:{" "}
                <Text className="font-t3-medium">{ask.answer ?? "Let the bot decide"}</Text>
              </Text>
              {ask.answerKind === "option" && !ask.remember ? (
                <Button
                  label="Remember this"
                  tone="secondary"
                  loading={busy}
                  onPress={() =>
                    void run(() => rememberAsk({ environmentId, input: { askId: ask.id } }))
                  }
                />
              ) : null}
            </View>
          ) : (
            <View className="gap-4">
              <View className="gap-2">
                {ask.options.map((option) => (
                  <Button
                    key={option}
                    label={option}
                    tone={ask.pick === option ? "primary" : "secondary"}
                    fullWidth
                    disabled={busy}
                    onPress={() => answerWith("option", option)}
                  />
                ))}
              </View>
              {ask.pick === null ? null : (
                <Text className="text-center text-xs text-foreground-muted">
                  It would pick {ask.pick}
                </Text>
              )}
              <View className="gap-2">
                <View className="flex-row items-end gap-2">
                  <TextInput
                    className="min-h-11 flex-1"
                    placeholder="Or answer in your own words…"
                    value={answer}
                    onChangeText={setAnswer}
                    multiline
                  />
                  <Button
                    label="Send"
                    icon="arrow.up"
                    size="compact"
                    loading={busy}
                    disabled={answer.trim() === ""}
                    onPress={() => answerWith("text", answer.trim())}
                  />
                </View>
                <View className="flex-row items-center justify-between gap-3 px-1">
                  <Text className="text-sm text-foreground">Remember this</Text>
                  <ThemedSwitch
                    value={remember}
                    accessibilityLabel="Remember this answer"
                    onValueChange={setRemember}
                  />
                </View>
              </View>
            </View>
          )}
        </>
      )}
    </SpaceSheetFrame>
  );
}
