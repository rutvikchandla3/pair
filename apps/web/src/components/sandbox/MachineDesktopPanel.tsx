import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { sandboxEnvironment } from "~/state/sandbox";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { useSandboxActionRunner, useSandboxThreadMachine } from "./useSandboxThreadStatus";

type DesktopView =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

function DesktopNotice(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <Empty className="min-h-0">
      <EmptyMedia variant="icon">
        <MonitorIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ? (
        <Button size="sm" variant="outline" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      ) : null}
    </Empty>
  );
}

/** One signed-in stream; a remount asks for a new URL, since each one is single-use and expires. */
function DesktopStream(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onReconnect: () => void;
}) {
  const { threadRef } = props;
  const { resolvedTheme } = useTheme();
  const [view, setView] = useState<DesktopView>({ status: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for a fresh signed-in stream URL each time the viewer mounts
  useEffect(() => {
    const controller = new AbortController();
    void runAtomCommand(
      appAtomRegistry,
      sandboxEnvironment.desktop,
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, theme: resolvedTheme },
      },
      { reportFailure: false, signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        setView({ status: "ready", url: result.value.url });
        return;
      }
      const error = squashAtomCommandFailure(result);
      setView({
        status: "failed",
        message: error instanceof Error ? error.message : "Could not open the machine's desktop.",
      });
    });
    return () => controller.abort();
  }, [threadRef.environmentId, threadRef.threadId, resolvedTheme]);

  if (view.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (view.status === "failed") {
    return (
      <DesktopNotice
        title="Desktop unavailable"
        description={view.message}
        action={{ label: "Retry", onClick: props.onReconnect }}
      />
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- boat's cross-origin viewer needs its own origin for stream auth; boat documents it unsandboxed */}
      <iframe
        title="Machine desktop"
        src={view.url}
        allow="autoplay; fullscreen; clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-black"
      />
      <Button
        aria-label="Reconnect desktop"
        title="Reconnect"
        size="icon-xs"
        variant="ghost-muted"
        className="absolute top-2 right-2"
        onClick={props.onReconnect}
      >
        <RefreshIcon size="sm" />
      </Button>
    </div>
  );
}

/** The screen of a cloud thread's machine, to watch and drive it by hand. */
export function MachineDesktopPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const machine = useSandboxThreadMachine(props.threadRef);
  const runAction = useSandboxActionRunner();
  const [connection, setConnection] = useState(0);

  if (machine === null) {
    return (
      <DesktopNotice
        title="No cloud machine"
        description="The desktop is available for threads that run on a cloud machine."
      />
    );
  }
  if (machine.state !== "ready") {
    const canWake = machine.actions.includes("wake");
    return (
      <DesktopNotice
        title={machine.presentation.label ?? "Machine not running"}
        description="The desktop shows once the machine is running."
        action={
          canWake
            ? {
                label: "Wake machine",
                onClick: () => void runAction(props.threadRef, machine.sandboxId, "wake"),
              }
            : undefined
        }
      />
    );
  }
  return (
    <DesktopStream
      key={connection}
      threadRef={props.threadRef}
      onReconnect={() => setConnection((value) => value + 1)}
    />
  );
}
