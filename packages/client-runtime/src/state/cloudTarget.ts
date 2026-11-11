import {
  type EnvironmentId,
  isListedThreadLineage,
  type PeerLinkSummary,
  type ProjectId,
  repositoryGroupingKeyOf,
  type ServerConfig,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { cloudAvailability } from "@t3tools/shared/sandbox";
import * as DateTime from "effect/DateTime";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { isWorkspaceProject } from "./workspaces.ts";

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

/** The environments `resolveCloudTarget` and `resolveContinueInCloud` read, from presentations. */
export function cloudTargetEnvironments(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): ReadonlyArray<CloudTargetEnvironment> {
  return [...presentations].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    connected: presentation.connection.phase === "connected",
    serverConfig: presentation.serverConfig,
  }));
}

const NOT_ON_GITHUB_MESSAGE = "Cloud needs this project's origin on github.com.";

export function isCloudLaunchEnvironment(
  serverConfig: Pick<ServerConfig, "environment"> | null,
): boolean {
  return serverConfig?.environment.capabilities.cloudLaunch === true;
}

/** Pair Cloud takes moves from other machines (3.20's routes). */
function isCloudImportEnvironment(serverConfig: Pick<ServerConfig, "environment"> | null): boolean {
  return serverConfig?.environment.capabilities.cloudImport === true;
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

/** The local project a move from Pair Cloud lands in: the oldest one with the same origin. */
function oldestProjectWithOrigin(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
  originKey: string,
): EnvironmentProject | null {
  const key = originKey.toLowerCase();
  return projects
    .filter(
      (candidate) =>
        candidate.environmentId === environmentId &&
        !candidate.archivedAt &&
        candidate.repositoryIdentity != null &&
        repositoryGroupingKeyOf(candidate.repositoryIdentity).toLowerCase() === key,
    )
    .reduce<EnvironmentProject | null>(
      (oldest, candidate) =>
        oldest === null || candidate.createdAt < oldest.createdAt ? candidate : oldest,
      null,
    );
}

export type ContinueLocallyOffer =
  | { readonly kind: "hidden" }
  /** `label` is the menu's short reason; `reason` the palette's sentence. */
  | { readonly kind: "disabled"; readonly label: string; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly localEnvironmentId: EnvironmentId;
      readonly projectId: ProjectId;
    };

/**
 * Whether a cloud thread can continue on the member's own server, the client's primary
 * environment (the desktop's server, or the `npx t3` one the page came from). Pair Cloud checks
 * each of these again.
 */
export function resolveContinueLocally(input: {
  readonly thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "lineage" | "runtime"
  > & { readonly source: { readonly sandboxId?: unknown } };
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    Pick<ServerConfig, "environment"> | null | undefined
  >;
  /** The primary environment grants `threadMove.toLocal`. */
  readonly canMove: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The primary environment's links. */
  readonly links: ReadonlyArray<
    Pick<PeerLinkSummary, "environmentId" | "label" | "status" | "expiresAt">
  >;
  readonly now: DateTime.Utc;
}): ContinueLocallyOffer {
  const { thread, primaryEnvironmentId: primary } = input;
  if (
    primary === null ||
    primary === thread.environmentId ||
    isCloudLaunchEnvironment(input.serverConfigs.get(primary) ?? null) ||
    !input.canMove ||
    !isListedThreadLineage(thread.lineage) ||
    thread.source.sandboxId === undefined ||
    input.serverConfigs.get(thread.environmentId)?.environment.capabilities.cloudImport !== true
  ) {
    return { kind: "hidden" };
  }
  const link = input.links.find((candidate) => candidate.environmentId === thread.environmentId);
  if (link === undefined) return { kind: "hidden" };
  if (link.status === "expired" || DateTime.isLessThanOrEqualTo(link.expiresAt, input.now)) {
    return {
      kind: "disabled",
      label: "link expired",
      reason: `The link to ${link.label} expired. Link it again in Settings → Environments.`,
    };
  }
  const cloudProject = input.projects.find(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
  );
  const originKey = cloudProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(cloudProject.repositoryIdentity)
    : null;
  const local =
    originKey === null ? null : oldestProjectWithOrigin(input.projects, primary, originKey);
  if (local === null) {
    return {
      kind: "disabled",
      label: "no matching project",
      reason:
        originKey === null
          ? "No project on this computer has this thread's origin."
          : `No project on this computer has origin ${originKey}.`,
    };
  }
  if (thread.runtime?.activeRunId != null) {
    return {
      kind: "disabled",
      label: "turn running",
      reason: "Wait for the turn to end, or stop it.",
    };
  }
  return { kind: "ready", localEnvironmentId: primary, projectId: local.id };
}

export type ContinueInCloudOffer =
  | { readonly kind: "hidden" }
  /** `label` is the menu's short reason; `reason` the palette's sentence. */
  | { readonly kind: "disabled"; readonly label: string; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly targets: ReadonlyArray<CloudTargetOption & { readonly projectId: ProjectId }>;
    };

/**
 * Whether a thread on this computer can continue on a Pair Cloud, from its project's
 * `resolveCloudTarget`. The local server checks each of these again.
 */
export function continueInCloudOffer(input: {
  readonly thread: {
    readonly environmentId: EnvironmentId;
    readonly sandboxId?: unknown;
    readonly runActive: boolean;
    /** The project's origin key, as `github.com/owner/name`. */
    readonly originKey: string | null;
  };
  readonly cloud: CloudTarget;
  readonly importsTo: (environmentId: EnvironmentId) => boolean;
}): ContinueInCloudOffer {
  const { thread, cloud } = input;
  if (thread.sandboxId !== undefined || cloud.kind === "hidden") return { kind: "hidden" };
  if (cloud.kind === "unavailable") {
    return { kind: "disabled", label: "Pair Cloud unavailable", reason: cloud.message };
  }
  // A project on Pair Cloud is its own target: the thread already runs there.
  if (cloud.targets.some((target) => target.environmentId === thread.environmentId)) {
    return { kind: "hidden" };
  }
  const importing = cloud.targets.filter((target) => input.importsTo(target.environmentId));
  if (importing.length === 0) return { kind: "hidden" };
  if (thread.runActive) {
    return {
      kind: "disabled",
      label: "a turn is running",
      reason: "A turn is running. Continue in cloud once it ends.",
    };
  }
  const ready = importing.flatMap((target) =>
    target.projectId !== null && target.disabledReason === null
      ? [{ ...target, projectId: target.projectId }]
      : [],
  );
  if (ready.length > 0) return { kind: "ready", targets: ready };
  const first = importing[0]!;
  const repository = thread.originKey?.replace(/^[^/]*\//, "") ?? "this project";
  return {
    kind: "disabled",
    label: "not available",
    reason: first.disabledReason ?? `Add ${repository} to ${first.label} first.`,
  };
}

const HIDDEN_OFFER: ContinueInCloudOffer = { kind: "hidden" };

/** Continue in cloud for a thread shell, read from its project and the paired environments. */
export function resolveContinueInCloud(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "runtime"> & {
    readonly source: { readonly sandboxId?: unknown };
  };
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
}): ContinueInCloudOffer {
  const { thread } = input;
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
  );
  // A workspace thread spans several repositories; Cloud runs one.
  if (project === undefined || isWorkspaceProject(project)) return HIDDEN_OFFER;
  return continueInCloudOffer({
    thread: {
      environmentId: thread.environmentId,
      ...(thread.source.sandboxId === undefined ? {} : { sandboxId: thread.source.sandboxId }),
      runActive: thread.runtime?.activeRunId != null,
      originKey: project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity)
        : null,
    },
    cloud: resolveCloudTarget({
      project,
      environments: cloudTargetEnvironments(input.presentations),
      projects: input.projects,
    }),
    importsTo: (environmentId) =>
      isCloudImportEnvironment(input.presentations.get(environmentId)?.serverConfig ?? null),
  });
}

/** For `Atom.withEquality`, so a row re-renders only when its own offer changes. */
export function sameContinueInCloudOffer(
  left: ContinueInCloudOffer,
  right: ContinueInCloudOffer,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "disabled" && right.kind === "disabled") {
    return left.label === right.label && left.reason === right.reason;
  }
  if (left.kind === "ready" && right.kind === "ready") {
    return (
      left.targets.length === right.targets.length &&
      left.targets.every((target, index) => {
        const other = right.targets[index]!;
        return (
          target.environmentId === other.environmentId &&
          target.label === other.label &&
          target.projectId === other.projectId &&
          target.disabledReason === other.disabledReason
        );
      })
    );
  }
  return true;
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
