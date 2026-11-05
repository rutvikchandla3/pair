import {
  MemberRole,
  type AuthPairingCredentialResult,
  type EnvironmentId,
  type TeamInviteInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { formatExpiresInLabel } from "../../timestampFormat";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { PairingLinkShare, usePairingLinkShare } from "../settings/PairingLinkShare";
import { usePairingShareEndpoints } from "../settings/usePairingShareEndpoints";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastCommandFailure } from "./toastCommandFailure";

const TRUST_WARNING =
  "Members can run commands as this server's user. Invite only people you'd give SSH access to.";

const ROLE_LABELS: Record<MemberRole, string> = { admin: "Admin", member: "Member" };
const ROLE_HINTS: Record<MemberRole, string> = {
  admin: "Manages settings, providers, members and access.",
  member: "Works in every project. Cannot change server settings or manage members.",
};

function LinkResult({ credential }: { readonly credential: AuthPairingCredentialResult }) {
  const nowMs = useNowSecond();
  const source = usePairingShareEndpoints();
  const share = usePairingLinkShare({ ...source, credential: credential.credential });
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {formatExpiresInLabel(DateTime.formatIso(credential.expiresAt), nowMs)}. The link works
        once.
      </p>
      {share.qrPairingUrl === null ? (
        <p className="text-xs text-muted-foreground">
          This server is only reachable from this machine. Copy the code and pair from another
          client using the server&apos;s reachable address.
        </p>
      ) : (
        <PairingLinkShare share={share} />
      )}
      {share.qrPairingUrl === null && share.canCopyToClipboard ? (
        <Button size="xs" variant="outline" onClick={share.copyCode}>
          Copy code
        </Button>
      ) : null}
    </div>
  );
}

/** A one-time link to share, for an invite, a sign-in link, or one of your own devices. */
export function MemberLinkDialog({
  title,
  description,
  credential,
  warning,
  onClose,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly credential: AuthPairingCredentialResult | null;
  readonly warning?: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={credential !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {credential === null ? null : <LinkResult credential={credential} />}
          {warning ? <p className="mt-3 text-xs text-muted-foreground">{TRUST_WARNING}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function InviteMemberDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    readonly name: string;
    readonly credential: AuthPairingCredentialResult;
  } | null>(null);
  const invite = useAtomCommand(teamEnvironment.inviteMember, { label: "invite member" });
  const trimmedName = name.trim();

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setRole("member");
      setCreated(null);
    }
  };

  const submit = async () => {
    if (busy || trimmedName.length === 0) return;
    setBusy(true);
    const input = { name: trimmedName, role } satisfies TeamInviteInput;
    const result = await invite({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setCreated({ name: trimmedName, credential: result.value.credential });
    } else {
      toastCommandFailure("Could not create the invite", result);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" aria-hidden />
            Invite member
          </Button>
        }
      />
      <DialogPopup className="max-w-lg">
        {created === null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                Creates a one-time invite link for one person. They pick it up on their own device.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Alice"
                    disabled={busy}
                    autoFocus
                  />
                </label>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-foreground">Role</span>
                  <Select
                    value={role}
                    onValueChange={(value) => setRole(value as MemberRole)}
                    disabled={busy}
                  >
                    <SelectTrigger aria-label="Role">
                      <SelectValue>{ROLE_LABELS[role]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {MemberRole.literals.map((option) => (
                        <SelectItem key={option} hideIndicator value={option}>
                          {ROLE_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="mt-1.5 text-xs text-muted-foreground">{ROLE_HINTS[role]}</p>
                </div>
                <Alert variant="warning">
                  <AlertDescription>{TRUST_WARNING}</AlertDescription>
                </Alert>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || trimmedName.length === 0}>
                {busy ? "Creating…" : "Create invite"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite {created.name}</DialogTitle>
              <DialogDescription>
                Send this link to {created.name}. Opening it signs them in as a {role} on this
                server.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-3">
                <LinkResult credential={created.credential} />
                <p className="text-xs text-muted-foreground">{TRUST_WARNING}</p>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
