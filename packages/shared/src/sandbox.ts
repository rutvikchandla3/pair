import type { ProjectId, SandboxDiskRetention, ServerSettings } from "@t3tools/contracts";

type CloudSettings = Pick<ServerSettings, "sandbox" | "projectSettingsOverrides">;

export const NOT_CLOUD_ONLY_MESSAGE =
  "New cloud threads run on your team's Pair Cloud. Connect to it to start one.";

/** Decision #2: archived machines' disks go after 7 days asleep, any idle machine's after 30. */
export const DEFAULT_DISK_RETENTION = {
  archivedAfterDays: 7,
  asleepAfterDays: 30,
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
