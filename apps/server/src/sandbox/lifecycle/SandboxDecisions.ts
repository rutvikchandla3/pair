import type {
  CommandId,
  MemberId,
  OrchestrationV2Sandbox,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  SandboxSleepReason,
  ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import type {
  OrchestrationEffectRequestV2,
  PendingOrchestrationEffectV2,
} from "../../orchestration-v2/EffectOutbox.ts";

export type SandboxCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "sandbox.wake"
      | "sandbox.sleep"
      | "sandbox.retry"
      | "sandbox.discard"
      | "sandbox.provision"
      | "sandbox.created"
      | "sandbox.runner.attached"
      | "sandbox.runner.lost"
      | "sandbox.stopped"
      | "sandbox.destroyed"
      | "sandbox.failed"
      | "sandbox.auto-sleep";
  }
>;

export type SandboxEffectRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: `sandbox.${string}`; readonly generation: number }
>;

/** A live thread using the sandbox, as the shared thread row says (never one member's view). */
export interface SandboxAttachedThread {
  readonly threadId: ThreadId;
  readonly archived: boolean;
  readonly settled: boolean;
  /** A run that is preparing, queued, starting, running or waiting. */
  readonly activeRun: boolean;
}

export const sandboxAttachedThread = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "id" | "archivedAt" | "settledOverride" | "activeRunId" | "activityRunStatus" | "status"
  >,
): SandboxAttachedThread => ({
  threadId: shell.id,
  archived: shell.archivedAt !== null,
  settled: shell.settledOverride === "settled",
  activeRun:
    shell.activeRunId !== null || shell.activityRunStatus != null || shell.status === "queued",
});

/** The orchestrator gathers these under the owner thread's lock; deciding does no I/O. */
export interface SandboxDecisionInput {
  readonly command: SandboxCommand;
  readonly record: OrchestrationV2Sandbox | null;
  /** The owning thread's owner, for a record `sandbox.provision` creates. */
  readonly ownerMemberId: MemberId | null;
  /** Read only for sleep, discard and auto-sleep. */
  readonly attachedThreads: ReadonlyArray<SandboxAttachedThread>;
  readonly now: DateTime.Utc;
}

type SandboxRefusalReason =
  | "not-found"
  /** The owner moved since the client read it; refused without a receipt and re-routed. */
  | "not-owner-thread"
  | "wrong-state"
  | "active-run"
  | "in-use"
  | "stale-generation";

/**
 * M1's settle-and-archive rule: once every attached thread is archived or settled and none has
 * an active run, the sandbox may sleep. Null while it is still in use, or with no thread left.
 */
export const decideAutoSleep = (
  threads: ReadonlyArray<SandboxAttachedThread>,
): Extract<SandboxSleepReason, "archived" | "settled"> | null => {
  if (threads.length === 0) return null;
  if (threads.some((thread) => thread.activeRun || (!thread.archived && !thread.settled))) {
    return null;
  }
  return threads.every((thread) => thread.archived) ? "archived" : "settled";
};

/**
 * Deleting the owner together with every live attached thread (its side chats deleted in the
 * same command) destroys the sandbox; while any other thread remains, deletion enqueues nothing.
 */
export const planSandboxOnThreadDelete = (input: {
  readonly deletedThreadIds: ReadonlyArray<ThreadId>;
  readonly sandbox: OrchestrationV2Sandbox | null;
  readonly liveAttachedThreadIds: ReadonlyArray<ThreadId>;
  readonly commandId: CommandId;
}): ReadonlyArray<PendingOrchestrationEffectV2> => {
  const { sandbox, commandId } = input;
  const deleted = new Set(input.deletedThreadIds);
  if (
    sandbox === null ||
    sandbox.state === "destroyed" ||
    !deleted.has(sandbox.ownerThreadId) ||
    input.liveAttachedThreadIds.some((threadId) => !deleted.has(threadId))
  ) {
    return [];
  }
  return [
    {
      id: `effect:${commandId}:sandbox.destroy`,
      commandId,
      threadId: sandbox.ownerThreadId,
      request: { type: "sandbox.destroy", sandboxId: sandbox.id, generation: sandbox.generation },
    },
  ];
};

export type SandboxDecision =
  | {
      readonly _tag: "Accept";
      readonly next: OrchestrationV2Sandbox;
      readonly effects: ReadonlyArray<SandboxEffectRequest>;
    }
  /** Already there; only types on dispatch's no-event allow list return it. */
  | { readonly _tag: "NoOp" }
  | { readonly _tag: "Refuse"; readonly reason: SandboxRefusalReason };

const noOp: SandboxDecision = { _tag: "NoOp" };
const refuse = (reason: SandboxRefusalReason): SandboxDecision => ({ _tag: "Refuse", reason });

const accept = (
  next: OrchestrationV2Sandbox,
  effectTypes: ReadonlyArray<SandboxEffectRequest["type"]>,
): SandboxDecision => ({
  _tag: "Accept",
  next,
  effects: effectTypes.map((type) => ({ type, sandboxId: next.id, generation: next.generation })),
});

const decideProvision = (
  input: SandboxDecisionInput & {
    readonly command: Extract<SandboxCommand, { readonly type: "sandbox.provision" }>;
  },
): SandboxDecision => {
  const { command, record, now } = input;
  if (record !== null && record.ownerThreadId !== command.threadId) {
    return refuse("not-owner-thread");
  }
  if (record !== null && record.state !== "destroyed") return refuse("wrong-state");
  return accept(
    {
      id: command.sandboxId,
      projectId: command.projectId,
      ownerThreadId: command.threadId,
      ownerMemberId: input.ownerMemberId,
      driverId: command.driverId,
      size: command.size,
      state: "provisioning",
      generation: (record?.generation ?? 0) + 1,
      driverRef: null,
      admission: null,
      runnerLostAt: null,
      sleepReason: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    },
    ["sandbox.create"],
  );
};

/** 04 §1's state table for M1. */
export const decideSandboxCommand = (input: SandboxDecisionInput): SandboxDecision => {
  const { command, record, now } = input;
  if (command.type === "sandbox.provision") return decideProvision({ ...input, command });
  if (record === null) return refuse("not-found");
  if (record.ownerThreadId !== command.threadId) return refuse("not-owner-thread");

  const update = (
    patch: Partial<OrchestrationV2Sandbox>,
    effectTypes: ReadonlyArray<SandboxEffectRequest["type"]> = [],
  ) => accept({ ...record, ...patch, updatedAt: now }, effectTypes);
  // A new generation boots either from the kept disk or, without one, from scratch.
  const nextGeneration = (fromScratch: boolean) =>
    fromScratch || record.driverRef === null
      ? update(
          {
            state: "provisioning",
            generation: record.generation + 1,
            driverRef: null,
            runnerLostAt: null,
            sleepReason: null,
            failure: null,
          },
          ["sandbox.create"],
        )
      : update(
          {
            state: "waking",
            generation: record.generation + 1,
            runnerLostAt: null,
            sleepReason: null,
            failure: null,
          },
          ["sandbox.start"],
        );
  const busy = input.attachedThreads.some((thread) => thread.activeRun);

  switch (command.type) {
    case "sandbox.wake":
      if (record.state === "sleeping") return nextGeneration(false);
      if (record.state === "destroyed") return nextGeneration(true);
      if (record.state === "waking" || record.state === "ready") return noOp;
      return record.state === "failed" && record.failure?.retryable === true
        ? nextGeneration(false)
        : refuse("wrong-state");
    case "sandbox.retry":
      return record.state === "failed" ? nextGeneration(false) : refuse("wrong-state");
    case "sandbox.sleep":
      if (record.state !== "ready") return refuse("wrong-state");
      return busy
        ? refuse("active-run")
        : update({ state: "sleeping", sleepReason: "manual" }, ["sandbox.stop"]);
    case "sandbox.discard":
      if (record.state === "ready" && busy) return refuse("active-run");
      // Destroy stops a running sandbox too, so no separate stop effect.
      return record.state === "ready" || record.state === "sleeping" || record.state === "failed"
        ? update({ state: "destroyed" }, ["sandbox.destroy"])
        : refuse("wrong-state");
    case "sandbox.auto-sleep": {
      if (record.state !== "ready") return refuse("wrong-state");
      if (busy) return refuse("active-run");
      const sleepReason = decideAutoSleep(input.attachedThreads);
      // Sleeping from the decision on, so a prompt before the stop runs wakes after it.
      return sleepReason === null
        ? refuse("in-use")
        : update({ state: "sleeping", sleepReason }, ["sandbox.stop"]);
    }
  }

  if (command.generation !== record.generation) return refuse("stale-generation");
  switch (command.type) {
    case "sandbox.created":
      // The runner's hello can beat the create's answer, so any live state takes the ref.
      return record.state === "destroyed"
        ? refuse("wrong-state")
        : update({
            driverRef: command.driverRef,
            ...(command.baseImage === undefined ? {} : { baseImage: command.baseImage }),
          });
    case "sandbox.runner.attached":
      if (record.state === "ready") {
        return record.runnerLostAt === null ? noOp : update({ runnerLostAt: null });
      }
      return record.state === "provisioning" || record.state === "waking"
        ? update({ state: "ready", runnerLostAt: null, sleepReason: null, failure: null })
        : refuse("wrong-state");
    case "sandbox.runner.lost":
      return record.state === "ready"
        ? update({ runnerLostAt: record.runnerLostAt ?? now }, ["sandbox.status"])
        : refuse("wrong-state");
    case "sandbox.stopped":
      // A failed sandbox keeps its failure; its backend stopping changes nothing.
      if (record.state === "sleeping" || record.state === "failed") return noOp;
      return record.state === "ready" || record.state === "waking"
        ? update({ state: "sleeping", runnerLostAt: null })
        : refuse("wrong-state");
    case "sandbox.destroyed":
      return record.state === "destroyed" ? noOp : update({ state: "destroyed" });
    case "sandbox.failed":
      if (command.failure.code === "boot-timeout") {
        return record.state === "provisioning" || record.state === "waking"
          ? update({ state: "failed", failure: command.failure }, ["sandbox.stop"])
          : refuse("wrong-state");
      }
      return record.state === "destroyed"
        ? refuse("wrong-state")
        : update({ state: "failed", failure: command.failure });
  }
};
