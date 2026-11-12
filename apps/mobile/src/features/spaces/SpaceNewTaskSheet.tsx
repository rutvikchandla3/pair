import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { orderSpaceMembers } from "@t3tools/client-runtime/spaces";
import { MemberId, type ModelSelection } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceModelRow, SpaceSelectRow, SpaceTextField, useSpaceModel } from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

export function SpaceNewTaskSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, viewer } = useSheetSpace(props.route.params);
  const task = useAtomCommand(spaceEnvironment.task, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState<MemberId | null>(viewer.memberId);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("main");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const model = useSpaceModel(environmentId, space?.projectId ?? null, picked).selection;
  const close = () => navigation.goBack();
  if (space === null) {
    return (
      <SpaceSheetFrame header={{ title: "New task", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const mine = ownerId !== null && ownerId === viewer.memberId;
  const ready =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    baseRef.trim().length > 0 &&
    ownerId !== null &&
    model !== null &&
    !busy;
  const nameOf = (memberId: MemberId) =>
    memberId === viewer.memberId ? "You" : viewer.nameOf(memberId);

  const create = async () => {
    if (!ready || ownerId === null || model === null) return;
    setBusy(true);
    const result = await task({
      environmentId,
      input: {
        type: "create",
        spaceId: space.id,
        title: title.trim(),
        description: description.trim(),
        ownerId,
        modelSelection: model,
        base: {
          baseRef: baseRef.trim(),
          ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
        },
      },
    });
    setBusy(false);
    if (!reportSpaceResult("Could not create the task", result)) return;
    if (result._tag !== "Success") return;
    close();
    if (mine) {
      navigation.dispatch(
        StackActions.push("Thread", { environmentId, threadId: result.value.threadId }),
      );
    }
  };

  return (
    <SpaceSheetFrame
      header={{
        title: `New task in ${space.name}`,
        subtitle: mine
          ? "It starts at once on your account."
          : "It waits for its owner to start it on their account.",
        onCancel: close,
        dismissDisabled: busy,
        confirm: {
          label: mine ? "Create and start" : "Create task",
          onPress: () => void create(),
          disabled: !ready,
          loading: busy,
        },
      }}
    >
      <SpaceTextField label="Title" autoFocus value={title} onChangeText={setTitle} />
      <SpaceTextField
        label="What to do"
        multiline
        value={description}
        onChangeText={setDescription}
      />
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
      {mine ? (
        <SpaceModelRow
          environmentId={environmentId}
          projectId={space.projectId}
          value={picked}
          onChange={setPicked}
        />
      ) : null}
      <View className="flex-row gap-3">
        <View className="flex-1">
          <SpaceTextField label="Base" value={baseRef} onChangeText={setBaseRef} />
        </View>
        <View className="flex-1">
          <SpaceTextField
            label="Branch (optional)"
            value={branch}
            placeholder="New from base"
            onChangeText={setBranch}
          />
        </View>
      </View>
    </SpaceSheetFrame>
  );
}
