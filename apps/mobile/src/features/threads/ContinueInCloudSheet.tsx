import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { sameContinueInCloudOffer } from "@t3tools/client-runtime/state/cloud-target";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CONTINUE_IN_CLOUD_BUSY_LABEL,
  CONTINUE_IN_CLOUD_LABEL,
  MOVE_EXCLUDE_NOTE,
  MOVE_IN_PROGRESS_NOTE,
  MOVE_STAYS_NOTE,
  moveNothingToUpload,
} from "@t3tools/client-runtime/state/threadMove";
import { CLOUD_MOVE_DEFAULT_MESSAGE, type EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import {
  threadMoveEnvironment,
  useCloudAccountNotice,
  useContinueInCloudOffer,
} from "../../state/sandbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelection } from "../../state/use-thread-selection";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { MachineNotice } from "./ThreadMachineNotices";

const FAILURE_TITLE = "Could not continue in cloud";

/** The phone can't link the Mac to Pair Cloud: that writes the Mac's settings, so it points there. */
function linkNotice(input: {
  readonly status: "missing" | "expired";
  readonly computer: string;
  readonly cloud: string;
}): string {
  return input.status === "missing"
    ? `On ${input.computer}, link ${input.cloud} in Settings → Environments.`
    : `The link to ${input.cloud} expired. On ${input.computer}, link it again in Settings → Environments.`;
}

export function ContinueInCloudSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThreadRef, selectedEnvironmentConnection } = useThreadSelection();
  const offer = useContinueInCloudOffer(selectedThreadRef);
  // The Pair Clouds the offer last listed; the live offer says when one can't take the thread now.
  const [listed, setListed] = useState(offer.kind === "ready" ? offer : null);
  if (offer.kind === "ready" && (listed === null || !sameContinueInCloudOffer(listed, offer))) {
    setListed(offer);
  }
  const targets = listed?.targets ?? [];
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const target = targets.find((candidate) => candidate.environmentId === targetId) ?? targets[0];
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState(CLOUD_MOVE_DEFAULT_MESSAGE);
  const [busy, setBusy] = useState(false);
  // A second press can land before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const preview = useEnvironmentQuery(
    selectedThreadRef === null || target === undefined
      ? null
      : threadMoveEnvironment.preview({
          environmentId: selectedThreadRef.environmentId,
          input: {
            threadId: selectedThreadRef.threadId,
            cloudEnvironmentId: target.environmentId,
          },
        }),
  );
  const accountNotice = useCloudAccountNotice(target?.environmentId ?? null);
  const toCloud = useAtomCommand(threadMoveEnvironment.toCloud, { reportFailure: false });

  const data = preview.data;
  const blockedReason = offer.kind === "disabled" ? offer.reason : null;
  const linkProblem =
    data === null || data.link.status === "linked" || target === undefined
      ? null
      : linkNotice({
          status: data.link.status,
          computer: selectedEnvironmentConnection?.environmentLabel ?? "this computer",
          cloud: target.label,
        });
  const allExcluded = data !== null && data.files.every((file) => excluded.has(file.path));
  // A move running on the Mac already (the phone locked, or reconnected): pressing joins it.
  const moving = busy || data?.moving === true;
  const canMove =
    selectedThreadRef !== null &&
    target !== undefined &&
    data !== null &&
    linkProblem === null &&
    accountNotice?.kind !== "provider" &&
    blockedReason === null &&
    message.trim().length > 0 &&
    !busy;

  const submit = async () => {
    if (inFlight.current || !canMove || selectedThreadRef === null || target === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const result = await toCloud({
      environmentId: selectedThreadRef.environmentId,
      input: {
        threadId: selectedThreadRef.threadId,
        cloudEnvironmentId: target.environmentId,
        cloudProjectId: target.projectId,
        excludePaths: [...excluded],
        message: message.trim(),
        creationSource: "mobile",
      },
    });
    inFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        FAILURE_TITLE,
        error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
      );
      return;
    }
    const { cloudThread } = result.value;
    selectDetail({
      name: "Thread",
      params: {
        environmentId: String(cloudThread.environmentId),
        threadId: String(cloudThread.threadId),
      },
    });
  };

  const toggle = (path: string, include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(path);
      else next.add(path);
      return next;
    });

  const android = Platform.OS === "android";
  const header = (
    <SheetHeader
      presentation={android ? "inline" : "native"}
      title={CONTINUE_IN_CLOUD_LABEL}
      subtitle={
        data === null
          ? "Reading this thread's branch and changes…"
          : `${data.branch} from ${data.baseRef}`
      }
      onCancel={() => navigation.goBack()}
      accessibilityLabel="Cancel continue in cloud"
    />
  );

  return (
    // Material sheet drags follow the first nested-scrolling native view, and the inline
    // header's Compose button is one, so Android renders content first and reverses the column.
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {android ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {android ? null : header}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 pb-6 gap-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {target === undefined && blockedReason === null ? (
            <Text className="text-sm text-foreground-muted">
              No Pair Cloud can take this thread.
            </Text>
          ) : null}
          {targets.length > 1 && target !== undefined ? (
            <View className="gap-2">
              <Text className="text-sm font-t3-medium text-foreground">Pair Cloud</Text>
              <Menu
                accessibilityLabel={`Pair Cloud: ${target.label}`}
                actions={targets.map((candidate) => ({
                  id: candidate.environmentId,
                  title: candidate.label,
                  state: candidate.environmentId === target.environmentId ? "on" : "off",
                }))}
                onPressAction={({ nativeEvent }) => {
                  const next = targets.find(
                    (candidate) => candidate.environmentId === nativeEvent.event,
                  );
                  if (next !== undefined) setTargetId(next.environmentId);
                }}
              >
                <View className="min-h-12 flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-4 py-3">
                  <Text className="text-base text-foreground">{target.label}</Text>
                  <SymbolView
                    name="chevron.down"
                    size={14}
                    tintColorClassName="accent-icon-muted"
                  />
                </View>
              </Menu>
            </View>
          ) : null}
          {preview.error !== null ? (
            <MachineNotice icon="cloud" tone="danger" title={preview.error} />
          ) : null}
          {linkProblem !== null ? (
            <MachineNotice icon="cloud" tone="default" title={linkProblem} />
          ) : null}
          {accountNotice !== null && target !== undefined ? (
            <MachineNotice
              icon={{ ios: "key", android: "lock" }}
              tone="default"
              title={accountNotice.title}
              detail={accountNotice.description}
              actions={
                <Button
                  label="Open Settings"
                  tone="secondary"
                  size="compact"
                  onPress={() => openSettings(navigation, "SettingsTeam")}
                />
              }
            />
          ) : null}
          {blockedReason !== null ? (
            <MachineNotice icon="cloud" tone="default" title={blockedReason} />
          ) : null}
          {data?.moving === true ? (
            <MachineNotice icon="cloud" tone="default" title={MOVE_IN_PROGRESS_NOTE} />
          ) : null}
          {data !== null && data.commits.length > 0 ? (
            <View className="gap-1">
              <Text className="text-base font-t3-bold text-foreground">Commits</Text>
              {data.commits.map((commit) => (
                <Text key={commit.sha} numberOfLines={1} className="text-xs text-foreground-muted">
                  {commit.sha.slice(0, 7)} {commit.subject}
                </Text>
              ))}
              {data.commitsTruncated ? (
                <Text className="text-xs text-foreground-muted">and more</Text>
              ) : null}
            </View>
          ) : null}
          {data !== null && data.files.length > 0 ? (
            <View className="gap-1">
              <Text className="text-base font-t3-bold text-foreground">Changes</Text>
              {data.files.map((file) => (
                <View
                  key={file.path}
                  className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle py-2"
                >
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      className="text-sm font-t3-medium text-foreground"
                    >
                      {file.path}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      +{file.insertions} −{file.deletions}
                    </Text>
                  </View>
                  <ThemedSwitch
                    accessibilityLabel={file.path}
                    disabled={moving}
                    value={!excluded.has(file.path)}
                    onValueChange={(include) => toggle(file.path, include)}
                  />
                </View>
              ))}
              {data.filesTruncated ? (
                <Text className="text-xs text-foreground-muted">and more</Text>
              ) : null}
              <Text className="pt-1 text-xs text-foreground-muted">{MOVE_EXCLUDE_NOTE}</Text>
            </View>
          ) : null}
          {data !== null && data.pushed && data.files.length > 0 && allExcluded ? (
            <MachineNotice icon="cloud" tone="default" title={moveNothingToUpload(data.branch)} />
          ) : null}
          <Text className="text-xs text-foreground-muted">{MOVE_STAYS_NOTE}</Text>
          <View className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground">First message</Text>
            <TextInput
              multiline
              accessibilityLabel="First message"
              editable={!moving}
              value={message}
              onChangeText={setMessage}
              textAlignVertical="top"
              className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
            />
          </View>
          <Button
            label={moving ? CONTINUE_IN_CLOUD_BUSY_LABEL : CONTINUE_IN_CLOUD_LABEL}
            icon="icloud.and.arrow.up"
            tone="primary"
            fullWidth
            loading={busy}
            disabled={!canMove}
            onPress={() => void submit()}
          />
        </ScrollView>
      </ScreenContent>
      {android ? header : null}
    </View>
  );
}
