import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { EnvironmentId, type MemberId, type ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { reportSpaceResult, spaceEnvironment, useSpaceViewer } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SpaceField,
  SpaceMemberChecklist,
  SpacePairKeyField,
  SpaceRepositoriesField,
  SpaceTextField,
  useSpaceModel,
} from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";

export function SpaceNewSheet(props: StaticScreenProps<{ readonly environmentId: string }>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const viewer = useSpaceViewer(environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [name, setName] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [brief, setBrief] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlySet<MemberId>>(new Set());
  const [busy, setBusy] = useState(false);
  const model = useSpaceModel(environmentId, repositoryIds[0] ?? null, null).selection;
  const ready = name.trim().length > 0 && repositoryIds.length > 0 && model !== null && !busy;
  const close = () => navigation.goBack();

  const create = async () => {
    if (!ready || model === null) return;
    setBusy(true);
    const result = await mutate({
      environmentId,
      input: {
        type: "create",
        name: name.trim(),
        brief: brief.trim(),
        repositoryIds,
        memberIds: [...memberIds],
        modelSelection: model,
      },
    });
    setBusy(false);
    if (!reportSpaceResult("Could not create the space", result)) return;
    if (result._tag !== "Success" || result.value.space === null) return;
    close();
    navigation.dispatch(
      StackActions.push("SpaceRoom", { environmentId, spaceId: result.value.space.id }),
    );
  };

  return (
    <SpaceSheetFrame
      header={{
        title: "New space",
        subtitle: "Only members see this space. A thread runs on the account of whoever starts it.",
        onCancel: close,
        dismissDisabled: busy,
        confirm: {
          label: "Create",
          onPress: () => void create(),
          disabled: !ready,
          loading: busy,
        },
      }}
    >
      <SpaceTextField
        label="Name"
        autoFocus
        value={name}
        placeholder="Question creation"
        onChangeText={setName}
      />
      <SpaceField label="Members">
        <SpaceMemberChecklist
          environmentId={environmentId}
          exclude={new Set(viewer.memberId === null ? [] : [viewer.memberId])}
          value={memberIds}
          onChange={setMemberIds}
        />
      </SpaceField>
      <SpaceRepositoriesField
        environmentId={environmentId}
        value={repositoryIds}
        spaceName={name}
        note="New threads start here by default. You can pick another when you start one."
        onChange={setRepositoryIds}
      />
      <SpaceTextField
        label="Brief (optional)"
        multiline
        value={brief}
        placeholder="What this space is for. Pair reads it before every reply."
        onChangeText={setBrief}
      />
      <SpacePairKeyField environmentId={environmentId} />
    </SpaceSheetFrame>
  );
}
