import {
  MemberRole,
  type AuthPairingCredentialResult,
  type EnvironmentId,
  type TeamInviteInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { formatExpiresInLabel } from "../../timestampFormat";
import { environmentCloudLaunchAtom } from "~/state/server";
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
import { GitHubUsernameField } from "./MemberGitHub";
import { toastCommandFailure } from "./toastCommandFailure";

const TRUST_WARNING =
  "Members can run commands as this server's user. Invite only people you'd give SSH access to.";
const CLOUD_TRUST_WARNING =
  "Members can start cloud threads on this server's machines and provider accounts. They see a teammate's thread only when it is shared with them.";

/** What an invited member can reach on this environment (D15). */
export function useTrustWarning(environmentId: EnvironmentId) {
  return useAtomValue(environmentCloudLaunchAtom(environmentId))
    ? CLOUD_TRUST_WARNING
    : TRUST_WARNING;
}

const ROLE_LABELS: Record<MemberRole, string> = { admin: "Admin", member: "Member" };
const ROLE_HINTS: Record<MemberRole, string> = {
  admin: "Manages settings, providers, members and access.",
  member: "Works in every project. Cannot change server settings or manage members.",
};

/** Git takes any email, but forges only link commits to an address that looks real. */
export const isGitEmailPlausible = (trimmed: string) => trimmed === "" || trimmed.includes("@");

export function GitEmailField({
  value,
  onChange,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const plausible = isGitEmailPlausible(value.trim());
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">Git email (optional)</span>
      <Input
        type="email"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={!plausible}
      />
      {plausible ? null : (
        <p className="mt-1.5 text-xs text-destructive">Enter an email address with an @.</p>
      )}
    </label>
  );
}

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
          This server is only reachable from this machine. Copy the code and sign in from another
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
  onClose,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly credential: AuthPairingCredentialResult | null;
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
  const [gitEmail, setGitEmail] = useState("");
  const [githubLogin, setGitHubLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    readonly name: string;
    readonly credential: AuthPairingCredentialResult;
  } | null>(null);
  const invite = useAtomCommand(teamEnvironment.inviteMember, { label: "invite member" });
  const trustWarning = useTrustWarning(environmentId);
  const trimmedName = name.trim();
  const trimmedGitEmail = gitEmail.trim();
  const trimmedGitHubLogin = githubLogin.trim().replace(/^@/, "");
  const canSubmit = trimmedName.length > 0 && isGitEmailPlausible(trimmedGitEmail);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setRole("member");
      setGitEmail("");
      setGitHubLogin("");
      setCreated(null);
    }
  };

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    const input = {
      name: trimmedName,
      role,
      ...(trimmedGitEmail === "" ? {} : { gitEmail: trimmedGitEmail }),
      ...(trimmedGitHubLogin === "" ? {} : { githubLogin: trimmedGitHubLogin }),
    } satisfies TeamInviteInput;
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
            className="flex min-h-0 flex-col"
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
                <GitEmailField value={gitEmail} onChange={setGitEmail} disabled={busy} />
                <GitHubUsernameField
                  environmentId={environmentId}
                  value={githubLogin}
                  onChange={setGitHubLogin}
                  disabled={busy}
                  hint="They can sign in with GitHub instead of using the link."
                />
                <Alert variant="warning">
                  <AlertDescription>{trustWarning}</AlertDescription>
                </Alert>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !canSubmit}>
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
                <p className="text-xs text-muted-foreground">{trustWarning}</p>
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
