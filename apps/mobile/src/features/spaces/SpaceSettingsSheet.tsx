import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { isSpaceOwner, orderSpaceMembers } from "@t3tools/client-runtime/spaces";
import type { MemberId, ProjectId, SpacePairBilling } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SpaceBillingRow,
  SpaceField,
  SpaceMemberChecklist,
  SpaceProjectRow,
  SpaceTextField,
} from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

export function SpaceSettingsSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, controls, viewer } = useSheetSpace(props.route.params);
  const { members: roster } = useTeamRoster(environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [name, setName] = useState<string | null>(null);
  const [adding, setAdding] = useState<ReadonlySet<MemberId>>(new Set());
  const [busy, setBusy] = useState(false);
  const close = () => navigation.goBack();
  if (space === null || controls === null) {
    return (
      <SpaceSheetFrame header={{ title: "Space settings", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const members = orderSpaceMembers(space);
  const apply = async (input: Parameters<typeof mutate>[0]["input"], failure: string) => {
    setBusy(true);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    return reportSpaceResult(failure, result);
  };
  const update = (patch: {
    name?: string;
    projectId?: ProjectId;
    pairBilling?: SpacePairBilling;
  }) => apply({ type: "update", spaceId: space.id, ...patch }, "Could not update the space");
  const addMembers = async (memberIds: ReadonlyArray<MemberId>) => {
    const added = await apply(
      { type: "member.add", spaceId: space.id, memberIds: [...memberIds] },
      "Could not add",
    );
    if (added) setAdding(new Set());
  };
  const confirm = (action: "leave" | "archive" | "remove" | "transfer", memberId?: MemberId) =>
    navigation.dispatch(
      StackActions.replace("SpaceConfirm", {
        environmentId,
        spaceId: space.id,
        action,
        ...(memberId === undefined ? {} : { memberId }),
      }),
    );
  const saveName = () => {
    const next = name?.trim() ?? "";
    setName(null);
    if (next !== "" && next !== space.name) void update({ name: next });
  };

  return (
    <SpaceSheetFrame
      header={{
        title: "Space settings",
        subtitle: controls.canManage
          ? "Only you, the owner, can change these."
          : `${viewer.nameOf(space.ownerId)} owns this space.`,
        onClose: close,
      }}
    >
      <SpaceTextField
        label="Name"
        value={name ?? space.name}
        editable={controls.canManage}
        onChangeText={setName}
        onBlur={saveName}
      />
      <SpaceProjectRow
        environmentId={environmentId}
        value={space.projectId}
        disabled={!controls.canManage}
        onChange={(projectId) => void update({ projectId })}
      />
      <SpaceBillingRow
        value={space.pairBilling}
        viewer={viewer}
        disabled={!controls.canManage}
        onChange={(pairBilling) => void update({ pairBilling })}
      />
      <SpaceField label={`Members (${members.length})`}>
        {members.map((member) => {
          const isOwner = isSpaceOwner(space, member.memberId);
          const memberName = viewer.nameOf(member.memberId);
          return (
            <View key={member.memberId} className="min-h-12 flex-row items-center gap-3">
              <MemberAvatar
                member={{
                  name: memberName,
                  color: roster.get(member.memberId)?.color ?? "#71717a",
                }}
              />
              <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
                {memberName}
                {member.memberId === viewer.memberId ? (
                  <Text className="text-base text-foreground-muted"> (you)</Text>
                ) : null}
              </Text>
              {isOwner ? <Text className="text-xs text-foreground-muted">Owner</Text> : null}
              {controls.canManage && !isOwner ? (
                <>
                  <Button
                    label="Make owner"
                    accessibilityLabel={`Make ${memberName} owner`}
                    tone="text"
                    size="compact"
                    onPress={() => confirm("transfer", member.memberId)}
                  />
                  <Button
                    label="Remove"
                    accessibilityLabel={`Remove ${memberName}`}
                    tone="danger"
                    size="compact"
                    onPress={() => confirm("remove", member.memberId)}
                  />
                </>
              ) : null}
            </View>
          );
        })}
      </SpaceField>
      {controls.canManage && space.joinRequests.length > 0 ? (
        <SpaceField label="Asked to join">
          {space.joinRequests.map((request) => (
            <View key={request.memberId} className="min-h-12 flex-row items-center gap-3">
              <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
                {viewer.nameOf(request.memberId)}
              </Text>
              <Button
                label="Add"
                accessibilityLabel={`Add ${viewer.nameOf(request.memberId)}`}
                tone="primary"
                size="compact"
                disabled={busy}
                onPress={() => void addMembers([request.memberId])}
              />
            </View>
          ))}
        </SpaceField>
      ) : null}
      {controls.canManage ? (
        <SpaceField label="Add members">
          <SpaceMemberChecklist
            environmentId={environmentId}
            exclude={
              new Set([
                ...members.map((member) => member.memberId),
                ...space.joinRequests.map((request) => request.memberId),
              ])
            }
            value={adding}
            onChange={setAdding}
          />
          {adding.size > 0 ? (
            <Button
              label={`Add ${adding.size}`}
              tone="primary"
              loading={busy}
              onPress={() => void addMembers([...adding])}
            />
          ) : null}
        </SpaceField>
      ) : null}
      {controls.canLeave || controls.canArchive ? (
        <View className="gap-3 pt-2">
          {controls.canArchive ? (
            <Button label="Archive space" icon="archivebox" onPress={() => confirm("archive")} />
          ) : null}
          {controls.canLeave ? (
            <Button label="Leave space" tone="danger" onPress={() => confirm("leave")} />
          ) : null}
        </View>
      ) : null}
    </SpaceSheetFrame>
  );
}
