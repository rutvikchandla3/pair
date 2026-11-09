import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type VcsRef,
  type ProjectId,
  repositoryGroupingKeyOf,
  resolveEnvironmentMachineKind,
  type SandboxId,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import type {
  EnvironmentConnectionPhase,
  EnvironmentServerConfig,
} from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  type CloudTarget,
  type CloudTargetOption,
  isCloudLaunchEnvironment,
} from "@t3tools/client-runtime/state/cloud-target";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { cloneUrlForProtocol } from "@t3tools/shared/cloneUrl";
import { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { AddProjectToMachineInput } from "../lib/addProjectToMachine";
export { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
}

/**
 * The machines a draft of `activeProject` can run on, for auto balance and the machine picker.
 * Pair Cloud runs only cloud threads, so it is left out unless it holds `activeProject`.
 */
export function resolveLogicalProjectEnvironments(input: {
  readonly activeProject: EnvironmentProject;
  readonly scratchDraft: boolean;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
    readonly serverConfig: EnvironmentServerConfig | null;
  }>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projectGroupingSettings: ProjectGroupingSettings;
}): EnvironmentOption[] {
  const { activeProject, projects, projectGroupingSettings } = input;
  const pairClouds = new Set(
    input.environments
      .filter(
        (environment) =>
          environment.environmentId !== activeProject.environmentId &&
          isCloudLaunchEnvironment(environment.serverConfig),
      )
      .map((environment) => environment.environmentId),
  );
  const environmentById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  const envs: EnvironmentOption[] = [];
  const pushEnvironment = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
    const environment = environmentById.get(environmentId) ?? null;
    envs.push({
      environmentId,
      projectId,
      label: environment?.label ?? environmentId,
      isPrimary: environmentId === input.primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
    });
  };
  if (input.scratchDraft) {
    for (const environment of input.environments) {
      if (pairClouds.has(environment.environmentId)) continue;
      const scratchRoot = availableScratchWorkspaceRoot(
        environment.connection.phase,
        environment.serverConfig,
      );
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : projects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const seen = new Set<string>();
    for (const p of projects) {
      if (seen.has(p.environmentId) || pairClouds.has(p.environmentId)) continue;
      if (deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) !== logicalKey) continue;
      seen.add(p.environmentId);
      pushEnvironment(p.environmentId, p.id);
    }
  }
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}

/** "Add to another machine" stays muted until hovered: easy to find, quieter than the machines. */
export const ADD_TO_MACHINE_LABEL_CLASS =
  "flex min-w-0 items-center gap-1.5 opacity-55 in-data-highlighted:opacity-100 in-data-popup-open:opacity-100";

export const EnvMode = Schema.Literals(["local", "worktree", "cloud"]);
export type EnvMode = typeof EnvMode.Type;

/** A machine clones origin and branches from `origin/<base>`, so its base names no remote. */
export function resolveWorktreeBaseBranchName(
  envMode: EnvMode,
  refName: Pick<VcsRef, "name" | "isRemote">,
): string {
  return envMode === "cloud" && refName.isRemote
    ? deriveLocalBranchNameFromRemoteRef(refName.name)
    : refName.name;
}

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  showEnvironmentIndicator: boolean;
}): boolean {
  // A new thread always shows the strip, since it names the permissions the first send uses.
  return (
    input.hasActiveProject &&
    (input.isDraftHeroState ||
      (input.persistInActiveThreads && (input.isGitRepo || input.showEnvironmentIndicator)))
  );
}

// Hysteresis prevents labels and icons from flapping at the width boundary.
const CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX = 16;

export function resolveContextStripLabelsCompact(input: {
  compact: boolean;
  neededWidth: number;
  availableWidth: number;
}): boolean {
  return input.compact
    ? input.neededWidth > input.availableWidth - CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX
    : input.neededWidth > input.availableWidth;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  if (mode === "cloud") return "Cloud";
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export interface CloudLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

const canLaunch = (target: CloudTargetOption) =>
  target.disabledReason === null && target.projectId !== null;

function chooseCloudTarget(
  cloud: CloudTarget,
  cloudEnvironmentId: EnvironmentId | undefined,
): CloudTargetOption | null {
  if (cloud.kind !== "targets") return null;
  return (
    cloud.targets.find((target) => target.environmentId === cloudEnvironmentId) ??
    cloud.targets.find(canLaunch) ??
    null
  );
}

/** Where Cloud launches: the draft's pick, else the first launchable target, else nowhere. */
export function resolveCloudLaunchTarget(
  cloud: CloudTarget,
  cloudEnvironmentId: EnvironmentId | undefined,
): CloudLaunchTarget | null {
  const chosen = chooseCloudTarget(cloud, cloudEnvironmentId);
  return chosen !== null && chosen.projectId !== null && chosen.disabledReason === null
    ? { environmentId: chosen.environmentId, projectId: chosen.projectId, label: chosen.label }
    : null;
}

export interface CloudEnvModeRow {
  readonly value: string;
  readonly label: string;
  /** Launch there (null: the only target), or add the repo to that Pair Cloud. */
  readonly action:
    | { readonly kind: "launch"; readonly environmentId: EnvironmentId | null }
    | { readonly kind: "add"; readonly environmentId: EnvironmentId; readonly label: string };
  readonly disabled: boolean;
  /** Shown on hover: why it is disabled, or what Add does. */
  readonly reason: string | null;
}

export interface CloudEnvModeItem {
  readonly disabledReason: string | null;
  /** A draft on a cloud-launch server: Cloud is its only workspace. */
  readonly only: boolean;
  readonly rows: ReadonlyArray<CloudEnvModeRow>;
  /** The row value that stands for the draft's Cloud mode. */
  readonly value: string;
}

const MULTI_MODEL_CLOUD_REASON = "Each model starts in its own worktree.";

function cloudRow(reason: string | null): CloudEnvModeRow {
  return {
    value: "cloud",
    label: resolveEnvModeLabel("cloud"),
    action: { kind: "launch", environmentId: null },
    disabled: reason !== null,
    reason,
  };
}

function repositoryName(project: Pick<EnvironmentProject, "repositoryIdentity"> | null): string {
  return project?.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity).replace(/^github\.com\//i, "")
    : "this repo";
}

/** Cloud's rows in both workspace pickers: null hides them, so servers that aren't cloud-only look as before. */
export function resolveCloudEnvModeItem(input: {
  cloud: CloudTarget;
  project: Pick<EnvironmentProject, "environmentId" | "repositoryIdentity"> | null;
  cloudEnvironmentId: EnvironmentId | undefined;
  effectiveEnvMode: EnvMode;
  isServerThread: boolean;
  forceNewWorktree: boolean;
}): CloudEnvModeItem | null {
  const { cloud } = input;
  if (input.isServerThread) {
    return input.effectiveEnvMode === "cloud"
      ? { disabledReason: null, only: false, rows: [cloudRow(null)], value: "cloud" }
      : null;
  }
  if (cloud.kind === "hidden") return null;
  const worktreeReason = input.forceNewWorktree ? MULTI_MODEL_CLOUD_REASON : null;
  if (cloud.kind === "unavailable") {
    const reason = worktreeReason ?? cloud.message;
    return { disabledReason: reason, only: false, rows: [cloudRow(reason)], value: "cloud" };
  }
  const [first] = cloud.targets;
  if (
    first !== undefined &&
    cloud.targets.length === 1 &&
    first.environmentId === input.project?.environmentId
  ) {
    const reason = worktreeReason ?? first.disabledReason;
    return { disabledReason: reason, only: true, rows: [cloudRow(reason)], value: "cloud" };
  }
  const several = cloud.targets.length > 1;
  const repository = repositoryName(input.project);
  const rows = cloud.targets.map((target): CloudEnvModeRow => {
    if (target.projectId === null) {
      return {
        value: `add:${target.environmentId}`,
        label: several ? `Add to ${target.label}` : "Add to Pair Cloud",
        action: { kind: "add", environmentId: target.environmentId, label: target.label },
        disabled: target.disabledReason !== null,
        reason: target.disabledReason ?? `Add ${repository} to ${target.label} first.`,
      };
    }
    const reason = worktreeReason ?? target.disabledReason;
    return {
      value: several ? `cloud:${target.environmentId}` : "cloud",
      label: several ? `Cloud on ${target.label}` : resolveEnvModeLabel("cloud"),
      action: { kind: "launch", environmentId: several ? target.environmentId : null },
      disabled: reason !== null,
      reason,
    };
  });
  const chosen = chooseCloudTarget(cloud, input.cloudEnvironmentId);
  const chosenRow = rows[chosen === null ? -1 : cloud.targets.indexOf(chosen)];
  return {
    disabledReason:
      worktreeReason ??
      (chosen === null
        ? (rows[0]?.reason ?? null)
        : (chosen.disabledReason ??
          (chosen.projectId === null ? `Add ${repository} to ${chosen.label} first.` : null))),
    only: false,
    rows,
    value: chosenRow?.action.kind === "launch" ? chosenRow.value : "cloud",
  };
}

/** Add to Pair Cloud: clone the local origin over https, no files, at the server's own path. */
export function pairCloudAddInput(input: {
  project: Pick<
    EnvironmentProject,
    "environmentId" | "workspaceRoot" | "title" | "repositoryIdentity"
  >;
  target: { readonly environmentId: EnvironmentId; readonly label: string };
  projectId: ProjectId;
}): AddProjectToMachineInput | null {
  const identity = input.project.repositoryIdentity;
  const sourceUrl = identity?.origin?.remoteUrl ?? identity?.locator.remoteUrl;
  const remoteUrl = sourceUrl ? cloneUrlForProtocol(sourceUrl, "https") : null;
  if (remoteUrl === null) return null;
  return {
    source: { environmentId: input.project.environmentId, cwd: input.project.workspaceRoot },
    subdirectory: "",
    target: input.target,
    projectId: input.projectId,
    title: input.project.title,
    remoteUrl,
    files: [],
  };
}

/** The built-in workspace default once the environment has a second member. */
export const TEAM_DEFAULT_ENV_MODE_LABEL = "New worktree (team default)";

export const WORKTREE_SUBMODULES_LABELS: Record<WorktreeSubmodules, string> = {
  recursive: "Recursive",
  "top-level": "Top level only",
  none: "Skip",
};

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  effectiveEnvMode: EnvMode,
): string {
  if (effectiveEnvMode === "cloud") return resolveEnvModeLabel("cloud");
  if (activeWorktreePath) return "Worktree";
  return effectiveEnvMode === "worktree" ? resolveEnvModeLabel("worktree") : "Local checkout";
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
}

export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
    source?: { readonly sandboxId?: SandboxId };
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: { branch: string | null; worktreePath: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null ||
      // A cloud thread's worktree path is inside its machine, not on this host.
      thread.source?.sandboxId !== undefined
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
      };
    }
  }
  return latest === null ? null : { branch: latest.branch, worktreePath: latest.worktreePath };
}

export function resolvePreviousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  preparingWorktree?: boolean;
  sandboxId: SandboxId | undefined;
  cloudAvailable: boolean;
  /** The environment's `capabilities.cloudLaunch`: every draft there is cloud. */
  cloudLaunch: boolean;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, preparingWorktree } = input;
  if (hasServerThread && input.sandboxId !== undefined) return "cloud";
  if (!hasServerThread && input.cloudLaunch) return "cloud";
  // A cloud draft falls back in render when Cloud goes away; the stored draft keeps its choice.
  if (!hasServerThread && draftThreadEnvMode === "cloud") {
    return input.cloudAvailable ? "cloud" : "worktree";
  }
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath || preparingWorktree ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (effectiveEnvMode === "cloud") return "cloud";
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
  /** A cloud server thread's pending base; a cloud draft still defaults to the host branch. */
  cloudThread: { readonly baseRef: string | null } | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  // The host checkout's branch says nothing about a machine that has no worktree yet.
  if (input.cloudThread !== null && !activeWorktreePath) {
    return activeThreadBranch ?? input.cloudThread.baseRef;
  }
  if (envMode !== "local" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode !== "local" && !activeWorktreePath) {
    // Only the server can determine a local branch's configured remote.
    return effectiveEnvMode === "worktree" &&
      startFromOrigin &&
      resolvedActiveBranchIsRemote === false
      ? `From ${resolvedActiveBranch} (remote)`
      : `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeProjectCheckoutRoot?: string | undefined;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    // Until the project's checkout root loads, a checkout containing the project counts as its own.
    const isProjectCheckout =
      input.activeProjectCheckoutRoot === undefined
        ? workspaceRelativeFilePath(activeProjectCwd, refName.worktreePath) !== null
        : workspaceRelativeFilePath(input.activeProjectCheckoutRoot, refName.worktreePath) === ".";
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: isProjectCheckout ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}
