import { spaceMark } from "@t3tools/client-runtime/spaces";
import type { Space } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

const SIZES = {
  sm: { box: 16, font: 9, radius: 4 },
  md: { box: 20, font: 11, radius: 5 },
  lg: { box: 32, font: 15, radius: 8 },
  xl: { box: 44, font: 22, radius: 12 },
} as const;

export function SpaceMark(props: {
  readonly space: Pick<Space, "id" | "name">;
  readonly size?: keyof typeof SIZES;
}) {
  const size = SIZES[props.size ?? "md"];
  const mark = spaceMark(props.space);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      className="items-center justify-center"
      style={{
        width: size.box,
        height: size.box,
        borderRadius: size.radius,
        backgroundColor: mark.color,
      }}
    >
      <Text
        className="font-t3-bold text-white"
        style={{ fontSize: size.font, lineHeight: size.font + 2 }}
      >
        {mark.letter}
      </Text>
    </View>
  );
}
