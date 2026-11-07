import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { sharesOtherOwnersMachine } from "@t3tools/client-runtime/state/sandbox";
import { type EnvironmentId, type MemberId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { UsersIcon } from "lucide-react";

import { environmentThreadDetails } from "~/state/threads";
import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { useTeamMembers } from "~/state/team";

/** The machine owner's member id when this thread runs on someone else's machine, else null. */
const machineOwnerFamily = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\u0000");
  const ref = { environmentId: environmentId as EnvironmentId, threadId: ThreadId.make(threadId) };
  return Atom.make((get): MemberId | null => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
    if (projection === undefined) return null;
    return sharesOtherOwnersMachine(projection.thread, projection.sandbox)
      ? (projection.sandbox?.ownerMemberId ?? null)
      : null;
  }).pipe(Atom.withLabel(`shared-machine:${key}`));
});

const NO_OWNER_ATOM = Atom.make<MemberId | null>(null).pipe(Atom.withLabel("shared-machine:none"));

/** Thread keys whose banner was dismissed, until the app reloads. */
const dismissedAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("shared-machine:dismissed"),
);

/**
 * A thread on a teammate's machine, as a fork of their cloud thread is. Derived from the thread
 * and its machine, so every way of forking gets it.
 */
export function useSharedMachineBanner(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ComposerBannerStackItem | null {
  const key = threadId === null ? null : `${environmentId}\u0000${threadId}`;
  const ownerMemberId = useAtomValue(key === null ? NO_OWNER_ATOM : machineOwnerFamily(key));
  const dismissed = useAtomValue(dismissedAtom);
  const setDismissed = useAtomSet(dismissedAtom);
  const members = useTeamMembers(environmentId);
  if (key === null || ownerMemberId === null || dismissed.has(key)) return null;
  const owner = members.get(ownerMemberId)?.name ?? "a teammate";
  return {
    id: `shared-machine:${key}`,
    variant: "info",
    icon: <UsersIcon />,
    title: `This thread shares ${owner}'s machine.`,
    description: "Its agent can read the GitHub and provider credentials of every thread there.",
    dismissLabel: "Dismiss",
    onDismiss: () => setDismissed(new Set(dismissed).add(key)),
  };
}
