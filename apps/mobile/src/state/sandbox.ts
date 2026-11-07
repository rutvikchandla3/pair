import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import {
  createSandboxEnvironmentAtoms,
  SANDBOX_ACTION_FAILURE_TITLES,
  SANDBOX_DISCARD_CONFIRMATION,
  sharesOtherOwnersMachine,
  type SandboxAction,
  type SandboxThreadMachine,
} from "@t3tools/client-runtime/state/sandbox";
import type { EnvironmentId, MemberId, SandboxId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import { teamEnvironment } from "./team";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime, {
  team: teamEnvironment,
  threadShells: environmentThreadShells,
});

/** Connected environments with a sandbox driver: the Machines page lists them. */
const cloudEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const configs = get(environmentServerConfigsAtom);
  const next = get(connectedEnvironmentIdsAtom).filter(
    (id) => (configs.get(id)?.settings.sandbox?.drivers.length ?? 0) > 0,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("mobile-cloud-environment-ids"));

export function useCloudEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(cloudEnvironmentIdsAtom);
}

const NO_MACHINE_ATOM = Atom.make<SandboxThreadMachine | null>(null).pipe(
  Atom.withLabel("mobile-sandbox-thread-machine:none"),
);

/** The thread's machine, from its shell; null for a local thread. */
export function useSandboxThreadMachine(
  threadRef: ScopedThreadRef | null,
): SandboxThreadMachine | null {
  return useAtomValue(
    threadRef === null ? NO_MACHINE_ATOM : sandboxEnvironment.threadMachineAtom(threadRef),
  );
}

// Both read the loaded thread's machine record, which the shell summary leaves out.
const failureMessageFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get): string | null => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
    const sandbox = projection?.sandbox;
    if (sandbox == null || sandbox.id !== projection?.thread.sandboxId) return null;
    return sandbox.failure?.message.trim() || null;
  }).pipe(Atom.withLabel(`mobile-sandbox-failure:${key}`));
});

const sharedMachineOwnerFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get): MemberId | null => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
    if (projection === undefined) return null;
    return sharesOtherOwnersMachine(projection.thread, projection.sandbox ?? undefined)
      ? (projection.sandbox?.ownerMemberId ?? null)
      : null;
  }).pipe(Atom.withLabel(`mobile-shared-machine:${key}`));
});

const NO_TEXT_ATOM = Atom.make<string | null>(null).pipe(Atom.withLabel("mobile-sandbox:none"));
const NO_MEMBER_ATOM = Atom.make<MemberId | null>(null).pipe(
  Atom.withLabel("mobile-shared-machine:none"),
);

/** The driver's own words for a failed machine, once the thread detail has loaded. */
export function useSandboxFailureMessage(threadRef: ScopedThreadRef | null): string | null {
  return useAtomValue(
    threadRef === null ? NO_TEXT_ATOM : failureMessageFamily(threadKey(threadRef)),
  );
}

/** The teammate whose machine this thread runs on, as a fork of their cloud thread does. */
export function useSharedMachineOwner(threadRef: ScopedThreadRef | null): MemberId | null {
  return useAtomValue(
    threadRef === null ? NO_MEMBER_ATOM : sharedMachineOwnerFamily(threadKey(threadRef)),
  );
}

/** Runs one machine action, confirming Discard first and showing the server's refusal. */
export function useSandboxActionRunner() {
  const options = { reportFailure: false } as const;
  const commands = {
    wake: useAtomCommand(sandboxEnvironment.wake, options),
    sleep: useAtomCommand(sandboxEnvironment.sleep, options),
    retry: useAtomCommand(sandboxEnvironment.retry, options),
    discard: useAtomCommand(sandboxEnvironment.discard, options),
  };
  const run = async (threadRef: ScopedThreadRef, sandboxId: SandboxId, action: SandboxAction) => {
    const result = await commands[action]({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, sandboxId },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      SANDBOX_ACTION_FAILURE_TITLES[action],
      error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
    );
  };
  return (threadRef: ScopedThreadRef, sandboxId: SandboxId, action: SandboxAction) => {
    if (action !== "discard") {
      void run(threadRef, sandboxId, action);
      return;
    }
    Dialog.confirm({
      title: SANDBOX_DISCARD_CONFIRMATION,
      confirmText: "Discard",
      destructive: true,
      onConfirm: () => void run(threadRef, sandboxId, action),
    });
  };
}
