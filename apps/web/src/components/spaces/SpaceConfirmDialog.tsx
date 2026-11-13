import {
  type SpaceConfirm,
  type SpaceViewer,
  orderSpaceMembers,
  spaceConfirmCopy,
  spaceConfirmMutation,
  spaceConfirmUndo,
  spaceOpenTaskCount,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, MemberId, SpaceTask } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { spaceEnvironment } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

export function SpaceConfirmDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly viewer: SpaceViewer;
  readonly confirm: SpaceConfirm | null;
  /** The space's tasks, for how many open ones a removal or leave hands over. */
  readonly tasks: ReadonlyArray<SpaceTask>;
  readonly onClose: () => void;
}) {
  if (props.confirm === null) return null;
  return <ConfirmDialog {...props} confirm={props.confirm} />;
}

function ConfirmDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly viewer: SpaceViewer;
  readonly confirm: SpaceConfirm;
  readonly tasks: ReadonlyArray<SpaceTask>;
  readonly onClose: () => void;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Update space");
  const navigate = useNavigate();
  const roster = useTeamMembers(props.environmentId);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(props.confirm);
  const { viewer } = props;
  const leaving: MemberId | null =
    confirm.type === "remove"
      ? confirm.memberId
      : confirm.type === "leave"
        ? viewer.memberId
        : null;
  const openTasks = leaving === null ? 0 : spaceOpenTaskCount(props.tasks, leaving);
  const copy = spaceConfirmCopy(confirm, viewer, openTasks);
  const reassignTo =
    confirm.type === "remove" || confirm.type === "leave" ? confirm.reassignTo : null;
  const heirs = orderSpaceMembers(confirm.space).filter((member) => member.memberId !== leaving);
  const nameOf = (memberId: MemberId) =>
    memberId === viewer.memberId ? "You" : viewer.nameOf(memberId);
  const avatar = (memberId: MemberId) => (
    <MemberAvatar
      size="sm"
      member={{
        name: viewer.nameOf(memberId),
        color: roster.get(memberId)?.color ?? "var(--muted-foreground)",
      }}
    />
  );

  const run = async () => {
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: spaceConfirmMutation(confirm),
    });
    setBusy(false);
    toastCommandFailure(`Could not ${copy.action.toLowerCase()}`, result);
    if (result._tag !== "Success") return;
    props.onClose();
    if (confirm.type === "leave") void navigate({ to: "/" });
    const undo = spaceConfirmUndo(confirm, viewer, openTasks);
    if (undo === null) return;
    const id = toastManager.add({
      type: "success",
      title: undo.title,
      ...(undo.description === null ? {} : { description: undo.description }),
      actionProps: {
        children: undo.label,
        onClick: () => {
          toastManager.close(id);
          void mutate({ environmentId: props.environmentId, input: undo.mutation }).then(
            (undone) => {
              toastCommandFailure(undo.failure, undone);
              if (undone._tag === "Success" && undo.restored !== undefined) {
                toastManager.add({ type: "success", title: undo.restored });
              }
            },
          );
        },
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {copy.reassignLabel !== null || copy.note !== null || confirm.type === "transfer" ? (
          <DialogPanel>
            <div className="flex flex-col gap-3 text-sm">
              {confirm.type === "transfer" ? (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">New owner</span>
                  {avatar(confirm.memberId)}
                  <span className="font-medium">{viewer.nameOf(confirm.memberId)}</span>
                </div>
              ) : null}
              {copy.reassignLabel !== null &&
              (confirm.type === "remove" || confirm.type === "leave") ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>{copy.reassignLabel}</span>
                  <Select
                    value={reassignTo ?? ""}
                    onValueChange={(value) =>
                      setConfirm({ ...confirm, reassignTo: value as MemberId })
                    }
                  >
                    <SelectTrigger size="sm" aria-label="Reassign to">
                      <SelectValue>
                        {reassignTo === null ? (
                          "Choose"
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {avatar(reassignTo)}
                            {nameOf(reassignTo)}
                          </span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {heirs.map((member) => (
                        <SelectItem key={member.memberId} value={member.memberId}>
                          <span className="flex items-center gap-1.5">
                            {avatar(member.memberId)}
                            {nameOf(member.memberId)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              {copy.note === null ? null : <p className="text-muted-foreground">{copy.note}</p>}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={copy.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void run()}
          >
            {copy.action}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
