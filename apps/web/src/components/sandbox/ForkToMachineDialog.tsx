import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type SandboxSize, type ScopedThreadRef } from "@t3tools/contracts";
import { machineSpecLabel, SANDBOX_SIZE_LABELS } from "@t3tools/shared/sandbox";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useId, useRef, useState } from "react";

import { newThreadId, randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell, waitForThreadShell } from "~/state/entities";
import { sandboxEnvironment, useForkToMachineOffer } from "~/state/sandbox";
import { environmentCloudMachineSizesAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { FORK_TO_MACHINE_LABEL } from "../threadActionMenu.logic";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { defaultForkBranch, forkMachineSizeDefault } from "./machineSize.logic";
import { MachineSizeSelect } from "./MachineSizeSelect";

/** The menu, the palette and the sidebar all close as they run, so the app root renders it once. */
const forkToMachineThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("sandbox:fork-to-machine-thread"),
);

export function openForkToMachineDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(forkToMachineThreadAtom, threadRef);
}

export function ForkToMachineDialogHost() {
  const threadRef = useAtomValue(forkToMachineThreadAtom);
  if (threadRef === null) return null;
  return (
    <ForkToMachineDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(forkToMachineThreadAtom, null)}
    />
  );
}

function ForkToMachineDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const offer = useForkToMachineOffer(threadRef);
  const sizes = useAtomValue(environmentCloudMachineSizesAtom(threadRef.environmentId));
  const fork = useAtomCommand(sandboxEnvironment.fork, { reportFailure: false });
  // Null until edited: the defaults follow the thread until the member picks.
  const [pickedSize, setPickedSize] = useState<SandboxSize | null>(null);
  const [editedBranch, setEditedBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const currentSize = thread?.source.sandbox?.size;
  const current = sizes.find((spec) => spec.size === currentSize) ?? null;
  const size = pickedSize ?? forkMachineSizeDefault(sizes, currentSize);
  const branch = editedBranch ?? (thread?.branch ? defaultForkBranch(thread.branch) : "");
  const blocker = offer === null ? "This thread does not run on a cloud machine." : offer.blocker;
  const canFork = blocker === null && size !== null && branch.trim().length > 0 && !busy;

  const submit = async () => {
    if (inFlight.current || !canFork || thread === null || size === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const forkThreadId = newThreadId();
    const result = await fork({
      environmentId: threadRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        sourceThreadId: threadRef.threadId,
        threadId: forkThreadId,
        size,
        branch: branch.trim(),
        title: `${thread.title} fork`,
      },
    });
    const forkRef = scopeThreadRef(threadRef.environmentId, forkThreadId);
    const ready = result._tag === "Success" && (await waitForThreadShell(forkRef));
    inFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    if (!ready) {
      setError(
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    onClose();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(forkRef) });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          id={formId}
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{FORK_TO_MACHINE_LABEL}</DialogTitle>
            <DialogDescription>
              Copies this machine&apos;s disk, including uncommitted changes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-size`}>Size</Label>
                {size === null ? null : (
                  <MachineSizeSelect
                    id={`${formId}-size`}
                    sizes={sizes}
                    value={size}
                    disabled={busy}
                    onChange={(spec) => setPickedSize(spec.size)}
                  />
                )}
                {current === null ? null : (
                  <p className="text-xs text-muted-foreground">
                    Now: {SANDBOX_SIZE_LABELS[current.size]} · {machineSpecLabel(current)}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-branch`}>Branch</Label>
                <Input
                  id={`${formId}-branch`}
                  value={branch}
                  disabled={busy}
                  onChange={(event) => setEditedBranch(event.target.value)}
                />
              </div>
              {blocker !== null ? (
                <Alert variant="warning">
                  <AlertDescription>{blocker}</AlertDescription>
                </Alert>
              ) : null}
              {error !== null ? (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canFork}>
              {busy ? "Forking…" : "Fork"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
