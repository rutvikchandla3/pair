import { useAtomValue } from "@effect/atom-react";
import {
  managedCapabilityDenial,
  type AuthPairingCredentialResult,
  type EnvironmentId,
  type MemberRole,
  type TeamMember,
  type TeamUpdateSelfInput,
} from "@t3tools/contracts";
import {
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ShieldIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { authEnvironment } from "~/state/auth";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { usePresence } from "~/state/presence";
import { teamEnvironment, useCurrentMemberId, useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatAccessTimestamp } from "../settings/ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { ManagedControl } from "../ManagedPolicy";
import { Badge } from "../ui/badge";
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
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  GitEmailField,
  InviteMemberDialog,
  isGitEmailPlausible,
  MemberLinkDialog,
} from "./InviteMemberDialog";
import { MemberAvatar } from "./MemberAvatar";
import { MemberUsage } from "./MemberUsage";
import { ProviderAccountsSection } from "./ProviderAccountsSection";
import { toastCommandFailure } from "./toastCommandFailure";

const ROLE_LABELS: Record<MemberRole, string> = { admin: "Admin", member: "Member" };
const STATUS_LABELS = { online: "Online", away: "Away" } as const;

function sortMembers(members: ReadonlyArray<TeamMember>): ReadonlyArray<TeamMember> {
  return members.toSorted(
    (left, right) =>
      Number(right.isOwner) - Number(left.isOwner) ||
      Number(right.role === "admin") - Number(left.role === "admin") ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

export function TeamSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection {...searchableSetting("team")}>
          <SettingsRow title="Connect to an environment to see its team." />
        </SettingsSection>
      ) : (
        <TeamMembersSection environmentId={environmentId} />
      )}
      {environmentId === null ? null : <ProviderAccountsSection environmentId={environmentId} />}
    </SettingsPageContainer>
  );
}

function TeamMembersSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const members = useTeamMembers(environmentId);
  const selfId = useCurrentMemberId(environmentId);
  const canInvite = useAtomValue(teamEnvironment.inviteMember.permissionAtom(environmentId));
  const pairingDenial = managedCapabilityDenial(usePrimaryManagedPolicy(), "remoteClients");
  const [showRemoved, setShowRemoved] = useState(false);
  const sorted = sortMembers([...members.values()]);
  const active = sorted.filter((member) => member.removedAt === null);
  const removed = sorted.filter((member) => member.removedAt !== null);
  const visible = showRemoved ? [...active, ...removed] : active;
  return (
    <SettingsSection
      {...searchableSetting("team")}
      headerAction={
        canInvite ? (
          <ManagedControl reason={pairingDenial}>
            <InviteMemberDialog environmentId={environmentId} />
          </ManagedControl>
        ) : null
      }
    >
      {canInvite ? (
        <p className="px-3 pt-3 text-xs text-muted-foreground sm:px-4">
          Members can run commands as this server&apos;s user. Invite only people you&apos;d give
          SSH access to.
        </p>
      ) : null}
      {selfId === null ? (
        <SettingsRow
          title="Teams are not available on this server"
          description="Update Pair on this server to invite members."
        />
      ) : members.size === 0 ? (
        <SettingsRow title="Loading members…" role="status" />
      ) : (
        visible.map((member) => (
          <MemberRow
            key={member.id}
            environmentId={environmentId}
            member={member}
            isSelf={member.id === selfId}
          />
        ))
      )}
      {removed.length > 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <Button size="xs" variant="ghost" onClick={() => setShowRemoved((shown) => !shown)}>
            {showRemoved ? "Hide removed members" : `Show removed members (${removed.length})`}
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function MemberRow({
  environmentId,
  member,
  isSelf,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly isSelf: boolean;
}) {
  const isRemoved = member.removedAt !== null;
  // Other members only, so your own row and offline members have no status.
  const presenceStatus = usePresence(environmentId).members.get(member.id);
  const status = isRemoved ? undefined : presenceStatus;
  const canSignIn = useAtomValue(teamEnvironment.createSignInLink.permissionAtom(environmentId));
  const canEdit = useAtomValue(
    (isSelf ? teamEnvironment.updateSelf : teamEnvironment.updateMember).permissionAtom(
      environmentId,
    ),
  );
  const canSetRole = useAtomValue(teamEnvironment.setMemberRole.permissionAtom(environmentId));
  const canRemove = useAtomValue(teamEnvironment.removeMember.permissionAtom(environmentId));
  const pairingDenial = managedCapabilityDenial(usePrimaryManagedPolicy(), "remoteClients");
  const createSignInLink = useAtomCommand(teamEnvironment.createSignInLink, {
    label: "create sign-in link",
  });
  const setMemberRole = useAtomCommand(teamEnvironment.setMemberRole, { label: "set member role" });
  const removeMember = useAtomCommand(teamEnvironment.removeMember, { label: "remove member" });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState<{
    readonly title: string;
    readonly description: string;
    readonly credential: AuthPairingCredentialResult;
  } | null>(null);

  const showSignIn = !isSelf && !isRemoved && canSignIn;
  const showRole = !isSelf && !isRemoved && !member.isOwner && canSetRole;
  const showEdit = !isRemoved && canEdit;
  const showRemove = !isSelf && !isRemoved && !member.isOwner && canRemove;
  const showMenu = !isSelf && (showSignIn || showRole || showEdit || showRemove);

  const signInLink = async () => {
    setBusy(true);
    const result = await createSignInLink({ environmentId, input: { memberId: member.id } });
    setBusy(false);
    if (result._tag === "Success") {
      setLink({
        title: `Sign-in link for ${member.name}`,
        description: `Send this to ${member.name} so they can sign in on a new device.`,
        credential: result.value.credential,
      });
    } else {
      toastCommandFailure("Could not create the sign-in link", result);
    }
  };

  const changeRole = async () => {
    setBusy(true);
    const role = member.role === "admin" ? "member" : "admin";
    const result = await setMemberRole({ environmentId, input: { memberId: member.id, role } });
    setBusy(false);
    toastCommandFailure("Could not change the role", result);
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Remove ${member.name}? Their devices are signed out and unused links stop working. Their past work stays in the threads.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await removeMember({ environmentId, input: { memberId: member.id } });
    setBusy(false);
    toastCommandFailure("Could not remove the member", result);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className={cn("flex min-w-0 flex-1 items-center gap-3", isRemoved && "opacity-60")}>
          <MemberAvatar member={member} size="md" away={status === "away"} />
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-h-5 items-center gap-1.5">
              <h3 className="truncate text-sm font-medium text-foreground">{member.name}</h3>
              {isSelf ? (
                <Badge size="sm" variant="outline">
                  You
                </Badge>
              ) : null}
              {member.isOwner ? (
                <Badge size="sm" variant="secondary">
                  Owner
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {isRemoved && member.removedAt !== null
                ? `Removed ${formatAccessTimestamp(member.removedAt)}`
                : [
                    status === undefined ? null : STATUS_LABELS[status],
                    ROLE_LABELS[member.role],
                    member.gitEmail,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
            <MemberUsage environmentId={environmentId} memberId={member.id} />
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {isSelf ? (
            <>
              {showEdit ? (
                <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                  Edit profile
                </Button>
              ) : null}
              <AddDeviceButton
                environmentId={environmentId}
                member={member}
                disabledReason={pairingDenial}
              />
            </>
          ) : null}
          {showMenu ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Actions for ${member.name}`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                {showSignIn ? (
                  <MenuItem
                    disabled={pairingDenial !== undefined}
                    onClick={() => void signInLink()}
                  >
                    <LinkIcon />
                    Sign-in link
                  </MenuItem>
                ) : null}
                {showEdit ? (
                  <MenuItem onClick={() => setEditing(true)}>
                    <PencilIcon />
                    Edit
                  </MenuItem>
                ) : null}
                {showRole ? (
                  <MenuItem onClick={() => void changeRole()}>
                    {member.role === "admin" ? <UserIcon /> : <ShieldIcon />}
                    {member.role === "admin" ? "Make member" : "Make admin"}
                  </MenuItem>
                ) : null}
                {showRemove ? (
                  <>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => void remove()}>
                      <Trash2Icon />
                      Remove
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      {editing ? (
        <EditMemberDialog
          environmentId={environmentId}
          member={member}
          isSelf={isSelf}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <MemberLinkDialog
        title={link?.title ?? ""}
        description={link?.description ?? ""}
        credential={link?.credential ?? null}
        onClose={() => setLink(null)}
      />
    </div>
  );
}

function AddDeviceButton({
  environmentId,
  member,
  disabledReason,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly disabledReason: string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState<AuthPairingCredentialResult | null>(null);
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const addDevice = async () => {
    setBusy(true);
    const result = await createPairingCredential({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") setCredential(result.value);
    else toastCommandFailure("Could not create the link", result);
  };
  return (
    <>
      <ManagedControl reason={disabledReason}>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || disabledReason !== undefined}
          onClick={() => void addDevice()}
        >
          Add a device
        </Button>
      </ManagedControl>
      <MemberLinkDialog
        title="Add a device"
        description={`Open this link on the new device to sign in as ${member.name}.`}
        credential={credential}
        onClose={() => setCredential(null)}
      />
    </>
  );
}

function EditMemberDialog({
  environmentId,
  member,
  isSelf,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly isSelf: boolean;
  readonly onClose: () => void;
}) {
  const updateSelf = useAtomCommand(teamEnvironment.updateSelf, { label: "update profile" });
  const updateMember = useAtomCommand(teamEnvironment.updateMember, { label: "update member" });
  const [name, setName] = useState(member.name);
  const [gitName, setGitName] = useState(member.gitName ?? "");
  const [gitEmail, setGitEmail] = useState(member.gitEmail ?? "");
  const [busy, setBusy] = useState(false);

  const trimmedGitName = gitName.trim();
  const trimmedGitEmail = gitEmail.trim();
  // An emptied git field is sent as null, which clears it.
  const changes = {
    ...(name.trim() !== "" && name.trim() !== member.name ? { name: name.trim() } : {}),
    ...(trimmedGitName !== (member.gitName ?? "")
      ? { gitName: trimmedGitName === "" ? null : trimmedGitName }
      : {}),
    ...(trimmedGitEmail !== (member.gitEmail ?? "")
      ? { gitEmail: trimmedGitEmail === "" ? null : trimmedGitEmail }
      : {}),
  } satisfies TeamUpdateSelfInput;
  const canSave = Object.keys(changes).length > 0 && isGitEmailPlausible(trimmedGitEmail);

  const submit = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    const result = isSelf
      ? await updateSelf({ environmentId, input: changes })
      : await updateMember({ environmentId, input: { memberId: member.id, ...changes } });
    setBusy(false);
    if (result._tag === "Success") onClose();
    else toastCommandFailure("Could not save the changes", result);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{isSelf ? "Edit your profile" : `Edit ${member.name}`}</DialogTitle>
            <DialogDescription>
              The name appears next to their work. Git name and email, when set, author their
              commits.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Git name (optional)
                </span>
                <Input
                  value={gitName}
                  onChange={(event) => setGitName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <GitEmailField value={gitEmail} onChange={setGitEmail} disabled={busy} />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !canSave}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
