import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import {
  SPACE_TASK_STATUSES,
  orderSpaceMembers,
  spaceTaskStatusInfo,
} from "@t3tools/client-runtime/spaces";
import { MemberId, type SpaceTaskStatus } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSelectRow, SpaceTextField, useSpaceThreadStart } from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

export function SpaceNewTaskSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, viewer } = useSheetSpace(props.route.params);
  const task = useAtomCommand(spaceEnvironment.task, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<SpaceTaskStatus>("todo");
  const [ownerId, setOwnerId] = useState<MemberId | null>(viewer.memberId);
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const thread = useSpaceThreadStart(environmentId, space);
  const close = () => navigation.goBack();
  if (space === null) {
    return (
      <SpaceSheetFrame header={{ title: "New task", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const mine = ownerId !== null && ownerId === viewer.memberId;
  const starting = mine && startNow;
  const ready =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    ownerId !== null &&
    (!starting || thread.start !== null) &&
    !busy;
  const nameOf = (memberId: MemberId) =>
    memberId === viewer.memberId ? "You" : viewer.nameOf(memberId);

  const create = async () => {
    if (!ready || ownerId === null) return;
    setBusy(true);
    const result = await task({
      environmentId,
      input: {
        type: "create",
        spaceId: space.id,
        title: title.trim(),
        description: description.trim(),
        ownerId,
        status,
        ...(starting && thread.start !== null ? { start: thread.start } : {}),
      },
    });
    setBusy(false);
    if (!reportSpaceResult("Could not create the task", result)) return;
    if (result._tag !== "Success" || result.value.task === null) return;
    close();
    const threadId = result.value.threadId;
    navigation.dispatch(
      threadId === undefined
        ? StackActions.push("SpaceTask", {
            environmentId,
            spaceId: space.id,
            taskId: result.value.task.id,
          })
        : StackActions.push("Thread", { environmentId, threadId }),
    );
  };

  return (
    <SpaceSheetFrame
      header={{
        title: "New task",
        subtitle: space.name,
        onCancel: close,
        dismissDisabled: busy,
        confirm: {
          label: starting ? "Create and start" : "Create task",
          onPress: () => void create(),
          disabled: !ready,
          loading: busy,
        },
      }}
    >
      <SpaceTextField label="Title" autoFocus value={title} onChangeText={setTitle} />
      <SpaceTextField
        label="Description"
        multiline
        value={description}
        onChangeText={setDescription}
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <SpaceSelectRow
            label="Status"
            value={spaceTaskStatusInfo(status).label}
            actions={SPACE_TASK_STATUSES.map((info) => ({
              id: info.status,
              title: info.label,
              state: info.status === status ? "on" : "off",
            }))}
            onSelect={(id) => setStatus(id as SpaceTaskStatus)}
          />
        </View>
        <View className="flex-1">
          <SpaceSelectRow
            label="Owner"
            value={ownerId === null ? "Choose an owner" : nameOf(ownerId)}
            actions={orderSpaceMembers(space).map((member) => ({
              id: member.memberId,
              title: nameOf(member.memberId),
              state: member.memberId === ownerId ? "on" : "off",
            }))}
            onSelect={(id) => setOwnerId(MemberId.make(id))}
          />
        </View>
      </View>
      {mine ? (
        <>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: startNow }}
            onPress={() => setStartNow(!startNow)}
            className="min-h-11 flex-row items-center gap-3 active:opacity-70"
          >
            <SymbolView
              name={startNow ? "checkmark.circle" : "circle"}
              size={20}
              tintColorClassName={startNow ? "accent-icon" : "accent-icon-muted"}
            />
            <Text className="min-w-0 flex-1 text-base text-foreground">Start a thread now</Text>
          </Pressable>
          {startNow ? thread.fields : null}
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          Assigning runs nothing. {ownerId === null ? "The owner" : viewer.nameOf(ownerId)} starts a
          thread when they are ready.
        </Text>
      )}
    </SpaceSheetFrame>
  );
}
