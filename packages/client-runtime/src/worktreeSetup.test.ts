import type { ThreadId, WorktreeSetupMachine, WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { WORKTREE_SETUP_SLOW_MACHINE_MS, worktreeSetupMachineRow } from "./worktreeSetup.ts";

const STARTED_AT = "2026-11-15T10:00:00.000Z";
const startedMs = Date.parse(STARTED_AT);

function snapshot(
  machine: Partial<WorktreeSetupMachine> | null,
  phase: WorktreeSetupSnapshot["phase"] = "running",
): WorktreeSetupSnapshot {
  return {
    threadId: "thread-1" as ThreadId,
    phase,
    startedAt: STARTED_AT,
    endedAt: null,
    branch: null,
    baseRef: null,
    worktreePath: null,
    setupScript: null,
    stages: [],
    ...(machine === null
      ? {}
      : {
          machine: {
            status: "running",
            startedAt: STARTED_AT,
            endedAt: null,
            detail: null,
            note: null,
            ...machine,
          },
        }),
    error: null,
    sequence: 0,
  };
}

describe("worktreeSetupMachineRow", () => {
  it.each([
    ["local setup", snapshot(null), startedMs, null],
    ["machine already up", snapshot({ status: "skipped", startedAt: null }), startedMs, null],
    [
      "waiting keeps its reason however long",
      snapshot({ status: "waiting", detail: "Team limit reached" }),
      startedMs + WORKTREE_SETUP_SLOW_MACHINE_MS * 5,
      { label: "Waiting for a machine", detail: "Team limit reached" },
    ],
    [
      "booting under the threshold",
      snapshot({ status: "running" }),
      startedMs + WORKTREE_SETUP_SLOW_MACHINE_MS - 1,
      { label: "Start machine", detail: null },
    ],
    [
      "booting past the threshold",
      snapshot({ status: "running" }),
      startedMs + WORKTREE_SETUP_SLOW_MACHINE_MS,
      { label: "Start machine", detail: "Taking longer than usual" },
    ],
    [
      "cancelled while getting the machine",
      snapshot({ status: "skipped" }, "cancelled"),
      startedMs,
      { label: "Start machine", detail: "Cancelled" },
    ],
  ])("%s", (_name, input, nowMs, expected) => {
    const row = worktreeSetupMachineRow(input, nowMs);
    if (expected === null) expect(row).toBeNull();
    else expect(row).toMatchObject(expected);
  });
});
