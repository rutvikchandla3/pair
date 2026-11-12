import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { orderSpaceMembers } from "@t3tools/client-runtime/spaces";
import type { MemberId } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

export function SpaceMembersSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, controls, viewer } = useSheetSpace(props.route.params);
  const { members: roster } = useTeamRoster(environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const close = () => navigation.goBack();
  if (space === null || controls === null) {
    return (
      <SpaceSheetFrame header={{ title: "Members", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const row = (memberId: MemberId, trailing: ReactNode) => {
    const name = viewer.nameOf(memberId);
    return (
      <View key={memberId} className="min-h-12 flex-row items-center gap-3">
        <MemberAvatar member={{ name, color: roster.get(memberId)?.color ?? "#71717a" }} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
          {name}
          {memberId === viewer.memberId ? (
            <Text className="text-base text-foreground-muted"> (you)</Text>
          ) : null}
        </Text>
        {trailing}
      </View>
    );
  };
  const add = async (memberId: MemberId) => {
    setBusy(true);
    const result = await mutate({
      environmentId,
      input: { type: "member.add", spaceId: space.id, memberIds: [memberId] },
    });
    setBusy(false);
    reportSpaceResult("Could not add", result);
  };
  const requests = controls.canManage ? space.joinRequests : [];
  const openSettings = () =>
    navigation.dispatch(
      StackActions.replace("SpaceSettings", { environmentId, spaceId: space.id }),
    );
  return (
    <SpaceSheetFrame header={{ title: "Members", onClose: close }}>
      <View>
        {orderSpaceMembers(space).map((member) =>
          row(
            member.memberId,
            member.memberId === space.ownerId ? (
              <Text className="text-xs text-foreground-muted">Owner</Text>
            ) : null,
          ),
        )}
      </View>
      {requests.length > 0 ? (
        <View>
          <Text className="pb-1 text-sm font-t3-medium text-foreground-muted">Asked to join</Text>
          {requests.map((request) =>
            row(
              request.memberId,
              <Button
                label="Add"
                accessibilityLabel={`Add ${viewer.nameOf(request.memberId)}`}
                tone="primary"
                size="compact"
                disabled={busy}
                onPress={() => void add(request.memberId)}
              />,
            ),
          )}
        </View>
      ) : null}
      {controls.isMember ? (
        <Button
          label={controls.canManage ? "Add people" : "Space settings"}
          icon={controls.canManage ? "plus" : "gearshape"}
          onPress={openSettings}
        />
      ) : null}
      <Text className="text-xs text-foreground-muted">Only members can see this space.</Text>
    </SpaceSheetFrame>
  );
}
