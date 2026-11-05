import type { EnvironmentId, MemberId, ProviderInstanceConfig } from "@t3tools/contracts";

import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import { useTeamAttribution } from "~/state/team";
import { SettingsRow } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const TEAM_VALUE = "team";

/** Whose own account an instance is, on its card in Settings → Providers. Team mode only. */
export function ProviderInstanceOwnerChip({
  environmentId,
  ownerMemberId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly ownerMemberId: MemberId | undefined;
}) {
  const team = useTeamAttribution(environmentId);
  if (!team.isTeamMode || ownerMemberId === undefined) return null;
  return (
    <Badge size="sm" variant="outline">
      {team.nameOf(ownerMemberId)}
    </Badge>
  );
}

/**
 * The admin's way to give a member an instance of any driver. An active member's account stays
 * theirs: the server refuses to move it, so the row only names them.
 */
export function ProviderInstanceOwnerRow({
  environmentId,
  instance,
  readOnly,
  onUpdate,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const team = useTeamAttribution(environmentId);
  if (!team.isTeamMode) return null;
  const owner = instance.ownerMemberId;
  const ownerIsActive = owner !== undefined && team.members.get(owner)?.removedAt === null;
  const ownerLabel = (id: MemberId | undefined) =>
    id === undefined
      ? "Team"
      : team.members.get(id)?.removedAt === null
        ? team.nameOf(id)
        : `${team.nameOf(id)} (removed)`;

  if (readOnly || ownerIsActive) {
    return (
      <SettingsRow
        title="Owner"
        description={
          ownerIsActive ? "Only its owner can pick this account for a thread." : undefined
        }
        control={<span className="text-sm text-muted-foreground">{ownerLabel(owner)}</span>}
      />
    );
  }

  const candidates = activeTeamMembers(team.members);
  const setOwner = (value: string | null) => {
    const { ownerMemberId: _owner, ...rest } = instance;
    if (value === TEAM_VALUE) {
      onUpdate(rest);
      return;
    }
    const member = candidates.find((candidate) => candidate.id === value);
    if (member) onUpdate({ ...rest, ownerMemberId: member.id });
  };

  return (
    <SettingsRow
      title="Owner"
      description="A member's own account. Only they can pick it for a thread."
      control={
        <Select value={owner ?? TEAM_VALUE} onValueChange={setOwner}>
          <SelectTrigger size="sm" aria-label="Owner">
            <SelectValue>{ownerLabel(owner)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={TEAM_VALUE}>Team</SelectItem>
            {owner === undefined ? null : <SelectItem value={owner}>{ownerLabel(owner)}</SelectItem>}
            {candidates.map((member) => (
              <SelectItem key={member.id} value={member.id}>
                {member.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
