import {
  spaceAskAdmin,
  spaceAskTargetSpace,
  spaceRoomVisits,
} from "@t3tools/client-runtime/spaces";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  teamAdmins,
  teamClaudeKeyIsSet,
  teamClaudeKeyStatusText,
} from "@t3tools/client-runtime/team-claude-key";
import { memberDisplayName } from "@t3tools/client-runtime/state/team";
import {
  TEAM_CLAUDE_KEY_SETTINGS_ANCHOR,
  type EnvironmentId,
  type TeamClaudeKeyErrorReason,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadShells } from "~/state/entities";
import {
  teamClaudeKeyEnvironment,
  useCanManageTeamClaudeKey,
  useTeamClaudeKeyStatus,
} from "~/state/spaceAgent";
import { useSpaceList } from "~/state/spaces";
import { useCurrentMemberId, useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useSpaceComposerDraftStore } from "../spaces/spaceComposerDraftStore";
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
import { toastManager } from "../ui/toast";
import { MemberAvatar } from "./MemberAvatar";
import { toastCommandFailure } from "./toastCommandFailure";

const REJECTED_COPY: Record<TeamClaudeKeyErrorReason, string> = {
  rejected: "Anthropic rejected this key. Check it and try again.",
  unreachable: "Couldn't reach Anthropic to check the key. Try again.",
  invalid: "That doesn't look like an Anthropic API key.",
  "not-admin": "Only team admins can change the key.",
};

function keyErrorReason(cause: unknown): TeamClaudeKeyErrorReason | null {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return null;
  if (cause._tag !== "TeamClaudeKeyError" || !("reason" in cause)) return null;
  const reason = cause.reason;
  return typeof reason === "string" && reason in REJECTED_COPY
    ? (reason as TeamClaudeKeyErrorReason)
    : null;
}

/** Add or replace the key: "Save and check" asks Anthropic before it's stored. */
export function TeamClaudeKeyDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly replacing: boolean;
  readonly onClose: () => void;
}) {
  const setKey = useAtomCommand(teamClaudeKeyEnvironment.set, {
    label: "Save Team Claude key",
    reportFailure: false,
  });
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const save = async () => {
    const key = value.trim();
    if (key === "" || checking) return;
    setChecking(true);
    setRejected(null);
    const result = await setKey({
      environmentId: props.environmentId,
      input: { value: Redacted.make(key) },
    });
    setChecking(false);
    if (result._tag === "Success") {
      setValue("");
      props.onClose();
      toastManager.add({ type: "success", title: "Team Claude key saved" });
      return;
    }
    const reason = keyErrorReason(squashAtomCommandFailure(result));
    if (reason === null) {
      toastCommandFailure("Could not save the key", result);
      return;
    }
    setRejected(REJECTED_COPY[reason]);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !checking && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {props.replacing ? "Replace Team Claude key" : "Add Team Claude key"}
          </DialogTitle>
          <DialogDescription>
            An Anthropic API key. It pays for @pair in every space on this server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              type="password"
              autoComplete="off"
              aria-label="Anthropic API key"
              placeholder="sk-ant-…"
              value={value}
              disabled={checking}
              aria-invalid={rejected !== null}
              onChange={(event) => {
                setValue(event.target.value);
                setRejected(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
            {rejected === null ? null : (
              <p role="alert" className="text-destructive-foreground text-xs">
                {rejected}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={checking} onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={checking || value.trim() === ""} onClick={() => void save()}>
            {checking ? "Checking…" : "Save and check"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RemoveKeyDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly activeSpaceCount: number;
  readonly onClose: () => void;
}) {
  const remove = useAtomCommand(teamClaudeKeyEnvironment.remove, "Remove Team Claude key");
  const [busy, setBusy] = useState(false);
  const spaces = props.activeSpaceCount;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Remove the Team Claude key?</DialogTitle>
          <DialogDescription>
            @pair stops replying in {spaces} {spaces === 1 ? "space" : "spaces"}. Members' own
            threads keep working.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await remove({ environmentId: props.environmentId, input: {} });
              setBusy(false);
              toastCommandFailure("Could not remove the key", result);
              if (result._tag === "Success") props.onClose();
            }}
          >
            Remove key
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Settings → Team: the key that pays for @pair, and who to ask when it's missing. */
export function TeamClaudeKeyCard(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const status = useTeamClaudeKeyStatus(environmentId);
  const canManage = useCanManageTeamClaudeKey(environmentId);
  const members = useTeamMembers(environmentId);
  const viewerId = useCurrentMemberId(environmentId);
  const spaces = useSpaceList(environmentId);
  const shells = useThreadShells();
  const putDraft = useSpaceComposerDraftStore((state) => state.put);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"set" | "remove" | null>(null);
  const now = Date.parse(`${useNowMinute()}Z`);
  const isSet = teamClaudeKeyIsSet(status);
  const nameOf = (memberId: Parameters<typeof memberDisplayName>[1]) =>
    memberId === viewerId ? "you" : memberDisplayName(members, memberId);
  const admins = teamAdmins(members.values());

  const ask = () => {
    const target = spaceAskAdmin(null, members.values(), status);
    if (target === null) return;
    const visits = spaceRoomVisits(
      shells.filter((shell) => shell.environmentId === environmentId).map((shell) => shell.source),
    );
    const space = spaceAskTargetSpace(spaces, viewerId, target.admin.id, visits);
    if (space === null) {
      const url = `${window.location.origin}/settings/team#${TEAM_CLAUDE_KEY_SETTINGS_ANCHOR}`;
      void navigator.clipboard.writeText(url).then(
        () =>
          toastManager.add({
            type: "success",
            title: "Link copied",
            description: `Send it to ${target.admin.name}.`,
          }),
        () => toastManager.add({ type: "error", title: "Could not copy the link" }),
      );
      return;
    }
    putDraft(space.id, target.draft);
    const id = toastManager.add({
      type: "success",
      title: "Drafted",
      description: `In ${space.name}, for ${target.admin.name}.`,
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(id);
          void navigate({
            to: "/spaces/$environmentId/$spaceId",
            params: { environmentId, spaceId: space.id },
          });
        },
      },
    });
  };

  return (
    <SettingsSection
      {...searchableSetting(TEAM_CLAUDE_KEY_SETTINGS_ANCHOR)}
      icon={<KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />}
      headerAction={
        canManage && status !== null ? (
          <div className="flex items-center gap-1.5">
            {isSet ? (
              <Button size="xs" variant="ghost-destructive" onClick={() => setDialog("remove")}>
                Remove
              </Button>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => setDialog("set")}>
              {isSet ? "Replace" : "Add key"}
            </Button>
          </div>
        ) : null
      }
    >
      <p className="px-3 pt-3 text-muted-foreground text-xs sm:px-4">
        Anthropic API key · Pays for @pair in every space on this server. Members' own threads keep
        using their own accounts.
      </p>
      <SettingsRow
        title={status === null ? "Checking…" : teamClaudeKeyStatusText(status, nameOf, now)}
        role="status"
      />
      {canManage || isSet || status === null ? null : (
        <SettingsRow
          title="Ask an admin to add one"
          description={
            <span className="flex flex-wrap items-center gap-1.5">
              {admins.map((admin) => (
                <span key={admin.id} className="inline-flex items-center gap-1">
                  <MemberAvatar size="sm" member={admin} />
                  {admin.name}
                </span>
              ))}
            </span>
          }
          control={
            admins.length === 0 ? null : (
              <Button size="xs" variant="outline" onClick={ask}>
                {spaceAskAdmin(null, members.values(), status)?.label ?? "Ask"}
              </Button>
            )
          }
        />
      )}
      {dialog === "set" ? (
        <TeamClaudeKeyDialog
          environmentId={environmentId}
          replacing={isSet}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "remove" && status !== null ? (
        <RemoveKeyDialog
          environmentId={environmentId}
          activeSpaceCount={status.activeSpaceCount}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
