import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, MemberId, Space, SpaceMutation } from "@t3tools/contracts";
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

export type SpaceConfirm =
  | { readonly type: "archive"; readonly space: Space }
  | { readonly type: "leave"; readonly space: Space }
  | { readonly type: "remove"; readonly space: Space; readonly memberId: MemberId }
  | { readonly type: "transfer"; readonly space: Space; readonly memberId: MemberId };

function copyOf(confirm: SpaceConfirm, viewer: SpaceViewer) {
  const name =
    confirm.type === "remove" || confirm.type === "transfer" ? viewer.nameOf(confirm.memberId) : "";
  switch (confirm.type) {
    case "archive":
      return {
        title: `Archive ${confirm.space.name}?`,
        description: `It becomes read-only for all ${activeMemberCount(confirm.space)} members and moves to Archived in the sidebar. Running tasks keep running.`,
        action: "Archive",
        destructive: false,
      };
    case "leave":
      return {
        title: `Leave ${confirm.space.name}?`,
        description:
          "You stop getting its messages and can no longer open it. Tasks you own stay yours.",
        action: "Leave",
        destructive: true,
      };
    case "remove":
      return {
        title: `Remove ${name}?`,
        description: `${name} can no longer open ${confirm.space.name}. Tasks they own stay with them.`,
        action: "Remove",
        destructive: true,
      };
    case "transfer":
      return {
        title: `Make ${name} the owner?`,
        description: `${name} can then manage members, archive the space and choose who pays for Pair. You stay a member.`,
        action: "Make owner",
        destructive: false,
      };
  }
}

const activeMemberCount = (space: Space) =>
  space.members.filter((member) => member.removedAt === null).length;

function mutationOf(confirm: SpaceConfirm): SpaceMutation {
  const spaceId = confirm.space.id;
  switch (confirm.type) {
    case "archive":
      return { type: "archive", spaceId };
    case "leave":
      return { type: "leave", spaceId };
    case "remove":
      return { type: "member.remove", spaceId, memberId: confirm.memberId };
    case "transfer":
      return { type: "owner.transfer", spaceId, ownerId: confirm.memberId };
  }
}

/** The way back, offered in the toast after the change lands. */
function undoOf(confirm: SpaceConfirm): { label: string; mutation: SpaceMutation } | null {
  const spaceId = confirm.space.id;
  switch (confirm.type) {
    case "archive":
      return { label: "Undo", mutation: { type: "unarchive", spaceId } };
    case "remove":
      return {
        label: "Undo",
        mutation: { type: "member.add", spaceId, memberIds: [confirm.memberId], restore: true },
      };
    case "leave":
      return { label: "Ask to be added back", mutation: { type: "join.request", spaceId } };
    case "transfer":
      return null;
  }
}

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
  const copy = copyOf(confirm, props.viewer);

  const run = async () => {
    setBusy(true);
    const result = await mutate({ environmentId: props.environmentId, input: mutationOf(confirm) });
    setBusy(false);
    toastCommandFailure(`Could not ${copy.action.toLowerCase()}`, result);
    if (result._tag !== "Success") return;
    props.onClose();
    if (confirm.type === "leave") void navigate({ to: "/" });
    const undo = undoOf(confirm);
    if (undo === null) return;
    const id = toastManager.add({
      type: "success",
      title:
        confirm.type === "remove"
          ? `Removed ${props.viewer.nameOf(confirm.memberId)}`
          : confirm.type === "leave"
            ? `Left ${confirm.space.name}`
            : `Archived ${confirm.space.name}`,
      actionProps: {
        children: undo.label,
        onClick: () => {
          toastManager.close(id);
          void mutate({ environmentId: props.environmentId, input: undo.mutation }).then((undone) =>
            toastCommandFailure(
              confirm.type === "leave" ? "Could not ask to join" : "Could not undo",
              undone,
            ),
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
