import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  MemberId,
  type OrchestrationV2Sandbox,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { decideSandboxCommand, type SandboxCommand } from "./SandboxDecisions.ts";

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

type Row = readonly [
  name: string,
  command: SandboxCommand,
  current: OrchestrationV2Sandbox | null,
  expected:
    | { readonly next: Partial<OrchestrationV2Sandbox>; readonly effects: ReadonlyArray<string> }
    | "NoOp"
    | string,
  activeRunThreadIds?: ReadonlyArray<ThreadId>,
];

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
    "created sets the ref",
    { type: "sandbox.created", ...at(2), driverRef: "new-ref" },
    record({ state: "provisioning", driverRef: null }),
    { next: { state: "provisioning", driverRef: "new-ref" }, effects: [] },
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
    { next: { state: "ready", sleepReason: null, failure: null }, effects: [] },
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
    record(),
    { next: { state: "sleeping", sleepReason: "manual" }, effects: ["sandbox.stop"] },
  ],
  [
    "sleep with a run on a side chat",
    { type: "sandbox.sleep", ...base },
    record(),
    "active-run",
    [sideChat],
  ],
  [
    "discard with a run on a side chat",
    { type: "sandbox.discard", ...base },
    record(),
    "active-run",
    [sideChat],
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
    "stopped while ready",
    { type: "sandbox.stopped", ...at(2) },
    record(),
    { next: { state: "sleeping" }, effects: [] },
  ],
  [
    "stopped while sleeping",
    { type: "sandbox.stopped", ...at(2) },
    record({ state: "sleeping" }),
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
    { next: { state: "failed", failure: lost }, effects: [] },
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
    "a command on a thread that no longer owns the sandbox",
    { type: "sandbox.wake", ...base, threadId: sideChat },
    record({ state: "sleeping" }),
    "not-owner-thread",
  ],
];

describe("decideSandboxCommand", () => {
  const cases = rows.map(([name, command, current, expected, activeRunThreadIds = []]) => ({
    name,
    command,
    current,
    expected,
    activeRunThreadIds,
  }));
  it.each(cases)("$name", ({ command, current, expected, activeRunThreadIds }) => {
    const decision = decideSandboxCommand({
      command,
      record: current,
      ownerMemberId: MemberId.make("member"),
      activeRunThreadIds,
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
