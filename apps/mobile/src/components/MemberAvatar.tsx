import { memberInitials } from "@t3tools/client-runtime/state/team";
import type { TeamMember } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";

const SIZES = {
  sm: { box: 18, font: 8 },
  md: { box: 24, font: 10 },
} as const;

export function MemberAvatar(props: {
  readonly member: Pick<TeamMember, "name" | "color">;
  readonly size?: keyof typeof SIZES;
}) {
  const size = SIZES[props.size ?? "md"];
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={props.member.name}
      className="items-center justify-center rounded-full"
      style={{ width: size.box, height: size.box, backgroundColor: props.member.color }}
    >
      <Text
        importantForAccessibility="no"
        className="font-t3-bold text-white"
        style={{ fontSize: size.font, lineHeight: size.font + 2 }}
      >
        {memberInitials(props.member.name)}
      </Text>
    </View>
  );
}
