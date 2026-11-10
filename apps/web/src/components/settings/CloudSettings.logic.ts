import {
  ComputeDriverId,
  type ComputeDriverKind,
  type GceSandboxDriver,
  type SandboxSettings,
  type SandboxDriverInstance,
  type SandboxSize,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";

/** Settings → Cloud exists on a cloud-only server, and elsewhere while drivers remain to remove. */
export function cloudSettingsVisible(serverConfig: EnvironmentServerConfig | null): boolean {
  return (
    serverConfig?.environment.capabilities.cloudLaunch === true ||
    (serverConfig?.settings.sandbox?.drivers.length ?? 0) > 0
  );
}

/** A Docker host other than a local socket cannot reach this server's disk (03 §3.2). */
export function isRemoteDockerHost(dockerHost: string): boolean {
  const host = dockerHost.trim();
  return host !== "" && !host.startsWith("unix://");
}

export function dockerDriverFormError(input: {
  readonly label: string;
  readonly dockerHost: string;
  readonly runnerUrl: string;
  /** Empty is the driver's default. */
  readonly runningCap: string;
}): string | null {
  const host = input.dockerHost.trim();
  const runnerUrl = input.runnerUrl.trim();
  const runningCap = input.runningCap.trim();
  if (input.label.trim() === "") return "Name the driver.";
  if (host.startsWith("ssh://"))
    return "Docker over ssh:// is not supported. Forward the socket and use unix://.";
  if (host !== "" && !/^(unix|tcp):\/\/./.test(host))
    return "Use a unix:// socket or a tcp:// address.";
  if (isRemoteDockerHost(host) && runnerUrl === "")
    return "A remote Docker host needs a runner URL: an address of this server its machines can reach.";
  if (runnerUrl !== "" && !/^https?:\/\/./.test(runnerUrl))
    return "The runner URL must start with http:// or https://.";
  if (runningCap !== "" && !/^[1-9]\d*$/.test(runningCap))
    return "Enter a whole number of machines, 1 or more.";
  return null;
}

/** Zones as typed: comma separated, tried in order. */
function parseZones(zones: string): ReadonlyArray<string> {
  return zones
    .split(",")
    .map((zone) => zone.trim())
    .filter((zone) => zone !== "");
}

export function gceDriverFormError(input: {
  readonly label: string;
  /** Empty is the server VM's project. */
  readonly project: string;
  /** Empty is the server VM's zone. */
  readonly zones: string;
  readonly subnetwork: string;
  /** Empty is the server's runner listener. */
  readonly runnerUrl: string;
  readonly runningCap: string;
}): string | null {
  const project = input.project.trim();
  const subnetwork = input.subnetwork.trim();
  const runnerUrl = input.runnerUrl.trim();
  const runningCap = input.runningCap.trim();
  if (input.label.trim() === "") return "Name the driver.";
  if (project !== "" && !/^[a-z0-9-]{6,30}$/.test(project))
    return "A project ID is 6 to 30 lowercase letters, digits and hyphens.";
  if (parseZones(input.zones).some((zone) => !/^[a-z]+-[a-z0-9]+-[a-z]$/.test(zone)))
    return "Name zones like us-central1-a, separated by commas.";
  if (subnetwork !== "" && !/(^|\/)regions\/[^/]+\/subnetworks\/[^/]+$/.test(subnetwork))
    return "Use regions/<region>/subnetworks/<name>, or the subnetwork's self link.";
  if (runnerUrl !== "" && !/^https?:\/\/./.test(runnerUrl))
    return "The runner URL must start with http:// or https://.";
  if (runningCap !== "" && !/^[1-9]\d*$/.test(runningCap))
    return "Enter a whole number of machines, 1 or more.";
  return null;
}

export interface GceDriverForm {
  readonly label: string;
  readonly project: string;
  readonly zones: string;
  readonly subnetwork: string;
  readonly runnerUrl: string;
  readonly size: SandboxSize;
  readonly runningCap: string;
}

const unshownGceKeys = ({
  kind: _kind,
  id: _id,
  label: _label,
  project: _project,
  zones: _zones,
  subnetwork: _subnetwork,
  runnerUrl: _runnerUrl,
  size: _size,
  runningCap: _runningCap,
  ...unshown
}: GceSandboxDriver) => unshown;

/** Keys the form does not show (a KMS key, machine types) survive an edit. */
export function gceDriverFromForm(
  initial: GceSandboxDriver | null,
  id: ComputeDriverId,
  form: GceDriverForm,
): GceSandboxDriver {
  const project = form.project.trim();
  const [firstZone, ...moreZones] = parseZones(form.zones);
  const subnetwork = form.subnetwork.trim();
  const runnerUrl = form.runnerUrl.trim();
  const runningCap = form.runningCap.trim();
  return {
    ...(initial === null ? {} : unshownGceKeys(initial)),
    kind: "gce",
    id,
    label: form.label.trim(),
    ...(project === "" ? {} : { project }),
    ...(firstZone === undefined ? {} : { zones: [firstZone, ...moreZones] }),
    ...(subnetwork === "" ? {} : { subnetwork }),
    ...(runnerUrl === "" ? {} : { runnerUrl }),
    ...(form.size === "default" ? {} : { size: form.size }),
    ...(runningCap === "" ? {} : { runningCap: Number(runningCap) }),
  };
}

/** The driver new machines start on, derived as the server does: the saved id if it names one, else the first. */
export function defaultDriverIdOf(
  sandbox: Pick<SandboxSettings, "drivers" | "defaultDriverId">,
): ComputeDriverId | undefined {
  const named = sandbox.drivers.find((driver) => driver.id === sandbox.defaultDriverId);
  return (named ?? sandbox.drivers[0])?.id;
}

export function nextDriverId(
  drivers: ReadonlyArray<SandboxDriverInstance>,
  kind: ComputeDriverKind,
): ComputeDriverId {
  const taken = new Set<string>(drivers.map((driver) => driver.id));
  let index = 1;
  while (taken.has(index === 1 ? kind : `${kind}-${index}`)) index += 1;
  return ComputeDriverId.make(index === 1 ? kind : `${kind}-${index}`);
}
