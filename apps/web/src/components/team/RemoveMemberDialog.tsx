import {
  MEMBER_REMOVAL_DELETE_LABEL,
  memberRemovalInput,
  memberRemovalPrompt,
  memberRemovalTargets,
  type MemberRemovalChoice,
} from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, MemberId, TeamMember } from "@t3tools/contracts";
import { useState } from "react";

import { teamEnvironment, useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastCommandFailure } from "./toastCommandFailure";

const DELETE_VALUE = "delete";

/**
 * Removing a member who owns cloud threads must say where they go. The admin never opens them:
 * the server gives them away or deletes them with the machines, then removes the member.
 */
export function RemoveMemberDialog({
  environmentId,
  member,
  cloudThreadCount,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly cloudThreadCount: number;
  readonly onClose: () => void;
}) {
  const members = useTeamMembers(environmentId);
  const removeMember = useAtomCommand(teamEnvironment.removeMember, { label: "remove member" });
  const [choice, setChoice] = useState<MemberRemovalChoice>({ type: "give", toMemberId: null });
  const [busy, setBusy] = useState(false);
  const targets = memberRemovalTargets(members, member.id);
  const input = memberRemovalInput(member.id, cloudThreadCount, choice);
  const selected = choice.type === "delete" ? DELETE_VALUE : choice.toMemberId;
  const selectedLabel =
    choice.type === "delete"
      ? MEMBER_REMOVAL_DELETE_LABEL
      : (targets.find((target) => target.id === choice.toMemberId)?.name ?? "Choose a member");

  const remove = async () => {
    if (input === null) return;
    setBusy(true);
    const result = await removeMember({ environmentId, input });
    setBusy(false);
    toastCommandFailure("Could not remove the member", result);
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Remove {member.name}</DialogTitle>
          <DialogDescription>
            Their devices are signed out and unused links stop working. Their past work stays in the
            threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <p className="text-sm">{memberRemovalPrompt(member.name, cloudThreadCount)}</p>
            <Select
              value={selected}
              onValueChange={(value) =>
                setChoice(
                  value === DELETE_VALUE
                    ? { type: "delete" }
                    : { type: "give", toMemberId: value as MemberId },
                )
              }
            >
              <SelectTrigger size="sm" aria-label="Give their cloud threads to">
                <SelectValue>{selectedLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.name}
                  </SelectItem>
                ))}
                <SelectItem value={DELETE_VALUE}>{MEMBER_REMOVAL_DELETE_LABEL}</SelectItem>
              </SelectPopup>
            </Select>
            {choice.type === "delete" ? (
              <p className="text-muted-foreground text-xs">
                This deletes the threads and every machine {member.name} owns, with its uncommitted
                work. You can't see what is on them.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={input === null || busy}
            onClick={() => void remove()}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
