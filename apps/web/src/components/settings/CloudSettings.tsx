import { useAtomValue } from "@effect/atom-react";
import {
  type ComputeDriverId,
  ComputeDriverKind,
  type DockerSandboxDriver,
  EnvironmentId,
  type GceSandboxDriver,
  isReservedSandboxEnvName,
  SANDBOX_VM_DRIVER_KINDS,
  type SandboxDiskRetention,
  type SandboxDriverCheckResult,
  type SandboxDriverCheckStep,
  type SandboxDriverInstance,
  type SandboxSize,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  drainNoticeLabel,
  sandboxIsolationLabel,
  sandboxMachineCountsLabel,
} from "@t3tools/client-runtime/state/sandbox";
import { teamImageImageLine } from "@t3tools/client-runtime/team-image-presentation";
import * as DateTime from "effect/DateTime";
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { DEFAULT_DISK_RETENTION, NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";

import { usePrimarySettings } from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sandboxEnvironment } from "~/state/sandbox";
import { serverEnvironment } from "~/state/server";
import { teamImageEnvironment } from "~/state/teamImage";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  cloudSettingsVisible,
  defaultDriverIdOf,
  dockerDriverFormError,
  type GceDriverForm,
  gceDriverFormError,
  gceDriverFromForm,
  isRemoteDockerHost,
  nextDriverId,
} from "./CloudSettings.logic";
import { resolveAccessEnvironmentId } from "./ConnectionsSettings.logic";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { RetentionControl } from "./RetentionControl";
import { useSecretSources } from "./SecretSourceInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { searchableSetting } from "./settingsSearch";
import { SettingsEnvironmentPicker } from "./SettingsEnvironmentPicker";
import { TeamImageSettings } from "./TeamImageSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const SIZE_LABELS: Readonly<Record<SandboxSize, string>> = {
  small: "Small",
  default: "Default",
  large: "Large",
};

const DRIVER_KIND_LABELS: Readonly<Record<ComputeDriverKind, string>> = {
  docker: "Docker",
  gce: "Google Cloud",
};

const STEP_LABELS: Readonly<Record<SandboxDriverCheckStep, string>> = {
  image: "Base image",
  create: "Create machine",
  runner: "Runner connects",
  git: "Run git and sudo, and reach github.com",
  discard: "Discard machine",
};

const RESERVED_NAME = "Pair sets this variable on every machine.";
const reservedName = (name: string) => (isReservedSandboxEnvName(name) ? RESERVED_NAME : null);

function checkFailureMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "The test could not start. Try again.";
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

export function CloudSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const candidates = environments.filter((environment) =>
    cloudSettingsVisible(environment.serverConfig),
  );
  const machine = scope?.search.machine;
  const environmentId = resolveAccessEnvironmentId({
    primaryEnvironmentId,
    environments: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
    })),
    selected: machine === undefined ? null : EnvironmentId.make(machine),
  });
  const environment = candidates.find((candidate) => candidate.environmentId === environmentId);
  return (
    <SettingsPageContainer>
      {candidates.length > 1 && environmentId !== null && scope !== null ? (
        <SettingsEnvironmentPicker
          label="Showing Cloud on"
          environments={candidates}
          value={environmentId}
          onChange={(next) => scope.selectScope({ machine: next })}
        />
      ) : null}
      {environment?.serverConfig && environment.connection.phase === "connected" ? (
        <CloudEnvironmentSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          serverConfig={environment.serverConfig}
        />
      ) : (
        <SettingsSection {...searchableSetting("cloud-overview")} title="Overview">
          {environment === undefined ? (
            <SettingsRow title="Cloud threads" description={NOT_CLOUD_ONLY_MESSAGE} />
          ) : (
            <SettingsRow title={`Reconnect ${environment.label} to change its settings.`} />
          )}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

type DriverForm =
  | { readonly mode: "add"; readonly kind: ComputeDriverKind }
  | { readonly mode: "edit"; readonly id: ComputeDriverId };

function AddDriverMenu({
  size,
  onAdd,
}: {
  readonly size: "xs" | "sm";
  readonly onAdd: (kind: ComputeDriverKind) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size={size} variant="outline" />}>Add driver</MenuTrigger>
      <MenuPopup align="end">
        {ComputeDriverKind.literals.map((kind) => (
          <MenuItem key={kind} onClick={() => onAdd(kind)}>
            {DRIVER_KIND_LABELS[kind]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function driverDescription(driver: SandboxDriverInstance): string {
  const size = `${SIZE_LABELS[driver.size ?? "default"]} machines`;
  switch (driver.kind) {
    case "docker":
      return [
        driver.dockerHost ? `Docker at ${driver.dockerHost}` : "Docker on this machine",
        isRemoteDockerHost(driver.dockerHost ?? "") && driver.runnerUrl
          ? `runner URL ${driver.runnerUrl}`
          : null,
        size,
      ]
        .filter(Boolean)
        .join(" · ");
    case "gce":
      return [
        DRIVER_KIND_LABELS.gce,
        driver.project,
        driver.zones?.join(", "),
        driver.runnerUrl ? `runner URL ${driver.runnerUrl}` : null,
        size,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function CloudEnvironmentSettings({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: EnvironmentServerConfig;
}) {
  const sandbox = serverConfig.settings.sandbox;
  const drivers = sandbox?.drivers ?? [];
  const diskRetention = sandbox?.diskRetention ?? DEFAULT_DISK_RETENTION;
  const configured = drivers.length > 0;
  const cloudLaunch = serverConfig.environment.capabilities.cloudLaunch === true;
  const canAdmin = useAtomValue(sandboxEnvironment.checkDriver.permissionAtom(environmentId));
  // Off cloud-only, admins only remove drivers and leave restore mode; existing machines keep working.
  const canEdit = canAdmin && cloudLaunch;
  const overview = useEnvironmentQuery(
    configured ? sandboxEnvironment.overview({ environmentId, input: {} }) : null,
  );
  const teamImages = serverConfig.environment.capabilities.teamImages === true;
  const teamImageSnapshot = useEnvironmentQuery(
    teamImages && configured ? teamImageEnvironment.snapshot({ environmentId, input: {} }) : null,
  ).data;
  const activeBuild =
    teamImageSnapshot?.builds.find((build) => build.id === teamImageSnapshot.activeBuildId) ?? null;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const checkDriver = useAtomCommand(sandboxEnvironment.checkDriver, { reportFailure: false });
  const cancelDrain = useAtomCommand(sandboxEnvironment.cancelDrain, { reportFailure: false });
  const canCancelDrain = useAtomValue(sandboxEnvironment.cancelDrain.permissionAtom(environmentId));
  const drainNotice = drainNoticeLabel(serverConfig.drainingSince);
  const secretSources = useSecretSources(environmentId);
  const [form, setForm] = useState<DriverForm | null>(null);
  const [checks, setChecks] = useState<
    Readonly<Record<string, SandboxDriverCheckResult | "running" | { readonly error: string }>>
  >({});

  const save = async (patch: ServerSettingsPatch, failure: string) => {
    const result = await updateSettings({ environmentId, input: { patch } });
    toastCommandFailure(failure, result);
    if (result._tag === "Success") overview.refresh();
    return result._tag === "Success";
  };

  const saveDiskRetention = (patch: Partial<SandboxDiskRetention>) =>
    void save(
      { sandbox: { diskRetention: { ...diskRetention, ...patch } } },
      "Disk retention not saved",
    );

  const startNewMachinesOn = (driver: SandboxDriverInstance) =>
    void save({ sandbox: { defaultDriverId: driver.id } }, "Default driver not saved");

  const saveDriver = async (driver: SandboxDriverInstance) => {
    if (await save({ sandbox: { drivers: { [driver.id]: driver } } }, "Driver not saved"))
      setForm(null);
  };

  const leaveRestoreMode = async () => {
    const confirmed = await requestConfirmDialog(
      "Leave restore mode? Machines without a record are destroyed at the next check, within 10 minutes. Copy any work off them first.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await save({ sandbox: { restoreModeSince: null } }, "Restore mode not left");
  };

  const removeDriver = async (driver: SandboxDriverInstance) => {
    const confirmed = await requestConfirmDialog(
      `Remove ${driver.label}? Cloud threads on its machines stop and show "driver removed".`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await save({ sandbox: { drivers: { [driver.id]: null } } }, "Driver not removed");
  };

  const runCheck = async (driverId: ComputeDriverId) => {
    setChecks((previous) => ({ ...previous, [driverId]: "running" }));
    const result = await checkDriver({ environmentId, input: { driverId } });
    setChecks((previous) => ({
      ...previous,
      [driverId]:
        result._tag === "Success"
          ? result.value
          : { error: checkFailureMessage(squashAtomCommandFailure(result)) },
    }));
    overview.refresh();
  };

  const healths = new Map(overview.data?.drivers.map((health) => [health.driverId, health]) ?? []);
  const plainDocker = drivers.filter((driver) => healths.get(driver.id)?.isolation === "runc");
  const defaultDriverId =
    drivers.length > 1 && sandbox !== undefined ? defaultDriverIdOf(sandbox) : undefined;
  const editing = form?.mode === "edit" ? drivers.find((driver) => driver.id === form.id) : null;
  const formKind = form?.mode === "add" ? form.kind : editing?.kind;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const formatTime = (time: DateTime.Utc) =>
    formatDayAwareTimestamp(DateTime.formatIso(time), timestampFormat);

  return (
    <>
      {plainDocker.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            Plain Docker is not a security boundary: agents in a machine can reach this host's
            Docker network and kernel. Use rootless Docker or gVisor.
          </AlertDescription>
        </Alert>
      ) : null}
      {drainNotice !== null ? (
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>{drainNotice}</AlertDescription>
          {canCancelDrain ? (
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                onClick={async () =>
                  toastCommandFailure(
                    "Drain not cancelled",
                    await cancelDrain({ environmentId, input: {} }),
                  )
                }
              >
                Cancel drain
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}
      {!cloudLaunch && configured ? (
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            Cloud moved to Pair Cloud. Existing machines here keep working until you discard them.
          </AlertDescription>
        </Alert>
      ) : null}

      {sandbox?.restoreModeSince !== undefined ? (
        <SettingsSection
          title="Restore mode"
          headerAction={
            canAdmin ? (
              <Button size="xs" variant="outline" onClick={() => void leaveRestoreMode()}>
                Leave restore mode
              </Button>
            ) : undefined
          }
        >
          <SettingsRow
            title={`Restore mode since ${formatTime(sandbox.restoreModeSince)}`}
            description="Nothing is destroyed while it is on."
          />
          {canAdmin
            ? overview.data?.restoreMode?.machines.map((machine) => (
                <SettingsRow
                  key={machine.sandboxId}
                  title={machine.sandboxId}
                  description={[
                    drivers.find((driver) => driver.id === machine.driverId)?.label ??
                      machine.driverId,
                    `created ${formatTime(machine.createdAt)}`,
                    machine.hasRecord ? "discarded" : "no record",
                  ].join(" · ")}
                />
              ))
            : null}
        </SettingsSection>
      ) : null}

      <SettingsSection
        {...searchableSetting("cloud-overview")}
        title="Overview"
        headerAction={
          configured ? (
            <Button size="xs" variant="ghost" onClick={overview.refresh}>
              Refresh
            </Button>
          ) : undefined
        }
      >
        {!configured && !cloudLaunch ? (
          <SettingsRow title="Cloud threads" description={NOT_CLOUD_ONLY_MESSAGE} />
        ) : !configured ? (
          <SettingsRow
            title="Cloud threads"
            description="Cloud runs each cloud thread on its own machine. Nothing changes until you add a driver."
            control={
              canEdit ? (
                <AddDriverMenu size="sm" onAdd={(kind) => setForm({ mode: "add", kind })} />
              ) : (
                <span className="text-xs text-muted-foreground">An admin can set it up.</span>
              )
            }
          />
        ) : (
          <>
            {drivers.map((driver) => {
              const health = healths.get(driver.id);
              return (
                <SettingsRow
                  key={driver.id}
                  title={driver.label}
                  description={
                    health === undefined
                      ? overview.isPending
                        ? "Checking…"
                        : (overview.error ?? "Status unknown.")
                      : [
                          health.reachable ? sandboxIsolationLabel(health) : "Unreachable",
                          health.message,
                        ]
                          .filter(Boolean)
                          .join(". ")
                  }
                />
              );
            })}
            <SettingsRow
              title="Machines"
              description={
                overview.data ? sandboxMachineCountsLabel(overview.data.machines) : "Checking…"
              }
            />
            <SettingsRow
              title={activeBuild === null ? "Base image" : "Image"}
              description={
                activeBuild === null
                  ? (overview.data?.baseImage.label ?? sandbox?.baseImage ?? "Pair base")
                  : teamImageImageLine(activeBuild)
              }
            />
            <SettingsRow
              title="Checkpoint mirror"
              description={
                overview.data
                  ? `${formatBytes(overview.data.mirrorBytes)} of checkpoints kept on this server for stopped machines.`
                  : "Checking…"
              }
            />
          </>
        )}
      </SettingsSection>

      {canAdmin && (configured || form !== null) ? (
        <SettingsSection
          {...searchableSetting("cloud-docker-driver")}
          title="Compute"
          headerAction={
            canEdit && configured && form === null ? (
              <AddDriverMenu size="xs" onAdd={(kind) => setForm({ mode: "add", kind })} />
            ) : undefined
          }
        >
          {formKind === "docker" ? (
            <DockerDriverFormRow
              key={form?.mode === "edit" ? form.id : "add"}
              initial={editing?.kind === "docker" ? editing : null}
              id={editing?.id ?? nextDriverId(drivers, "docker")}
              onCancel={() => setForm(null)}
              onSave={saveDriver}
            />
          ) : formKind === "gce" ? (
            <GceDriverFormRow
              key={form?.mode === "edit" ? form.id : "add"}
              initial={editing?.kind === "gce" ? editing : null}
              id={editing?.id ?? nextDriverId(drivers, "gce")}
              onCancel={() => setForm(null)}
              onSave={saveDriver}
            />
          ) : null}
          {drivers.map((driver) => {
            const check = checks[driver.id];
            return (
              <SettingsRow
                key={driver.id}
                title={driver.label}
                description={driverDescription(driver)}
                control={
                  <div className="flex items-center gap-1.5">
                    {defaultDriverId === driver.id ? (
                      <span className="text-xs text-muted-foreground">New machines start here</span>
                    ) : null}
                    {canEdit ? (
                      <>
                        {defaultDriverId !== undefined && defaultDriverId !== driver.id ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => startNewMachinesOn(driver)}
                          >
                            Use for new machines
                          </Button>
                        ) : null}
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={check === "running"}
                          onClick={() => void runCheck(driver.id)}
                        >
                          {check === "running" ? "Testing…" : "Test"}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setForm({ mode: "edit", id: driver.id })}
                        >
                          Edit
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => void removeDriver(driver)}
                    >
                      Remove
                    </Button>
                  </div>
                }
              >
                {check !== undefined && check !== "running" ? <CheckResult check={check} /> : null}
              </SettingsRow>
            );
          })}
          {canEdit && configured ? (
            <>
              <SettingsRow
                {...searchableSetting("cloud-base-image")}
                description={`The image machines boot from. Empty uses ${overview.data && sandbox?.baseImage === undefined ? overview.data.baseImage.label : "Pair base"}, matched to this server's version.`}
                control={
                  <div className="w-56">
                    <DraftInput
                      size="sm"
                      aria-label="Base image"
                      placeholder="Pair base"
                      spellCheck={false}
                      value={sandbox?.baseImage ?? ""}
                      onCommit={(value) =>
                        void save(
                          { sandbox: { baseImage: value.trim() === "" ? null : value.trim() } },
                          "Base image not saved",
                        )
                      }
                    />
                  </div>
                }
              />
              <SettingsRow
                {...searchableSetting("cloud-caps")}
                description={
                  <span className="grid gap-0.5">
                    {drivers.map((driver) => {
                      const cap = healths.get(driver.id)?.runningCap;
                      return (
                        <span key={driver.id}>
                          {drivers.length > 1 ? `${driver.label}: ` : "Team: "}
                          {cap === undefined ? "…" : `${cap} machine${cap === 1 ? "" : "s"}`} at
                          once{" "}
                          {driver.runningCap !== undefined
                            ? "(set by an admin)"
                            : SANDBOX_VM_DRIVER_KINDS.has(driver.kind)
                              ? "(the driver's default)"
                              : "(a quarter of the host's vCPUs)"}
                        </span>
                      );
                    })}
                    <span>
                      {overview.data?.startsPerMinute ?? 10} starts a minute · No member cap
                    </span>
                  </span>
                }
              />
              <SettingsRow
                {...searchableSetting("cloud-disk-archived")}
                description="Days a machine sleeps with every thread archived before its disk is deleted. Its threads stay readable, and waking one rebuilds the machine from this server's copy."
                control={
                  <RetentionControl
                    label="Delete archived machines' disks"
                    value={diskRetention.archivedAfterDays}
                    enabledDays={DEFAULT_DISK_RETENTION.archivedAfterDays}
                    onChange={(archivedAfterDays) => saveDiskRetention({ archivedAfterDays })}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("cloud-disk-inactive")}
                description="Days a stopped machine goes without activity on any of its threads before its disk is deleted."
                control={
                  <RetentionControl
                    label="Delete unused machines' disks"
                    value={diskRetention.asleepAfterDays}
                    enabledDays={DEFAULT_DISK_RETENTION.asleepAfterDays}
                    onChange={(asleepAfterDays) => saveDiskRetention({ asleepAfterDays })}
                  />
                }
              />
            </>
          ) : null}
        </SettingsSection>
      ) : null}

      {teamImages ? (
        <TeamImageSettings environmentId={environmentId} driversConfigured={configured} />
      ) : null}

      {canEdit && configured ? (
        <SettingsSection {...searchableSetting("cloud-env")} title="Environment variables">
          <ProviderEnvironmentSection
            environment={sandbox?.env ?? []}
            description="Set in every cloud machine's terminals, scripts and agents. Projects can add their own."
            invalidName={reservedName}
            secretSources={secretSources}
            onChange={(env) => void save({ sandbox: { env } }, "Environment variables not saved")}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

function CheckResult({
  check,
}: {
  readonly check: SandboxDriverCheckResult | { readonly error: string };
}) {
  if ("error" in check) {
    return <p className="pb-2 text-xs text-destructive">{check.error}</p>;
  }
  return (
    <ul className="grid gap-1 pb-2 text-xs" aria-label="Test results">
      {check.steps.map((step) => (
        <li key={step.step} className="flex min-w-0 items-start gap-1.5">
          {step.ok ? (
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="Passed" />
          ) : (
            <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="Failed" />
          )}
          <span className="shrink-0 font-medium">{STEP_LABELS[step.step]}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatDuration(step.durationMs)}
          </span>
          {step.message ? (
            <span className="min-w-0 break-words text-muted-foreground">{step.message}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DockerDriverFormRow({
  initial,
  id,
  onSave,
  onCancel,
}: {
  readonly initial: DockerSandboxDriver | null;
  readonly id: ComputeDriverId;
  readonly onSave: (driver: DockerSandboxDriver) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "This machine");
  const [dockerHost, setDockerHost] = useState(initial?.dockerHost ?? "");
  const [runnerUrl, setRunnerUrl] = useState(initial?.runnerUrl ?? "");
  const [size, setSize] = useState<SandboxSize>(initial?.size ?? "default");
  const [runningCap, setRunningCap] = useState(initial?.runningCap?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const error = dockerDriverFormError({ label, dockerHost, runnerUrl, runningCap });
  const remote = isRemoteDockerHost(dockerHost);
  const field = (name: string) => `cloud-driver-${id}-${name}`;

  return (
    <SettingsRow
      title={initial ? `Edit ${initial.label}` : "Add Docker driver"}
      description="Docker on this machine, or another host through DOCKER_HOST."
    >
      <form
        className="grid gap-3 pb-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (error !== null || saving) return;
          setSaving(true);
          await onSave({
            kind: "docker",
            id,
            label: label.trim(),
            ...(dockerHost.trim() === "" ? {} : { dockerHost: dockerHost.trim() }),
            ...(runnerUrl.trim() === "" ? {} : { runnerUrl: runnerUrl.trim() }),
            ...(size === "default" ? {} : { size }),
            ...(runningCap.trim() === "" ? {} : { runningCap: Number(runningCap.trim()) }),
          });
          setSaving(false);
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={field("label")}>Name</Label>
          <Input
            id={field("label")}
            size="sm"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={field("host")}>Docker host</Label>
          <Input
            id={field("host")}
            size="sm"
            placeholder="This machine (or DOCKER_HOST)"
            spellCheck={false}
            value={dockerHost}
            onChange={(event) => setDockerHost(event.target.value)}
          />
        </div>
        {remote ? (
          <div className="grid gap-1.5">
            <Label htmlFor={field("runner")}>Runner URL</Label>
            <Input
              id={field("runner")}
              size="sm"
              placeholder="https://team-server.example:3773"
              spellCheck={false}
              aria-invalid={runnerUrl.trim() === "" || undefined}
              value={runnerUrl}
              onChange={(event) => setRunnerUrl(event.target.value)}
            />
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor={field("size")}>Machine size</Label>
          <Select
            value={size}
            onValueChange={(value) => {
              if (value === "small" || value === "default" || value === "large") setSize(value);
            }}
          >
            <SelectTrigger id={field("size")} size="sm" aria-label="Machine size">
              <SelectValue>
                {(value: string | null) =>
                  value === "small" || value === "default" || value === "large"
                    ? SIZE_LABELS[value]
                    : ""
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {(["small", "default", "large"] as const).map((option) => (
                <SelectItem key={option} value={option}>
                  {SIZE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={field("cap")}>Machines at once</Label>
          <Input
            id={field("cap")}
            size="sm"
            inputMode="numeric"
            placeholder="Default: a quarter of the host's vCPUs"
            value={runningCap}
            onChange={(event) => setRunningCap(event.target.value)}
          />
        </div>
        {error !== null ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={error !== null || saving}>
            {saving ? "Saving…" : "Save driver"}
          </Button>
        </div>
      </form>
    </SettingsRow>
  );
}

function GceDriverFormRow({
  initial,
  id,
  onSave,
  onCancel,
}: {
  readonly initial: GceSandboxDriver | null;
  readonly id: ComputeDriverId;
  readonly onSave: (driver: GceSandboxDriver) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<GceDriverForm>({
    label: initial?.label ?? DRIVER_KIND_LABELS.gce,
    project: initial?.project ?? "",
    zones: initial?.zones?.join(", ") ?? "",
    subnetwork: initial?.subnetwork ?? "",
    runnerUrl: initial?.runnerUrl ?? "",
    size: initial?.size ?? "default",
    runningCap: initial?.runningCap?.toString() ?? "",
  });
  const [saving, setSaving] = useState(false);
  const error = gceDriverFormError(draft);
  const field = (name: string) => `cloud-driver-${id}-${name}`;
  const text = (name: Exclude<keyof GceDriverForm, "size">, label: string, placeholder: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={field(name)}>{label}</Label>
      <Input
        id={field(name)}
        size="sm"
        placeholder={placeholder}
        spellCheck={false}
        value={draft[name]}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
      />
    </div>
  );

  return (
    <SettingsRow
      title={initial ? `Edit ${initial.label}` : "Add Google Cloud driver"}
      description="Compute Engine VMs in this server's Google Cloud project, created as the server's own service account."
    >
      <form
        className="grid gap-3 pb-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (error !== null || saving) return;
          setSaving(true);
          await onSave(gceDriverFromForm(initial, id, draft));
          setSaving(false);
        }}
      >
        {text("label", "Name", "")}
        {text("project", "Project", "This server's project")}
        {text("zones", "Zones", "This server's zone, or zones separated by commas")}
        {text("subnetwork", "Subnetwork", "regions/<region>/subnetworks/<name>")}
        <div className="grid gap-1.5">
          <Label htmlFor={field("size")}>Machine size</Label>
          <Select
            value={draft.size}
            onValueChange={(value) => {
              if (value === "small" || value === "default" || value === "large")
                setDraft({ ...draft, size: value });
            }}
          >
            <SelectTrigger id={field("size")} size="sm" aria-label="Machine size">
              <SelectValue>
                {(value: string | null) =>
                  value === "small" || value === "default" || value === "large"
                    ? SIZE_LABELS[value]
                    : ""
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {(["small", "default", "large"] as const).map((option) => (
                <SelectItem key={option} value={option}>
                  {SIZE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={field("runningCap")}>Machines at once</Label>
          <Input
            id={field("runningCap")}
            size="sm"
            inputMode="numeric"
            placeholder="The driver's default"
            value={draft.runningCap}
            onChange={(event) => setDraft({ ...draft, runningCap: event.target.value })}
          />
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Advanced</summary>
          <div className="mt-3">
            {text("runnerUrl", "Runner URL", "Uses this server's runner listener")}
          </div>
        </details>
        {error !== null ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={error !== null || saving}>
            {saving ? "Saving…" : "Save driver"}
          </Button>
        </div>
      </form>
    </SettingsRow>
  );
}
