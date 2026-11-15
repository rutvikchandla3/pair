import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "../../state/entities";
import { useTeamMembers } from "../../state/team";

/** "Hanad · :3001": a port another thread on the machine listens on, named by its owner. */
function otherThreadPortLabel(ownerName: string | null, port: number): string {
  return `${ownerName ?? "Another thread"} · :${port}`;
}

export function OtherThreadPortLabel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly port: number;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const members = useTeamMembers(props.threadRef.environmentId);
  const ownerId = shell?.source.ownerId ?? null;
  return otherThreadPortLabel(
    ownerId === null ? null : memberDisplayName(members, ownerId),
    props.port,
  );
}
