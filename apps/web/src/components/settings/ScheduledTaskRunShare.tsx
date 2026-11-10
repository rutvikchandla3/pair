import {
  applyShareChange,
  exceedsShareCap,
  RUN_SHARE_CREATOR_ONLY_REASON,
  RUN_SHARE_NOTE,
  shareAudienceLabel,
  shareCandidates,
  shareCapMessage,
  type RunShareControl,
  type ShareAccess,
} from "@t3tools/client-runtime/state/share-thread";
import type { TeamMember } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { MemberAvatar } from "../team/MemberAvatar";
import { Badge } from "../ui/badge";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../ui/combobox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { TeamMembers } from "@t3tools/client-runtime/state/team";

/** The editor's "Share runs with": the Share dialog's two-part choice, applied as the form is edited. */
export function ScheduledTaskRunShare({
  control,
  access,
  members,
  teamName,
  onChange,
}: {
  readonly control: RunShareControl;
  readonly access: ShareAccess;
  readonly members: TeamMembers;
  readonly teamName: string;
  readonly onChange: (next: ShareAccess) => void;
}) {
  const [query, setQuery] = useState("");
  const [capMessage, setCapMessage] = useState<string | null>(null);
  const { canEdit } = control;
  const listed = access.memberIds.flatMap((id) => {
    const member = members.get(id);
    return member === undefined || member.removedAt !== null ? [] : [member];
  });
  const candidates = shareCandidates(members, {
    ownerId: control.creatorId,
    listed: access.memberIds,
    query,
  });
  const change = (next: ShareAccess) => {
    if (exceedsShareCap(next)) {
      setCapMessage(shareCapMessage(teamName));
      return;
    }
    setCapMessage(null);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {listed.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {listed.map((member) => (
            <Badge
              key={member.id}
              variant="secondary"
              render={
                canEdit ? (
                  <button
                    type="button"
                    aria-label={`Remove ${member.name}`}
                    onClick={() =>
                      change(applyShareChange(access, { kind: "remove", memberId: member.id }))
                    }
                  />
                ) : (
                  <span />
                )
              }
            >
              <MemberAvatar member={member} size="sm" />
              {member.name}
              {canEdit ? <XIcon aria-hidden /> : null}
            </Badge>
          ))}
        </div>
      ) : null}
      {canEdit ? (
        <Combobox
          multiple
          items={candidates}
          filteredItems={candidates}
          filter={null}
          itemToStringLabel={(member: TeamMember) => member.name}
          isItemEqualToValue={(left: TeamMember, right: TeamMember) => left.id === right.id}
          value={[]}
          onValueChange={(picked) => {
            setQuery("");
            change(
              applyShareChange(access, {
                kind: "add",
                memberIds: picked.map((member) => member.id),
              }),
            );
          }}
          inputValue={query}
          onInputValueChange={setQuery}
        >
          <ComboboxInput
            aria-label="Add people"
            placeholder="Add people…"
            showTrigger={false}
            size="sm"
          />
          <ComboboxPopup>
            <ComboboxEmpty>No matching members.</ComboboxEmpty>
            <ComboboxList>
              {(member: TeamMember) => (
                <ComboboxItem key={member.id} value={member}>
                  <MemberAvatar member={member} size="sm" />
                  <span className="min-w-0 truncate">{member.name}</span>
                  {member.github ? (
                    <span className="truncate text-muted-foreground text-xs">
                      @{member.github.login}
                    </span>
                  ) : null}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : null}
      {capMessage === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {capMessage}
        </p>
      )}
      <Select
        disabled={!canEdit}
        value={access.audience}
        onValueChange={(audience) => {
          if (audience === "members" || audience === "team") {
            change(applyShareChange(access, { kind: "audience", audience }));
          }
        }}
      >
        <SelectTrigger size="sm" aria-label="General access">
          <SelectValue>{shareAudienceLabel(access.audience, teamName)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="members">Only people added</SelectItem>
          <SelectItem value="team">Everyone on {teamName}</SelectItem>
        </SelectPopup>
      </Select>
      {canEdit ? null : (
        <p className="text-muted-foreground text-xs">{RUN_SHARE_CREATOR_ONLY_REASON}.</p>
      )}
      <p className="text-muted-foreground text-xs">{RUN_SHARE_NOTE}</p>
    </div>
  );
}
