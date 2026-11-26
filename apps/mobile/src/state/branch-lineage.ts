import { useAtomValue } from "@effect/atom-react";
import {
  type LineageViewer,
  lineageBranchesOf,
  parseRememberedRunsOn,
  rememberedRunsOnKey,
} from "@t3tools/client-runtime/branch-lineage";
import { createBranchLineageEnvironmentAtoms } from "@t3tools/client-runtime/state/branch-lineage";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import type {
  EnvironmentId,
  LineageRunsOn,
  LineageView,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import type { Preferences } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom, saveMobilePreferences } from "./preferences";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { useTeamViewer } from "./team";
import { environmentThreadShells } from "./threads";

export const branchLineageEnvironment = createBranchLineageEnvironmentAtoms(connectionAtomRuntime, {
  threadShells: environmentThreadShells,
});

/** Lineage copy's viewer; null on solo servers, where none of the team UI shows. */
export function useLineageViewer(environmentId: EnvironmentId | null): LineageViewer | null {
  const viewer = useTeamViewer(environmentId);
  if (viewer === null) return null;
  return {
    memberId: viewer.memberId,
    serverOwnerId: viewer.ownerId,
    nameOf: (id) => memberDisplayName(viewer.members, id),
  };
}

const NO_BRANCHES: ReadonlyArray<EnvironmentThreadShell> = [];

// Keyed `env\u0000threadId`. Holds its last array until the set of branches changes, so the
// pill doesn't re-render on every shell tick.
const sourceBranchesFamily = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const threadId = key.slice(separator + 1) as ThreadId;
  return Atom.make((get): ReadonlyArray<EnvironmentThreadShell> => {
    const shells = get(environmentThreadShells.quietThreadShellsAtom).filter(
      (shell) => shell.environmentId === environmentId,
    );
    const next = lineageBranchesOf(
      shells.map((shell) => ({ ...shell.source, shell })),
      threadId,
    ).map((entry) => entry.shell);
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentThreadShell>>());
    if (next.length === 0) return NO_BRANCHES;
    return previous !== null &&
      previous.length === next.length &&
      previous.every((shell, index) => shell.id === next[index]?.id)
      ? previous
      : next;
  }).pipe(Atom.withLabel(`mobile-lineage-branches:${key}`));
});

/** A source's branches among the shells this client has, so the count matches what opens. */
export function useSourceBranches(ref: ScopedThreadRef): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(sourceBranchesFamily(`${ref.environmentId}\u0000${ref.threadId}`));
}

/** `lineage.read`; null while loading or without a ref. */
export function useLineageView(ref: ScopedThreadRef | null): LineageView | null {
  return useEnvironmentQuery(
    ref === null
      ? null
      : branchLineageEnvironment.view({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
  ).data;
}

const NO_REMEMBERED_ATOM = Atom.make<LineageRunsOn | null>(null).pipe(
  Atom.withLabel("mobile-branch-off-runs-on:none"),
);

const rememberedRunsOnFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const preferences = AsyncResult.getOrElse(get(mobilePreferencesAtom), () => null);
    return parseRememberedRunsOn(
      preferences?.branchOffRunsOn?.[rememberedRunsOnKey(environmentId)],
    );
  }).pipe(Atom.withLabel(`mobile-branch-off-runs-on:${environmentId}`)),
);

const rememberRunsOn =
  (environmentId: EnvironmentId, runsOn: LineageRunsOn) => (current: Preferences) => ({
    branchOffRunsOn: { ...current.branchOffRunsOn, [rememberedRunsOnKey(environmentId)]: runsOn },
  });

/** The last Runs on choice on this device for the environment, and a setter that persists it. */
export function useRememberedRunsOn(environmentId: EnvironmentId | null) {
  const remembered = useAtomValue(
    environmentId === null ? NO_REMEMBERED_ATOM : rememberedRunsOnFamily(environmentId),
  );
  const update = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const remember = (runsOn: LineageRunsOn) => {
    if (environmentId !== null) void update({ transform: rememberRunsOn(environmentId, runsOn) });
  };
  return { remembered, remember };
}

/** Alerts a failed lineage command with the server's message; true when it landed. */
export function reportLineageResult(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  Dialog.alert(
    title,
    error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
  );
  return false;
}
