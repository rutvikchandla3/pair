import type {
  CloudMachineSize,
  ProjectId,
  SandboxDiskRetention,
  SandboxDriverInstance,
  SandboxSettings,
  SandboxSize,
  ServerSettings,
} from "@t3tools/contracts";

type CloudSettings = Pick<ServerSettings, "sandbox" | "projectSettingsOverrides">;

export const NOT_CLOUD_ONLY_MESSAGE =
  "New cloud threads run on your team's Pair Cloud. Connect to it to start one.";

/**
 * Decision #2: archived machines' disks go after 7 days asleep, any idle machine's after 14,
 * which is as long as boat.dev promises to keep a stopped disk.
 */
export const DEFAULT_DISK_RETENTION = {
  archivedAfterDays: 7,
  asleepAfterDays: 14,
} as const satisfies SandboxDiskRetention;

export type CloudAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: "not-cloud-only" | "not-configured" | "project-disallowed";
      readonly message: string;
    };

/**
 * Hidden when not-cloud-only; otherwise disabled with `message`, since a cloud-only server refuses
 * every local mode.
 * `cloudLaunch` is the server's `capabilities.cloudLaunch` (or `ServerConfig.cloudOnly`).
 */
export function cloudAvailability(
  settings: CloudSettings | null,
  projectId: ProjectId | null,
  cloudLaunch: boolean,
): CloudAvailability {
  if (!cloudLaunch) {
    return { available: false, reason: "not-cloud-only", message: NOT_CLOUD_ONLY_MESSAGE };
  }
  if (!settings?.sandbox?.drivers.length) {
    return {
      available: false,
      reason: "not-configured",
      message: "Cloud is not set up on this environment.",
    };
  }
  if (
    projectId !== null &&
    settings.projectSettingsOverrides[projectId]?.sandboxAllowed === false
  ) {
    return {
      available: false,
      reason: "project-disallowed",
      message: "Cloud threads are turned off for this project.",
    };
  }
  return { available: true };
}

/** On a cloud-launch server every new thread is cloud while Cloud is available. */
export function newThreadPrefersCloud(
  settings: CloudSettings | null,
  projectId: ProjectId | null,
  cloudLaunch: boolean,
): boolean {
  return projectId !== null && cloudAvailability(settings, projectId, cloudLaunch).available;
}

export interface MachineSpec {
  readonly vcpus: number;
  readonly memoryGb: number;
}

export const SANDBOX_SIZES = [
  "small",
  "default",
  "large",
] as const satisfies ReadonlyArray<SandboxSize>;

export type BoatMachineType = "small" | "default" | "large" | "xlarge";

const BOAT_MACHINE_SPECS: Readonly<Record<BoatMachineType, MachineSpec>> = {
  small: { vcpus: 2, memoryGb: 4 },
  default: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};

/** Docker caps each at the host's own CPUs and memory. */
export const DOCKER_MACHINE_SPECS: Readonly<Record<SandboxSize, MachineSpec>> = {
  small: { vcpus: 2, memoryGb: 4 },
  default: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
};

/** The e2-standard types the driver picks unless `machineTypes` names others. */
export const GCE_MACHINE_SPECS: Readonly<Record<SandboxSize, MachineSpec>> = {
  small: { vcpus: 2, memoryGb: 8 },
  default: { vcpus: 4, memoryGb: 16 },
  large: { vcpus: 8, memoryGb: 32 },
};

export const boatMachineType = (
  driver: Extract<SandboxDriverInstance, { readonly kind: "boat" }>,
  size: SandboxSize,
): BoatMachineType => driver.types?.[size] ?? size;

/** What each size of a driver's machines gets. */
export function sandboxDriverSizes(
  driver: SandboxDriverInstance,
): ReadonlyArray<MachineSpec & { readonly size: SandboxSize }> {
  return SANDBOX_SIZES.map((size) => ({
    size,
    ...(driver.kind === "boat"
      ? BOAT_MACHINE_SPECS[boatMachineType(driver, size)]
      : driver.kind === "gce"
        ? GCE_MACHINE_SPECS[size]
        : DOCKER_MACHINE_SPECS[size]),
  }));
}

/** The driver new cloud machines run on. */
export function defaultSandboxDriver(sandbox: SandboxSettings): SandboxDriverInstance | undefined {
  return (
    sandbox.drivers.find((candidate) => candidate.id === sandbox.defaultDriverId) ??
    sandbox.drivers[0]
  );
}

/** The sizes a cloud launch here may ask for; empty where no driver is set up. */
export function cloudMachineSizes(
  settings: Pick<ServerSettings, "sandbox"> | null,
): ReadonlyArray<CloudMachineSize> {
  const driver =
    settings?.sandbox === undefined ? undefined : defaultSandboxDriver(settings.sandbox);
  if (driver === undefined) return [];
  const fallback = driver.size ?? "default";
  return sandboxDriverSizes(driver).map((spec) => ({
    ...spec,
    ...(spec.size === fallback ? { default: true as const } : {}),
  }));
}

/** The `default` size is Medium: an admin may make Large the team default. */
export const SANDBOX_SIZE_LABELS: Readonly<Record<SandboxSize, string>> = {
  small: "Small",
  default: "Medium",
  large: "Large",
};

/**
 * Drivers whose machine disk can be copied into a new machine. Docker keeps checkouts in a volume
 * a commit leaves out.
 */
export const canCopyMachine = (kind: SandboxDriverInstance["kind"]): boolean =>
  kind === "boat" || kind === "gce";

/** Why a cloud thread can't fork onto a new machine, or null when it can. */
export function forkToMachineBlocker(input: {
  readonly driverKind: SandboxDriverInstance["kind"] | null;
  readonly machineState: string | null;
  readonly branch: string | null;
  readonly workspace: boolean;
  readonly turnRunning: boolean;
}): string | null {
  if (input.driverKind === null || input.machineState === "destroyed") {
    return "This thread's machine was discarded, so there is no disk to copy.";
  }
  if (!canCopyMachine(input.driverKind)) return "Not supported on this driver.";
  if (input.workspace) return "Not available for workspace threads yet.";
  if (input.branch === null) return "This thread has no branch yet.";
  if (input.turnRunning) return "Wait for the turn to finish.";
  return null;
}

/** "4 vCPU · 8 GB" */
export const machineSpecLabel = (spec: MachineSpec): string =>
  `${spec.vcpus} vCPU · ${spec.memoryGb} GB`;
