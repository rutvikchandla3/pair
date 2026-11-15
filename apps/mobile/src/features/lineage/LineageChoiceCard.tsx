import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

/** One of a sheet's two-option choices, with what it means on its second line. */
export function LineageChoiceCard(props: {
  readonly label: string;
  readonly subtitle: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${props.label}, ${props.subtitle}`}
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={cn(
        "flex-row items-start gap-3 rounded-xl border px-3.5 py-3",
        props.selected ? "border-primary bg-card" : "border-border bg-card",
      )}
    >
      <View
        className={cn(
          "mt-0.5 size-4 items-center justify-center rounded-full border",
          props.selected ? "border-primary" : "border-border",
        )}
      >
        {props.selected ? <View className="size-2 rounded-full bg-primary" /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
        <Text className="text-xs text-foreground-muted">{props.subtitle}</Text>
      </View>
    </Pressable>
  );
}
