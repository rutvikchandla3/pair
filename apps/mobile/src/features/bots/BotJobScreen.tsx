import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import type { BotAsk, BotJob, BotSession } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useBotsCommands, useBotsSnapshot } from "../../state/bots";
import { startOpeningEnvironmentThread } from "../../state/threads";
import { jobHeadline } from "./botsModel";
import { useBotSessionStates } from "./useBotSessions";

type Params = {
  readonly environmentId: string;
  readonly botId?: string;
  readonly jobId: string;
};

function statusLabel(job: BotJob): string {
  switch (job.status) {
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "stopped":
      return "Stopped";
  }
}

function Field(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

/** A job's read-only detail and its report, wherever a finish notification lands. */
export function BotJobScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const snapshot = useBotsSnapshot(environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const nowMs = useNowMinuteMs();
  const { createJob, stopJob } = useBotsCommands();

  const job = snapshot?.jobs.find((candidate) => candidate.id === props.route.params.jobId);
  const bot = snapshot?.bots.find((candidate) => candidate.id === job?.botId);
  const botName = bot?.name ?? "the bot";
  const sessions = (snapshot?.sessions ?? []).filter((session) => session.jobId === job?.id);
  const states = useBotSessionStates({ environmentId, sessions, botName, nowMs });
  const decisions = (snapshot?.events ?? []).filter(
    (event) => event.jobId === job?.id && event.kind === "decision" && event.decision !== null,
  );
  const answeredByYou = (snapshot?.asks ?? []).filter(
    (ask: BotAsk) =>
      ask.jobId === job?.id &&
      ask.status === "answered" &&
      (ask.answerKind === "option" || ask.answerKind === "text"),
  );

  const openThread = (session: BotSession) => {
    startOpeningEnvironmentThread(environmentId, session.threadId);
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: session.threadId }));
  };
  const confirmStop = () => {
    if (job === undefined) return;
    const running = states.filter(
      (state) => state.kind === "working" || state.kind === "quiet",
    ).length;
    Dialog.confirm({
      title: `Stop J-${job.number}?`,
      message:
        running === 0
          ? "The job stops; its sessions keep running."
          : `Stop J-${job.number} and its ${running} running session${running === 1 ? "" : "s"}?`,
      confirmText: "Stop job",
      destructive: true,
      onConfirm: () => {
        void stopJob({ environmentId, input: { jobId: job.id } });
      },
    });
  };

  if (job === undefined) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-8">
        {snapshot === null ? (
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        ) : (
          <Text className="text-sm text-foreground-muted">This job isn’t on this environment.</Text>
        )}
      </View>
    );
  }

  const report = job.report;

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: insets.bottom + 32 }}
    >
      <View className="gap-1">
        <Text className="text-2xl font-t3-bold text-foreground">
          {`J-${job.number} · ${job.title}`}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-t3-medium text-foreground">{statusLabel(job)}</Text>
          {job.pullRequests.map((pr) => (
            <Chip key={pr.number} size="small" label={`#${pr.number}`} />
          ))}
          <View className="grow" />
          <Text className="text-xs text-foreground-muted">
            {relativeTime(job.finishedAt ?? job.updatedAt, nowMs)}
          </Text>
        </View>
        <Text className="text-sm text-foreground-secondary">{jobHeadline(job, botName)}</Text>
      </View>

      <Field title="Your request">
        <Text className="text-sm text-foreground">{job.request}</Text>
      </Field>

      <Field title={`Sessions (${sessions.length})`}>
        {sessions.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No sessions yet.</Text>
        ) : (
          sessions.map((session, index) => {
            const state = states[index];
            if (state === undefined) return null;
            return (
              <View
                key={session.threadId}
                className="flex-row items-center gap-3 border-b border-border-subtle py-2"
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
                    {session.title}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className={
                      state.trouble ? "text-xs text-warning" : "text-xs text-foreground-muted"
                    }
                  >
                    {state.label === "" ? state.kind.replace("-", " ") : state.label}
                  </Text>
                </View>
                <Button
                  label="Open"
                  size="compact"
                  tone="secondary"
                  onPress={() => openThread(session)}
                />
              </View>
            );
          })
        )}
      </Field>

      <Field title={`Decided for you (${decisions.length})`}>
        {decisions.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No decisions yet.</Text>
        ) : (
          decisions.map((event) => (
            <View key={event.id} className="gap-0.5 border-b border-border-subtle py-2">
              <Text className="text-sm text-foreground">
                {event.decision?.question ?? ""} →{" "}
                <Text className="font-t3-medium">{event.decision?.answer ?? ""}</Text>
              </Text>
              {event.decision?.cite === undefined || event.decision.cite === "" ? null : (
                <Text numberOfLines={2} className="text-xs text-foreground-muted">
                  {event.decision.cite}
                </Text>
              )}
            </View>
          ))
        )}
      </Field>

      {report === null ? null : (
        <View className="gap-4">
          <Field title="What changed">
            <Text className="text-sm text-foreground">{report.changed}</Text>
          </Field>
          {report.evidence.length === 0 ? null : (
            <Field title="Evidence">
              {report.evidence.map((line) => (
                <Text key={line} className="text-sm text-foreground-secondary">
                  {line}
                </Text>
              ))}
            </Field>
          )}
          <Field title={`You decided (${answeredByYou.length})`}>
            {answeredByYou.length === 0 ? (
              <Text className="text-sm text-foreground-muted">You answered nothing here.</Text>
            ) : (
              answeredByYou.map((ask) => (
                <Text key={ask.id} className="text-sm text-foreground">
                  {ask.question} → <Text className="font-t3-medium">{ask.answer ?? ""}</Text>
                </Text>
              ))
            )}
          </Field>
          {report.openQuestions.length === 0 ? null : (
            <Field title="Open questions">
              {report.openQuestions.map((question) => (
                <Text key={question} className="text-sm text-foreground-secondary">
                  {question}
                </Text>
              ))}
            </Field>
          )}
          {report.next === null ? null : (
            <Field title="Next">
              <Text className="text-sm text-foreground">{report.next.text}</Text>
              {report.next.suggestedRequest === null ? null : (
                <Button
                  label="Start job"
                  tone="secondary"
                  onPress={() =>
                    void createJob({
                      environmentId,
                      input: {
                        botId: job.botId,
                        request: report.next?.suggestedRequest ?? "",
                      },
                    })
                  }
                />
              )}
            </Field>
          )}
        </View>
      )}

      {job.status === "working" ? (
        <Button label="Stop job" tone="danger" onPress={confirmStop} />
      ) : null}
    </ScrollView>
  );
}
