import { FORMER_MEMBER, otherMessageAuthorId } from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, MemberId } from "@t3tools/contracts";
import { View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { useTeamAttribution } from "../../state/team";

/** A teammate's name and avatar above their message; nothing for mine or on a solo server. */
export function MessageAuthorName(props: {
  readonly environmentId: EnvironmentId;
  readonly authorId: MemberId;
  readonly attribution: string | null;
}) {
  const team = useTeamAttribution(props.environmentId);
  const authorId = otherMessageAuthorId({
    isTeamMode: team.isTeamMode,
    currentMemberId: team.currentMemberId,
    message: { authorId: props.authorId },
    attribution: props.attribution,
  });
  if (authorId === undefined) return null;
  const member = team.members.get(authorId) ?? FORMER_MEMBER;
  return (
    <View className="mb-1 flex-row items-center gap-1.5 pr-1">
      <MemberAvatar member={member} size="sm" />
      <Text className="font-t3-medium text-2xs text-foreground-muted" numberOfLines={1}>
        {member.name}
      </Text>
    </View>
  );
}
