import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
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
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import { decideAutoSleep, sandboxAttachedThread } from "./SandboxDecisions.ts";
import { listLiveSandboxes } from "./SandboxProjection.ts";

const PROVISION_DEADLINE_MS = 10 * 60_000;
const WAKE_DEADLINE_MS = 5 * 60_000;

/** When a booting sandbox that never says hello fails; null for one with no deadline. */
const bootDeadlineMs = (sandbox: OrchestrationV2Sandbox): number | null => {
  const since = DateTime.toEpochMillis(sandbox.updatedAt);
  // Waiting for admission is not booting.
  if (sandbox.state === "provisioning" && sandbox.admission === null) {
    return since + PROVISION_DEADLINE_MS;
  }
  return sandbox.state === "waking" ? since + WAKE_DEADLINE_MS : null;
};

const affectsLifecycle = (event: OrchestrationV2DomainEvent) =>
  event.type === "sandbox.updated" ||
  event.type === "thread.settled" ||
  event.type === "thread.unsettled" ||
  event.type === "thread.archived" ||
  event.type === "thread.unarchived" ||
  event.type === "thread.deleted" ||
  event.type === "run.updated";

const freshCommandId = (kind: string, sandbox: OrchestrationV2Sandbox) =>
  Effect.sync(() =>
    CommandId.make(`server:sandbox-${kind}:${sandbox.id}:${SecureRandom.uuidV4Unsafe()}`),
  );

/** One sweep per call; the layer registers it with the scheduler. */
export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
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

  const shouldSleep = Effect.fn("SandboxLifecycleWorker.shouldSleep")(function* (
    sandbox: OrchestrationV2Sandbox,
  ) {
    const rows = yield* projections.listSandboxThreads(sandbox.id);
    const shells = yield* Effect.forEach(rows, (row) => projections.getThreadShell(row.threadId));
    return (
      decideAutoSleep(
        shells.flatMap((shell) => (shell === null ? [] : [sandboxAttachedThread(shell)])),
      ) !== null
    );
  });

  return Effect.fn("SandboxLifecycleWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const sandboxes = yield* listLiveSandboxes();
    // Only Docker stops on settle in M1; hosted drivers wait for idle sleep (2.1).
    const dockerDriverIds = sandboxes.some((sandbox) => sandbox.state === "ready")
      ? new Set(
          (yield* registry.list)
            .filter((driver) => driver.kind === "docker")
            .map((driver) => driver.driverId),
        )
      : new Set();
    let acted = false;
    let nextDueMs = Infinity;
    for (const sandbox of sandboxes) {
      if (sandbox.state === "ready" && dockerDriverIds.has(sandbox.driverId)) {
        if (!(yield* shouldSleep(sandbox))) continue;
        acted = true;
        yield* dispatch(sandbox, {
          type: "sandbox.auto-sleep",
          commandId: yield* freshCommandId("auto-sleep", sandbox),
          threadId: sandbox.ownerThreadId,
          sandboxId: sandbox.id,
          snapshotAt: now,
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
