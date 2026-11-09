import {
  CommandId,
  type ComputeDriverId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type RunId,
  type SandboxDiskRetention,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerDrain from "../../drain/ServerDrain.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as DueHint from "../../scheduling/DueHint.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ComputeDriver } from "../compute/ComputeDriver.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import * as LiveTeamImageBuild from "../image/LiveTeamImageBuild.ts";
import * as CheckpointMirror from "../mirror/CheckpointMirror.ts";
import * as SandboxActivity from "./SandboxActivity.ts";
import * as SandboxAdmission from "./SandboxAdmission.ts";
import {
  decideDiskExpiry,
  diskExpiryFloorMs,
  diskRetentionOf,
  idleDecision,
  SANDBOX_BACKEND_MISSING_FAILURE,
  sandboxAttachedThread,
} from "./SandboxDecisions.ts";
import { listLiveSandboxes } from "./SandboxProjection.ts";

const APPROVAL_EXPIRED_MESSAGE =
  "Stopped after 2 hours without an answer, so the machine could sleep. Send a message to continue.";

const PROVISION_DEADLINE_MS = 10 * 60_000;
const WAKE_DEADLINE_MS = 5 * 60_000;
/** How often a created machine's backend is asked whether it still runs, until its hello. */
const BOOT_CHECK_MS = 30_000;
const STATUS_BOUND = "10 seconds";

/** When a booting sandbox that never says hello fails; null for one with no deadline. */
const bootDeadlineMs = (sandbox: OrchestrationV2Sandbox): number | null => {
  // Waiting for admission is not booting; admitting it restarts `updatedAt`.
  if (sandbox.admission !== null) return null;
  const since = DateTime.toEpochMillis(sandbox.updatedAt);
  if (sandbox.state === "provisioning") return since + PROVISION_DEADLINE_MS;
  return sandbox.state === "waking" ? since + WAKE_DEADLINE_MS : null;
};

/** Ready machines sleep by their driver's policy; created, booting ones are checked through it. */
const needsDriver = (sandbox: OrchestrationV2Sandbox) =>
  sandbox.state === "ready" || (sandbox.state === "provisioning" && sandbox.driverRef !== null);

const affectsLifecycle = (event: OrchestrationV2DomainEvent) =>
  event.type === "sandbox.updated" ||
  event.type === "thread.settled" ||
  event.type === "thread.unsettled" ||
  event.type === "thread.archived" ||
  event.type === "thread.unarchived" ||
  event.type === "thread.deleted" ||
  event.type === "run.updated" ||
  // Questions, background work and messages end a busy machine's hold.
  event.type === "runtime-request.updated" ||
  event.type === "provider-thread.updated" ||
  event.type === "message.updated";

const freshCommandId = (kind: string, sandbox: OrchestrationV2Sandbox) =>
  Effect.sync(() =>
    CommandId.make(`server:sandbox-${kind}:${sandbox.id}:${SecureRandom.uuidV4Unsafe()}`),
  );

/** Each driver's waiters, oldest first. */
const admissionQueues = (sandboxes: ReadonlyArray<OrchestrationV2Sandbox>) => {
  const queues = new Map<ComputeDriverId, Array<OrchestrationV2Sandbox>>();
  const waiters = sandboxes
    .flatMap((sandbox) =>
      sandbox.admission === null
        ? []
        : [{ sandbox, sinceMs: DateTime.toEpochMillis(sandbox.admission.since) }],
    )
    .toSorted(
      (left, right) =>
        left.sinceMs - right.sinceMs || left.sandbox.id.localeCompare(right.sandbox.id),
    );
  for (const { sandbox } of waiters) {
    const queue = queues.get(sandbox.driverId);
    if (queue === undefined) queues.set(sandbox.driverId, [sandbox]);
    else queue.push(sandbox);
  }
  return queues;
};

/** One sweep per call; the layer registers it with the scheduler. */
export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
  const admission = yield* SandboxAdmission.SandboxAdmission;
  const activity = yield* SandboxActivity.SandboxActivity;
  const settings = yield* ServerSettingsService;
  const drain = yield* ServerDrain.ServerDrain;
  const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const mirror = yield* Effect.serviceOption(CheckpointMirror.CheckpointMirror);
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLifecycle(event) ? due.invalidate : Effect.void,
    ),
  );
  // A raised cap sends no event, and a full queue's hint never comes due on its own.
  const settingsChanges = yield* settings.subscribeChanges;
  yield* forkParked(Stream.runForEach(settingsChanges, () => due.invalidate));
  // A team image build frees its slot without a domain event.
  yield* forkParked(Stream.runForEach(liveBuild.changes, () => due.invalidate));
  // A cancel sends no domain event, so the first sweep after a drain runs even when idle.
  let sawDrain = false;

  // The decider re-checks each command under the owner's lock, so a race ends in a refusal.
  const dispatch = (sandbox: OrchestrationV2Sandbox, command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Sandbox lifecycle command was not applied", {
          sandboxId: sandbox.id,
          commandType: command.type,
          cause,
        }),
      ),
    );

  const attachedShells = Effect.fn("SandboxLifecycleWorker.attachedShells")(function* (
    sandbox: OrchestrationV2Sandbox,
  ) {
    const rows = yield* projections.listSandboxThreads(sandbox.id);
    const shells = yield* Effect.forEach(rows, (row) => projections.getThreadShell(row.threadId));
    return shells.filter((shell) => shell !== null);
  });

  /**
   * Releases runs a drain parked on a ready machine, which no hello will release. Uses the id
   * `releaseWaiters` uses, so the two dedupe; runs with a checkout to make are re-armed there.
   */
  const releaseHeld = Effect.fn("SandboxLifecycleWorker.releaseHeld")(function* (
    sandbox: OrchestrationV2Sandbox,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    let released = false;
    for (const shell of shells) {
      if (shell.activityRunStatus !== "preparing") continue;
      const { runs } = yield* projections.getThreadRecords(shell.id, ["runs"]);
      for (const run of runs) {
        if (run.status !== "preparing" || run.workspacePreparation !== undefined) continue;
        released = true;
        yield* dispatch(sandbox, {
          type: "prepared-run.release",
          commandId: CommandId.make(`sandbox-release:${run.id}:${sandbox.generation}`),
          threadId: shell.id,
          runId: run.id,
        });
      }
    }
    return released;
  });

  const idleFor = Effect.fn("SandboxLifecycleWorker.idleFor")(function* (
    sandbox: OrchestrationV2Sandbox,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    driver: ComputeDriver["Service"],
    capPressure: boolean,
    nowMs: number,
  ) {
    const threads = shells.map(sandboxAttachedThread);
    return idleDecision({
      record: sandbox,
      threads,
      activity: yield* activity.read(threads.map((thread) => thread.threadId)),
      policy: {
        idleMs: driver.capabilities.defaultIdleSleepMs,
        sleepOnSettle: driver.capabilities.sleepOnSettle,
      },
      capPressure,
      nowMs,
    });
  });

  /** Whether the mirror holds the branch of every thread with a checkout, which a wake rebuilds from. */
  const mirrored = Effect.fn("SandboxLifecycleWorker.mirrored")(
    function* (shells: ReadonlyArray<OrchestrationV2ThreadShell>) {
      if (Option.isNone(mirror)) return false;
      for (const shell of shells) {
        if (shell.worktreePath === null) continue;
        const ref = CheckpointMirror.sandboxBranchRef(shell.id);
        if (!(yield* mirror.value.tips(shell.projectId, [ref])).has(ref)) return false;
      }
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the mirror before a disk expiry", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  /** Destroys a stopped machine's disk that outlived retention, or says when to look again. */
  const expireDue = Effect.fn("SandboxLifecycleWorker.expireDue")(function* (
    sandbox: OrchestrationV2Sandbox,
    retention: SandboxDiskRetention,
    nowMs: number,
  ) {
    const floorMs = diskExpiryFloorMs(sandbox, retention);
    if (floorMs > nowMs) return { expired: false, nextDueMs: floorMs };
    const shells = yield* attachedShells(sandbox);
    const expiry = decideDiskExpiry({
      record: sandbox,
      threads: shells.map(sandboxAttachedThread),
      retention,
    });
    if (expiry === null) return { expired: false, nextDueMs: Infinity };
    if (expiry.atMs > nowMs) return { expired: false, nextDueMs: expiry.atMs };
    // Without the branch a wake could only check out from origin, losing unpushed work.
    if (!(yield* mirrored(shells))) {
      yield* Effect.logDebug("Kept a stopped machine's disk the mirror cannot rebuild", {
        sandboxId: sandbox.id,
      });
      return { expired: false, nextDueMs: Infinity };
    }
    yield* dispatch(sandbox, {
      type: "sandbox.expire",
      commandId: yield* freshCommandId("expire", sandbox),
      threadId: sandbox.ownerThreadId,
      sandboxId: sandbox.id,
      reason: expiry.reason,
    });
    return { expired: true, nextDueMs: Infinity };
  });

  /**
   * Fails a provisioning machine whose backend stopped before its hello; else when to ask again.
   * A wake is not checked: until its start runs, the ref names the container that was stopped.
   */
  const checkBoot = Effect.fn("SandboxLifecycleWorker.checkBoot")(function* (
    sandbox: OrchestrationV2Sandbox,
    driver: ComputeDriver["Service"] | undefined,
    nowMs: number,
  ) {
    if (sandbox.state !== "provisioning" || sandbox.driverRef === null || driver === undefined) {
      return { failed: false, nextDueMs: Infinity };
    }
    // `sandbox.created` set the ref once the container started, so `updatedAt` is the boot.
    const dueMs = DateTime.toEpochMillis(sandbox.updatedAt) + BOOT_CHECK_MS;
    if (dueMs > nowMs) return { failed: false, nextDueMs: dueMs };
    const backend = yield* driver.status(sandbox.driverRef).pipe(
      Effect.timeout(STATUS_BOUND),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check a booting machine's backend", {
          sandboxId: sandbox.id,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (backend === null || backend.status === "running" || backend.status === "starting") {
      return { failed: false, nextDueMs: nowMs + BOOT_CHECK_MS };
    }
    yield* dispatch(sandbox, {
      type: "sandbox.failed",
      commandId: yield* freshCommandId("boot-check", sandbox),
      threadId: sandbox.ownerThreadId,
      sandboxId: sandbox.id,
      generation: sandbox.generation,
      failure:
        backend.status === "missing"
          ? SANDBOX_BACKEND_MISSING_FAILURE
          : {
              code: "boot-stopped",
              message: "The machine stopped before it was ready.",
              retryable: true,
            },
    });
    return { failed: true, nextDueMs: Infinity };
  });

  /** Stops each run whose question outlived the hold; false if any could not be stopped. */
  const interruptExpired = Effect.fn("SandboxLifecycleWorker.interruptExpired")(function* (
    sandbox: OrchestrationV2Sandbox,
    runs: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
  ) {
    for (const { threadId, runId } of runs) {
      const stopped = yield* threads
        .dispatch({
          type: "run.interrupt",
          // Per run, so a repeat sweep replays this receipt.
          commandId: CommandId.make(`server:sandbox-approval-expiry:${runId}`),
          threadId,
          runId,
          reason: APPROVAL_EXPIRED_MESSAGE,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a run whose question expired", {
              sandboxId: sandbox.id,
              runId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!stopped) return false;
    }
    return true;
  });

  /**
   * Admits one driver's waiters in order while a slot and a start token are free, and says when
   * the queue can move next: at the next token, or never until a machine stops (an event).
   */
  const admitWaiters = Effect.fn("SandboxLifecycleWorker.admitWaiters")(function* (
    driverId: ComputeDriverId,
    queue: ReadonlyArray<OrchestrationV2Sandbox>,
  ) {
    // A cancel or the restart moves the queue.
    if ((yield* drain.current) !== null) return { admitted: 0, nextDueMs: Infinity };
    let admitted = 0;
    for (const sandbox of queue) {
      const snapshot = yield* admission.withLock(admission.snapshot(driverId));
      if (snapshot.running >= snapshot.cap) return { admitted, nextDueMs: Infinity };
      if (!snapshot.startAvailable) {
        const next = yield* admission.nextStartAt;
        return { admitted, nextDueMs: next === null ? Infinity : DateTime.toEpochMillis(next) };
      }
      // A refusal means another start took the slot or the token first; the next tick retries.
      const accepted = yield* threads
        .dispatch({
          type: "sandbox.admit",
          commandId: CommandId.make(
            `server:sandbox-admit:${sandbox.id}:${sandbox.generation}:${SecureRandom.uuidV4Unsafe()}`,
          ),
          threadId: sandbox.ownerThreadId,
          sandboxId: sandbox.id,
          generation: sandbox.generation,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logDebug("Sandbox admission was refused", { sandboxId: sandbox.id, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (!accepted) return { admitted, nextDueMs: Infinity };
      admitted++;
    }
    return { admitted, nextDueMs: Infinity };
  });

  return Effect.fn("SandboxLifecycleWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const draining = (yield* drain.current) !== null;
    const drainEnded = sawDrain && !draining;
    sawDrain = draining;
    if (!drainEnded && (yield* due.isIdle(nowMs))) return;
    const readVersion = yield* due.version;
    const sandboxes = yield* listLiveSandboxes();
    const drivers = sandboxes.some(needsDriver)
      ? new Map((yield* registry.list).map((driver) => [driver.driverId, driver]))
      : new Map<ComputeDriverId, ComputeDriver["Service"]>();
    const queues = admissionQueues(sandboxes);
    const retention = diskRetentionOf((yield* settings.getSettings).sandbox);
    let acted = false;
    let nextDueMs = Infinity;
    for (const [driverId, queue] of queues) {
      const result = yield* admitWaiters(driverId, queue);
      if (result.admitted > 0) acted = true;
      nextDueMs = Math.min(nextDueMs, result.nextDueMs);
    }
    for (const sandbox of sandboxes) {
      if (sandbox.state === "ready") {
        const shells = yield* attachedShells(sandbox);
        if (!draining && (yield* releaseHeld(sandbox, shells))) acted = true;
        const driver = drivers.get(sandbox.driverId);
        if (driver === undefined) continue;
        const decision = yield* idleFor(
          sandbox,
          shells,
          driver,
          queues.has(sandbox.driverId),
          nowMs,
        );
        if (decision._tag === "Busy") continue;
        if (decision._tag === "Awake") {
          nextDueMs = Math.min(nextDueMs, decision.untilMs);
          continue;
        }
        acted = true;
        if (!(yield* interruptExpired(sandbox, decision.interrupt))) continue;
        yield* dispatch(sandbox, {
          type: "sandbox.auto-sleep",
          commandId: yield* freshCommandId("auto-sleep", sandbox),
          threadId: sandbox.ownerThreadId,
          sandboxId: sandbox.id,
          snapshotAt: now,
          reason: decision.reason,
        });
        continue;
      }
      if (sandbox.state === "sleeping" || sandbox.state === "failed") {
        if (!cloudOnly) continue;
        const expiry = yield* expireDue(sandbox, retention, nowMs);
        if (expiry.expired) acted = true;
        nextDueMs = Math.min(nextDueMs, expiry.nextDueMs);
        continue;
      }
      const deadlineMs = bootDeadlineMs(sandbox);
      if (deadlineMs === null) continue;
      if (deadlineMs > nowMs) {
        const check = yield* checkBoot(sandbox, drivers.get(sandbox.driverId), nowMs);
        if (check.failed) acted = true;
        nextDueMs = Math.min(nextDueMs, check.nextDueMs, deadlineMs);
        continue;
      }
      acted = true;
      yield* dispatch(sandbox, {
        type: "sandbox.failed",
        commandId: yield* freshCommandId("deadline", sandbox),
        threadId: sandbox.ownerThreadId,
        sandboxId: sandbox.id,
        generation: sandbox.generation,
        failure: {
          code: "boot-timeout",
          message: "The machine did not connect in time.",
          retryable: true,
        },
      });
    }
    // A sweep that acted re-checks on the next tick.
    if (acted) return;
    yield* due.record(readVersion, nextDueMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("sandbox-lifecycle", sweep());
  }),
);
