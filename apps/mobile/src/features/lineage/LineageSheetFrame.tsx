import type { ReactNode } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";

/** The routed sheets of Branch off, Update, Offer and the lineage list, laid out as Cloud's are. */
export function LineageSheetFrame(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const android = Platform.OS === "android";
  const header = (
    <SheetHeader
      presentation={android ? "inline" : "native"}
      title={props.title}
      {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
      onCancel={props.onClose}
      accessibilityLabel={props.closeLabel}
    />
  );
  return (
    // Material sheet drags follow the first nested-scrolling native view, so Android renders
    // content first and reverses the column, as ContinueInCloudSheet does.
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {android ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {android ? null : header}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 pb-6 gap-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {props.children}
        </ScrollView>
      </ScreenContent>
      {android ? header : null}
    </View>
  );
}
