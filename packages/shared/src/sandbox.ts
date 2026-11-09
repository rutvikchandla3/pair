import type { ProjectId, ServerSettings } from "@t3tools/contracts";

type CloudSettings = Pick<ServerSettings, "sandbox" | "projectSettingsOverrides">;

export const NOT_CLOUD_ONLY_MESSAGE =
  "New cloud threads run on your team's Pair Cloud. Connect to it to start one.";

export type CloudAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: "not-configured" | "project-disallowed";
      readonly message: string;
    };

/** Hidden when not-configured (solo stays T3 Code); disabled with `message` when project-disallowed. */
export function cloudAvailability(
  settings: CloudSettings | null,
  projectId: ProjectId | null,
): CloudAvailability {
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

/** The project's Cloud default, only while Cloud is available. Callers fall back to resolveNewThreadEnvMode. */
export function newThreadPrefersCloud(
  settings: CloudSettings | null,
  projectId: ProjectId | null,
): boolean {
  return (
    projectId !== null &&
    cloudAvailability(settings, projectId).available &&
    settings?.projectSettingsOverrides[projectId]?.defaultsToCloud === true
  );
}
