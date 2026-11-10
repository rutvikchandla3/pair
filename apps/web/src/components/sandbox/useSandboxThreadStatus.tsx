import { useAtomValue } from "@effect/atom-react";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  drainNoticeLabel,
  SANDBOX_ACTION_FAILURE_TITLES,
  SANDBOX_DISCARD_CONFIRMATION,
  SANDBOX_OWNER_ONLY_REASON,
  type SandboxAction,
  type SandboxStatePresentation,
  type SandboxThreadMachine,
} from "@t3tools/client-runtime/state/sandbox";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import {
  sandboxImageLabel,
  type OrchestrationV2Sandbox,
  type SandboxId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ThreadStatusLine } from "~/components/chat/ThreadStatusLine";
import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { sandboxEnvironment } from "~/state/sandbox";
import { serverEnvironment } from "~/state/server";
import { activeTeamImageBuildNumberAtom } from "~/state/teamImage";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

const NO_MACHINE_ATOM = Atom.make<SandboxThreadMachine | null>(null).pipe(
  Atom.withLabel("sandbox-thread-machine:none"),
);

export function useSandboxThreadMachine(
  threadRef: ScopedThreadRef | null,
): SandboxThreadMachine | null {
  return useAtomValue(
    threadRef === null ? NO_MACHINE_ATOM : sandboxEnvironment.threadMachineAtom(threadRef),
  );
}

/** For menus built at click time. */
export function readSandboxThreadMachine(threadRef: ScopedThreadRef): SandboxThreadMachine | null {
  return appAtomRegistry.get(sandboxEnvironment.threadMachineAtom(threadRef));
}

/** Runs one machine action, confirming Discard first and toasting the server's refusal. */
export function useSandboxActionRunner() {
  const options = { reportFailure: false } as const;
  const commands = {
    wake: useOrchestrationCommand(sandboxEnvironment.wake, options),
    sleep: useOrchestrationCommand(sandboxEnvironment.sleep, options),
    retry: useOrchestrationCommand(sandboxEnvironment.retry, options),
    discard: useOrchestrationCommand(sandboxEnvironment.discard, options),
  };
  return async (threadRef: ScopedThreadRef, sandboxId: SandboxId, action: SandboxAction) => {
    if (action === "discard") {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(SANDBOX_DISCARD_CONFIRMATION, { variant: "destructive" }),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    const result = await commands[action]({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, sandboxId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: SANDBOX_ACTION_FAILURE_TITLES[action],
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}

/** "Starting machine: cloning repository" while the launch reports a phase past the machine's own. */
function withPreparingPhase(
  label: string,
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
): string {
  const phase = turnItems.findLast(
    (item) =>
      item.type === "command_execution" &&
      item.status === "running" &&
      turnItemIsWorkspacePreparation(item),
  )?.title;
  if (!phase || label.startsWith(phase)) return label;
  return `${label}: ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`;
}

export interface SandboxThreadStatus {
  /** The header badge; null for local threads and a ready machine. */
  readonly badge: {
    readonly label: string;
    readonly tone: SandboxStatePresentation["tone"];
  } | null;
  readonly statusLine: ReactNode | null;
  readonly bannerItems: ReadonlyArray<ComposerBannerStackItem>;
  readonly run: (action: SandboxAction) => void;
}

const NO_BANNER_ITEMS: ReadonlyArray<ComposerBannerStackItem> = [];

interface SandboxThreadStatusInput {
  readonly threadRef: ScopedThreadRef | null;
  /** The loaded detail's machine, for the driver's own failure message. */
  readonly sandbox: OrchestrationV2Sandbox | null | undefined;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly onStartNewMachine: () => void;
}

const NO_BUILD_NUMBER_ATOM = Atom.make<number | null>(null).pipe(
  Atom.withLabel("team-image-active-build-number:none"),
);

/**
 * Which build the machine runs, and that new sessions use a different one; null while the
 * machine's record isn't loaded. There is no machine-details view on web, so this rides the
 * status line and the failure banner.
 */
function machineImageNote(
  sandbox: OrchestrationV2Sandbox | null | undefined,
  sandboxId: SandboxId,
  activeBuildNumber: number | null,
): { readonly image: string; readonly newSessions: string | null } | null {
  if (sandbox == null || sandbox.id !== sandboxId) return null;
  return {
    image: sandboxImageLabel(sandbox),
    newSessions:
      activeBuildNumber !== null && activeBuildNumber !== sandbox.imageBuild?.number
        ? `New sessions use build ${activeBuildNumber}`
        : null,
  };
}

const NOT_DRAINING_ATOM = Atom.make<DateTime.Utc | null>(null).pipe(
  Atom.withLabel("server-draining-since:none"),
);

/** The active thread's machine: header badge, status line, failure and discarded notices. */
export function useSandboxThreadStatus(input: SandboxThreadStatusInput): SandboxThreadStatus {
  const status = useMachineStatus(input);
  const machine = useSandboxThreadMachine(input.threadRef);
  const drainingSince = useAtomValue(
    input.threadRef === null || machine === null
      ? NOT_DRAINING_ATOM
      : serverEnvironment.drainingSinceAtom(input.threadRef.environmentId),
  );
  const notice = drainNoticeLabel(drainingSince);
  if (notice === null) return status;
  return {
    ...status,
    bannerItems: [
      {
        id: "server-draining",
        variant: "info",
        group: "environment",
        icon: <CloudIcon />,
        title: notice,
      },
      ...status.bannerItems,
    ],
  };
}

function useMachineStatus(input: SandboxThreadStatusInput): SandboxThreadStatus {
  const { threadRef } = input;
  const machine = useSandboxThreadMachine(threadRef);
  const activeBuildNumber = useAtomValue(
    threadRef === null || machine === null
      ? NO_BUILD_NUMBER_ATOM
      : activeTeamImageBuildNumberAtom(threadRef.environmentId),
  );
  const runAction = useSandboxActionRunner();
  const run = (action: SandboxAction) => {
    if (threadRef === null || machine === null || !machine.actions.includes(action)) return;
    void runAction(threadRef, machine.sandboxId, action);
  };
  const imageNote =
    machine === null ? null : machineImageNote(input.sandbox, machine.sandboxId, activeBuildNumber);
  if (machine === null || machine.presentation.label === null) {
    // A ready machine says nothing unless it runs an older image than new sessions get.
    const behind =
      machine?.state === "ready" && imageNote?.newSessions != null
        ? `This machine runs ${imageNote.image}. ${imageNote.newSessions}.`
        : null;
    return {
      badge: null,
      statusLine: behind === null ? null : <ThreadStatusLine icon={<CloudIcon />} label={behind} />,
      bannerItems: NO_BANNER_ITEMS,
      run,
    };
  }
  const { presentation, sandboxId } = machine;
  const label =
    machine.state === "provisioning"
      ? withPreparingPhase(presentation.label ?? "", input.turnItems)
      : (presentation.label ?? "");
  const badge = { label, tone: presentation.tone };
  const actionButton = (action: SandboxAction, text: string) => {
    if (!machine.actions.includes(action)) return null;
    const denied = machine.ownerOnlyDenied.includes(action);
    return (
      <Button
        key={action}
        size="xs"
        variant="outline"
        disabled={denied}
        title={denied ? SANDBOX_OWNER_ONLY_REASON : undefined}
        onClick={() => run(action)}
      >
        {text}
      </Button>
    );
  };
  if (machine.state === "failed") {
    const message = input.sandbox?.id === sandboxId ? input.sandbox.failure?.message.trim() : "";
    return {
      badge,
      statusLine: null,
      bannerItems: [
        {
          id: `sandbox-failed:${sandboxId}`,
          variant: "error",
          group: "environment",
          icon: <CloudOffIcon />,
          title: message || label,
          ...(imageNote === null
            ? {}
            : {
                description: [imageNote.image, imageNote.newSessions]
                  .filter((part) => part !== null)
                  .join(" · "),
              }),
          actions: (
            <>
              {actionButton("retry", "Retry")}
              {actionButton("discard", "Discard")}
            </>
          ),
        },
      ],
      run,
    };
  }
  if (machine.state === "destroyed") {
    return {
      badge,
      statusLine: null,
      bannerItems: [
        {
          id: `sandbox-destroyed:${sandboxId}`,
          variant: "info",
          group: "environment",
          icon: <CloudIcon />,
          title: label,
          description: "Sending starts a new machine.",
          actions: (
            <Button size="xs" variant="outline" onClick={input.onStartNewMachine}>
              Start a new machine
            </Button>
          ),
        },
      ],
      run,
    };
  }
  // Asleep is a quiet line, not a banner (01 J6).
  const wake = machine.actions.includes("wake");
  return {
    badge,
    statusLine: (
      <ThreadStatusLine
        icon={<CloudIcon />}
        label={
          imageNote === null
            ? label
            : [label, imageNote.image, imageNote.newSessions]
                .filter((part) => part !== null)
                .join(" · ")
        }
        {...(wake ? { actionLabel: "Wake", onAction: () => run("wake") } : {})}
      />
    ),
    bannerItems: NO_BANNER_ITEMS,
    run,
  };
}
