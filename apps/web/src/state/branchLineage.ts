import {
  type LineageViewer,
  lineageBranchesOf,
  parseRememberedRunsOn,
  rememberedRunsOnKey,
} from "@t3tools/client-runtime/branch-lineage";
import { createBranchLineageEnvironmentAtoms } from "@t3tools/client-runtime/state/branch-lineage";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import type {
  EnvironmentId,
  LineageRunsOn,
  LineageView,
  MemberId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useEnvironmentQuery } from "./query";
import { useCurrentMemberId, useTeamMembers } from "./team";
import { environmentThreadShells } from "./threads";

/** Branch off, Update, Offer and Apply (Spaces redesign Part 2) for every environment. */
export const branchLineageEnvironment = createBranchLineageEnvironmentAtoms(connectionAtomRuntime, {
  threadShells: environmentThreadShells,
});

/** The viewer for lineage copy: "You" or a name, and who holds threads with no owner. */
export function useLineageViewer(environmentId: EnvironmentId | null): LineageViewer {
  const members = useTeamMembers(environmentId);
  const memberId = useCurrentMemberId(environmentId);
  let serverOwnerId: MemberId | null = null;
  for (const member of members.values()) if (member.isOwner) serverOwnerId = member.id;
  return { memberId, serverOwnerId, nameOf: (id) => memberDisplayName(members, id) };
}

/** `lineage.read` for a thread with a lineage; null without one or while it loads. */
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

const RememberedRunsOn = Schema.NullOr(Schema.Literals(["source-machine", "new-machine"]));

/** Branch off's last Runs on choice in this environment; null until the first one. */
export function useRememberedRunsOn(
  environmentId: EnvironmentId,
): readonly [LineageRunsOn | null, (runsOn: LineageRunsOn) => void] {
  const [stored, setStored] = useLocalStorage(
    rememberedRunsOnKey(environmentId),
    null,
    RememberedRunsOn,
  );
  return [parseRememberedRunsOn(stored), setStored] as const;
}

// A count, so streaming ticks on other threads don't re-render the chip.
const branchCountFamily = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const threadId = key.slice(separator + 1) as ScopedThreadRef["threadId"];
  return Atom.make(
    (get) =>
      lineageBranchesOf(
        get(environmentThreadShells.environmentThreadsAtom(environmentId)),
        threadId,
      ).length,
  ).pipe(Atom.withLabel(`lineage-branch-count:${key}`));
});

/** A source's branches among the shells this client has, so the count is only what it can open. */
export function useLineageBranchCount(ref: ScopedThreadRef | null): number {
  return useAtomValue(
    ref === null ? NO_BRANCHES : branchCountFamily(`${ref.environmentId}\u0000${ref.threadId}`),
  );
}

const NO_BRANCHES = Atom.make(0).pipe(Atom.withLabel("lineage-branch-count:none"));
