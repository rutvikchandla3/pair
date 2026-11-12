import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import {
  EnvironmentId,
  type MemberId,
  type ProjectId,
  type SpacePairBilling,
} from "@t3tools/contracts";
import { useState } from "react";

import { reportSpaceResult, spaceEnvironment, useSpaceViewer } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SpaceBillingRow,
  SpaceField,
  SpaceMemberChecklist,
  SpaceProjectRow,
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
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [brief, setBrief] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlySet<MemberId>>(new Set());
  const [billing, setBilling] = useState<SpacePairBilling>({ type: "team" });
  const [busy, setBusy] = useState(false);
  const model = useSpaceModel(environmentId, projectId, null).selection;
  const ready = name.trim().length > 0 && projectId !== null && model !== null && !busy;
  const close = () => navigation.goBack();

  const create = async () => {
    if (!ready || projectId === null || model === null) return;
    setBusy(true);
    const result = await mutate({
      environmentId,
      input: {
        type: "create",
        name: name.trim(),
        brief: brief.trim(),
        projectId,
        memberIds: [...memberIds],
        pairBilling: billing,
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
        subtitle: "A room for your team and Pair, with its own tasks.",
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
      <SpaceProjectRow environmentId={environmentId} value={projectId} onChange={setProjectId} />
      <SpaceField label="Members">
        <SpaceMemberChecklist
          environmentId={environmentId}
          exclude={new Set(viewer.memberId === null ? [] : [viewer.memberId])}
          value={memberIds}
          onChange={setMemberIds}
        />
      </SpaceField>
      <SpaceTextField
        label="Brief"
        multiline
        value={brief}
        placeholder="What this space is for. Pair reads it before every reply."
        onChangeText={setBrief}
      />
      <SpaceBillingRow value={billing} viewer={viewer} onChange={setBilling} />
    </SpaceSheetFrame>
  );
}
