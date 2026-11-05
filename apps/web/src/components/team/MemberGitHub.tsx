import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, SourceControlSignInPrompt, TeamMember } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { teamEnvironment, useIsTeamMode, useTeamGitHub } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SourceControlIconArtwork } from "../SourceControlIconArtwork";
import { DeviceCodePrompt } from "../settings/DeviceCodePrompt";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastCommandFailure } from "./toastCommandFailure";

const TEAM_GITHUB_DOCS_URL =
  "https://github.com/rutvikchandla3/t3code/blob/main/docs/user/team.md#github";
const GITHUB = sourceControlClients.find("github");
const GITHUB_ICON = GITHUB?.icon;
const REVOKE_URL = GITHUB?.credentials?.appSignIn?.revokeUrl;

type LinkState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: SourceControlSignInPrompt }
  | { readonly status: "failed"; readonly message: string };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

function ExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <InlineButton render={<a href={props.href} target="_blank" rel="noreferrer noopener" />}>
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </InlineButton>
  );
}

/** Admins of a team whose server has no GitHub App configured learn where to set one up. */
export function TeamGitHubSetupNote({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useTeamGitHub(environmentId);
  const isTeamMode = useIsTeamMode(environmentId);
  if (enabled || !isTeamMode) return null;
  return (
    <p className="px-3 pt-3 text-xs text-muted-foreground sm:px-4">
      Let members sign in with GitHub and open PRs as themselves.{" "}
      <InlineButton
        render={<a href={TEAM_GITHUB_DOCS_URL} target="_blank" rel="noreferrer noopener" />}
      >
        Set up GitHub →
      </InlineButton>
    </p>
  );
}

/** The viewer's own GitHub connection, on their row in Settings → Team. */
export function OwnGitHubConnection({
  environmentId,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
}) {
  const enabled = useTeamGitHub(environmentId);
  const start = useAtomCommand(teamEnvironment.startGitHubLink, { reportFailure: false });
  const wait = useAtomCommand(teamEnvironment.waitForGitHubLink, { reportFailure: false });
  const cancel = useAtomCommand(teamEnvironment.cancelGitHubLink, { reportFailure: false });
  const disconnect = useAtomCommand(teamEnvironment.disconnectGitHub, {
    label: "disconnect GitHub",
  });
  const [state, setState] = useState<LinkState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;

  const github = member.github;
  const connected = github?.connected === true;
  const waiting = !connected && state.status === "waiting" ? state.prompt : null;

  const connect = async () => {
    setState({ status: "starting" });
    const started = await start({ environmentId, input: {} });
    if (started._tag !== "Success") {
      setState({ status: "failed", message: failureMessage(started.cause) });
      return;
    }
    const prompt = started.value;
    setState({ status: "waiting", prompt });
    const finished = await wait({ environmentId, input: {} });
    // A newer attempt, a cancel, or a disconnect owns the state by now.
    setState((current) => {
      if (current.status !== "waiting" || current.prompt !== prompt) return current;
      return finished._tag === "Success"
        ? { status: "idle" }
        : { status: "failed", message: failureMessage(finished.cause) };
    });
  };

  const disconnectGitHub = async () => {
    const confirmed = await requestConfirmDialog(
      `Disconnect GitHub? This server deletes your GitHub connection. To revoke the app on GitHub too, visit ${REVOKE_URL ?? "your GitHub settings"}.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setState({ status: "idle" });
    setBusy(true);
    const result = await disconnect({ environmentId, input: {} });
    setBusy(false);
    toastCommandFailure("Could not disconnect GitHub", result);
  };

  let subtitle: ReactNode;
  let action: ReactNode;
  if (connected) {
    subtitle = `Connected as @${github.login}`;
    action = (
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void disconnectGitHub()}>
        Disconnect
      </Button>
    );
  } else if (waiting !== null) {
    subtitle = "Approve the app on GitHub to finish connecting.";
    action = (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setState({ status: "idle" });
          void cancel({ environmentId, input: {} });
        }}
      >
        Cancel
      </Button>
    );
  } else {
    subtitle =
      github === undefined
        ? "Connect your own GitHub account."
        : `@${github.login} · not connected`;
    action = (
      <div className="flex items-center gap-2">
        {github !== undefined ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void disconnectGitHub()}>
            Disconnect
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={busy || state.status === "starting"}
          onClick={() => void connect()}
        >
          {state.status === "starting" ? <Spinner /> : null}
          {state.status === "failed"
            ? "Try again"
            : github === undefined
              ? "Connect GitHub"
              : "Reconnect"}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-3 p-3">
        {GITHUB_ICON == null ? null : (
          <SourceControlIconArtwork icon={GITHUB_ICON} className="size-6 shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">GitHub</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {waiting !== null ? <DeviceCodePrompt prompt={waiting} /> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          Your GitHub connection is stored on this server. Anyone who can run commands here,
          including agents, could use it to act as you on GitHub.
        </span>
        {github !== undefined && REVOKE_URL !== undefined ? (
          <ExternalLink href={REVOKE_URL}>Revoke on GitHub</ExternalLink>
        ) : null}
      </div>
      {state.status === "failed" && !connected ? (
        <p
          role="alert"
          className="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** What an admin's edit of the GitHub username sends: nothing, a new claim, or null to clear. */
export function githubLoginChange(
  member: TeamMember,
  value: string,
): { readonly githubLogin?: string | null } {
  const login = value.trim().replace(/^@/, "");
  // The server keeps a proven binding when only the case differs, so there is nothing to send.
  if (login.toLowerCase() === (member.github?.login ?? "").toLowerCase()) return {};
  return { githubLogin: login === "" ? null : login };
}

/** Asks before an edit drops a member's working GitHub connection. */
export async function confirmGitHubLoginChange(
  member: TeamMember,
  change: { readonly githubLogin?: string | null },
): Promise<boolean> {
  if (change.githubLogin === undefined || member.github?.connected !== true) return true;
  const confirmed = await requestConfirmDialog(
    change.githubLogin === null
      ? `Disconnect ${member.name}'s GitHub? This server deletes their GitHub connection.`
      : `Change ${member.name}'s GitHub username? Their connection to @${member.github.login} is deleted until they connect again.`,
    { variant: "destructive" },
  );
  return confirmed === true;
}

export function GitHubUsernameField({
  environmentId,
  value,
  onChange,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  if (!useTeamGitHub(environmentId)) return null;
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">
        GitHub username (optional)
      </span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="mt-1.5 block text-xs text-muted-foreground">
        They still connect the account themselves. Clearing it disconnects their GitHub.
      </span>
    </label>
  );
}
