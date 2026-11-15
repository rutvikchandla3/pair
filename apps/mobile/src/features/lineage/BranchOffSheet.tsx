import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { branchOffDraftCopy, runsOnOptions } from "@t3tools/client-runtime/branch-lineage";
import type { LineageRunsOn } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import {
  branchLineageEnvironment,
  reportLineageResult,
  useRememberedRunsOn,
} from "../../state/branch-lineage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";
import { MachineNotice } from "../threads/ThreadMachineNotices";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  type BranchOffStartFrom,
  branchOffInput,
  branchOffStartFromLabel,
  branchOffStartFromOptions,
} from "./lineagePresentation";
import { LineageChoiceCard } from "./LineageChoiceCard";
import { LineageSheetFrame } from "./LineageSheetFrame";
import { type LineageSheetParams, useLineageThread } from "./useLineageThread";

const FAILURE_TITLE = "Could not branch off";

/** Branch off as a sheet: Start from, Runs on with its disclosure, branch, summary and prompt. */
export function BranchOffSheet(props: StaticScreenProps<LineageSheetParams>) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { ref, viewer, providerName } = useLineageThread(props.route.params);
  const draftQuery = useEnvironmentQuery(
    branchLineageEnvironment.branchOffDraft({
      environmentId: ref.environmentId,
      input: { sourceThreadId: ref.threadId },
    }),
  );
  const { remembered, remember } = useRememberedRunsOn(ref.environmentId);
  const branchOff = useAtomCommand(branchLineageEnvironment.branchOff, { reportFailure: false });
  const summarize = useAtomCommand(branchLineageEnvironment.branchOffSummary, {
    reportFailure: false,
  });

  const [startFrom, setStartFrom] = useState<BranchOffStartFrom>({ type: "latest" });
  const [baseBranch, setBaseBranch] = useState("main");
  const [runsOnPick, setRunsOnPick] = useState<LineageRunsOn | null>(null);
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [busy, setBusy] = useState(false);
  // A second press can land before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const draft = draftQuery.data;
  const close = () => navigation.goBack();
  if (viewer === null || draft === null) {
    return (
      <LineageSheetFrame title="Branch off" closeLabel="Cancel branch off" onClose={close}>
        <Text className="text-sm text-foreground-muted">
          {draftQuery.error ??
            (viewer === null ? "Branch off is for team cloud threads." : "Reading this thread…")}
        </Text>
      </LineageSheetFrame>
    );
  }

  const copy = branchOffDraftCopy(draft, viewer, providerName);
  const choice = runsOnOptions(draft, viewer, { remembered, providerName });
  const runsOn =
    runsOnPick !== null && choice.options.some((option) => option.value === runsOnPick)
      ? runsOnPick
      : choice.selected;
  const branch = branchEdit ?? draft.suggestedBranch;
  const startOptions = branchOffStartFromOptions(draft, copy.latestDetail);
  const input = branchOffInput(
    draft,
    ref.threadId,
    { startFrom, baseBranch, runsOn, branch, prompt, summary },
    choice.options.map((option) => option.value),
  );

  const requestSummary = async () => {
    if (summarizing) return;
    setSummarizing(true);
    const result = await summarize({
      environmentId: ref.environmentId,
      input: { sourceThreadId: ref.threadId },
    });
    setSummarizing(false);
    if (reportLineageResult("Could not write the summary", result) && result._tag === "Success") {
      setSummary(result.value.text);
    }
  };

  const submit = async () => {
    if (inFlight.current || input === null) return;
    inFlight.current = true;
    setBusy(true);
    const result = await branchOff({ environmentId: ref.environmentId, input });
    inFlight.current = false;
    setBusy(false);
    if (!reportLineageResult(FAILURE_TITLE, result) || result._tag !== "Success") return;
    remember(runsOn);
    selectDetail({
      name: "Thread",
      params: { environmentId: String(ref.environmentId), threadId: String(result.value.threadId) },
    });
  };

  return (
    <LineageSheetFrame
      title={copy.title}
      subtitle={copy.subtitle}
      closeLabel="Cancel branch off"
      onClose={close}
    >
      {copy.blocked !== null ? (
        <MachineNotice
          icon={{ ios: "key", android: "lock" }}
          tone="default"
          title={copy.blocked.text}
          {...(copy.blocked.connect === null
            ? {}
            : {
                actions: (
                  <Button
                    label={copy.blocked.connect}
                    tone="secondary"
                    size="compact"
                    onPress={() => openSettings(navigation, "SettingsProviderAccounts")}
                  />
                ),
              })}
        />
      ) : null}

      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Start from</Text>
        <Menu
          accessibilityLabel={`Start from: ${branchOffStartFromLabel(startFrom, startOptions, baseBranch)}`}
          actions={startOptions.map((option) => ({
            id: option.id,
            title: option.title,
            state:
              (option.value.type === "turn" &&
                startFrom.type === "turn" &&
                option.value.runId === startFrom.runId) ||
              (option.value.type !== "turn" && option.value.type === startFrom.type)
                ? "on"
                : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = startOptions.find((option) => option.id === nativeEvent.event);
            if (next !== undefined) setStartFrom(next.value);
          }}
        >
          <View className="min-h-12 flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-4 py-3">
            <Text className="shrink text-base text-foreground" numberOfLines={1}>
              {branchOffStartFromLabel(startFrom, startOptions, baseBranch)}
            </Text>
            <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" />
          </View>
        </Menu>
        {startFrom.type === "branch" ? (
          <TextInput
            accessibilityLabel="Branch to start from"
            autoCapitalize="none"
            autoCorrect={false}
            value={baseBranch}
            onChangeText={setBaseBranch}
            placeholder="main"
            className="rounded-xl bg-subtle px-4 py-3 text-base"
          />
        ) : null}
        {copy.taskLine !== null ? (
          <Text className="text-xs text-foreground-muted">{copy.taskLine}</Text>
        ) : null}
      </View>

      <View className="gap-2" accessibilityRole="radiogroup">
        <Text className="text-sm font-t3-medium text-foreground">Runs on</Text>
        {choice.options.map((option) => (
          <LineageChoiceCard
            key={option.value}
            label={option.label}
            subtitle={option.subtitle}
            selected={option.value === runsOn}
            onPress={() => setRunsOnPick(option.value)}
          />
        ))}
        {choice.reason !== null ? (
          <Text className="text-xs font-t3-medium text-foreground">{choice.reason}</Text>
        ) : null}
        <Text className="text-xs text-foreground-muted">{choice.disclosures[runsOn]}</Text>
      </View>

      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Branch name</Text>
        <TextInput
          accessibilityLabel="Branch name"
          autoCapitalize="none"
          autoCorrect={false}
          value={branch}
          onChangeText={setBranchEdit}
          className="rounded-xl bg-subtle px-4 py-3 text-base"
        />
      </View>

      <View className="gap-2">
        {summary === null ? (
          <Button
            label={summarizing ? "Writing the summary…" : copy.contextLabel}
            icon="text.alignleft"
            tone="secondary"
            loading={summarizing}
            disabled={summarizing || busy}
            onPress={() => void requestSummary()}
          />
        ) : (
          <>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="shrink text-sm font-t3-medium text-foreground">First message</Text>
              <Button label="Remove" tone="text" size="compact" onPress={() => setSummary(null)} />
            </View>
            <TextInput
              multiline
              accessibilityLabel="Summary of the conversation"
              editable={!busy}
              value={summary}
              onChangeText={setSummary}
              textAlignVertical="top"
              className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
            />
          </>
        )}
        <Text className="text-xs text-foreground-muted">{copy.contextHint}</Text>
      </View>

      <TextInput
        multiline
        accessibilityLabel="Prompt"
        placeholder="What should your agent do?"
        editable={!busy}
        value={prompt}
        onChangeText={setPrompt}
        textAlignVertical="top"
        className="min-h-20 rounded-xl bg-subtle px-4 py-3 text-base"
      />

      <Button
        label="Branch off"
        icon="arrow.triangle.branch"
        tone="primary"
        fullWidth
        loading={busy}
        disabled={input === null || busy}
        onPress={() => void submit()}
      />
    </LineageSheetFrame>
  );
}
