import { useAtomValue } from "@effect/atom-react";
import {
  applyShareChange,
  exceedsShareCap,
  removalWarning,
  SHARE_FAILURE_TITLE,
  sameShareAccess,
  shareAudienceLabel,
  shareCandidates,
  shareCapMessage,
  shareMachineContext,
  shareTrustSentence,
  unsettledShares,
  visibleShareAccess,
  type PendingShare,
  type ShareAccess,
  type ShareChange,
} from "@t3tools/client-runtime/state/share-thread";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MemberId, ScopedThreadRef, TeamMember } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { copyThreadReference } from "~/lib/copyThreadReference";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { sandboxEnvironment } from "~/state/sandbox";
import { readThreadShareOrigin, useTeamMembers } from "~/state/team";
import { environmentThreadShells } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../ui/combobox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { MemberAvatar } from "./MemberAvatar";
import { shareThreadDialogThreadAtom } from "./shareThreadDialogTarget";
import { toastCommandFailure } from "./toastCommandFailure";

export function ShareThreadDialogHost() {
  const threadRef = useAtomValue(shareThreadDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ShareThreadDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(shareThreadDialogThreadAtom, null)}
    />
  );
}

function ShareThreadDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId } = threadRef;
  const shell = useThreadShell(threadRef);
  const summary = useAtomValue(sandboxEnvironment.threadAccessAtom(threadRef));
  const members = useTeamMembers(environmentId);
  const teamName = useEnvironment(environmentId)?.label.trim() || "the team";
  const sandboxId = shell?.source.sandboxId;
  const ownerThreadId = shell?.source.sandbox?.ownerThreadId;
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const ownerId = summary?.ownerId ?? null;
  const share = useOrchestrationCommand(sandboxEnvironment.shareThreadCommand, {
    reportFailure: false,
  });
  const nextPendingId = useRef(0);
  const [pending, setPending] = useState<ReadonlyArray<PendingShare>>([]);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<TeamMember[]>([]);
  const [highlighted, setHighlighted] = useState(false);
  const [confirming, setConfirming] = useState<MemberId | null>(null);
  const [capMessage, setCapMessage] = useState<string | null>(null);

  if (shell === null || sandboxId === undefined || summary?.canShare !== true) return null;
  const { relatedThreadOwnerIds, ownAccountProvider } = shareMachineContext({
    threads,
    sandboxId,
    ownerThreadId,
    ownerId,
    providerInstances,
  });
  const server: ShareAccess = {
    audience: summary.audience ?? "members",
    memberIds: summary.memberIds,
  };
  const access = visibleShareAccess(server, pending);
  const listed = access.memberIds.flatMap((id) => {
    const member = members.get(id);
    return member === undefined || member.removedAt !== null ? [] : [member];
  });
  const owner = ownerId === null ? undefined : members.get(ownerId);
  const candidates = shareCandidates(members, { ownerId, listed: access.memberIds, query });

  const apply = async (change: ShareChange) => {
    const next = applyShareChange(access, change);
    if (sameShareAccess(next, access)) return;
    if (exceedsShareCap(next)) {
      setCapMessage(shareCapMessage(teamName));
      return;
    }
    setCapMessage(null);
    const id = ++nextPendingId.current;
    setPending((current) => [
      ...unsettledShares(server, current),
      { id, access: next, confirmed: false },
    ]);
    const result = await share({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        sandboxId,
        audience: next.audience,
        memberIds: next.memberIds,
      },
    });
    if (result._tag === "Failure") {
      setPending((current) => current.filter((entry) => entry.id !== id));
      toastCommandFailure(SHARE_FAILURE_TITLE, result);
      return;
    }
    setPending((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, confirmed: true } : entry)),
    );
  };

  const addChips = () => {
    if (chips.length === 0) return;
    void apply({ kind: "add", memberIds: chips.map((member) => member.id) });
    setChips([]);
    setQuery("");
  };

  const warningFor = (member: TeamMember) =>
    removalWarning({
      access,
      member,
      threadOwnerIds: relatedThreadOwnerIds,
    });

  const remove = (member: TeamMember) => {
    setConfirming(null);
    void apply({ kind: "remove", memberId: member.id });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{shell.title}&rdquo;</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            <Combobox
              multiple
              items={candidates}
              filteredItems={candidates}
              filter={null}
              itemToStringLabel={(member: TeamMember) => member.name}
              isItemEqualToValue={(left: TeamMember, right: TeamMember) => left.id === right.id}
              value={chips}
              onValueChange={(next) => {
                setChips(next);
                setQuery("");
              }}
              inputValue={query}
              onInputValueChange={setQuery}
              onItemHighlighted={(member) => setHighlighted(member !== undefined)}
            >
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {chips.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {chips.map((member) => (
                        <Badge
                          key={member.id}
                          variant="secondary"
                          render={
                            <button
                              type="button"
                              aria-label={`Remove ${member.name}`}
                              onClick={() =>
                                setChips((current) =>
                                  current.filter((chip) => chip.id !== member.id),
                                )
                              }
                            />
                          }
                        >
                          {member.name}
                          <XIcon aria-hidden />
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <ComboboxInput
                    aria-label="Add people"
                    placeholder="Add people…"
                    showTrigger={false}
                    size="sm"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || highlighted || chips.length === 0) return;
                      event.preventDefault();
                      addChips();
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={chips.length === 0}
                  onClick={addChips}
                >
                  Add
                </Button>
              </div>
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
            {capMessage === null ? null : (
              <p role="alert" className="text-destructive text-xs">
                {capMessage}
              </p>
            )}

            <section className="space-y-2">
              <h3 className="font-medium text-sm">People with access</h3>
              <ul className="space-y-1">
                {owner === undefined ? null : (
                  <li className="flex min-h-8 items-center gap-2">
                    <MemberAvatar member={owner} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{owner.name} (you)</span>
                    <span className="text-muted-foreground text-xs">Owner</span>
                  </li>
                )}
                {listed.map((member) => {
                  const warning = confirming === member.id ? warningFor(member) : null;
                  return (
                    <li key={member.id} className="space-y-1">
                      <div className="flex min-h-8 items-center gap-2">
                        <MemberAvatar member={member} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
                        {warning === null ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              if (warningFor(member) === null) remove(member);
                              else setConfirming(member.id);
                            }}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                      {warning === null ? null : (
                        <div className="flex items-center gap-2 ps-7">
                          <p className="min-w-0 flex-1 text-muted-foreground text-xs">{warning}</p>
                          <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                          <Button size="xs" variant="destructive" onClick={() => remove(member)}>
                            Remove
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="font-medium text-sm">General access</h3>
              <Select
                value={access.audience}
                onValueChange={(audience) => {
                  if (audience === "members" || audience === "team") {
                    void apply({ kind: "audience", audience });
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
            </section>

            <p className="text-muted-foreground text-xs">
              {shareTrustSentence({
                audience: access.audience,
                teamName,
                ownAccountProvider,
                relatedCount: relatedThreadOwnerIds.length,
              })}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void copyThreadReference(
                threadChipCopyTarget(threadRef, shell.title, readThreadShareOrigin(environmentId)),
              )
            }
          >
            Copy link
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
