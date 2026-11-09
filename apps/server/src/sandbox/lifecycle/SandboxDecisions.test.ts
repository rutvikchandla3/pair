import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  MemberId,
  type OrchestrationV2Sandbox,
  ProjectId,
  RunId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import { NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";
import * as DateTime from "effect/DateTime";

import type { AdmissionSnapshot } from "./SandboxAdmission.ts";
import {
  APPROVAL_HOLD_MS,
  decideGitCredentialRecord,
  decideCloudPrompt,
  decideSandboxCommand,
  idleDecision,
  type IdleDecision,
  type IdleInput,
  planSandboxOnDelete,
  type SandboxAttachedThread,
  type SandboxCommand,
} from "./SandboxDecisions.ts";

const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const owner = ThreadId.make("thread-owner");
const sideChat = ThreadId.make("thread-side-chat");
const earlier = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-11-07T00:00:00.000Z");

const record = (patch: Partial<OrchestrationV2Sandbox> = {}): OrchestrationV2Sandbox => ({
  id: sandboxId,
  projectId: ProjectId.make("project"),
  ownerThreadId: owner,
  ownerMemberId: null,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 2,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: earlier,
  updatedAt: earlier,
  ...patch,
});

const base = { commandId: CommandId.make("command"), threadId: owner, sandboxId };
const at = (generation: number) => ({ ...base, generation });
const lost = { code: "lost", message: "Gone.", retryable: true };
const bootTimeout = { code: "boot-timeout", message: "No hello.", retryable: true };
const fork = ThreadId.make("thread-fork");

const nowMs = DateTime.toEpochMillis(now);
const runId = RunId.make("run-waiting");

/** A settled or archived thread rests from `now` unless the patch says otherwise. */
const attached = (
  threadId: ThreadId,
  patch: Partial<SandboxAttachedThread> = {},
): SandboxAttachedThread => ({
  threadId,
  archived: false,
  settled: false,
  activeRun: false,
  activeRunId: null,
  activityAt: DateTime.toEpochMillis(earlier),
  restingAt: patch.settled === true || patch.archived === true ? nowMs : null,
  pendingRequestAt: null,
  backgroundWork: false,
  ...patch,
});
const autoSleep = (
  reason: Extract<SandboxCommand, { readonly type: "sandbox.auto-sleep" }>["reason"] = "settled",
): SandboxCommand => ({ type: "sandbox.auto-sleep", ...base, snapshotAt: now, reason });

type Row = readonly [
  name: string,
  command: SandboxCommand,
  current: OrchestrationV2Sandbox | null,
  expected:
    | { readonly next: Partial<OrchestrationV2Sandbox>; readonly effects: ReadonlyArray<string> }
    | "NoOp"
    | string,
  attachedThreads?: ReadonlyArray<SandboxAttachedThread>,
  admission?: AdmissionSnapshot,
  cloudOnly?: boolean,
];

const free: AdmissionSnapshot = { running: 0, waiting: 0, cap: 2, startAvailable: true };
const waiting = (reason: "team-cap" | "rate-limit", generation = 2) =>
  record({
    state: "provisioning",
    generation,
    driverRef: null,
    admission: { reason, since: earlier },
  });

const provision: SandboxCommand = {
  type: "sandbox.provision",
  ...base,
  projectId: ProjectId.make("project"),
  driverId: ComputeDriverId.make("docker"),
  size: "small",
};

const rows: ReadonlyArray<Row> = [
  [
    "provision creates generation 1",
    provision,
    null,
    {
      next: {
        state: "provisioning",
        generation: 1,
        size: "small",
        ownerMemberId: MemberId.make("member"),
      },
      effects: ["sandbox.create"],
    },
  ],
  [
    "provision after destroy bumps the generation",
    provision,
    record({ state: "destroyed" }),
    {
      next: { state: "provisioning", generation: 3, driverRef: null },
      effects: ["sandbox.create"],
    },
  ],
  ["provision over a live record", provision, record(), "wrong-state"],
  [
    "provision at a full cap waits without a create",
    provision,
    null,
    {
      next: { state: "provisioning", generation: 1, admission: { reason: "team-cap", since: now } },
      effects: [],
    },
    [],
    { ...free, running: 2 },
  ],
  [
    "a wake with no start token left waits",
    { type: "sandbox.wake", ...base },
    record({ state: "sleeping" }),
    {
      next: { state: "waking", generation: 3, admission: { reason: "rate-limit", since: now } },
      effects: [],
    },
    [],
    { ...free, startAvailable: false },
  ],
  [
    "a start queues behind a machine already waiting",
    { type: "sandbox.retry", ...base },
    record({ state: "failed", failure: lost }),
    { next: { state: "waking", admission: { reason: "team-cap", since: now } }, effects: [] },
    [],
    { ...free, running: 1, waiting: 1 },
  ],
  [
    "admit clears the wait and creates",
    { type: "sandbox.admit", ...at(2) },
    waiting("team-cap"),
    { next: { state: "provisioning", admission: null }, effects: ["sandbox.create"] },
    [],
    { ...free, running: 1, waiting: 1 },
  ],
  [
    "admit a waking machine starts its kept disk",
    { type: "sandbox.admit", ...at(2) },
    record({ state: "waking", admission: { reason: "rate-limit", since: earlier } }),
    { next: { state: "waking", admission: null }, effects: ["sandbox.start"] },
    [],
    free,
  ],
  [
    "admit with no free slot",
    { type: "sandbox.admit", ...at(2) },
    waiting("team-cap"),
    "no-capacity",
    [],
    { ...free, running: 2 },
  ],
  [
    "admit with no start token",
    { type: "sandbox.admit", ...at(2) },
    waiting("rate-limit"),
    "no-capacity",
    [],
    { ...free, startAvailable: false },
  ],
  [
    "admit for an older generation",
    { type: "sandbox.admit", ...at(1) },
    waiting("team-cap"),
    "stale-generation",
    [],
    free,
  ],
  [
    "admit a machine that is not waiting",
    { type: "sandbox.admit", ...at(2) },
    record({ state: "provisioning", driverRef: null }),
    "wrong-state",
    [],
    free,
  ],
  [
    "a waiting machine that fails stops waiting",
    { type: "sandbox.failed", ...at(2), failure: lost },
    waiting("team-cap"),
    { next: { state: "failed", admission: null }, effects: ["sandbox.release-waiters"] },
  ],
  [
    "created sets the ref",
    { type: "sandbox.created", ...at(2), driverRef: "new-ref" },
    record({ state: "provisioning", driverRef: null }),
    { next: { state: "provisioning", driverRef: "new-ref" }, effects: [] },
  ],
  [
    "created records the base image it booted",
    {
      type: "sandbox.created",
      ...at(2),
      driverRef: "new-ref",
      baseImage: { ref: "t3-sandbox:dev", digest: "sha256:a", version: null },
    },
    record({ state: "provisioning", driverRef: null }),
    {
      next: {
        driverRef: "new-ref",
        baseImage: { ref: "t3-sandbox:dev", digest: "sha256:a", version: null },
      },
      effects: [],
    },
  ],
  [
    "created for an older generation",
    { type: "sandbox.created", ...at(1), driverRef: "old" },
    record({ state: "provisioning" }),
    "stale-generation",
  ],
  [
    "attached makes a waking sandbox ready",
    { type: "sandbox.runner.attached", ...at(2), runnerBootId: "boot" },
    record({ state: "waking", sleepReason: "manual" }),
    {
      next: { state: "ready", sleepReason: null, failure: null },
      effects: ["sandbox.release-waiters"],
    },
  ],
  [
    "attached clears a lost runner",
    { type: "sandbox.runner.attached", ...at(2), runnerBootId: "boot-2" },
    record({ runnerLostAt: earlier }),
    { next: { state: "ready", runnerLostAt: null }, effects: [] },
  ],
  [
    "attached while ready and connected",
    { type: "sandbox.runner.attached", ...at(2), runnerBootId: "boot" },
    record(),
    "NoOp",
  ],
  [
    "lost marks the runner and asks the backend",
    { type: "sandbox.runner.lost", ...at(2), runnerBootId: "boot" },
    record(),
    { next: { runnerLostAt: now }, effects: ["sandbox.status"] },
  ],
  [
    "lost from an older generation",
    { type: "sandbox.runner.lost", ...at(1), runnerBootId: "boot" },
    record(),
    "stale-generation",
  ],
  [
    "wake from sleep starts the kept disk",
    { type: "sandbox.wake", ...base },
    record({ state: "sleeping", sleepReason: "idle" }),
    { next: { state: "waking", generation: 3, sleepReason: null }, effects: ["sandbox.start"] },
  ],
  [
    "wake from a retryable failure",
    { type: "sandbox.wake", ...base },
    record({ state: "failed", failure: lost }),
    { next: { state: "waking", generation: 3, failure: null }, effects: ["sandbox.start"] },
  ],
  [
    "wake from a final failure",
    { type: "sandbox.wake", ...base },
    record({ state: "failed", failure: { ...lost, retryable: false } }),
    "wrong-state",
  ],
  [
    "wake after discard starts a new machine",
    { type: "sandbox.wake", ...base },
    record({ state: "destroyed" }),
    {
      next: { state: "provisioning", generation: 3, driverRef: null },
      effects: ["sandbox.create"],
    },
  ],
  ["wake while waking", { type: "sandbox.wake", ...base }, record({ state: "waking" }), "NoOp"],
  ["wake while ready", { type: "sandbox.wake", ...base }, record(), "NoOp"],
  [
    "retry with a disk",
    { type: "sandbox.retry", ...base },
    record({ state: "failed", failure: lost }),
    { next: { state: "waking", generation: 3 }, effects: ["sandbox.start"] },
  ],
  [
    "retry without a disk",
    { type: "sandbox.retry", ...base },
    record({ state: "failed", failure: lost, driverRef: null }),
    { next: { state: "provisioning", generation: 3 }, effects: ["sandbox.create"] },
  ],
  ["retry when not failed", { type: "sandbox.retry", ...base }, record(), "wrong-state"],
  [
    "sleep a ready sandbox",
    { type: "sandbox.sleep", ...base },
    record({ sleepSnapshotAt: earlier }),
    {
      next: { state: "sleeping", sleepReason: "manual", sleepSnapshotAt: null },
      effects: ["sandbox.stop"],
    },
  ],
  [
    "sleep with a run on a side chat",
    { type: "sandbox.sleep", ...base },
    record(),
    "active-run",
    [attached(owner), attached(sideChat, { activeRun: true })],
  ],
  [
    "discard with a run on a side chat",
    { type: "sandbox.discard", ...base },
    record(),
    "active-run",
    [attached(owner), attached(sideChat, { activeRun: true })],
  ],
  [
    "auto-sleep once the owner is settled and its fork archived",
    autoSleep(),
    record({ sleepSnapshotAt: earlier }),
    {
      next: { state: "sleeping", sleepReason: "settled", sleepSnapshotAt: null },
      effects: ["sandbox.stop"],
    },
    [attached(owner, { settled: true }), attached(fork, { archived: true })],
  ],
  [
    "auto-sleep once every thread is archived",
    autoSleep("archived"),
    record(),
    { next: { state: "sleeping", sleepReason: "archived" }, effects: ["sandbox.stop"] },
    [attached(owner, { archived: true, settled: true }), attached(fork, { archived: true })],
  ],
  [
    "auto-sleep while a fork is still open",
    autoSleep(),
    record(),
    "in-use",
    [attached(owner, { settled: true }), attached(fork)],
  ],
  [
    "auto-sleep with a run on a settled thread",
    autoSleep(),
    record(),
    "active-run",
    [attached(owner, { settled: true, activeRun: true })],
  ],
  [
    "auto-sleep when not ready",
    autoSleep(),
    record({ state: "waking" }),
    "wrong-state",
    [attached(owner, { settled: true })],
  ],
  [
    "auto-sleep idle after a thread was active past the snapshot",
    autoSleep("idle"),
    record(),
    "in-use",
    [attached(owner), attached(sideChat, { activityAt: nowMs + 1 })],
  ],
  [
    "auto-sleep idle with only a question past its hold",
    autoSleep("idle"),
    record({ sleepSnapshotAt: earlier }),
    {
      next: { state: "sleeping", sleepReason: "idle", sleepSnapshotAt: null },
      effects: ["sandbox.stop"],
    },
    [
      attached(owner, {
        activeRun: true,
        activeRunId: runId,
        pendingRequestAt: nowMs - APPROVAL_HOLD_MS,
      }),
    ],
  ],
  [
    "auto-sleep settled when the settle predates the last wake",
    autoSleep(),
    record({ updatedAt: now }),
    "in-use",
    [attached(owner, { settled: true, restingAt: nowMs - 60_000 })],
  ],
  [
    "discard a sleeping sandbox",
    { type: "sandbox.discard", ...base },
    record({ state: "sleeping" }),
    { next: { state: "destroyed" }, effects: ["sandbox.destroy"] },
  ],
  [
    "discard while waking",
    { type: "sandbox.discard", ...base },
    record({ state: "waking" }),
    "wrong-state",
  ],
  [
    "stopped while ready drops an older sleep's snapshot",
    { type: "sandbox.stopped", ...at(2) },
    record({ sleepSnapshotAt: earlier }),
    { next: { state: "sleeping", sleepSnapshotAt: null }, effects: [] },
  ],
  [
    "stopped while sleeping",
    { type: "sandbox.stopped", ...at(2) },
    record({ state: "sleeping" }),
    "NoOp",
  ],
  [
    "stopped after a snapshot records its time",
    { type: "sandbox.stopped", ...at(2), sleepSnapshotAt: now },
    record({ state: "sleeping", sleepSnapshotAt: null }),
    { next: { state: "sleeping", sleepSnapshotAt: now }, effects: [] },
  ],
  [
    "a wake keeps the last snapshot's time",
    { type: "sandbox.wake", ...base },
    record({ state: "sleeping", sleepSnapshotAt: earlier }),
    { next: { state: "waking", sleepSnapshotAt: earlier }, effects: ["sandbox.start"] },
  ],
  [
    "stopped while failed keeps the failure",
    { type: "sandbox.stopped", ...at(2) },
    record({ state: "failed", failure: lost }),
    "NoOp",
  ],
  [
    "destroyed",
    { type: "sandbox.destroyed", ...at(2) },
    record({ state: "sleeping" }),
    { next: { state: "destroyed" }, effects: [] },
  ],
  [
    "destroyed twice",
    { type: "sandbox.destroyed", ...at(2) },
    record({ state: "destroyed" }),
    "NoOp",
  ],
  [
    "failed",
    { type: "sandbox.failed", ...at(2), failure: lost },
    record({ state: "provisioning" }),
    { next: { state: "failed", failure: lost }, effects: ["sandbox.release-waiters"] },
  ],
  [
    "a boot deadline stops the machine",
    { type: "sandbox.failed", ...at(2), failure: bootTimeout },
    record({ state: "waking" }),
    {
      next: { state: "failed", failure: bootTimeout },
      effects: ["sandbox.stop", "sandbox.release-waiters"],
    },
  ],
  [
    "a boot deadline after the runner attached",
    { type: "sandbox.failed", ...at(2), failure: bootTimeout },
    record(),
    "wrong-state",
  ],
  [
    "failed after destroy",
    { type: "sandbox.failed", ...at(2), failure: lost },
    record({ state: "destroyed" }),
    "wrong-state",
  ],
  [
    "failed from an older generation",
    { type: "sandbox.failed", ...at(1), failure: lost },
    record({ state: "waking" }),
    "stale-generation",
  ],
  ["any command without a record", { type: "sandbox.sleep", ...base }, null, "not-found"],
  [
    "adopt moves the owner and its member to the adopting thread",
    { type: "sandbox.adopt", ...base, threadId: fork, previousOwnerThreadId: owner },
    record({ state: "sleeping" }),
    { next: { ownerThreadId: fork, ownerMemberId: MemberId.make("member") }, effects: [] },
  ],
  [
    "adopt after the owner already moved",
    { type: "sandbox.adopt", ...base, threadId: sideChat, previousOwnerThreadId: fork },
    record(),
    "not-owner-thread",
  ],
  [
    "a command on a thread that no longer owns the sandbox",
    { type: "sandbox.wake", ...base, threadId: sideChat },
    record({ state: "sleeping" }),
    "not-owner-thread",
  ],
  [
    "provision on a server that is not cloud-only",
    provision,
    null,
    "not-cloud-only",
    [],
    free,
    false,
  ],
  [
    "wake after discard on a server that is not cloud-only",
    { type: "sandbox.wake", ...base },
    record({ state: "destroyed" }),
    "not-cloud-only",
    [],
    free,
    false,
  ],
  [
    "retry without a disk on a server that is not cloud-only",
    { type: "sandbox.retry", ...base },
    record({ state: "failed", failure: lost, driverRef: null }),
    "not-cloud-only",
    [],
    free,
    false,
  ],
  [
    "wake from sleep starts the kept disk anywhere",
    { type: "sandbox.wake", ...base },
    record({ state: "sleeping", sleepReason: "idle" }),
    { next: { state: "waking", generation: 3 }, effects: ["sandbox.start"] },
    [],
    free,
    false,
  ],
  [
    "sleep anywhere",
    { type: "sandbox.sleep", ...base },
    record(),
    { next: { state: "sleeping", sleepReason: "manual" }, effects: ["sandbox.stop"] },
    [],
    free,
    false,
  ],
  [
    "discard anywhere",
    { type: "sandbox.discard", ...base },
    record({ state: "sleeping" }),
    { next: { state: "destroyed" }, effects: ["sandbox.destroy"] },
    [],
    free,
    false,
  ],
  [
    "admit a waiting create on a server that is not cloud-only",
    { type: "sandbox.admit", ...at(2) },
    waiting("team-cap"),
    {
      next: {
        state: "failed",
        admission: null,
        failure: {
          code: "not-cloud-only",
          message: NOT_CLOUD_ONLY_MESSAGE,
          retryable: false,
        },
      },
      effects: ["sandbox.release-waiters"],
    },
    [],
    free,
    false,
  ],
  [
    "admit a waiting wake on a server that is not cloud-only starts its kept disk",
    { type: "sandbox.admit", ...at(2) },
    record({ state: "waking", admission: { reason: "rate-limit", since: earlier } }),
    { next: { state: "waking", admission: null }, effects: ["sandbox.start"] },
    [],
    free,
    false,
  ],
];

describe("decideSandboxCommand", () => {
  const cases = rows.map(
    ([
      name,
      command,
      current,
      expected,
      attachedThreads = [],
      admission = free,
      cloudOnly = true,
    ]) => ({
      name,
      command,
      current,
      expected,
      gathered: { attachedThreads, admission, cloudOnly },
    }),
  );
  it.each(cases)("$name", ({ command, current, expected, gathered }) => {
    const decision = decideSandboxCommand({
      command,
      record: current,
      ownerMemberId: MemberId.make("member"),
      ...gathered,
      now,
    });
    if (expected === "NoOp") return expect(decision).toEqual({ _tag: "NoOp" });
    if (typeof expected === "string") {
      return expect(decision).toEqual({ _tag: "Refuse", reason: expected });
    }
    if (decision._tag !== "Accept") throw new Error(`Expected Accept, got ${decision._tag}`);
    expect(decision.next).toMatchObject({ ...expected.next, updatedAt: now });
    expect(decision.effects).toEqual(
      expected.effects.map((type) => ({
        type,
        sandboxId,
        generation: decision.next.generation,
      })),
    );
  });
});

describe("idleDecision", () => {
  const minutes = (count: number) => count * 60_000;
  const readyAt = DateTime.toEpochMillis(earlier);
  const thread = (patch: Partial<SandboxAttachedThread> = {}) =>
    attached(owner, { activityAt: readyAt, ...patch });
  const input = (
    atMinute: number,
    patch: Partial<Omit<IdleInput, "activity">> & {
      readonly activity?: Partial<IdleInput["activity"]>;
    } = {},
  ): IdleInput => ({
    record: record(),
    threads: [thread()],
    policy: { idleMs: minutes(60), sleepOnSettle: true },
    capPressure: false,
    ...patch,
    activity: { viewedAt: null, terminalAt: null, nextScheduledAt: null, ...patch.activity },
    nowMs: readyAt + minutes(atMinute),
  });
  const awake = (atMinute: number): IdleDecision => ({
    _tag: "Awake",
    untilMs: readyAt + minutes(atMinute),
  });
  const sleeps = (reason: Extract<IdleDecision, { _tag: "Sleep" }>["reason"]): IdleDecision => ({
    _tag: "Sleep",
    reason,
    interrupt: [],
  });

  it.each<readonly [string, IdleInput, IdleDecision]>([
    [
      "a run with no question keeps it busy",
      input(180, { threads: [thread({ activeRun: true, activeRunId: runId })] }),
      { _tag: "Busy" },
    ],
    [
      "background work keeps it busy",
      input(180, {
        threads: [thread({ settled: true, restingAt: readyAt, backgroundWork: true })],
      }),
      { _tag: "Busy" },
    ],
    [
      "a question younger than 2 hours holds it until the hold ends",
      input(60, {
        threads: [
          thread({ activeRun: true, activeRunId: runId, pendingRequestAt: readyAt + minutes(10) }),
        ],
      }),
      awake(130),
    ],
    [
      "a question 2 hours old sleeps it and names the run to interrupt",
      input(120, {
        threads: [thread({ activeRun: true, activeRunId: runId, pendingRequestAt: readyAt })],
      }),
      { _tag: "Sleep", reason: "idle", interrupt: [{ threadId: owner, runId }] },
    ],
    [
      "a settle after it became ready sleeps it at once",
      input(1, { threads: [thread({ settled: true, restingAt: readyAt + minutes(1) })] }),
      sleeps("settled"),
    ],
    [
      "a settle before its last wake waits for the idle deadline",
      input(20, {
        record: record({ updatedAt: DateTime.makeUnsafe(readyAt + minutes(10)) }),
        threads: [thread({ settled: true, restingAt: readyAt })],
      }),
      awake(70),
    ],
    [
      "every thread archived sleeps as archived",
      input(0, {
        threads: [
          thread({ archived: true, restingAt: readyAt }),
          attached(fork, { archived: true, restingAt: readyAt }),
        ],
      }),
      sleeps("archived"),
    ],
    [
      "a driver without sleepOnSettle ignores settling",
      input(1, {
        threads: [thread({ settled: true, restingAt: readyAt })],
        policy: { idleMs: minutes(60), sleepOnSettle: false },
      }),
      awake(60),
    ],
    [
      "terminal output inside the window keeps it awake",
      input(60, { activity: { terminalAt: readyAt + minutes(30) } }),
      awake(90),
    ],
    [
      "a lease renewal keeps it awake",
      input(60, { activity: { viewedAt: readyAt + minutes(50) } }),
      awake(110),
    ],
    [
      "a scheduled run due inside the window keeps it awake until it runs",
      input(60, { activity: { nextScheduledAt: readyAt + minutes(90) } }),
      awake(90),
    ],
    [
      "a scheduled run that came due counts as activity",
      input(90, { activity: { nextScheduledAt: readyAt + minutes(90) } }),
      awake(150),
    ],
    [
      "a scheduled run past twice the window does not hold it",
      input(60, { activity: { nextScheduledAt: readyAt + minutes(120) } }),
      sleeps("idle"),
    ],
    ["60 idle minutes sleeps as idle", input(60), sleeps("idle")],
    [
      "a waiter queued sleeps one idle 5 minutes",
      input(5, { capPressure: true }),
      sleeps("cap-pressure"),
    ],
    ["a waiter queued waits until 5 idle minutes", input(2, { capPressure: true }), awake(5)],
  ])("%s", (_name, idle, expected) => {
    expect(idleDecision(idle)).toEqual(expected);
  });
});

describe("planSandboxOnDelete", () => {
  const rows = (...threadIds: ReadonlyArray<ThreadId>) =>
    threadIds.map((threadId) => ({ threadId, attachedAt: earlier, archived: false }));
  const destroy = {
    _tag: "Destroy",
    next: record({ state: "destroyed", updatedAt: now }),
    effects: [{ type: "sandbox.destroy", sandboxId, generation: 2 }],
  };
  it.each([
    { name: "the owner alone", deleted: [owner], remaining: [owner], expected: destroy },
    {
      name: "the owner with a side chat deleted in the same command",
      deleted: [owner, sideChat],
      remaining: [owner, sideChat],
      expected: destroy,
    },
    {
      name: "the owner while a fork remains",
      deleted: [owner],
      remaining: [owner, fork],
      expected: { _tag: "HandOver", effect: { type: "sandbox.hand-over", sandboxId } },
    },
    {
      name: "the owner of a discarded machine a fork still uses",
      deleted: [owner],
      remaining: [owner, fork],
      sandbox: record({ state: "destroyed" }),
      expected: { _tag: "HandOver", effect: { type: "sandbox.hand-over", sandboxId } },
    },
    {
      name: "a thread that is not the owner",
      deleted: [fork],
      remaining: [owner, fork],
      expected: { _tag: "Untouched" },
    },
    {
      name: "the last thread of a sandbox already destroyed",
      deleted: [owner],
      remaining: [owner],
      sandbox: record({ state: "destroyed" }),
      expected: { _tag: "Untouched" },
    },
  ])("$name", ({ deleted, remaining, sandbox = record(), expected }) => {
    expect(
      planSandboxOnDelete({
        record: sandbox,
        deletedThreadIds: new Set(deleted),
        remaining: rows(...remaining),
        now,
      }),
    ).toEqual(expected);
  });
});

describe("decideGitCredentialRecord", () => {
  const issued = {
    sandboxId,
    source: "app-installation",
    host: "github.com",
    repository: "org/repo",
    expiresAt: "2026-11-07T01:00:00.000Z",
  } as const;
  const command = {
    type: "sandbox.git-credential.record",
    commandId: CommandId.make("record"),
    threadId: fork,
    ...issued,
  } as const;
  const other = SandboxId.make("sbx_ffffffffffffffffffff");
  it.each([
    { name: "a thread on the sandbox", thread: { sandboxId, deletedAt: null }, accepted: true },
    { name: "a thread of another sandbox", thread: { sandboxId: other, deletedAt: null } },
    { name: "a local thread", thread: { deletedAt: null } },
    { name: "a deleted thread", thread: { sandboxId, deletedAt: now } },
    { name: "a missing thread", thread: null },
  ])("$name", ({ thread, accepted }) => {
    expect(decideGitCredentialRecord(command, thread)).toEqual(
      accepted === true
        ? { _tag: "Accept", payload: issued }
        : { _tag: "Refuse", reason: "not-this-sandbox" },
    );
  });
});

describe("decideCloudPrompt", () => {
  const checkout = { baseRef: "main", branch: "pair/fix" };
  it.each([
    { name: "a ready machine sends", current: record(), expected: { _tag: "Send" } },
    {
      name: "a booting machine parks the run without a second start",
      current: record({ state: "provisioning", generation: 1, driverRef: null }),
      expected: { _tag: "Defer", workspaceStrategy: undefined, wake: null },
    },
    {
      name: "a waking machine parks the run",
      current: record({ state: "waking" }),
      expected: { _tag: "Defer", workspaceStrategy: undefined, wake: null },
    },
    {
      name: "a sleeping machine wakes in the same commit",
      current: record({ state: "sleeping", sleepReason: "settled" }),
      expected: { _tag: "Defer", workspaceStrategy: undefined, state: "waking", generation: 3 },
    },
    {
      name: "a discarded machine is replaced and the checkout rebuilt",
      current: record({ state: "destroyed" }),
      expected: {
        _tag: "Defer",
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "pair/fix" },
        state: "provisioning",
        generation: 3,
      },
    },
    {
      name: "a machine whose disk is gone is replaced and the checkout rebuilt",
      current: record({
        state: "failed",
        driverRef: null,
        failure: { code: "missing", message: "Gone.", retryable: true },
      }),
      expected: {
        _tag: "Defer",
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "pair/fix" },
        state: "provisioning",
        generation: 3,
      },
    },
    {
      name: "a machine that failed for good refuses",
      current: record({ state: "failed", failure: { ...lost, retryable: false } }),
      expected: { _tag: "Refuse", message: "Gone." },
    },
    {
      name: "another thread's prompt asks the owner to wake the generation it saw",
      current: record({ state: "sleeping" }),
      threadId: sideChat,
      expected: {
        _tag: "Defer",
        workspaceStrategy: undefined,
        wake: {
          _tag: "RequestWake",
          request: { type: "sandbox.request-wake", sandboxId, generation: 2 },
        },
      },
    },
    {
      name: "another thread's prompt refuses what the owner's would",
      current: record({ state: "failed", failure: { ...lost, retryable: false } }),
      threadId: sideChat,
      expected: { _tag: "Refuse", message: "Gone." },
    },
    {
      name: "a discarded machine on a server that is not cloud-only points at Pair Cloud",
      current: record({ state: "destroyed" }),
      cloudOnly: false,
      expected: { _tag: "Refuse", message: NOT_CLOUD_ONLY_MESSAGE },
    },
    {
      name: "a sleeping machine on a server that is not cloud-only still wakes",
      current: record({ state: "sleeping", sleepReason: "settled" }),
      cloudOnly: false,
      expected: { _tag: "Defer", workspaceStrategy: undefined, state: "waking", generation: 3 },
    },
  ])("$name", ({ current, threadId = owner, cloudOnly = true, expected }) => {
    const decision = decideCloudPrompt({
      record: current,
      commandId: CommandId.make("prompt"),
      threadId,
      dispatchMode: "start_immediately",
      checkout,
      admission: free,
      cloudOnly,
      now,
    });
    if (!("state" in expected)) return expect(decision).toEqual(expected);
    if (decision._tag !== "Defer" || decision.wake?._tag !== "Accept") {
      throw new Error("Expected a wake");
    }
    expect(decision.workspaceStrategy).toEqual(expected.workspaceStrategy);
    expect(decision.wake.next).toMatchObject({
      state: expected.state,
      generation: expected.generation,
    });
  });
});
