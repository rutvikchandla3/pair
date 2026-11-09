import {
  type EnvironmentId,
  type ProjectId,
  repositoryGroupingKeyOf,
  type ServerConfig,
  type VcsRef,
  type VcsStatusResult,
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

const ORIGIN_PREFIX = "origin/";

function withoutOrigin(branch: string): string {
  return branch.startsWith(ORIGIN_PREFIX) ? branch.slice(ORIGIN_PREFIX.length) : branch;
}

/** What a routed launch sends: the member's branch, or a fresh one from the default branch. */
export function routedCloudLaunch(input: {
  readonly selectedBranch: string;
  readonly defaultBranch: string;
}): { readonly baseRef: string; readonly branch?: string; readonly existingBranch?: true } {
  const branch = withoutOrigin(input.selectedBranch);
  const defaultBranch = withoutOrigin(input.defaultBranch);
  return branch === defaultBranch
    ? { baseRef: defaultBranch }
    : { baseRef: defaultBranch, branch, existingBranch: true };
}

export type CloudBranchCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "block"; readonly message: string }
  | { readonly kind: "warn"; readonly message: string };

/**
 * Whether Pair Cloud will find `branch` on origin, from the selected branch's own ref. HEAD's
 * status counts for HEAD once it knows the upstream; any other branch uses its ref's own count. A
 * null ref (refs not loaded, or a remote-only branch) is `ok`: the server's own check still
 * refuses an unpushed one.
 */
export function cloudBranchCheck(input: {
  readonly branch: string;
  readonly ref: Pick<VcsRef, "upstreamRef" | "isDefault" | "aheadCount"> | null;
  readonly status: Pick<VcsStatusResult, "refName" | "aheadCount" | "hasUpstream"> | null;
}): CloudBranchCheck {
  const branch = withoutOrigin(input.branch);
  if (input.ref === null || input.ref.isDefault) return { kind: "ok" };
  const upstream = input.ref.upstreamRef;
  if (upstream === undefined) return { kind: "block", message: `Push ${branch} first.` };
  const expected = `refs/remotes/${ORIGIN_PREFIX}${branch}`;
  if (upstream !== expected) {
    const shown = upstream.replace(/^refs\/remotes\//, "");
    return {
      kind: "warn",
      message: `${branch} tracks ${shown}, not ${ORIGIN_PREFIX}${branch}. Pair Cloud looks on origin.`,
    };
  }
  const ahead =
    input.status?.refName === branch && input.status.hasUpstream
      ? input.status.aheadCount
      : (input.ref.aheadCount ?? 0);
  if (ahead > 0) {
    return {
      kind: "warn",
      message: `${ahead} ${ahead === 1 ? "commit" : "commits"} not pushed won't be included.`,
    };
  }
  return { kind: "ok" };
}
