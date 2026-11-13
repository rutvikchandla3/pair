import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { SpaceTaskId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";
import { SpaceTextField, useSpaceThreadStart } from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import type { SpaceTaskSheetParams } from "./SpaceStatusSheet";
import { useSheetSpace } from "./useSheetSpace";

/** Start a thread on a task (board 7c), on the viewer's own account. */
export function SpaceStartThreadSheet(props: StaticScreenProps<SpaceTaskSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, tasks } = useSheetSpace(props.route.params);
  const startThread = useAtomCommand(spaceEnvironment.startThread, { reportFailure: false });
  const taskId = SpaceTaskId.make(props.route.params.taskId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { start, model, fields } = useSpaceThreadStart(environmentId, space);
  const close = () => navigation.goBack();
  if (space === null || task === undefined) {
    return (
      <SpaceSheetFrame header={{ title: "Start a thread", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This task isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const text = (prompt ?? task.description).trim();
  const ready = start !== null && text !== "" && !busy;
  const submit = async () => {
    if (!ready || start === null) return;
    setBusy(true);
    const result = await startThread({
      environmentId,
      input: {
        spaceId: space.id,
        taskId: task.id,
        ...start,
        ...(text === task.description ? {} : { text }),
      },
    });
    setBusy(false);
    if (!reportSpaceResult("Could not start the thread", result)) return;
    if (result._tag !== "Success") return;
    close();
    const threadId = result.value.threadId;
    if (threadId !== undefined) {
      navigation.dispatch(StackActions.push("Thread", { environmentId, threadId }));
    }
  };
  return (
    <SpaceSheetFrame
      header={{
        title: "Start a thread",
        subtitle: `on ${task.title}`,
        onCancel: close,
        dismissDisabled: busy,
        confirm: { label: "Start", onPress: () => void submit(), disabled: !ready, loading: busy },
      }}
    >
      <View className="gap-1.5">
        <SpaceTextField
          label="Prompt · from the task, edit freely"
          multiline
          value={prompt ?? task.description}
          onChangeText={setPrompt}
        />
        <Text className="text-xs text-foreground-muted">
          The thread also reads the brief, Pair's notes and the task's other threads.
        </Text>
      </View>
      {fields}
      {model === null ? (
        <View className="flex-row items-center gap-2 rounded-md bg-warning/10 px-3 py-2">
          <Text className="min-w-0 flex-1 text-sm text-warning-foreground">
            Connect a provider account in Settings. The thread runs on your account.
          </Text>
          <Button
            label="Open Settings"
            size="compact"
            onPress={() => openSettings(navigation, "SettingsProviderAccounts")}
          />
        </View>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        Linked to the task. Space members can see it.
      </Text>
    </SpaceSheetFrame>
  );
}
