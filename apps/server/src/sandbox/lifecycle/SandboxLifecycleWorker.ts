import {
  CommandId,
  type ComputeDriverId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as DueHint from "../../scheduling/DueHint.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";
import type { ComputeDriver } from "../compute/ComputeDriver.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import * as SandboxActivity from "./SandboxActivity.ts";
import * as SandboxAdmission from "./SandboxAdmission.ts";
import { idleDecision, sandboxAttachedThread } from "./SandboxDecisions.ts";
import { listLiveSandboxes } from "./SandboxProjection.ts";

const APPROVAL_EXPIRED_MESSAGE =
  "Stopped after 2 hours without an answer, so the machine could sleep. Send a message to continue.";

const PROVISION_DEADLINE_MS = 10 * 60_000;
const WAKE_DEADLINE_MS = 5 * 60_000;

/** When a booting sandbox that never says hello fails; null for one with no deadline. */
const bootDeadlineMs = (sandbox: OrchestrationV2Sandbox): number | null => {
  // Waiting for admission is not booting; admitting it restarts `updatedAt`.
  if (sandbox.admission !== null) return null;
  const since = DateTime.toEpochMillis(sandbox.updatedAt);
  if (sandbox.state === "provisioning") return since + PROVISION_DEADLINE_MS;
  return sandbox.state === "waking" ? since + WAKE_DEADLINE_MS : null;
};

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
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLifecycle(event) ? due.invalidate : Effect.void,
    ),
  );

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

  const idleFor = Effect.fn("SandboxLifecycleWorker.idleFor")(function* (
    sandbox: OrchestrationV2Sandbox,
    driver: ComputeDriver["Service"],
    capPressure: boolean,
    nowMs: number,
  ) {
    const rows = yield* projections.listSandboxThreads(sandbox.id);
    const shells = yield* Effect.forEach(rows, (row) => projections.getThreadShell(row.threadId));
    const threads = shells.flatMap((shell) =>
      shell === null ? [] : [sandboxAttachedThread(shell)],
    );
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
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const sandboxes = yield* listLiveSandboxes();
    const drivers = sandboxes.some((sandbox) => sandbox.state === "ready")
      ? new Map((yield* registry.list).map((driver) => [driver.driverId, driver]))
      : new Map<ComputeDriverId, ComputeDriver["Service"]>();
    const queues = admissionQueues(sandboxes);
    let acted = false;
    let nextDueMs = Infinity;
    for (const [driverId, queue] of queues) {
      const result = yield* admitWaiters(driverId, queue);
      if (result.admitted > 0) acted = true;
      nextDueMs = Math.min(nextDueMs, result.nextDueMs);
    }
    for (const sandbox of sandboxes) {
      if (sandbox.state === "ready") {
        const driver = drivers.get(sandbox.driverId);
        if (driver === undefined) continue;
        const decision = yield* idleFor(sandbox, driver, queues.has(sandbox.driverId), nowMs);
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
      const deadlineMs = bootDeadlineMs(sandbox);
      if (deadlineMs === null) continue;
      if (deadlineMs > nowMs) {
        nextDueMs = Math.min(nextDueMs, deadlineMs);
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
