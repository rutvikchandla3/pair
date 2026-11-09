import type {
  EnvironmentId,
  EnvironmentMachineKind,
  VcsRef,
  ProjectId,
  SandboxId,
  WorktreeSubmodules,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { CloudAvailability } from "@t3tools/shared/sandbox";
import { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
export { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
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

export interface CloudEnvModeItem {
  readonly disabledReason: string | null;
  /** A draft on a cloud-launch server: Cloud is its only workspace. */
  readonly only: boolean;
}

/** Cloud's row in both workspace pickers: null hides it, so servers that aren't cloud-only look as before. */
export function resolveCloudEnvModeItem(input: {
  cloud: CloudAvailability;
  effectiveEnvMode: EnvMode;
  isServerThread: boolean;
  forceNewWorktree: boolean;
}): CloudEnvModeItem | null {
  if (input.isServerThread) {
    return input.effectiveEnvMode === "cloud" ? { disabledReason: null, only: false } : null;
  }
  if (!input.cloud.available && input.cloud.reason === "not-cloud-only") return null;
  if (input.forceNewWorktree) {
    return { disabledReason: "Each model starts in its own worktree.", only: true };
  }
  return { disabledReason: input.cloud.available ? null : input.cloud.message, only: true };
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
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
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
