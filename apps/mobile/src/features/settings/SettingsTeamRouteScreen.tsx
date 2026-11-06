import { activeTeamMembers, type TeamViewer } from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, TeamMember } from "@t3tools/contracts";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { usePresence } from "../../state/presence";
import { useTeamViewers } from "../../state/team";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const STATUS_LABELS = { online: "Online", away: "Away" } as const;

function sortMembers(members: ReadonlyArray<TeamMember>): ReadonlyArray<TeamMember> {
  return [...members].sort(
    (left, right) =>
      Number(right.isOwner) - Number(left.isOwner) ||
      Number(right.role === "admin") - Number(left.role === "admin") ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function TeamMemberRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly isSelf: boolean;
}) {
  // Other members only, so your own row and offline members have no status.
  const status = usePresence(props.environmentId).members.get(props.member.id);
  const role = props.member.role === "admin" ? "Admin" : "Member";
  const detail = props.isSelf ? "You" : status === undefined ? null : STATUS_LABELS[status];
  return (
    <View
      accessible
      accessibilityLabel={[props.member.name, role, detail].filter(Boolean).join(", ")}
      className="min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3"
    >
      <MemberAvatar member={props.member} size="md" />
      <View className="min-w-0 flex-1 gap-1">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {props.member.name}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {role}
        </Text>
      </View>
      {detail !== null ? (
        <Text textRole="footnote" className="shrink-0 text-foreground-muted">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function TeamSection(props: {
  readonly environmentId: EnvironmentId;
  readonly viewer: TeamViewer;
  readonly title: string | undefined;
  readonly footer: string | undefined;
}) {
  return (
    <SettingsSection title={props.title} footer={props.footer}>
      {sortMembers(activeTeamMembers(props.viewer.members)).map((member) => (
        <TeamMemberRow
          key={member.id}
          environmentId={props.environmentId}
          member={member}
          isSelf={member.id === props.viewer.memberId}
        />
      ))}
    </SettingsSection>
  );
}

/** Read-only: members are invited, changed and removed on the web. */
export function SettingsTeamRouteScreen() {
  const insets = useSafeAreaInsets();
  const viewers = [...useTeamViewers()];
  const { savedConnectionsById } = useSavedRemoteConnections();
  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {viewers.map(([environmentId, viewer], index) => (
        <TeamSection
          key={environmentId}
          environmentId={environmentId}
          viewer={viewer}
          title={
            viewers.length > 1
              ? (savedConnectionsById[environmentId]?.environmentLabel ?? "Team server")
              : undefined
          }
          footer={index === viewers.length - 1 ? "Manage members on the web." : undefined}
        />
      ))}
    </ScrollView>
  );

  return Platform.OS === "android" ? (
    <SettingsScreen title="Team">{content}</SettingsScreen>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {content}
    </View>
  );
}
