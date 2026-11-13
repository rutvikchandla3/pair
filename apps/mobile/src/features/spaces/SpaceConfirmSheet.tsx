import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  type SpaceConfirm,
  orderSpaceMembers,
  spaceConfirmCopy,
  spaceConfirmMutation,
  spaceConfirmUndo,
  spaceDefaultReassignTo,
  spaceOpenTaskCount,
} from "@t3tools/client-runtime/spaces";
import { MemberId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { markSpaceLeft, showSpaceUndoNotice } from "./space-notices";
import { SpaceSelectRow } from "./SpaceFields";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

type Params = SpaceSheetParams & {
  readonly action: SpaceConfirm["type"];
  readonly memberId?: string;
};

export function SpaceConfirmSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const { environmentId, space, viewer, tasks } = useSheetSpace(props.route.params);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [reassign, setReassign] = useState(true);
  const [picked, setPicked] = useState<MemberId | null>(null);
  const close = () => navigation.goBack();
  const { action, memberId } = props.route.params;
  const leaving = action === "leave" ? viewer.memberId : null;
  const departing =
    action === "remove" && memberId !== undefined ? MemberId.make(memberId) : leaving;
  const openTasks = departing === null ? 0 : spaceOpenTaskCount(tasks, departing);
  const reassignTo =
    space === null || openTasks === 0 || !reassign || (action !== "remove" && action !== "leave")
      ? null
      : (picked ?? spaceDefaultReassignTo(action, space, viewer));
  const confirm: SpaceConfirm | null =
    space === null
      ? null
      : action === "remove"
        ? departing === null
          ? null
          : { type: action, space, memberId: departing, reassignTo }
        : action === "transfer"
          ? memberId === undefined
            ? null
            : { type: action, space, memberId: MemberId.make(memberId) }
          : action === "leave"
            ? { type: action, space, reassignTo }
            : { type: action, space };
  if (confirm === null) {
    return (
      <SpaceSheetFrame header={{ title: "Space", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const copy = spaceConfirmCopy(confirm, viewer, openTasks);
  const candidates = orderSpaceMembers(confirm.space).filter(
    (member) => member.memberId !== departing,
  );
  const nameOf = (id: MemberId) => (id === viewer.memberId ? "You" : viewer.nameOf(id));
  const departingName = departing === null ? "" : viewer.nameOf(departing);
  const note =
    copy.reassignLabel === null
      ? copy.note
      : reassignTo !== null
        ? `They move to ${reassignTo === viewer.memberId ? "your" : `${viewer.nameOf(reassignTo)}'s`} Assigned to me. ${
            confirm.type === "leave"
              ? "Your threads stay on the tasks and keep running on your account."
              : (copy.note ?? "")
          }`
        : confirm.type === "leave"
          ? "They stay yours, shown as removed, and leave your Assigned to me."
          : `They stay on ${departingName}, shown as ${departingName} (removed), and leave ${departingName}'s Assigned to me.`;
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
    const undo = spaceConfirmUndo(confirm, viewer, openTasks);
    if (undo === null) return;
    showSpaceUndoNotice({
      title: undo.title,
      action: {
        label: undo.label,
        run: () =>
          void mutate({ environmentId, input: undo.mutation }).then((undone) => {
            if (reportSpaceResult(undo.failure, undone) && undo.restored !== undefined) {
              showSpaceUndoNotice({ title: undo.restored });
            }
          }),
      },
    });
  };
  return (
    <SpaceSheetFrame header={{ title: copy.title, onCancel: close, dismissDisabled: busy }}>
      <Text className="text-base text-foreground">{copy.description}</Text>
      {copy.reassignLabel === null ? null : (
        <View className="gap-3">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: reassign }}
            onPress={() => setReassign(!reassign)}
            className="min-h-11 flex-row items-center gap-3 active:opacity-70"
          >
            <SymbolView
              name={reassign ? "checkmark.circle" : "circle"}
              size={20}
              tintColorClassName={reassign ? "accent-icon" : "accent-icon-muted"}
            />
            <Text className="min-w-0 flex-1 text-base text-foreground">{copy.reassignLabel}</Text>
          </Pressable>
          {reassign && reassignTo !== null ? (
            <SpaceSelectRow
              label="Reassign to"
              value={nameOf(reassignTo)}
              actions={candidates.map((member) => ({
                id: member.memberId,
                title: nameOf(member.memberId),
                state: member.memberId === reassignTo ? "on" : "off",
              }))}
              onSelect={(id) => setPicked(MemberId.make(id))}
            />
          ) : null}
        </View>
      )}
      {note === null ? null : <Text className="text-sm text-foreground-muted">{note}</Text>}
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
