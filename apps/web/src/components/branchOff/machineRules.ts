import {
  type MachineThread,
  machineOthersNote,
  sourceKeepsMachineNote,
} from "@t3tools/client-runtime/branch-lineage";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SandboxId, ScopedThreadRef } from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { readBranchOffViewer } from "./branchOffTarget";

/** The other unarchived threads on a machine, among the shells this client has. */
function machineThreadsOf(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  threadRef: ScopedThreadRef,
  sandboxId: SandboxId,
  options: { readonly activeOnly: boolean },
): ReadonlyArray<MachineThread> {
  return shells.flatMap((shell) =>
    shell.environmentId === threadRef.environmentId &&
    shell.id !== threadRef.threadId &&
    shell.source.sandboxId === sandboxId &&
    shell.source.archivedAt === null &&
    (!options.activeOnly || shell.source.settledAt === null)
      ? [{ ownerId: shell.source.ownerId ?? null, title: shell.title }]
      : [],
  );
}

const readMachineThreads = (
  threadRef: ScopedThreadRef,
  sandboxId: SandboxId,
  activeOnly: boolean,
) =>
  machineThreadsOf(
    appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom),
    threadRef,
    sandboxId,
    { activeOnly },
  );

const confirm = async (message: string, destructive: boolean) => {
  const api = readLocalApi();
  if (!api) return false;
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(message, destructive ? { variant: "destructive" } : undefined),
  );
  return confirmed._tag === "Success" && confirmed.value;
};

/**
 * Sleep and Discard name the other people's threads on the machine. Null when nobody else is on
 * it: Discard keeps its own confirm, and Sleep asks nothing.
 */
export function machineActionNote(
  threadRef: ScopedThreadRef,
  sandboxId: SandboxId,
  action: "sleep" | "discard",
): string | null {
  const viewer = readBranchOffViewer(threadRef.environmentId);
  if (viewer === null) return null;
  return machineOthersNote(readMachineThreads(threadRef, sandboxId, false), viewer, action);
}

/**
 * Settling or archiving the thread a machine belongs to asks first while others still use it:
 * the confirm's text, or null when there is nothing to ask.
 */
export function sourceKeepsMachinePrompt(
  threadRef: ScopedThreadRef,
  verb: "Settle" | "Archive",
): string | null {
  const viewer = readBranchOffViewer(threadRef.environmentId);
  const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef));
  const sandboxId = shell?.source.sandboxId;
  if (
    viewer === null ||
    shell === null ||
    sandboxId === undefined ||
    shell.source.sandbox?.ownerThreadId !== threadRef.threadId
  ) {
    return null;
  }
  const note = sourceKeepsMachineNote(readMachineThreads(threadRef, sandboxId, true), viewer);
  return note === null ? null : `${verb} ${shell.title}?\n${note}`;
}

/** Asks a machine rule's question; true when confirmed. */
export function confirmMachinePrompt(message: string): Promise<boolean> {
  return confirm(message, false);
}

/** Sleep's confirm when others' threads share the machine; true when there is nothing to ask. */
export async function confirmMachineSleep(
  threadRef: ScopedThreadRef,
  sandboxId: SandboxId,
): Promise<boolean> {
  const note = machineActionNote(threadRef, sandboxId, "sleep");
  return note === null ? true : confirm(`Put this machine to sleep?\n${note}`, false);
}
