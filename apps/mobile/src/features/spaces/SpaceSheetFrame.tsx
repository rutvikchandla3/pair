import type { ReactNode } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import type { SheetHeaderProps } from "../../components/ui/SheetHeader.types";
import { NativeStackScreenOptions } from "../../native/StackHeader";

type HeaderProps = SheetHeaderProps & { readonly presentation?: never };

/** The Spaces sheets' shell, laid out like Share: a header, then one scrolling column. */
export function SpaceSheetFrame(props: {
  readonly header: HeaderProps;
  readonly children: ReactNode;
  /** Pinned under the scrolling column, such as a sheet's primary action. */
  readonly footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const android = Platform.OS === "android";
  const header = <SheetHeader {...props.header} presentation={android ? "inline" : "native"} />;
  return (
    // Material sheet drags follow the first nested-scrolling native view, and the inline
    // header's buttons are one, so Android renders content first and reverses the column.
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
          contentContainerStyle={{
            paddingBottom: props.footer ? 18 : Math.max(insets.bottom, 18) + 18,
          }}
        >
          {props.children}
        </ScrollView>
        {props.footer ? (
          <View className="px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 18) }}>
            {props.footer}
          </View>
        ) : null}
      </ScreenContent>
      {android ? header : null}
    </View>
  );
}
