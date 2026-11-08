import type {
  CommandId,
  MemberId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunWorkspacePreparation,
  OrchestrationV2Sandbox,
  OrchestrationV2SandboxAdmission,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  SandboxSleepReason,
  ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import type { OrchestrationEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";
import type { AdmissionSnapshot } from "./SandboxAdmission.ts";
import type { SandboxThreadRow } from "./SandboxProjection.ts";

export type SandboxCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "sandbox.wake"
      | "sandbox.sleep"
      | "sandbox.retry"
      | "sandbox.discard"
      | "sandbox.provision"
      | "sandbox.admit"
      | "sandbox.created"
      | "sandbox.runner.attached"
      | "sandbox.runner.lost"
      | "sandbox.stopped"
      | "sandbox.destroyed"
      | "sandbox.failed"
      | "sandbox.auto-sleep"
      | "sandbox.adopt";
  }
>;

export type SandboxEffectRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: `sandbox.${string}`; readonly generation: number }
>;

type SandboxHandOverRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: "sandbox.hand-over" }
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
  /** The commanding thread's owner, for a record `sandbox.provision` creates or `sandbox.adopt` moves. */
  readonly ownerMemberId: MemberId | null;
  /** Read only for sleep, discard and auto-sleep. */
  readonly attachedThreads: ReadonlyArray<SandboxAttachedThread>;
  /** Read under the admission lock for commands that can start a machine; null for the rest. */
  readonly admission: AdmissionSnapshot | null;
  readonly now: DateTime.Utc;
}

type SandboxRefusalReason =
  | "not-found"
  /** The owner moved since the client read it; refused without a receipt and re-routed. */
  | "not-owner-thread"
  | "wrong-state"
  | "active-run"
  | "in-use"
  | "stale-generation"
  /** `sandbox.admit` with no free slot or start token; the sweep tries again later. */
  | "no-capacity";

/**
 * Why a machine about to start must wait, or null to start it now. A new start also queues
 * behind anyone already waiting on the driver, so waiters are admitted in order.
 */
const admissionWait = (
  snapshot: AdmissionSnapshot | null,
  now: DateTime.Utc,
): OrchestrationV2SandboxAdmission | null => {
  if (snapshot === null) return null;
  if (snapshot.running + snapshot.waiting >= snapshot.cap)
    return { reason: "team-cap", since: now };
  return snapshot.startAvailable && snapshot.waiting === 0
    ? null
    : { reason: "rate-limit", since: now };
};

/** The failure code for a backend that no longer exists, disk and all. */
export const SANDBOX_BACKEND_MISSING = "missing";

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
 * Deleting the owner (with the side chats deleted in the same command) destroys the sandbox when
 * no other thread uses it, and otherwise hands it to the oldest remaining one.
 */
export const planSandboxOnDelete = (input: {
  readonly record: OrchestrationV2Sandbox;
  readonly deletedThreadIds: ReadonlySet<ThreadId>;
  /** `listSandboxThreads` read before the deletion commits, oldest first. */
  readonly remaining: ReadonlyArray<SandboxThreadRow>;
  readonly now: DateTime.Utc;
}):
  | { readonly _tag: "Untouched" }
  | {
      readonly _tag: "Destroy";
      readonly next: OrchestrationV2Sandbox;
      readonly effects: ReadonlyArray<SandboxEffectRequest>;
    }
  | { readonly _tag: "HandOver"; readonly effect: SandboxHandOverRequest } => {
  const { record, deletedThreadIds } = input;
  if (!deletedThreadIds.has(record.ownerThreadId)) return { _tag: "Untouched" };
  if (input.remaining.some((row) => !deletedThreadIds.has(row.threadId))) {
    return { _tag: "HandOver", effect: { type: "sandbox.hand-over", sandboxId: record.id } };
  }
  if (record.state === "destroyed") return { _tag: "Untouched" };
  // Destroy stops a running sandbox too, so no separate stop effect.
  const next: OrchestrationV2Sandbox = { ...record, state: "destroyed", updatedAt: input.now };
  return {
    _tag: "Destroy",
    next,
    effects: [{ type: "sandbox.destroy", sandboxId: next.id, generation: next.generation }],
  };
};

/** Reassigning the owning thread moves the sandbox's member with it; other threads' don't. */
export const sandboxOwnerMemberChange = (
  record: OrchestrationV2Sandbox | null,
  threadId: ThreadId,
  ownerMemberId: MemberId | null,
  now: DateTime.Utc,
): OrchestrationV2Sandbox | null =>
  record === null || record.ownerThreadId !== threadId || record.ownerMemberId === ownerMemberId
    ? null
    : { ...record, ownerMemberId, updatedAt: now };

export type CloudPromptDecision =
  | { readonly _tag: "Send" }
  /**
   * The run waits in `preparing`. On the owner a wake (or a new machine) commits with it; another
   * thread can't write the owner's stream, so it asks the owner's stream with an effect.
   */
  | {
      readonly _tag: "Defer";
      readonly workspaceStrategy: OrchestrationV2RunWorkspacePreparation | undefined;
      readonly wake:
        | Extract<SandboxDecision, { readonly _tag: "Accept" }>
        | {
            readonly _tag: "RequestWake";
            readonly request: Extract<SandboxEffectRequest, { type: "sandbox.request-wake" }>;
          }
        | null;
    }
  | { readonly _tag: "Refuse"; readonly message: string };

/** A discarded machine, or one whose backend is gone, starts over on an empty disk. */
export const hasNoDisk = (record: OrchestrationV2Sandbox) =>
  record.state === "destroyed" || (record.state === "failed" && record.driverRef === null);

/**
 * A prompt to a cloud thread whose machine is not `ready` waits for it instead of starting. A
 * new machine has an empty disk, so that prompt also re-creates the checkout from the remote.
 */
export const decideCloudPrompt = (input: {
  readonly record: OrchestrationV2Sandbox | null;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly dispatchMode: "start_immediately" | "queue_after_active";
  /** The base the thread's checkout was first made from, and its branch now. */
  readonly checkout: { readonly baseRef: string; readonly branch: string | null } | null;
  readonly admission: AdmissionSnapshot | null;
  readonly now: DateTime.Utc;
}): CloudPromptDecision => {
  const { record } = input;
  if (record === null || record.state === "ready") return { _tag: "Send" };
  // Decided as the owner would decide the wake, so another thread refuses what the owner would.
  const decision = decideSandboxCommand({
    command: {
      type: "sandbox.wake",
      commandId: input.commandId,
      threadId: record.ownerThreadId,
      sandboxId: record.id,
    },
    record,
    ownerMemberId: record.ownerMemberId,
    attachedThreads: [],
    admission: input.admission,
    now: input.now,
  });
  // Provisioning and waking release their waiters on hello; nothing more to start.
  if (decision._tag === "NoOp" || record.state === "provisioning") {
    return { _tag: "Defer", workspaceStrategy: undefined, wake: null };
  }
  if (decision._tag === "Refuse") {
    return { _tag: "Refuse", message: record.failure?.message ?? "The machine is not running." };
  }
  const wake =
    record.ownerThreadId === input.threadId
      ? decision
      : {
          _tag: "RequestWake" as const,
          request: {
            type: "sandbox.request-wake" as const,
            sandboxId: record.id,
            generation: record.generation,
          },
        };
  if (!hasNoDisk(record)) return { _tag: "Defer", workspaceStrategy: undefined, wake };
  if (input.checkout === null) {
    return { _tag: "Refuse", message: "This thread has no checkout to rebuild on a new machine." };
  }
  return {
    _tag: "Defer",
    workspaceStrategy: {
      type: "worktree",
      baseRef: input.checkout.baseRef,
      ...(input.checkout.branch === null ? {} : { branch: input.checkout.branch }),
    },
    wake,
  };
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

/** A machine past the cap or the start rate still bumps its generation, but waits to boot. */
const acceptStart = (
  next: OrchestrationV2Sandbox,
  start: "sandbox.create" | "sandbox.start",
  snapshot: AdmissionSnapshot | null,
): SandboxDecision => {
  const admission = admissionWait(snapshot, next.updatedAt);
  return admission === null ? accept(next, [start]) : accept({ ...next, admission }, []);
};

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
  return acceptStart(
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
    "sandbox.create",
    input.admission,
  );
};

/** 04 §1's state table for M1. */
export const decideSandboxCommand = (input: SandboxDecisionInput): SandboxDecision => {
  const { command, record, now } = input;
  if (command.type === "sandbox.provision") return decideProvision({ ...input, command });
  if (record === null) return refuse("not-found");
  if (command.type === "sandbox.adopt") {
    // A hand-over that lost its race resends to the next thread under the same id.
    return record.ownerThreadId === command.previousOwnerThreadId
      ? accept(
          {
            ...record,
            ownerThreadId: command.threadId,
            ownerMemberId: input.ownerMemberId,
            updatedAt: now,
          },
          [],
        )
      : refuse("not-owner-thread");
  }
  if (record.ownerThreadId !== command.threadId) return refuse("not-owner-thread");

  // Only a booting record waits for admission.
  const patched = (patch: Partial<OrchestrationV2Sandbox>): OrchestrationV2Sandbox => {
    const next = { ...record, ...patch, updatedAt: now };
    return next.state === "provisioning" || next.state === "waking"
      ? next
      : { ...next, admission: null };
  };
  const update = (
    patch: Partial<OrchestrationV2Sandbox>,
    effectTypes: ReadonlyArray<SandboxEffectRequest["type"]> = [],
  ) => accept(patched(patch), effectTypes);
  // A new generation boots either from the kept disk or, without one, from scratch.
  const nextGeneration = (fromScratch: boolean) =>
    fromScratch || record.driverRef === null
      ? acceptStart(
          patched({
            state: "provisioning",
            generation: record.generation + 1,
            driverRef: null,
            runnerLostAt: null,
            sleepReason: null,
            failure: null,
          }),
          "sandbox.create",
          input.admission,
        )
      : acceptStart(
          patched({
            state: "waking",
            generation: record.generation + 1,
            runnerLostAt: null,
            sleepReason: null,
            failure: null,
          }),
          "sandbox.start",
          input.admission,
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
    case "sandbox.admit": {
      if (
        record.admission === null ||
        (record.state !== "provisioning" && record.state !== "waking")
      ) {
        return refuse("wrong-state");
      }
      const snapshot = input.admission;
      if (snapshot !== null && (snapshot.running >= snapshot.cap || !snapshot.startAvailable)) {
        return refuse("no-capacity");
      }
      return update({ admission: null }, [
        record.driverRef === null ? "sandbox.create" : "sandbox.start",
      ]);
    }
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
        ? update({ state: "ready", runnerLostAt: null, sleepReason: null, failure: null }, [
            "sandbox.release-waiters",
          ])
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
          ? update({ state: "failed", failure: command.failure }, [
              "sandbox.stop",
              "sandbox.release-waiters",
            ])
          : refuse("wrong-state");
      }
      return record.state === "destroyed"
        ? refuse("wrong-state")
        : update(
            {
              state: "failed",
              failure: command.failure,
              // Its disk is gone too, so a retry or wake provisions from scratch.
              ...(command.failure.code === SANDBOX_BACKEND_MISSING ? { driverRef: null } : {}),
            },
            ["sandbox.release-waiters"],
          );
  }
};

type GitCredentialRecord = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "sandbox.git-credential.record" }
>;
type GitCredentialIssued = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "sandbox.git-credential.issued" }
>["payload"];

/** Only a live thread that runs on the sandbox may carry its credential's audit. */
export const decideGitCredentialRecord = (
  command: GitCredentialRecord,
  thread: Pick<OrchestrationV2ThreadShell, "sandboxId" | "deletedAt"> | null,
):
  | { readonly _tag: "Accept"; readonly payload: GitCredentialIssued }
  | { readonly _tag: "Refuse"; readonly reason: "not-this-sandbox" } => {
  if (thread === null || thread.deletedAt !== null || thread.sandboxId !== command.sandboxId) {
    return { _tag: "Refuse", reason: "not-this-sandbox" };
  }
  const { type: _type, commandId: _commandId, threadId: _threadId, ...payload } = command;
  return { _tag: "Accept", payload };
};
