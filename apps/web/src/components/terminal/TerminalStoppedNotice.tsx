import { TERMINAL_ASLEEP_LABEL, terminalStoppedLabel } from "@t3tools/client-runtime/state/sandbox";
import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import type { ScopedThreadRef, TerminalStoppedBy } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";

import {
  useSandboxActionRunner,
  useSandboxThreadMachine,
} from "~/components/sandbox/useSandboxThreadStatus";
import { Button } from "~/components/ui/button";

/** The session's `stoppedBy` alone, so output chunks do not re-render the notice. */
export const terminalStoppedByAtom = Atom.family((session: Atom.Atom<TerminalSessionState>) =>
  Atom.make((get) => get(session).stoppedBy).pipe(
    Atom.withEquality(
      (left: TerminalStoppedBy | null, right: TerminalStoppedBy | null) =>
        left === right ||
        (left !== null && right !== null && left.reason === right.reason && left.at === right.at),
    ),
  ),
);

/** Over a shell the machine's sleep stopped: Wake while it sleeps, then typing or Wake restarts it. */
export function TerminalStoppedNotice(props: {
  readonly threadRef: ScopedThreadRef;
  readonly stoppedBy: TerminalStoppedBy;
  readonly onRestart: () => void;
}) {
  const machine = useSandboxThreadMachine(props.threadRef);
  const runAction = useSandboxActionRunner();
  const [woke, setWoke] = useState(false);
  const ready = machine?.state === "ready" && machine.presentation.label === null;
  const restart = useEffectEvent(() => props.onRestart());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a new shell once the machine this viewer woke reports ready
  useEffect(() => {
    if (woke && ready) restart();
  }, [woke, ready]);

  const label =
    machine === null || ready
      ? `${terminalStoppedLabel(props.stoppedBy)}. Type to start a new shell.`
      : machine.state === "sleeping"
        ? TERMINAL_ASLEEP_LABEL
        : (machine.presentation.label ?? TERMINAL_ASLEEP_LABEL);
  const canWake = machine?.state === "sleeping" && machine.actions.includes("wake");
  return (
    <div
      role="status"
      className="pointer-events-auto absolute inset-x-2 bottom-2 z-10 flex items-center gap-2 rounded-md border border-border/80 bg-background px-2.5 py-1.5 text-xs text-muted-foreground shadow-xs"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {canWake ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            setWoke(true);
            void runAction(props.threadRef, machine.sandboxId, "wake");
          }}
        >
          Wake
        </Button>
      ) : null}
    </div>
  );
}
