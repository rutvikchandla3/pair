import type { Bot } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { botInitial } from "./botsModel";

/** A bot's avatar: its assigned colour as a rounded square with the name's initial. */
export function BotAvatar(props: {
  readonly bot: Pick<Bot, "name" | "color">;
  readonly size?: number;
}) {
  const size = props.size ?? 32;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      className="items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: props.bot.color,
      }}
    >
      <Text
        className="font-t3-bold text-white"
        style={{ fontSize: Math.round(size * 0.44), lineHeight: Math.round(size * 0.5) }}
      >
        {botInitial(props.bot.name)}
      </Text>
    </View>
  );
}
