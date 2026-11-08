import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  type SandboxId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  type BackendSandbox,
  type ComputeDriver,
  type ComputeDriverError,
  sandboxBackendName,
} from "../compute/ComputeDriver.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import { SANDBOX_BACKEND_MISSING } from "./SandboxDecisions.ts";
import { getSandboxes, listLiveSandboxes } from "./SandboxProjection.ts";

export type ReconcileAction =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "ReportStopped" }
  | { readonly _tag: "ReportLost"; readonly retryable: boolean }
  | { readonly _tag: "ReportCreated"; readonly driverRef: string }
  | { readonly _tag: "StopBackend" }
  | { readonly _tag: "DestroyBackend" };

interface ReconcilePair {
  readonly record: OrchestrationV2Sandbox | null;
  readonly backend: BackendSandbox | null;
}

const RECONCILE_INTERVAL_MS = 10 * 60_000;
/** A backend younger than this may belong to a create whose record has not committed yet. */
const ORPHAN_GRACE_MS = 5 * 60_000;
const DRIVER_CALL_TIMEOUT = Duration.seconds(60);

const keep: ReconcileAction = { _tag: "Keep" };

/**
 * A backend pairs with the record holding its `driverRef`, or, for a record with none yet, the
 * record whose current backend name it carries. Any other backend is a stray; a live record left
 * without a backend is missing.
 */
export const pairBackends = (
  records: ReadonlyArray<OrchestrationV2Sandbox>,
  backends: ReadonlyArray<BackendSandbox>,
  installId: EnvironmentId,
): ReadonlyArray<ReconcilePair> => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const paired = new Set<SandboxId>();
  const pairs = backends.map((backend): ReconcilePair => {
    const record = backend.sandboxId === null ? undefined : byId.get(backend.sandboxId);
    const matches =
      record !== undefined &&
      (record.driverRef === null
        ? backend.name === sandboxBackendName(installId, record.id, record.generation)
        : backend.driverRef === record.driverRef);
    if (!matches) return { record: null, backend };
    paired.add(record.id);
    return { record, backend };
  });
  const missing = records
    .filter((record) => record.state !== "destroyed" && !paired.has(record.id))
    .map((record): ReconcilePair => ({ record, backend: null }));
  return [...pairs, ...missing];
};

const isRunning = (backend: BackendSandbox | null) =>
  backend?.status === "running" || backend?.status === "starting";
const isGone = (backend: BackendSandbox | null) =>
  backend === null || backend.status === "missing" || backend.status === "failed";

/** 04 §5's table. Only a backend nothing will use again is destroyed, and never a young one. */
export const planReconciliation = (
  record: OrchestrationV2Sandbox | null,
  backend: BackendSandbox | null,
  now: DateTime.Utc,
): ReconcileAction => {
  if (
    record === null ||
    record.state === "destroyed" ||
    (record.state === "failed" && record.failure?.retryable !== true)
  ) {
    if (backend === null || backend.status === "missing") return keep;
    const ageMs = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(backend.createdAt);
    return ageMs > ORPHAN_GRACE_MS ? { _tag: "DestroyBackend" } : keep;
  }
  // The create's answer was lost (or the runner's hello beat it): adopt the backend found by name.
  if (record.driverRef === null && backend !== null && backend.status !== "missing") {
    return { _tag: "ReportCreated", driverRef: backend.driverRef };
  }
  switch (record.state) {
    case "ready":
      if (isRunning(backend)) return keep;
      return isGone(backend) ? { _tag: "ReportLost", retryable: true } : { _tag: "ReportStopped" };
    case "waking":
      return isGone(backend) ? { _tag: "ReportLost", retryable: true } : keep;
    case "provisioning":
      // A requeued create is idempotent, and the boot deadline catches a backend that died.
      return keep;
    case "sleeping":
      if (isRunning(backend)) return { _tag: "StopBackend" };
      return backend === null || backend.status === "missing"
        ? { _tag: "ReportLost", retryable: false }
        : keep;
    case "failed":
      // Retryable: keep the disk for Retry, but free the CPU.
      return isRunning(backend) ? { _tag: "StopBackend" } : keep;
  }
};

const make = Effect.gen(function* () {
  const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const report = (record: OrchestrationV2Sandbox, command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Sandbox reconciliation report was not applied", {
          sandboxId: record.id,
          commandType: command.type,
          cause,
        }),
      ),
    );

  const guardedCommandId = (record: OrchestrationV2Sandbox) =>
    Effect.sync(() =>
      CommandId.make(`server:sandbox-reconcile:${record.id}:${SecureRandom.uuidV4Unsafe()}`),
    );

  const callDriver = (
    effect: Effect.Effect<void, ComputeDriverError>,
    details: { readonly operation: string; readonly driverRef: string },
  ) =>
    effect.pipe(
      Effect.timeout(DRIVER_CALL_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("Sandbox reconciliation driver call failed", { ...details, cause }),
      ),
    );

  const execute = Effect.fn("SandboxReconciler.execute")(function* (
    driver: ComputeDriver["Service"],
    pair: ReconcilePair,
    action: ReconcileAction,
  ) {
    const { record, backend } = pair;
    switch (action._tag) {
      case "Keep":
        return;
      case "DestroyBackend":
        if (backend === null) return;
        yield* Effect.logInfo("Destroying an unused sandbox backend", {
          driverRef: backend.driverRef,
          sandboxId: record?.id ?? backend.sandboxId,
        });
        return yield* callDriver(driver.destroy(backend.driverRef), {
          operation: "destroy",
          driverRef: backend.driverRef,
        });
    }
    if (record === null) return;
    const generationFields = {
      threadId: record.ownerThreadId,
      sandboxId: record.id,
      generation: record.generation,
    };
    switch (action._tag) {
      case "ReportCreated":
        // The id the create effect uses, so whichever lands second is dropped by its receipt.
        return yield* report(record, {
          type: "sandbox.created",
          commandId: CommandId.make(`sandbox-created:${record.id}:${record.generation}`),
          ...generationFields,
          driverRef: action.driverRef,
        });
      case "ReportStopped":
        return yield* report(record, {
          type: "sandbox.stopped",
          commandId: yield* guardedCommandId(record),
          ...generationFields,
        });
      case "ReportLost":
        return yield* report(record, {
          type: "sandbox.failed",
          commandId: yield* guardedCommandId(record),
          ...generationFields,
          failure: {
            code: action.retryable ? "lost" : SANDBOX_BACKEND_MISSING,
            message: action.retryable
              ? "The machine stopped and its runner did not come back."
              : "The machine and its disk are gone.",
            retryable: action.retryable,
          },
        });
      case "StopBackend": {
        if (backend === null) return;
        // Under the owner's lock, so a wake that just committed cannot be stopped from under it.
        return yield* threadLocks.withLock(
          record.ownerThreadId,
          Effect.gen(function* () {
            const current = yield* projections.getSandbox(record.id);
            if (
              current === null ||
              current.generation !== record.generation ||
              current.driverRef !== backend.driverRef ||
              (current.state !== "sleeping" && current.state !== "failed")
            ) {
              return;
            }
            yield* callDriver(driver.stop(backend.driverRef), {
              operation: "stop",
              driverRef: backend.driverRef,
            });
          }),
        );
      }
    }
  });

  const reconcileDriver = Effect.fn("SandboxReconciler.reconcileDriver")(function* (
    driver: ComputeDriver["Service"],
    liveRecords: ReadonlyArray<OrchestrationV2Sandbox>,
    installId: EnvironmentId,
  ) {
    const backends = yield* driver.list({ "pair.install": installId });
    const listedIds = backends.flatMap((backend) =>
      backend.sandboxId === null ? [] : [backend.sandboxId],
    );
    const records = new Map(
      liveRecords
        .filter((record) => record.driverId === driver.driverId)
        .map((record) => [record.id, record]),
    );
    for (const [id, record] of yield* getSandboxes(listedIds)) records.set(id, record);
    const now = yield* DateTime.now;
    for (const pair of pairBackends(Array.from(records.values()), backends, installId)) {
      yield* execute(driver, pair, planReconciliation(pair.record, pair.backend, now));
    }
    // Docker re-ensures its private-network block here (1.14).
    yield* driver.health.pipe(
      Effect.timeout(DRIVER_CALL_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("Sandbox driver health check failed", {
          driverId: driver.driverId,
          cause,
        }),
      ),
    );
  });

  return Effect.fn("SandboxReconciler.reconcileOnce")(function* () {
    const installId = yield* environment.getEnvironmentId;
    const drivers = yield* registry.list;
    const liveRecords = yield* listLiveSandboxes();
    const configured = new Set(drivers.map((driver) => driver.driverId));
    for (const record of liveRecords) {
      if (configured.has(record.driverId)) continue;
      yield* Effect.logWarning("Skipping a sandbox whose compute driver is not configured", {
        sandboxId: record.id,
        driverId: record.driverId,
      });
    }
    for (const driver of drivers) {
      yield* reconcileDriver(driver, liveRecords, installId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sandbox reconciliation failed for a driver", {
            driverId: driver.driverId,
            cause,
          }),
        ),
      );
    }
  });
});

/** The scheduler starts sources after startup recovery, so the first pass follows the requeue. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconcileOnce = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    const nextRunAt = yield* Ref.make(0);
    yield* scheduler.register(
      "sandbox-reconciler",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < (yield* Ref.get(nextRunAt))) return;
        yield* Ref.set(nextRunAt, now + RECONCILE_INTERVAL_MS);
        yield* reconcileOnce();
      }),
    );
  }),
);
