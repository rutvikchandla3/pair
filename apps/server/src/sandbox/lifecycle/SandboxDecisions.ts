import type {
  CommandId,
  MemberId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunWorkspacePreparation,
  OrchestrationV2Sandbox,
  OrchestrationV2SandboxAdmission,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  RunId,
  SandboxDiskRetention,
  SandboxFailure,
  SandboxSettings,
  SandboxSleepReason,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_DISK_RETENTION, NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";
import * as DateTime from "effect/DateTime";

import type { OrchestrationEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { threadActivityAt } from "../../orchestration-v2/threadActivity.ts";
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
      | "sandbox.expire"
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
  readonly activeRunId: RunId | null;
  /** Epoch ms of the thread's last message or run, as storage cleanup measures it. */
  readonly activityAt: number;
  /** When it archived, or else settled; null while neither. */
  readonly restingAt: number | null;
  /** When its blocking question was asked; null without one. */
  readonly pendingRequestAt: number | null;
  readonly backgroundWork: boolean;
}

const epochMs = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

export const sandboxAttachedThread = (shell: OrchestrationV2ThreadShell): SandboxAttachedThread => {
  const archived = shell.archivedAt !== null;
  const settled = shell.settledOverride === "settled";
  const request = shell.pendingRuntimeRequest;
  return {
    threadId: shell.id,
    archived,
    settled,
    activeRun:
      shell.activeRunId !== null || shell.activityRunStatus != null || shell.status === "queued",
    activeRunId: shell.activeRunId,
    activityAt: threadActivityAt(shell),
    restingAt: archived ? epochMs(shell.archivedAt) : settled ? epochMs(shell.settledAt) : null,
    pendingRequestAt:
      request === null || request.blocking === false ? null : epochMs(request.createdAt),
    backgroundWork: (shell.pendingBackgroundTasks?.length ?? 0) > 0,
  };
};

/** The orchestrator gathers these under the owner thread's lock; deciding does no I/O. */
export interface SandboxDecisionInput {
  readonly command: SandboxCommand;
  readonly record: OrchestrationV2Sandbox | null;
  /** The commanding thread's owner, for a record `sandbox.provision` creates or `sandbox.adopt` moves. */
  readonly ownerMemberId: MemberId | null;
  /** Read only for sleep, discard, auto-sleep and expire. */
  readonly attachedThreads: ReadonlyArray<SandboxAttachedThread>;
  /** Read only for `sandbox.expire`; absent, nothing expires. */
  readonly diskRetention?: SandboxDiskRetention;
  /** Read under the admission lock for commands that can start a machine; null for the rest. */
  readonly admission: AdmissionSnapshot | null;
  /** Only a cloud-only server makes new machines; others still wake, sleep and discard theirs. */
  readonly cloudOnly: boolean;
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
  /** `sandbox.admit` with no free slot or start token, or while draining; the sweep tries again later. */
  | "no-capacity"
  | "not-cloud-only";

/**
 * Why a machine about to start must wait, or null to start it now. A new start also queues
 * behind anyone already waiting on the driver, so waiters are admitted in order.
 */
const admissionWait = (
  snapshot: AdmissionSnapshot | null,
  now: DateTime.Utc,
): OrchestrationV2SandboxAdmission | null => {
  if (snapshot === null) return null;
  if (snapshot.draining) return { reason: "draining", since: now };
  if (snapshot.running + snapshot.waiting >= snapshot.cap)
    return { reason: "team-cap", since: now };
  return snapshot.startAvailable && snapshot.waiting === 0
    ? null
    : { reason: "rate-limit", since: now };
};

/** The failure code for a backend that no longer exists, disk and all. */
export const SANDBOX_BACKEND_MISSING = "missing";
export const SANDBOX_BACKEND_MISSING_FAILURE: SandboxFailure = {
  code: SANDBOX_BACKEND_MISSING,
  message: "The machine and its disk are gone. Retry starts a new one.",
  retryable: true,
};

/**
 * The settle-and-archive rule: once every attached thread is archived or settled and none has
 * an active run, the sandbox may sleep. Null while it is still in use, with no thread left, or
 * when the newest settle came before the machine last became ready, so a wake stays up.
 */
const decideAutoSleep = (
  threads: ReadonlyArray<SandboxAttachedThread>,
  readySinceMs: number,
): Extract<SandboxSleepReason, "archived" | "settled"> | null => {
  if (threads.length === 0) return null;
  if (threads.some((thread) => thread.activeRun || (!thread.archived && !thread.settled))) {
    return null;
  }
  if (Math.max(...threads.map((thread) => thread.restingAt ?? -Infinity)) < readySinceMs) {
    return null;
  }
  return threads.every((thread) => thread.archived) ? "archived" : "settled";
};

/** How long a blocking question keeps its machine awake before the run is stopped (decision #2). */
export const APPROVAL_HOLD_MS = 2 * 60 * 60_000;
/** How long a machine may sit unused while another machine on its driver waits for a slot. */
const CAP_PRESSURE_IDLE_MS = 5 * 60_000;

const questionExpired = (thread: SandboxAttachedThread, nowMs: number) =>
  thread.pendingRequestAt !== null && nowMs - thread.pendingRequestAt >= APPROVAL_HOLD_MS;

/** Background work, or an active run unless its blocking question has outlived the hold. */
const holdsMachine = (thread: SandboxAttachedThread, nowMs: number) =>
  thread.backgroundWork || (thread.activeRun && !questionExpired(thread, nowMs));

export type AutoSleepReason = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "sandbox.auto-sleep" }
>["reason"];

export interface IdleInput {
  /** A ready machine; its `updatedAt` is when it last became ready. */
  readonly record: OrchestrationV2Sandbox;
  readonly threads: ReadonlyArray<SandboxAttachedThread>;
  readonly activity: {
    readonly viewedAt: number | null;
    readonly terminalAt: number | null;
    readonly nextScheduledAt: number | null;
  };
  readonly policy: { readonly idleMs: number; readonly sleepOnSettle: boolean };
  /** Another sandbox on this driver waits for admission. */
  readonly capPressure: boolean;
  readonly nowMs: number;
}

export type IdleDecision =
  /** Only an event can end it, so it sets no deadline. */
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Awake"; readonly untilMs: number }
  | {
      readonly _tag: "Sleep";
      readonly reason: AutoSleepReason;
      readonly interrupt: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>;
    };

const sleep = (reason: AutoSleepReason): IdleDecision => ({ _tag: "Sleep", reason, interrupt: [] });

/** 04 §2's idle policy for one ready machine, from activity across every attached thread. */
export const idleDecision = (input: IdleInput): IdleDecision => {
  const { threads, activity, policy, nowMs } = input;
  const holders = threads.filter((thread) => holdsMachine(thread, nowMs));
  if (holders.length > 0) {
    if (holders.some((thread) => thread.backgroundWork || thread.pendingRequestAt === null)) {
      return { _tag: "Busy" };
    }
    return {
      _tag: "Awake",
      untilMs: Math.min(...holders.map((thread) => thread.pendingRequestAt! + APPROVAL_HOLD_MS)),
    };
  }
  const expired = threads.filter((thread) => thread.activeRun);
  if (expired.length > 0) {
    return {
      _tag: "Sleep",
      reason: "idle",
      interrupt: expired.flatMap((thread) =>
        thread.activeRunId === null
          ? []
          : [{ threadId: thread.threadId, runId: thread.activeRunId }],
      ),
    };
  }
  const readySinceMs = DateTime.toEpochMillis(input.record.updatedAt);
  const settled =
    policy.sleepOnSettle || input.record.discardOnSettle === true
      ? decideAutoSleep(threads, readySinceMs)
      : null;
  if (settled !== null) return sleep(settled);

  const next = activity.nextScheduledAt;
  // A run that came due counts as activity from then on, even before its thread shows it.
  const anchor = Math.max(
    readySinceMs,
    ...threads.map((thread) => thread.activityAt),
    activity.viewedAt ?? -Infinity,
    activity.terminalAt ?? -Infinity,
    next !== null && next <= nowMs ? next : -Infinity,
  );
  if (input.capPressure) {
    const pressureAt = anchor + CAP_PRESSURE_IDLE_MS;
    return nowMs >= pressureAt ? sleep("cap-pressure") : { _tag: "Awake", untilMs: pressureAt };
  }
  if (next !== null && next > nowMs && next < anchor + 2 * policy.idleMs) {
    return { _tag: "Awake", untilMs: next };
  }
  const idleAt = anchor + policy.idleMs;
  return nowMs >= idleAt ? sleep("idle") : { _tag: "Awake", untilMs: idleAt };
};

export type DiskExpiryReason = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "sandbox.expire" }
>["reason"];

const DAY_MS = 24 * 60 * 60_000;
const NEVER_EXPIRE: SandboxDiskRetention = { archivedAfterDays: null, asleepAfterDays: null };

/** The admin's retention, or the defaults; nothing expires in restore mode (04 §5). */
export const diskRetentionOf = (sandbox: SandboxSettings | undefined): SandboxDiskRetention =>
  sandbox?.restoreModeSince !== undefined
    ? NEVER_EXPIRE
    : (sandbox?.diskRetention ?? DEFAULT_DISK_RETENTION);

/**
 * No rule below comes due before this, so a sweep reads no threads for a machine stopped recently.
 * Infinity when retention is off.
 */
export const diskExpiryFloorMs = (
  record: OrchestrationV2Sandbox,
  retention: SandboxDiskRetention,
): number => {
  const days = [retention.archivedAfterDays, retention.asleepAfterDays].filter(
    (value) => value !== null,
  );
  return days.length === 0
    ? Infinity
    : DateTime.toEpochMillis(record.updatedAt) + Math.min(...days) * DAY_MS;
};

/**
 * When a stopped machine's disk is due to be destroyed and why, or null while no rule can come due
 * without an event. Both clocks also start no earlier than the record's last change (when it went
 * to sleep or failed), so a machine woken and used without a message is not destroyed early.
 */
export const decideDiskExpiry = (input: {
  readonly record: OrchestrationV2Sandbox;
  readonly threads: ReadonlyArray<SandboxAttachedThread>;
  readonly retention: SandboxDiskRetention;
}): { readonly reason: DiskExpiryReason; readonly atMs: number } | null => {
  const { record, threads, retention } = input;
  const hasDisk =
    record.state === "sleeping" || (record.state === "failed" && record.driverRef !== null);
  if (!hasDisk || threads.some((thread) => thread.activeRun)) return null;
  const sinceMs = DateTime.toEpochMillis(record.updatedAt);
  const due: Array<{ readonly reason: DiskExpiryReason; readonly atMs: number }> = [];
  if (
    record.state === "sleeping" &&
    retention.archivedAfterDays !== null &&
    threads.length > 0 &&
    threads.every((thread) => thread.archived)
  ) {
    const restingMs = Math.max(sinceMs, ...threads.map((thread) => thread.restingAt ?? sinceMs));
    due.push({ reason: "archived", atMs: restingMs + retention.archivedAfterDays * DAY_MS });
  }
  if (retention.asleepAfterDays !== null) {
    const activeMs = Math.max(sinceMs, ...threads.map((thread) => thread.activityAt));
    due.push({ reason: "inactive", atMs: activeMs + retention.asleepAfterDays * DAY_MS });
  }
  return due.reduce<(typeof due)[number] | null>(
    (first, next) => (first === null || next.atMs < first.atMs ? next : first),
    null,
  );
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
  readonly cloudOnly: boolean;
  readonly now: DateTime.Utc;
}): CloudPromptDecision => {
  const { record } = input;
  if (record === null) return { _tag: "Send" };
  if (record.state === "ready") {
    // Held until a cancel or the restart; the lifecycle sweep then releases it.
    return input.admission?.draining === true
      ? { _tag: "Defer", workspaceStrategy: undefined, wake: null }
      : { _tag: "Send" };
  }
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
    cloudOnly: input.cloudOnly,
    now: input.now,
  });
  // Provisioning and waking release their waiters on hello; nothing more to start.
  if (decision._tag === "NoOp" || record.state === "provisioning") {
    return { _tag: "Defer", workspaceStrategy: undefined, wake: null };
  }
  if (decision._tag === "Refuse") {
    return {
      _tag: "Refuse",
      message:
        decision.reason === "not-cloud-only"
          ? NOT_CLOUD_ONLY_MESSAGE
          : (record.failure?.message ?? "The machine is not running."),
    };
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
      ...(command.discardOnSettle === true ? { discardOnSettle: true } : {}),
      createdAt: now,
      updatedAt: now,
    },
    "sandbox.create",
    input.admission,
  );
};

/** 04 §1's state table for M1. */
const decide = (input: SandboxDecisionInput): SandboxDecision => {
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
        : update({ state: "sleeping", sleepReason: "manual", sleepSnapshotAt: null }, [
            "sandbox.stop",
          ]);
    case "sandbox.discard":
      if (record.state === "ready" && busy) return refuse("active-run");
      // Destroy stops a running sandbox too, so no separate stop effect.
      return record.state === "ready" || record.state === "sleeping" || record.state === "failed"
        ? update({ state: "destroyed" }, ["sandbox.destroy"])
        : refuse("wrong-state");
    case "sandbox.auto-sleep": {
      if (record.state !== "ready") return refuse("wrong-state");
      const nowMs = DateTime.toEpochMillis(now);
      if (input.attachedThreads.some((thread) => holdsMachine(thread, nowMs))) {
        return refuse("active-run");
      }
      const readySinceMs = DateTime.toEpochMillis(record.updatedAt);
      if (command.reason === "settled" || command.reason === "archived") {
        if (decideAutoSleep(input.attachedThreads, readySinceMs) !== command.reason) {
          return refuse("in-use");
        }
        // Destroy stops a running sandbox too, so no separate stop effect.
        if (record.discardOnSettle === true) {
          return update({ state: "destroyed" }, ["sandbox.destroy"]);
        }
      } else {
        // Used since the worker read it, so its idle clock restarted.
        const snapshotMs = DateTime.toEpochMillis(command.snapshotAt);
        if (
          readySinceMs > snapshotMs ||
          input.attachedThreads.some((thread) => thread.activityAt > snapshotMs)
        ) {
          return refuse("in-use");
        }
      }
      // Sleeping from the decision on, so a prompt before the stop runs wakes after it.
      return update({ state: "sleeping", sleepReason: command.reason, sleepSnapshotAt: null }, [
        "sandbox.stop",
      ]);
    }
    case "sandbox.expire": {
      if (record.state !== "sleeping" && record.state !== "failed") return refuse("wrong-state");
      // Waking it would make a new machine, which only a cloud-only server may do.
      if (!input.cloudOnly) return refuse("not-cloud-only");
      const expiry =
        input.diskRetention === undefined
          ? null
          : decideDiskExpiry({
              record,
              threads: input.attachedThreads,
              retention: input.diskRetention,
            });
      // The thread keeps its mirror refs, so it stays readable and a wake rebuilds from them.
      return expiry !== null && expiry.atMs <= DateTime.toEpochMillis(now)
        ? update({ state: "destroyed" }, ["sandbox.destroy"])
        : refuse("in-use");
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
      if (
        snapshot !== null &&
        (snapshot.draining || snapshot.running >= snapshot.cap || !snapshot.startAvailable)
      ) {
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
      if (record.state === "sleeping") {
        return command.sleepSnapshotAt === undefined
          ? noOp
          : update({ sleepSnapshotAt: command.sleepSnapshotAt });
      }
      // A failed sandbox keeps its failure; its backend stopping changes nothing.
      if (record.state === "failed") return noOp;
      // Stopped under us, so no snapshot of this sleep; an older one would mislabel the files.
      return record.state === "ready" || record.state === "waking"
        ? update({ state: "sleeping", runnerLostAt: null, sleepSnapshotAt: null })
        : refuse("wrong-state");
    case "sandbox.destroyed":
      return record.state === "destroyed" ? noOp : update({ state: "destroyed" });
    case "sandbox.failed":
      if (command.failure.code === "boot-timeout" || command.failure.code === "boot-stopped") {
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

/** A decision that would make a new machine is the launch gate's, and only cloud-only servers pass it. */
const createsMachine = (record: OrchestrationV2Sandbox | null, decision: SandboxDecision) =>
  decision._tag === "Accept" &&
  (decision.effects.some((effect) => effect.type === "sandbox.create") ||
    (decision.next.state === "provisioning" &&
      (record === null || decision.next.generation !== record.generation)));

/** 04 §1's state table, behind the launch gate. */
export const decideSandboxCommand = (input: SandboxDecisionInput): SandboxDecision => {
  const decision = decide(input);
  if (input.cloudOnly || !createsMachine(input.record, decision)) return decision;
  // A waiter left by an older server fails visibly, so its thread can discard it.
  if (input.command.type === "sandbox.admit" && input.record !== null) {
    return accept(
      {
        ...input.record,
        state: "failed",
        admission: null,
        failure: { code: "not-cloud-only", message: NOT_CLOUD_ONLY_MESSAGE, retryable: false },
        updatedAt: input.now,
      },
      ["sandbox.release-waiters"],
    );
  }
  return refuse("not-cloud-only");
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
