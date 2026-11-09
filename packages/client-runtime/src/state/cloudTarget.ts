import {
  type EnvironmentId,
  type ProjectId,
  repositoryGroupingKeyOf,
  type ServerConfig,
} from "@t3tools/contracts";
import { cloudAvailability } from "@t3tools/shared/sandbox";

import type { EnvironmentProject } from "./models.ts";

export type CloudTarget =
  /** No paired environment reports cloudLaunch: Cloud stays hidden. */
  | { readonly kind: "hidden" }
  /** Cloud shows disabled with `message`. */
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "targets"; readonly targets: ReadonlyArray<CloudTargetOption> };

export interface CloudTargetOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The matching Pair Cloud project, or null: Cloud offers Add to Pair Cloud here. */
  readonly projectId: ProjectId | null;
  /** Why it can't launch now (offline, turned off for the project), or null. */
  readonly disabledReason: string | null;
}

interface CloudTargetEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null;
}

const NOT_ON_GITHUB_MESSAGE = "Cloud needs this project's origin on github.com.";

export function isCloudLaunchEnvironment(
  serverConfig: Pick<ServerConfig, "environment"> | null,
): boolean {
  return serverConfig?.environment.capabilities.cloudLaunch === true;
}

function unavailableReason(
  serverConfig: CloudTargetEnvironment["serverConfig"],
  projectId: ProjectId | null,
): string | null {
  const availability = cloudAvailability(serverConfig?.settings ?? null, projectId, true);
  return availability.available ? null : availability.message;
}

/** Where Cloud goes for `project`: itself on Pair Cloud, a matching Pair Cloud project, or Add. */
export function resolveCloudTarget(input: {
  readonly project: Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;
  readonly environments: ReadonlyArray<CloudTargetEnvironment>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): CloudTarget {
  const { project } = input;
  const own = input.environments.find(
    (environment) => environment.environmentId === project.environmentId,
  );
  if (own && isCloudLaunchEnvironment(own.serverConfig)) {
    // Local modes are refused there, so even an unconfigured Cloud shows, disabled with why.
    const availability = cloudAvailability(own.serverConfig?.settings ?? null, project.id, true);
    return {
      kind: "targets",
      targets: [
        {
          environmentId: own.environmentId,
          label: own.label,
          projectId: project.id,
          disabledReason: availability.available ? null : availability.message,
        },
      ],
    };
  }

  const cloudEnvironments = input.environments.filter((environment) =>
    isCloudLaunchEnvironment(environment.serverConfig),
  );
  if (cloudEnvironments.length === 0) return { kind: "hidden" };

  const originKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  if (originKey === null || !originKey.toLowerCase().startsWith("github.com/")) {
    return { kind: "unavailable", message: NOT_ON_GITHUB_MESSAGE };
  }

  const targets = cloudEnvironments
    .map((environment): CloudTargetOption => {
      const match = input.projects
        .filter(
          (candidate) =>
            candidate.environmentId === environment.environmentId &&
            !candidate.archivedAt &&
            candidate.repositoryIdentity != null &&
            repositoryGroupingKeyOf(candidate.repositoryIdentity) === originKey,
        )
        .reduce<EnvironmentProject | null>(
          (oldest, candidate) =>
            oldest === null || candidate.createdAt < oldest.createdAt ? candidate : oldest,
          null,
        );
      const projectId = match?.id ?? null;
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        projectId,
        disabledReason: environment.connected
          ? unavailableReason(environment.serverConfig, projectId)
          : `${environment.label} is offline.`,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  return { kind: "targets", targets };
}
