import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";

/** Inbox, My tasks and Shared with you: back, a large title, and what sits at its end. */
export function PageTopBar(props: { readonly title: string; readonly trailing?: ReactNode }) {
  const navigation = useNavigation();
  return (
    <View className="gap-1 border-b border-border-subtle px-2 pb-2">
      <View className="min-h-12 flex-row items-center">
        <IconButton
          icon="chevron.left"
          accessibilityLabel="Back"
          onPress={() => navigation.goBack()}
        />
      </View>
      <View className="min-h-10 flex-row items-center gap-2 px-2">
        <Text
          accessibilityRole="header"
          className="min-w-0 flex-1 text-3xl font-t3-bold text-foreground"
        >
          {props.title}
        </Text>
        {props.trailing}
      </View>
    </View>
  );
}
