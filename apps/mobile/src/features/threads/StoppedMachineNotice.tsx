import {
  stoppedReadLabel,
  TERMINAL_ASLEEP_LABEL,
  terminalStoppedLabel,
  type StoppedFiles,
} from "@t3tools/client-runtime/state/sandbox";
import type { ScopedThreadRef, TerminalStoppedBy } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useSandboxActionRunner, useSandboxThreadMachine } from "../../state/sandbox";

function StoppedNotice(props: {
  readonly label: string;
  readonly onWake: (() => void) | null;
  readonly topInset?: number;
}) {
  return (
    <View
      accessibilityRole="summary"
      className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-2"
      style={props.topInset ? { paddingTop: props.topInset + 8 } : undefined}
    >
      <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted" numberOfLines={2}>
        {props.label}
      </Text>
      {props.onWake ? (
        <Button label="Wake" tone="secondary" size="compact" onPress={props.onWake} />
      ) : null}
    </View>
  );
}

/** How old an asleep machine's files and Changes are, with Wake where the viewer may wake it. */
export function StoppedFilesNotice(props: {
  readonly threadRef: ScopedThreadRef;
  readonly stopped: StoppedFiles;
  /** Room for a header the content scrolls under. */
  readonly topInset?: number;
}) {
  const { threadRef, stopped } = props;
  const machine = useSandboxThreadMachine(threadRef);
  const runAction = useSandboxActionRunner();
  const canWake = stopped.state === "sleeping" && machine?.actions.includes("wake") === true;
  return (
    <StoppedNotice
      label={`${stoppedReadLabel(stopped)}. Read-only.`}
      onWake={canWake ? () => runAction(threadRef, stopped.sandboxId, "wake") : null}
      {...(props.topInset === undefined ? {} : { topInset: props.topInset })}
    />
  );
}

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
    <StoppedNotice
      label={label}
      onWake={
        canWake
          ? () => {
              setWoke(true);
              runAction(props.threadRef, machine.sandboxId, "wake");
            }
          : null
      }
    />
  );
}
