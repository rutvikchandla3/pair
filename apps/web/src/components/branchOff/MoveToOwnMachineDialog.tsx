import { useAtomValue } from "@effect/atom-react";
import { moveToOwnMachineConfirm } from "@t3tools/client-runtime/branch-lineage";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { branchLineageEnvironment } from "../../state/branchLineage";
import { useQuietThreadShell } from "../../state/entities";
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

/** The menus and the palette close as they run, so the app root renders it once. */
const moveToOwnMachineThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("branch-off:move-to-own-machine-thread"),
);

export function openMoveToOwnMachineDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(moveToOwnMachineThreadAtom, threadRef);
}

export function MoveToOwnMachineDialogHost() {
  const threadRef = useAtomValue(moveToOwnMachineThreadAtom);
  if (threadRef === null) return null;
  return (
    <MoveToOwnMachineDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(moveToOwnMachineThreadAtom, null)}
    />
  );
}

/** A thread on someone else's machine continues on a new one of its own. */
function MoveToOwnMachineDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const move = useAtomCommand(branchLineageEnvironment.moveToOwnMachine, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const copy = moveToOwnMachineConfirm(shell?.title ?? "This thread");

  const confirm = async () => {
    setBusy(true);
    const result = await move({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    });
    setBusy(false);
    toastCommandFailure("Could not move the thread", result);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void confirm()}>
            {busy ? "Moving…" : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
