import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type MemberId,
  type MemberProviderAccountDriver,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  KeyRoundIcon,
  LogInIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { teamEnvironment, useCurrentMemberId, useIsTeamMode, useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getProviderStatusMessage } from "../chat/ProviderStatusBanner";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { ProviderWizardAuthenticationStep } from "../settings/ProviderWizardAuthenticationStep";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import {
  addProviderAccountDialogOpenAtom,
  setAddProviderAccountDialogOpen,
} from "./providerAccountDialogState";
import { toastCommandFailure } from "./toastCommandFailure";

const DRIVER_LABELS: Record<MemberProviderAccountDriver, string> = {
  claudeAgent: "Claude",
  codex: "ChatGPT",
};
const DRIVERS = Object.keys(DRIVER_LABELS) as ReadonlyArray<MemberProviderAccountDriver>;
const TOKEN_VARIABLES: ReadonlyArray<string> = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

const ADD_TRUST_COPY =
  "Your sign-in is saved on this server. Anyone who can run commands here, including agents, can read it. Only you can pick this account for a thread, but anyone who prompts that thread uses it.";
const SECTION_TRUST_COPY = "Saved on this server, where anyone who can run commands can read them.";

interface OwnedAccount {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: MemberProviderAccountDriver;
  readonly displayName: string;
}

function memberAccountDriver(driver: ProviderDriverKind): MemberProviderAccountDriver | null {
  return DRIVERS.find((candidate) => candidate === driver) ?? null;
}

function configString(config: unknown, key: string): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" ? value : undefined;
}

function claudeLoginCommand(homePath: string): string {
  return `CLAUDE_CONFIG_DIR='${homePath.replaceAll("'", `'\\''`)}' claude auth login`;
}

function accountStatus(instance: ProviderInstanceConfig, provider: ServerProvider | undefined) {
  if (instance.enabled === false) return "Disabled";
  if (provider === undefined) return "Checking…";
  if (provider.auth.status === "authenticated") {
    return provider.auth.email ? `Signed in as ${provider.auth.email}` : "Signed in";
  }
  if (provider.auth.status === "unauthenticated") return "Signed out";
  return provider.status === "ready" ? "Ready" : getProviderStatusMessage(provider);
}

/** Settings → Team: the accounts the viewer brought. Team mode only, so a solo server shows nothing. */
export function ProviderAccountsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const isTeamMode = useIsTeamMode(environmentId);
  const selfId = useCurrentMemberId(environmentId);
  if (!isTeamMode || selfId === null) return null;
  return <ProviderAccountsList environmentId={environmentId} selfId={selfId} />;
}

function ProviderAccountsList({
  environmentId,
  selfId,
}: {
  readonly environmentId: EnvironmentId;
  readonly selfId: MemberId;
}) {
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    teamEnvironment.mutateProviderAccount.permissionAtom(environmentId),
  );
  const addOpen = useAtomValue(addProviderAccountDialogOpenAtom);
  const selfName = useTeamMembers(environmentId).get(selfId)?.name ?? "Your";
  const accounts = Object.entries(providerInstances).flatMap(([key, instance]): OwnedAccount[] => {
    const driver = memberAccountDriver(instance.driver);
    if (instance.ownerMemberId !== selfId || driver === null) return [];
    const instanceId = ProviderInstanceId.make(key);
    return [{ instanceId, instance, driver, displayName: instance.displayName ?? key }];
  });

  return (
    <SettingsSection
      {...searchableSetting("provider-accounts")}
      headerAction={
        canOperate ? (
          <Button size="xs" variant="outline" onClick={() => setAddProviderAccountDialogOpen(true)}>
            <PlusIcon className="size-3" aria-hidden />
            Add account
          </Button>
        ) : null
      }
    >
      <p className="px-3 pt-3 text-xs text-muted-foreground sm:px-4">{SECTION_TRUST_COPY}</p>
      {accounts.length === 0 ? (
        <SettingsRow
          title="No accounts yet"
          description="Add your Claude or ChatGPT account to use your own subscription in threads."
        />
      ) : (
        accounts.map((account) => (
          <ProviderAccountRow
            key={account.instanceId}
            environmentId={environmentId}
            account={account}
            provider={providers.find((candidate) => candidate.instanceId === account.instanceId)}
            canOperate={canOperate}
          />
        ))
      )}
      {addOpen && canOperate ? (
        <AddProviderAccountDialog
          environmentId={environmentId}
          selfName={selfName}
          onClose={() => setAddProviderAccountDialogOpen(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

function ProviderAccountRow({
  environmentId,
  account,
  provider,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: OwnedAccount;
  readonly provider: ServerProvider | undefined;
  readonly canOperate: boolean;
}) {
  const { instanceId, instance, driver, displayName } = account;
  const mutate = useAtomCommand(teamEnvironment.mutateProviderAccount, {
    label: "update provider account",
  });
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, {
    label: "sign out of provider account",
  });
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"sign-in" | "rename" | null>(null);
  const signedIn = provider?.auth.status === "authenticated";
  const hasToken = (instance.environment ?? []).some((variable) =>
    TOKEN_VARIABLES.includes(variable.name),
  );
  // Claude has no sign-in controller: a terminal login is undone by removing the account.
  const canSignOut = driver === "codex" ? signedIn : hasToken;

  const signOut = async () => {
    setBusy(true);
    const result =
      driver === "codex"
        ? await logout({ environmentId, input: { instanceId } })
        : await mutate({ environmentId, input: { operation: "update", instanceId, token: null } });
    setBusy(false);
    toastCommandFailure("Could not sign out", result);
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Threads using ${displayName} will need another provider.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await mutate({ environmentId, input: { operation: "remove", instanceId } });
    setBusy(false);
    toastCommandFailure("Could not remove the account", result);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderInstanceIcon
            driverKind={ProviderDriverKind.make(driver)}
            displayName={displayName}
            accentColor={instance.accentColor}
          />
          <div className="min-w-0 space-y-0.5">
            <h3 className="truncate text-sm font-medium text-foreground">{displayName}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {DRIVER_LABELS[driver]} · {accountStatus(instance, provider)}
            </p>
          </div>
        </div>
        {canOperate ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {!signedIn && instance.enabled !== false ? (
              <Button size="xs" variant="outline" onClick={() => setDialog("sign-in")}>
                Sign in
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Actions for ${displayName}`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                {instance.enabled === false ? null : (
                  <MenuItem onClick={() => setDialog("sign-in")}>
                    {driver === "claudeAgent" ? <KeyRoundIcon /> : <LogInIcon />}
                    {signedIn ? "Sign in again" : "Sign in"}
                  </MenuItem>
                )}
                {canSignOut ? (
                  <MenuItem onClick={() => void signOut()}>
                    <LogOutIcon />
                    Sign out
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => setDialog("rename")}>
                  <PencilIcon />
                  Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => void remove()}>
                  <Trash2Icon />
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : null}
      </div>
      {dialog === "sign-in" ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setDialog(null))}>
          <WizardPopup>
            <ProviderAccountSignIn
              environmentId={environmentId}
              account={account}
              onFinish={() => setDialog(null)}
            />
          </WizardPopup>
        </Dialog>
      ) : null}
      {dialog === "rename" ? (
        <RenameProviderAccountDialog
          environmentId={environmentId}
          account={account}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function RenameProviderAccountDialog({
  environmentId,
  account,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: OwnedAccount;
  readonly onClose: () => void;
}) {
  const mutate = useAtomCommand(teamEnvironment.mutateProviderAccount, {
    label: "rename provider account",
  });
  const [name, setName] = useState(account.displayName);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    if (busy || trimmed === "") return;
    setBusy(true);
    const result = await mutate({
      environmentId,
      input: { operation: "update", instanceId: account.instanceId, displayName: trimmed },
    });
    setBusy(false);
    if (result._tag === "Success") onClose();
    else toastCommandFailure("Could not rename the account", result);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <WizardPopup>
        <WizardHeader title={`Rename ${account.displayName}`} />
        <WizardPanel>
          <form
            id="rename-provider-account"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SettingsRow
              title="Name"
              description="Shown in the model picker and on threads that use it."
              control={
                <Input
                  aria-label="Account name"
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              }
            />
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rename-provider-account" disabled={busy || trimmed === ""}>
            Save
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

function AddProviderAccountDialog({
  environmentId,
  selfName,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly selfName: string;
  readonly onClose: () => void;
}) {
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const mutate = useAtomCommand(teamEnvironment.mutateProviderAccount, {
    label: "add provider account",
  });
  const [driver, setDriver] = useState<MemberProviderAccountDriver>("claudeAgent");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OwnedAccount | null>(null);
  const managedCodex = useManagedCodexInstalled(environmentId, driver === "codex");
  const unavailable = driver === "codex" && managedCodex !== true;
  const defaultName = `${selfName}'s ${DRIVER_LABELS[driver]}`;

  const submit = async () => {
    if (busy || unavailable) return;
    setBusy(true);
    const displayName = name.trim() || defaultName;
    const savedToken = driver === "claudeAgent" ? token.trim() : "";
    const result = await mutate({
      environmentId,
      input: {
        operation: "create",
        driver,
        ...(name.trim() === "" ? {} : { displayName }),
        ...(savedToken === "" ? {} : { token: savedToken }),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      toastCommandFailure("Could not add the account", result);
      return;
    }
    if (savedToken !== "") {
      onClose();
      return;
    }
    const instanceId = result.value.instanceId;
    setCreated({
      instanceId,
      driver,
      displayName,
      instance: providerInstances[instanceId] ?? {
        driver: ProviderDriverKind.make(driver),
        displayName,
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <WizardPopup size={created?.driver === "codex" ? "wide" : "default"}>
        {created ? (
          <ProviderAccountSignIn
            environmentId={environmentId}
            account={created}
            onFinish={onClose}
          />
        ) : (
          <>
            <WizardHeader title="Add your provider account" description={ADD_TRUST_COPY} />
            <WizardPanel>
              <form
                id="add-provider-account"
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <SettingsRow
                  title="Provider"
                  control={
                    <Select
                      value={driver}
                      onValueChange={(next) => {
                        const known = DRIVERS.find((candidate) => candidate === next);
                        if (known) setDriver(known);
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="Provider">
                        <SelectValue>{DRIVER_LABELS[driver]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {DRIVERS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {DRIVER_LABELS[option]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  }
                />
                {driver === "codex" && managedCodex === false ? (
                  <p className="text-xs text-muted-foreground">
                    Ask an admin to set up ChatGPT accounts in Settings → Providers.
                  </p>
                ) : (
                  <SettingsRow
                    title="Name"
                    description="Shown in the model picker and on threads that use it."
                    control={
                      <Input
                        aria-label="Account name"
                        value={name}
                        placeholder={defaultName}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    }
                  />
                )}
                {driver === "claudeAgent" ? (
                  <SettingsRow
                    title="Token"
                    description="Optional. An API key, or a token from claude setup-token. Leave it empty to sign in from a terminal next."
                    control={
                      <Input
                        aria-label="Claude token"
                        type="password"
                        autoComplete="off"
                        value={token}
                        disabled={busy}
                        onChange={(event) => setToken(event.target.value)}
                      />
                    }
                  />
                ) : null}
              </form>
            </WizardPanel>
            <WizardFooter>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="add-provider-account" disabled={busy || unavailable}>
                {busy ? "Adding…" : "Continue"}
              </Button>
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

/**
 * Whether managed Codex is installed, read through a managed Codex instance's install state:
 * the runtime is shared, and only an admin can install it. `undefined` while that loads.
 */
function useManagedCodexInstalled(
  environmentId: EnvironmentId,
  enabled: boolean,
): boolean | undefined {
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const probe = Object.entries(providerInstances).find(
    ([, instance]) =>
      instance.driver === "codex" && configString(instance.config, "setupMode") === "managed",
  )?.[0];
  const install = useEnvironmentQuery(
    enabled && probe !== undefined
      ? serverEnvironment.providerInstallState({
          environmentId,
          input: { instanceId: ProviderInstanceId.make(probe) },
        })
      : null,
  );
  if (probe === undefined) return false;
  if (install.error !== null) return false;
  return install.data === null ? undefined : install.data.installedVersion != null;
}

function ProviderAccountSignIn({
  environmentId,
  account,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: OwnedAccount;
  readonly onFinish: () => void;
}) {
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this server";
  if (account.driver === "codex") {
    return (
      <>
        <WizardHeader title={`Sign in to ${account.displayName}`} />
        <ProviderWizardAuthenticationStep
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={account.instanceId}
          onFinish={onFinish}
        />
      </>
    );
  }
  return (
    <ClaudeAccountSignIn environmentId={environmentId} account={account} onFinish={onFinish} />
  );
}

function ClaudeAccountSignIn({
  environmentId,
  account,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: OwnedAccount;
  readonly onFinish: () => void;
}) {
  const homePath = useEnvironmentSettings(environmentId, (settings) =>
    configString(settings.providerInstances[account.instanceId]?.config, "homePath"),
  );
  const signedIn = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId),
    (providers) =>
      providers?.find((candidate) => candidate.instanceId === account.instanceId)?.auth.status ===
      "authenticated",
  );
  const mutate = useAtomCommand(teamEnvironment.mutateProviderAccount, {
    label: "save provider account token",
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "check provider account",
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "sign-in command" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const command = homePath ? claudeLoginCommand(homePath) : null;

  const saveToken = async () => {
    const trimmed = token.trim();
    if (busy || trimmed === "") return;
    setBusy(true);
    const result = await mutate({
      environmentId,
      input: { operation: "update", instanceId: account.instanceId, token: trimmed },
    });
    setBusy(false);
    if (result._tag === "Success") onFinish();
    else toastCommandFailure("Could not save the token", result);
  };

  return (
    <>
      <WizardHeader title={`Sign in to ${account.displayName}`} />
      <WizardPanel>
        <div className="grid gap-4">
          <SettingsRow
            title="Run this in a terminal"
            description="Then come back and check again."
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={command === null}
                  onClick={() => command && copyToClipboard(command)}
                >
                  {isCopied ? "Copied" : "Copy"}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void refresh({ environmentId, input: { instanceId: account.instanceId } })
                  }
                >
                  Check again
                </Button>
              </div>
            }
          />
          <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {command ?? "Preparing the account…"}
          </pre>
          <form
            id="claude-account-token"
            onSubmit={(event) => {
              event.preventDefault();
              void saveToken();
            }}
          >
            <SettingsRow
              title="Or paste a token"
              description="An API key, or a token from claude setup-token."
              control={
                <Input
                  aria-label="Claude token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  disabled={busy}
                  onChange={(event) => setToken(event.target.value)}
                />
              }
            />
          </form>
        </div>
      </WizardPanel>
      <WizardFooter>
        {token.trim() === "" ? (
          <Button size="sm" variant={signedIn ? "default" : "outline"} onClick={onFinish}>
            {signedIn ? "Done" : "Finish later"}
          </Button>
        ) : (
          <Button size="sm" type="submit" form="claude-account-token" disabled={busy}>
            Save token
          </Button>
        )}
      </WizardFooter>
    </>
  );
}
