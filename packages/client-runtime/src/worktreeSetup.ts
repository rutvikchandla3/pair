import {
  type OrchestrationV2Run,
  type WorktreeSetupMachine,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { worktreeSetupStageLabel } from "./contractLabels.ts";

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "startedAt">>;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.runs.some((run) => run.startedAt !== null)) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}

/** A boot past this reads as slow; waiting for a slot never does. */
export const WORKTREE_SETUP_SLOW_MACHINE_MS = 2 * 60_000;

function setupScriptFailed(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.status === "failed");
}

/** The setup's own words for where it is; a cloud launch speaks of its session, not a worktree. */
export function worktreeSetupHeaderLabel(
  snapshot: WorktreeSetupSnapshot,
  resolve: MFunctionType = mFallback,
): string {
  const cloud = snapshot.machine !== undefined;
  switch (snapshot.phase) {
    case "running":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
      return cloud ? "Starting cloud session…" : resolve(msg("Setting up worktree…"));
    case "done":
      if (setupScriptFailed(snapshot)) {
        return cloud
          ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
            "Cloud session ready, setup script failed"
          : resolve(msg("Worktree ready, setup script failed"));
      }
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
      return cloud ? "Cloud session ready" : resolve(msg("Worktree ready"));
    case "failed":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
      return cloud ? "Couldn't start cloud session" : resolve(msg("Worktree setup failed"));
    case "cancelled":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
      return cloud ? "Cloud session cancelled" : resolve(msg("Worktree setup cancelled"));
  }
}

export function worktreeSetupStageTitle(
  snapshot: WorktreeSetupSnapshot,
  stage: WorktreeSetupStage,
  resolve: MFunctionType = mFallback,
): string {
  if (stage.id === "setup-script" && snapshot.setupScript) return snapshot.setupScript.name;
  // A cloud fetch clones or restores the repository on the machine and checks it out.
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
  if (stage.id === "fetch" && snapshot.machine !== undefined) return "Prepare repository";
  return worktreeSetupStageLabel(stage.id, resolve);
}

/** A stage's trailing text: checkout percent, where the code came from, or why it didn't run. */
export function worktreeSetupStageDetail(
  snapshot: WorktreeSetupSnapshot,
  stage: WorktreeSetupStage,
  resolve: MFunctionType = mFallback,
): string | null {
  switch (stage.status) {
    case "pending":
      return null;
    case "skipped":
      return (
        stage.detail ??
        (snapshot.phase === "cancelled" && stage.startedAt !== null
          ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
            "Cancelled"
          : resolve(msg("skipped", { $context: "worktree setup stage status" })))
      );
    case "running":
      return stage.id === "checkout" && stage.percent !== null ? `${stage.percent}%` : stage.detail;
    case "done":
    case "warning":
    case "failed":
      return stage.detail;
  }
}

export interface WorktreeSetupMachineRow {
  readonly status: WorktreeSetupMachine["status"];
  readonly label: string;
  readonly detail: string | null;
  /** A line under the row: what happens next while waiting, or what failed. */
  readonly note: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** The cloud machine's row; null for a local setup and for a machine that was already up. */
export function worktreeSetupMachineRow(
  snapshot: WorktreeSetupSnapshot,
  nowMs: number,
): WorktreeSetupMachineRow | null {
  const machine = snapshot.machine;
  if (machine === undefined || (machine.status === "skipped" && machine.startedAt === null)) {
    return null;
  }
  const slow =
    machine.status === "running" &&
    machine.startedAt !== null &&
    nowMs - Date.parse(machine.startedAt) >= WORKTREE_SETUP_SLOW_MACHINE_MS;
  return {
    status: machine.status,
    // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
    label: machine.status === "waiting" ? "Waiting for a machine" : "Start machine",
    detail:
      machine.status === "skipped"
        ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
          "Cancelled"
        : slow
          ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
            "Taking longer than usual"
          : machine.detail,
    note: machine.note,
    startedAt: machine.startedAt,
    endedAt: machine.endedAt,
  };
}

/** Waiting for a slot is not progress, so nothing about the setup should look busy. */
export function worktreeSetupMachineWaiting(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.phase === "running" && snapshot.machine?.status === "waiting";
}
