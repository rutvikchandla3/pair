import type { PresentMember } from "@t3tools/client-runtime/state/presence";
import { View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppText as Text } from "../../components/ui/AppText";

const SHOWN = 3;

/** Teammates viewing this thread; away members are dimmed. */
export function ThreadViewerStack(props: { readonly viewers: ReadonlyArray<PresentMember> }) {
  const shown = props.viewers.slice(0, SHOWN);
  const overflow = props.viewers.length - shown.length;
  return (
    <View
      accessible
      accessibilityLabel={`Viewing: ${props.viewers.map((viewer) => viewer.name).join(", ")}`}
      className="flex-row items-center px-1"
    >
      {shown.map((viewer, index) => (
        <View
          key={viewer.id}
          style={{ marginLeft: index === 0 ? 0 : -6, opacity: viewer.away ? 0.5 : 1 }}
        >
          <MemberAvatar member={viewer} size="md" />
        </View>
      ))}
      {overflow > 0 ? (
        <Text className="pl-1 text-2xs tabular-nums text-foreground-muted">{`+${overflow}`}</Text>
      ) : null}
    </View>
  );
}
