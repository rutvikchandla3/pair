import type { SandboxAccessChip } from "@t3tools/client-runtime/state/sandbox";
import { Pressable, View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";

/** Who can open the thread: avatars and "+N" when shared with people, "Team" for everyone. */
export function ThreadAccessChip(props: { readonly chip: SandboxAccessChip }) {
  const { chip } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chip.label}
      onPress={() => Dialog.alert(chip.label)}
      className="flex-row items-center px-1"
    >
      {chip.kind === "team" ? (
        <View className="flex-row items-center gap-1 rounded-full bg-subtle px-2 py-1">
          <SymbolView name="person.2" size={12} tintColorClassName="accent-icon-muted" />
          <Text className="text-2xs font-t3-medium text-foreground-muted">Team</Text>
        </View>
      ) : (
        <>
          {chip.shown.map((member, index) => (
            <View key={member.id} style={{ marginLeft: index === 0 ? 0 : -6 }}>
              <MemberAvatar member={member} size="md" />
            </View>
          ))}
          {chip.more > 0 ? (
            <Text className="pl-1 text-2xs tabular-nums text-foreground-muted">{`+${chip.more}`}</Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}
