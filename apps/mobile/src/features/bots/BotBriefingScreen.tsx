import {
  type StaticScreenProps,
  StackActions,
  useFocusEffect,
  useNavigation,
} from "@react-navigation/native";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { Bot, BotAsk, BotJob, BotJobId, EnvironmentId } from "@t3tools/contracts";
import { EnvironmentId as EnvironmentIdSchema } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useBotsCommands, useBotsSnapshot } from "../../state/bots";
import { startOpeningEnvironmentThread } from "../../state/threads";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BotAvatar } from "./BotAvatar";
import {
  type BotSessionState,
  botSummaryLine,
  groupJobs,
  jobHeadline,
  jobProgressLabel,
  needsYouCount,
} from "./botsModel";
import { useBotSessionStates } from "./useBotSessions";

type Params = { readonly environmentId: string; readonly botId: string };

/** Alerts a failed Bots command with the server's reason; true when it landed. */
export function reportBotsResult(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  Dialog.alert(
    title,
    error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
  );
  return false;
}

function SectionHeader(props: {
  readonly title: string;
  readonly count?: number;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pt-4 pb-1">
      {props.trailing}
      <Text className="text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.count === undefined ? null : (
        <Text className="text-xs tabular-nums text-foreground-muted">{props.count}</Text>
      )}
    </View>
  );
}

function AskRow(props: {
  readonly ask: BotAsk;
  readonly job: BotJob | undefined;
  readonly onPress: () => void;
}) {
  const { ask, job } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={ask.question}
      onPress={props.onPress}
      className="min-h-14 flex-row items-start gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
    >
      <View className="pt-0.5">
        <SymbolView name="questionmark.bubble" size={16} tintColorClassName="accent-icon-muted" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={2} className="text-base font-t3-medium text-foreground">
          {ask.question}
        </Text>
        <Text numberOfLines={1} className="text-sm text-foreground-muted">
          {job === undefined ? "A job" : `J-${job.number} · ${job.title}`}
        </Text>
        {ask.why === "" ? null : (
          <Text numberOfLines={2} className="text-sm text-foreground-secondary">
            {ask.why}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function JobRow(props: {
  readonly job: BotJob;
  readonly botName: string;
  readonly states: ReadonlyArray<BotSessionState>;
  readonly nowMs: number;
  readonly onPress: () => void;
}) {
  const { job } = props;
  const progress = jobProgressLabel(props.states);
  const trouble = props.states.some((state) => state.trouble);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`J-${job.number} ${job.title}`}
      onPress={props.onPress}
      className="min-h-16 flex-row gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
    >
      <View className="pt-1">
        <SymbolView
          name={job.status === "working" ? "circle.dashed" : "checkmark.circle"}
          size={16}
          tintColorClassName="accent-icon-muted"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
          <Text className="text-foreground-muted">{`J-${job.number} · `}</Text>
          {job.title}
        </Text>
        <Text numberOfLines={2} className="text-sm text-foreground-secondary">
          {jobHeadline(job, props.botName)}
        </Text>
        <View className="flex-row items-center gap-2">
          {progress === null ? null : (
            <Text
              numberOfLines={1}
              className={trouble ? "text-xs text-warning" : "text-xs text-foreground-muted"}
            >
              {progress}
            </Text>
          )}
          <View className="grow" />
          {job.pullRequests.length > 0 ? (
            <View className="flex-row gap-1">
              {job.pullRequests.slice(0, 3).map((pr) => (
                <Chip key={pr.number} size="small" label={`#${pr.number}`} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
      <Text className="text-xs tabular-nums text-foreground-muted">
        {relativeTime(job.updatedAt, props.nowMs)}
      </Text>
    </Pressable>
  );
}

function BotHeader(props: {
  readonly bot: Bot;
  readonly summary: string;
  readonly onBack?: (() => void) | undefined;
  readonly onChat: (() => void) | undefined;
}) {
  return (
    <View className="flex-row items-center gap-3 border-b border-border-subtle px-3 py-2">
      {props.onBack === undefined ? null : (
        <IconButton icon="chevron.left" accessibilityLabel="Back" onPress={props.onBack} />
      )}
      <BotAvatar bot={props.bot} size={30} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-t3-bold text-foreground">
          {props.bot.name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {props.summary}
        </Text>
      </View>
      {props.onChat === undefined ? null : (
        <Button label="Chat" size="compact" tone="secondary" onPress={props.onChat} />
      )}
    </View>
  );
}

/** One bot's Briefing: Needs you, In progress, Done this week and the job composer. */
export function BotBriefingScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly onBack?: (() => void) | undefined;
}) {
  const { environmentId, bot } = props;
  const snapshot = useBotsSnapshot(environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const nowMs = useNowMinuteMs();
  const { createJob, markSeen } = useBotsCommands();
  const [request, setRequest] = useState("");
  const [sending, setSending] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const jobs = useMemo(
    () => (snapshot?.jobs ?? []).filter((job) => job.botId === bot.id),
    [snapshot, bot.id],
  );
  const asks = useMemo(
    () => (snapshot?.asks ?? []).filter((ask) => ask.botId === bot.id && ask.status === "open"),
    [snapshot, bot.id],
  );
  const sessions = useMemo(
    () => (snapshot?.sessions ?? []).filter((session) => session.botId === bot.id),
    [snapshot, bot.id],
  );
  const states = useBotSessionStates({ environmentId, sessions, botName: bot.name, nowMs });
  const statesByJob = new Map<BotJobId, BotSessionState[]>();
  sessions.forEach((session, index) => {
    const state = states[index];
    if (state === undefined) return;
    const list = statesByJob.get(session.jobId);
    if (list === undefined) statesByJob.set(session.jobId, [state]);
    else list.push(state);
  });
  const groups = groupJobs(jobs, nowMs);
  const needsYou = needsYouCount(asks);
  const summary = botSummaryLine({ jobCount: jobs.length, sessionStates: states, needsYou });
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  const markSeenRef = useRef(markSeen);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the focus effect stable while running the latest command
  useEffect(() => {
    markSeenRef.current = markSeen;
  }, [markSeen]);
  useFocusEffect(
    useCallback(() => {
      void markSeenRef.current({ environmentId, input: { botId: bot.id } });
    }, [environmentId, bot.id]),
  );

  const openAsk = (ask: BotAsk) => {
    navigation.dispatch(StackActions.push("BotAsk", { environmentId, askId: ask.id }));
  };
  const openJob = (job: BotJob) => {
    navigation.dispatch(
      StackActions.push("BotJob", { environmentId, botId: bot.id, jobId: job.id }),
    );
  };
  const openChat = () => {
    const threadId = bot.homeThreadId;
    if (threadId === null) return;
    startOpeningEnvironmentThread(environmentId, threadId);
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId }));
  };
  const send = async () => {
    const text = request.trim();
    if (text === "") return;
    setSending(true);
    const result = await createJob({ environmentId, input: { botId: bot.id, request: text } });
    setSending(false);
    if (reportBotsResult("Could not start the job", result)) setRequest("");
  };

  if (snapshot === null) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }

  const jobRow = (job: BotJob) => (
    <JobRow
      key={job.id}
      job={job}
      botName={bot.name}
      states={statesByJob.get(job.id) ?? []}
      nowMs={nowMs}
      onPress={() => openJob(job)}
    />
  );

  return (
    <View className="flex-1">
      <BotHeader
        bot={bot}
        summary={summary}
        onBack={props.onBack}
        onChat={bot.homeThreadId === null ? undefined : openChat}
      />
      <ScrollView
        contentContainerStyle={{
          paddingBottom: (workspace?.bottomClearance ?? insets.bottom) + 96,
        }}
      >
        <SectionHeader title="Needs you" count={needsYou} />
        {asks.length === 0 ? (
          <Text className="px-4 py-2 text-sm text-foreground-muted">Nothing needs you.</Text>
        ) : (
          asks.map((ask) => (
            <AskRow
              key={ask.id}
              ask={ask}
              job={ask.jobId === null ? undefined : jobById.get(ask.jobId)}
              onPress={() => openAsk(ask)}
            />
          ))
        )}
        <SectionHeader title="In progress" count={groups.inProgress.length} />
        {groups.inProgress.length === 0 ? (
          <Text className="px-4 py-2 text-sm text-foreground-muted">No jobs in progress.</Text>
        ) : (
          groups.inProgress.map(jobRow)
        )}
        <SectionHeader
          title="Done this week"
          count={groups.doneThisWeek.length}
          trailing={
            groups.doneThisWeek.length === 0 ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={showDone ? "Collapse done jobs" : "Expand done jobs"}
                onPress={() => setShowDone(!showDone)}
              >
                <SymbolView
                  name={showDone ? "chevron.down" : "chevron.right"}
                  size={12}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
            )
          }
        />
        {showDone ? groups.doneThisWeek.map(jobRow) : null}
      </ScrollView>
      <View
        className="absolute inset-x-0 border-t border-border-subtle bg-screen px-3 pt-2"
        style={{ bottom: 0, paddingBottom: Math.max(insets.bottom, 10) }}
      >
        <View className="flex-row items-end gap-2">
          <TextInput
            className="min-h-11 flex-1"
            placeholder={bot.paused ? `${bot.name} is paused` : `Give ${bot.name} a job…`}
            value={request}
            editable={!bot.paused}
            onChangeText={setRequest}
            multiline
          />
          <Button
            label="Send"
            icon="arrow.up"
            size="compact"
            loading={sending}
            disabled={bot.paused || request.trim() === ""}
            onPress={() => void send()}
          />
        </View>
        {bot.paused ? (
          <Text className="px-1 pt-1 text-xs text-foreground-muted">
            {bot.name} is paused · Resume on desktop or web.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A bot's Briefing, opened from a notification or a bots list row. */
export function BotBriefingRouteScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentIdSchema.make(props.route.params.environmentId);
  const snapshot = useBotsSnapshot(environmentId);
  const navigation = useNavigation();
  const bot = snapshot?.bots.find((candidate) => candidate.id === props.route.params.botId);
  if (bot === undefined) {
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
    <View className="flex-1 bg-screen">
      <BotBriefingScreen
        environmentId={environmentId}
        bot={bot}
        onBack={() => navigation.goBack()}
      />
    </View>
  );
}
