import {
  type SpaceConfirm,
  type SpaceViewer,
  spaceConfirmCopy,
  spaceConfirmMutation,
  spaceConfirmUndo,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

export function SpaceConfirmDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly viewer: SpaceViewer;
  readonly confirm: SpaceConfirm | null;
  readonly onClose: () => void;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Update space");
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const confirm = props.confirm;
  if (confirm === null) return null;
  const copy = spaceConfirmCopy(confirm, props.viewer);

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
    const undo = spaceConfirmUndo(confirm, props.viewer);
    if (undo === null) return;
    const id = toastManager.add({
      type: "success",
      title: undo.title,
      actionProps: {
        children: undo.label,
        onClick: () => {
          toastManager.close(id);
          void mutate({ environmentId: props.environmentId, input: undo.mutation }).then((undone) =>
            toastCommandFailure(undo.failure, undone),
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
