import { useAtomValue } from "@effect/atom-react";
import {
  type BoatSandboxDriver,
  type ComputeDriverId,
  ComputeDriverKind,
  type DockerSandboxDriver,
  EnvironmentId,
  type GceSandboxDriver,
  isReservedSandboxEnvName,
  type SandboxDiskRetention,
  type SandboxDriverCheckResult,
  type SandboxDriverCheckStep,
  type SandboxDriverHealth,
  type SandboxDriverInstance,
  type SandboxOverview,
  type SandboxSize,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { drainNoticeLabel, sandboxIsolationLabel } from "@t3tools/client-runtime/state/sandbox";
import * as DateTime from "effect/DateTime";
import {
  BoxIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { DEFAULT_DISK_RETENTION, NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";

import { usePrimarySettings } from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sandboxEnvironment } from "~/state/sandbox";
import { serverEnvironment } from "~/state/server";
import { teamImageEnvironment } from "~/state/teamImage";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  type BoatDriverForm,
  boatDriverFormError,
  boatDriverFromForm,
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
import { CloudMachines } from "./CloudMachines";
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
  boat: "boat.dev",
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

type DriverCheck = SandboxDriverCheckResult | "running" | { readonly error: string };

const PLAIN_DOCKER_WARNING =
  "Plain Docker isn't a security boundary. Agents here can reach the host's Docker network and kernel, and private threads aren't isolated from other members. Use rootless Docker or gVisor on this host.";

function AddDriverMenu({ onAdd }: { readonly onAdd: (kind: ComputeDriverKind) => void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>
        <PlusIcon className="size-3" aria-hidden />
        Add driver
      </MenuTrigger>
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

/** "Docker on this server · gVisor · Default size · up to 4 machines at once". */
function driverSummary(
  driver: SandboxDriverInstance,
  health: SandboxDriverHealth | undefined,
): string {
  const where = (() => {
    switch (driver.kind) {
      case "docker":
        return [
          driver.dockerHost ? `Docker at ${driver.dockerHost}` : "Docker on this server",
          isRemoteDockerHost(driver.dockerHost ?? "") && driver.runnerUrl
            ? `runner URL ${driver.runnerUrl}`
            : null,
        ];
      case "gce":
        return [
          DRIVER_KIND_LABELS.gce,
          driver.project ?? null,
          driver.zones?.join(", ") ?? null,
          driver.runnerUrl ? `runner URL ${driver.runnerUrl}` : null,
        ];
      case "boat":
        return [
          DRIVER_KIND_LABELS.boat,
          driver.organization ?? null,
          driver.runnerUrl ? `runner URL ${driver.runnerUrl}` : null,
        ];
    }
  })();
  const cap = health?.runningCap;
  return [
    ...where,
    health?.reachable ? sandboxIsolationLabel(health) : null,
    `${SIZE_LABELS[driver.size ?? "default"]} size`,
    cap === undefined ? null : `up to ${cap} machine${cap === 1 ? "" : "s"} at once`,
  ]
    .filter(Boolean)
    .join(" · ");
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
  const canEditTeamImage = useAtomValue(
    teamImageEnvironment.saveRecipe.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const checkDriver = useAtomCommand(sandboxEnvironment.checkDriver, { reportFailure: false });
  const cancelDrain = useAtomCommand(sandboxEnvironment.cancelDrain, { reportFailure: false });
  const canCancelDrain = useAtomValue(sandboxEnvironment.cancelDrain.permissionAtom(environmentId));
  const drainNotice = drainNoticeLabel(serverConfig.drainingSince);
  const secretSources = useSecretSources(environmentId);
  const [form, setForm] = useState<DriverForm | null>(null);
  const [checks, setChecks] = useState<Readonly<Record<string, DriverCheck>>>({});

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

  const hideCheck = (driverId: ComputeDriverId) =>
    setChecks((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => id !== driverId)),
    );

  const healths = new Map(overview.data?.drivers.map((health) => [health.driverId, health]) ?? []);
  const defaultDriverId =
    drivers.length > 1 && sandbox !== undefined ? defaultDriverIdOf(sandbox) : undefined;
  const editing = form?.mode === "edit" ? drivers.find((driver) => driver.id === form.id) : null;
  const formKind = form?.mode === "add" ? form.kind : editing?.kind;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const formatTime = (time: DateTime.Utc) =>
    formatDayAwareTimestamp(DateTime.formatIso(time), timestampFormat);
  const keepSucceeded = teamImageSnapshot?.keepSucceeded;

  const healthLine = (health: SandboxDriverHealth | undefined) => {
    if (health === undefined)
      return overview.isPending ? "Checking…" : (overview.error ?? "Status unknown.");
    if (!health.reachable)
      return (
        <span className="text-destructive-foreground">
          {["Unreachable.", health.message].filter(Boolean).join(" ")}
        </span>
      );
    return health.isolation === "runc" ? (
      <span className="flex items-start gap-1.5 text-warning-foreground">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        {PLAIN_DOCKER_WARNING}
      </span>
    ) : (
      (health.message ?? null)
    );
  };

  return (
    <>
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

      {!configured ? (
        <SettingsSection {...searchableSetting("cloud-overview")} title="Cloud machines">
          {!cloudLaunch ? (
            <SettingsRow title="Cloud threads" description={NOT_CLOUD_ONLY_MESSAGE} />
          ) : canEdit ? (
            <>
              <p
                id={searchableSetting("cloud-docker-driver").id}
                className="px-3 py-3 text-xs text-muted-foreground sm:px-4"
              >
                Each cloud thread runs on its own machine. Add a driver to choose where those
                machines run.
              </p>
              <SettingsRow
                title={
                  <span className="flex items-center gap-2">
                    <BoxIcon className="size-4 text-muted-foreground" aria-hidden />
                    {DRIVER_KIND_LABELS.docker}
                  </span>
                }
                description={
                  <>
                    Containers on this server, or on another host through <code>DOCKER_HOST</code>.
                    Good for one team server.
                  </>
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setForm({ mode: "add", kind: "docker" })}
                  >
                    Add
                  </Button>
                }
              />
              <SettingsRow
                title={
                  <span className="flex items-center gap-2">
                    <CloudIcon className="size-4 text-muted-foreground" aria-hidden />
                    {DRIVER_KIND_LABELS.gce}
                  </span>
                }
                description="Compute Engine VMs in this server's Google Cloud project, created with its service account."
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setForm({ mode: "add", kind: "gce" })}
                  >
                    Add
                  </Button>
                }
              />
            </>
          ) : (
            <SettingsRow
              title="Cloud threads"
              description="Every cloud thread runs on its own machine. An admin can add a driver to set it up."
            />
          )}
        </SettingsSection>
      ) : (
        <SettingsSection
          {...searchableSetting("cloud-overview")}
          title="Overview"
          headerAction={
            <Button size="xs" variant="ghost" onClick={overview.refresh}>
              <RefreshCwIcon className="size-3" aria-hidden />
              Refresh
            </Button>
          }
        >
          {overview.data ? (
            <MachineCounts machines={overview.data.machines} />
          ) : (
            <SettingsRow title="Machines" description={overview.error ?? "Checking…"} />
          )}
          {overview.data?.machineList !== undefined && overview.data.machineList.length > 0 ? (
            <CloudMachines
              environmentId={environmentId}
              machines={overview.data.machineList}
              drivers={drivers}
              onChanged={overview.refresh}
            />
          ) : null}
        </SettingsSection>
      )}

      {canAdmin && configured ? (
        <SettingsSection
          {...searchableSetting("cloud-docker-driver")}
          title="Compute"
          headerAction={
            canEdit ? <AddDriverMenu onAdd={(kind) => setForm({ mode: "add", kind })} /> : undefined
          }
        >
          {drivers.map((driver) => {
            const check = checks[driver.id];
            const health = healths.get(driver.id);
            const isDefault = defaultDriverId === driver.id;
            return (
              <SettingsRow
                key={driver.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        health === undefined
                          ? "bg-muted-foreground/40"
                          : health.reachable
                            ? "bg-success"
                            : "bg-destructive",
                      )}
                    />
                    <span className="truncate">{driver.label}</span>
                    {isDefault ? <Badge variant="outline">Default</Badge> : null}
                  </span>
                }
                description={driverSummary(driver, health)}
                status={healthLine(health)}
                control={
                  canEdit ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={check === "running"}
                        onClick={() => void runCheck(driver.id)}
                      >
                        {check === "running" ? "Testing…" : "Test"}
                      </Button>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Actions for ${driver.label}`}
                            />
                          }
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => setForm({ mode: "edit", id: driver.id })}>
                            Edit
                          </MenuItem>
                          {defaultDriverId !== undefined && !isDefault ? (
                            <MenuItem onClick={() => startNewMachinesOn(driver)}>
                              Use for new machines
                            </MenuItem>
                          ) : null}
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => void removeDriver(driver)}>
                            Remove
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => void removeDriver(driver)}
                    >
                      Remove
                    </Button>
                  )
                }
              >
                {check !== undefined && check !== "running" ? (
                  <CheckResult check={check} onHide={() => hideCheck(driver.id)} />
                ) : null}
              </SettingsRow>
            );
          })}
          {canEdit ? (
            <>
              <SettingsRow
                {...searchableSetting("cloud-base-image")}
                description={`Machines boot from this image. Empty uses ${overview.data && sandbox?.baseImage === undefined ? overview.data.baseImage.label : "Pair base"}, matched to this server's version.`}
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
                description="Machines that may start each minute, across the team. There is no per-member cap."
                control={
                  <span className="text-sm tabular-nums">
                    {overview.data ? `${overview.data.startsPerMinute} per minute` : "…"}
                  </span>
                }
              />
            </>
          ) : null}
        </SettingsSection>
      ) : null}

      {teamImages ? (
        <TeamImageSettings environmentId={environmentId} driversConfigured={configured} />
      ) : null}

      {configured ? (
        <SettingsSection title="Storage">
          {canEdit ? (
            <>
              <SettingsRow
                {...searchableSetting("cloud-disk-archived")}
                description="After a machine sleeps this long with every thread archived. Its threads stay readable, and waking one rebuilds the machine from this server's copy."
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
                description="After a stopped machine goes this long without activity on any of its threads."
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
          {canEditTeamImage && keepSucceeded !== undefined ? (
            <SettingsRow
              {...searchableSetting("cloud-team-image-keep")}
              description="Besides the active build and any a running session uses. Older builds are removed."
              control={
                <NumberField
                  key={keepSucceeded}
                  defaultValue={keepSucceeded}
                  min={1}
                  max={20}
                  step={1}
                  size="sm"
                  className="w-auto"
                  onValueCommitted={(next) => {
                    if (next === null) return;
                    const keep = Math.min(20, Math.max(1, Math.round(next)));
                    if (keep !== keepSucceeded)
                      void save(
                        { sandbox: { teamImage: { keepSucceeded: keep } } },
                        "Setting not saved",
                      );
                  }}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease builds kept" />
                    <NumberFieldInput
                      aria-label="Team image builds to keep"
                      size={4}
                      className="w-auto grow-0 text-right"
                    />
                    <NumberFieldIncrement aria-label="Increase builds kept" />
                  </NumberFieldGroup>
                </NumberField>
              }
            />
          ) : null}
          <SettingsRow
            title="Checkpoint mirror"
            description="Copies of stopped machines' work kept on this server, so a deleted disk can be rebuilt."
            control={
              <span className="text-sm tabular-nums">
                {overview.data ? formatBytes(overview.data.mirrorBytes) : "…"}
              </span>
            }
          />
        </SettingsSection>
      ) : null}

      {canEdit && configured ? (
        <SettingsSection {...searchableSetting("cloud-env")} title="Environment variables">
          <ProviderEnvironmentSection
            environment={sandbox?.env ?? []}
            title="Every cloud machine"
            description="Set in each machine's terminals, scripts and agents. Projects can add their own in project settings."
            invalidName={reservedName}
            secretSources={secretSources}
            onChange={(env) => void save({ sandbox: { env } }, "Environment variables not saved")}
          />
        </SettingsSection>
      ) : null}

      {formKind === "docker" ? (
        <DockerDriverDialog
          key={form?.mode === "edit" ? form.id : "add"}
          initial={editing?.kind === "docker" ? editing : null}
          id={editing?.id ?? nextDriverId(drivers, "docker")}
          onCancel={() => setForm(null)}
          onSave={saveDriver}
        />
      ) : formKind === "gce" ? (
        <GceDriverDialog
          key={form?.mode === "edit" ? form.id : "add"}
          initial={editing?.kind === "gce" ? editing : null}
          id={editing?.id ?? nextDriverId(drivers, "gce")}
          onCancel={() => setForm(null)}
          onSave={saveDriver}
        />
      ) : formKind === "boat" ? (
        <BoatDriverDialog
          key={form?.mode === "edit" ? form.id : "add"}
          initial={editing?.kind === "boat" ? editing : null}
          id={editing?.id ?? nextDriverId(drivers, "boat")}
          onCancel={() => setForm(null)}
          onSave={saveDriver}
        />
      ) : null}
    </>
  );
}

const MACHINE_COUNTS: ReadonlyArray<{
  readonly key: keyof SandboxOverview["machines"];
  readonly label: string;
  readonly dot: string;
}> = [
  { key: "ready", label: "Running", dot: "bg-success" },
  { key: "sleeping", label: "Asleep", dot: "bg-muted-foreground/40" },
  { key: "waiting", label: "Waiting", dot: "bg-warning" },
  { key: "failed", label: "Failed", dot: "bg-destructive" },
];

function MachineCounts({ machines }: { readonly machines: SandboxOverview["machines"] }) {
  return (
    <dl className="grid grid-cols-4 divide-x divide-border/50">
      {MACHINE_COUNTS.map(({ key, label, dot }) => (
        <div key={key} className="min-w-0 px-3 py-3 sm:px-4">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
            {label}
          </dt>
          <dd className="mt-0.5 text-xl font-semibold tabular-nums">{machines[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckResult({
  check,
  onHide,
}: {
  readonly check: SandboxDriverCheckResult | { readonly error: string };
  readonly onHide: () => void;
}) {
  const failed = "error" in check || check.steps.some((step) => !step.ok);
  const summary =
    "error" in check
      ? check.error
      : failed
        ? `Failed at ${STEP_LABELS[check.steps.find((step) => !step.ok)!.step].toLowerCase()}`
        : `Passed in ${formatDuration(check.steps.reduce((total, step) => total + step.durationMs, 0))}`;
  return (
    <div className="mb-2 mt-3 rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between gap-3 py-1 ps-3 pe-1">
        <span
          className={cn(
            "text-xs font-medium",
            failed ? "text-destructive-foreground" : "text-success-foreground",
          )}
        >
          {summary}
        </span>
        <Button size="xs" variant="ghost" onClick={onHide}>
          Hide
        </Button>
      </div>
      {"error" in check ? null : (
        <ul className="grid gap-1 px-3 pb-2.5 text-xs" aria-label="Test results">
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
      )}
    </div>
  );
}

function SizeSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: SandboxSize;
  readonly onChange: (size: SandboxSize) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "small" || next === "default" || next === "large") onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm" aria-label="Machine size">
        <SelectValue>
          {(selected: string | null) =>
            selected === "small" || selected === "default" || selected === "large"
              ? SIZE_LABELS[selected]
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
  );
}

/** A count where empty means the driver's own default. */
function MachinesAtOnceField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <NumberField
      id={id}
      value={value === "" || Number.isNaN(Number(value)) ? null : Number(value)}
      min={1}
      step={1}
      size="sm"
      onValueChange={(next) => onChange(next === null ? "" : String(next))}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label="Fewer machines at once" />
        <NumberFieldInput aria-label="Machines at once" placeholder="Automatic" />
        <NumberFieldIncrement aria-label="More machines at once" />
      </NumberFieldGroup>
    </NumberField>
  );
}

function DriverDialog({
  title,
  description,
  error,
  saving,
  onCancel,
  onSubmit,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly error: string | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (error === null && !saving) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {children}
            {error !== null ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={error !== null || saving}>
              {saving ? "Saving…" : "Save driver"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DialogField({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DockerDriverDialog({
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
  const [label, setLabel] = useState(initial?.label ?? "This server");
  const [dockerHost, setDockerHost] = useState(initial?.dockerHost ?? "");
  const [runnerUrl, setRunnerUrl] = useState(initial?.runnerUrl ?? "");
  const [size, setSize] = useState<SandboxSize>(initial?.size ?? "default");
  const [runningCap, setRunningCap] = useState(initial?.runningCap?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const error = dockerDriverFormError({ label, dockerHost, runnerUrl, runningCap });
  const remote = isRemoteDockerHost(dockerHost);
  const field = (name: string) => `cloud-driver-${id}-${name}`;

  return (
    <DriverDialog
      title={initial ? `Edit ${initial.label}` : "Add Docker driver"}
      description="Machines run as containers on this server, or on another Docker host."
      error={error}
      saving={saving}
      onCancel={onCancel}
      onSubmit={async () => {
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
      <DialogField id={field("label")} label="Name">
        <Input
          id={field("label")}
          size="sm"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </DialogField>
      <DialogField
        id={field("host")}
        label="Docker host"
        hint={
          <>
            Empty uses this server's Docker, or <code>DOCKER_HOST</code>. Isolation (gVisor,
            rootless or plain Docker) is detected from the host; Test shows it.
          </>
        }
      >
        <Input
          id={field("host")}
          size="sm"
          font="mono"
          placeholder="unix:///var/run/docker.sock"
          spellCheck={false}
          value={dockerHost}
          onChange={(event) => setDockerHost(event.target.value)}
        />
      </DialogField>
      {remote ? (
        <DialogField id={field("runner")} label="Runner URL">
          <Input
            id={field("runner")}
            size="sm"
            placeholder="https://team-server.example:3773"
            spellCheck={false}
            value={runnerUrl}
            onChange={(event) => setRunnerUrl(event.target.value)}
          />
        </DialogField>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <DialogField id={field("size")} label="Machine size">
          <SizeSelect id={field("size")} value={size} onChange={setSize} />
        </DialogField>
        <DialogField
          id={field("cap")}
          label="Machines at once"
          hint="Automatic allows a quarter of the host's vCPUs."
        >
          <MachinesAtOnceField id={field("cap")} value={runningCap} onChange={setRunningCap} />
        </DialogField>
      </div>
    </DriverDialog>
  );
}

function GceDriverDialog({
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
  const text = (
    name: Exclude<keyof GceDriverForm, "size" | "runningCap">,
    label: string,
    placeholder: string,
    hint?: string,
  ) => (
    <DialogField id={field(name)} label={label} hint={hint}>
      <Input
        id={field(name)}
        size="sm"
        placeholder={placeholder}
        spellCheck={false}
        value={draft[name]}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
      />
    </DialogField>
  );

  return (
    <DriverDialog
      title={initial ? `Edit ${initial.label}` : "Add Google Cloud driver"}
      description="Compute Engine VMs in this server's Google Cloud project, created as the server's own service account."
      error={error}
      saving={saving}
      onCancel={onCancel}
      onSubmit={async () => {
        setSaving(true);
        await onSave(gceDriverFromForm(initial, id, draft));
        setSaving(false);
      }}
    >
      {text("label", "Name", "")}
      {text("project", "Project", "This server's project")}
      {text(
        "zones",
        "Zones",
        "us-central1-a, us-central1-b",
        "Tried in order, separated by commas. Empty uses this server's zone.",
      )}
      {text("subnetwork", "Subnetwork", "regions/<region>/subnetworks/<name>")}
      <div className="grid gap-4 sm:grid-cols-2">
        <DialogField id={field("size")} label="Machine size">
          <SizeSelect
            id={field("size")}
            value={draft.size}
            onChange={(size) => setDraft({ ...draft, size })}
          />
        </DialogField>
        <DialogField
          id={field("runningCap")}
          label="Machines at once"
          hint="Automatic uses the driver's default."
        >
          <MachinesAtOnceField
            id={field("runningCap")}
            value={draft.runningCap}
            onChange={(runningCap) => setDraft({ ...draft, runningCap })}
          />
        </DialogField>
      </div>
      <Collapsible defaultOpen={draft.runnerUrl !== ""}>
        <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          Advanced
          <span className="font-normal group-data-panel-open:hidden">
            {draft.runnerUrl === "" ? "Runner URL" : `Runner URL: ${draft.runnerUrl}`}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-3">
            {text("runnerUrl", "Runner URL", "Uses this server's runner listener")}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </DriverDialog>
  );
}

function BoatDriverDialog({
  initial,
  id,
  onSave,
  onCancel,
}: {
  readonly initial: BoatSandboxDriver | null;
  readonly id: ComputeDriverId;
  readonly onSave: (driver: BoatSandboxDriver) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BoatDriverForm>({
    label: initial?.label ?? DRIVER_KIND_LABELS.boat,
    apiKey: "",
    organization: initial?.organization ?? "",
    runnerUrl: initial?.runnerUrl ?? "",
    size: initial?.size ?? "default",
    runningCap: initial?.runningCap?.toString() ?? "",
  });
  const [saving, setSaving] = useState(false);
  const hasSavedKey =
    initial !== null && (typeof initial.apiKey !== "string" || initial.apiKey !== "");
  const error = boatDriverFormError({ ...draft, hasSavedKey });
  const field = (name: string) => `cloud-driver-${id}-${name}`;
  const text = (
    name: Exclude<keyof BoatDriverForm, "size" | "runningCap">,
    label: string,
    placeholder: string,
    options: { readonly hint?: string; readonly password?: boolean } = {},
  ) => (
    <DialogField id={field(name)} label={label} hint={options.hint}>
      <Input
        id={field(name)}
        size="sm"
        type={options.password ? "password" : undefined}
        autoComplete={options.password ? "off" : undefined}
        placeholder={placeholder}
        spellCheck={false}
        value={draft[name]}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
      />
    </DialogField>
  );

  return (
    <DriverDialog
      title={initial ? `Edit ${initial.label}` : "Add boat.dev driver"}
      description="Full VMs in boat.dev's EU cloud, billed to your boat account while they run. Machines dial this server over the internet."
      error={error}
      saving={saving}
      onCancel={onCancel}
      onSubmit={async () => {
        setSaving(true);
        await onSave(boatDriverFromForm(initial, id, draft));
        setSaving(false);
      }}
    >
      {text("label", "Name", "")}
      {text("apiKey", "API key", hasSavedKey ? "Saved. Paste a new key to replace it" : "boat_…", {
        password: true,
      })}
      {text("runnerUrl", "Runner URL", "https://pair.example.com", {
        hint: "An https:// address of this server that boat machines reach.",
      })}
      <div className="grid gap-4 sm:grid-cols-2">
        <DialogField id={field("size")} label="Machine size">
          <SizeSelect
            id={field("size")}
            value={draft.size}
            onChange={(size) => setDraft({ ...draft, size })}
          />
        </DialogField>
        <DialogField
          id={field("runningCap")}
          label="Machines at once"
          hint="Automatic uses the driver's default."
        >
          <MachinesAtOnceField
            id={field("runningCap")}
            value={draft.runningCap}
            onChange={(runningCap) => setDraft({ ...draft, runningCap })}
          />
        </DialogField>
      </div>
      <Collapsible defaultOpen={draft.organization !== ""}>
        <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          Advanced
          <span className="font-normal group-data-panel-open:hidden">
            {draft.organization === "" ? "Organization" : `Organization: ${draft.organization}`}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-3">
            {text("organization", "Organization", "The key's own wallet", {
              hint: "Sent as X-Boat-Org, so machines bill this organization's wallet.",
            })}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </DriverDialog>
  );
}
