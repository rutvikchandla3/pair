import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  type SpaceConfirm,
  spaceConfirmCopy,
  spaceConfirmMutation,
  spaceConfirmUndo,
} from "@t3tools/client-runtime/spaces";
import { MemberId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { markSpaceLeft, showSpaceUndoNotice } from "./space-notices";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

type Params = SpaceSheetParams & {
  readonly action: SpaceConfirm["type"];
  readonly memberId?: string;
};

export function SpaceConfirmSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const { environmentId, space, viewer } = useSheetSpace(props.route.params);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const close = () => navigation.goBack();
  const { action, memberId } = props.route.params;
  const confirm: SpaceConfirm | null =
    space === null
      ? null
      : action === "remove" || action === "transfer"
        ? memberId === undefined
          ? null
          : { type: action, space, memberId: MemberId.make(memberId) }
        : { type: action, space };
  if (confirm === null) {
    return (
      <SpaceSheetFrame header={{ title: "Space", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const copy = spaceConfirmCopy(confirm, viewer);
  const run = async () => {
    setBusy(true);
    const result = await mutate({ environmentId, input: spaceConfirmMutation(confirm) });
    setBusy(false);
    if (!reportSpaceResult(`Could not ${copy.action.toLowerCase()}`, result)) return;
    close();
    // Leaving turns the room into "You left", which offers the way back itself.
    if (confirm.type === "leave") {
      markSpaceLeft(environmentId, confirm.space.id, true);
      return;
    }
    const undo = spaceConfirmUndo(confirm, viewer);
    if (undo === null) return;
    showSpaceUndoNotice({
      title: undo.title,
      label: undo.label,
      undo: () =>
        void mutate({ environmentId, input: undo.mutation }).then((undone) =>
          reportSpaceResult(undo.failure, undone),
        ),
    });
  };
  return (
    <SpaceSheetFrame header={{ title: copy.title, onCancel: close, dismissDisabled: busy }}>
      <Text className="text-base text-foreground">{copy.description}</Text>
      <View className="flex-row gap-3">
        <Button label="Cancel" disabled={busy} onPress={close} />
        <Button
          label={copy.action}
          tone={copy.destructive ? "danger" : "primary"}
          loading={busy}
          onPress={() => void run()}
        />
      </View>
    </SpaceSheetFrame>
  );
}
