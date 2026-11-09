import {
  CommandId,
  NonNegativeInt,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  SandboxId,
  type SandboxFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import * as ServerDrain from "../../drain/ServerDrain.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as CheckpointService from "../../orchestration-v2/CheckpointService.ts";
import {
  EffectOutboxV2,
  type OrchestrationEffectRequestV2,
} from "../../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  type ComputeDriver,
  ComputeDriverError,
  sandboxBackendName,
  sandboxTags,
} from "../compute/ComputeDriver.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";
import * as SandboxCredentialRevocation from "../credentials/SandboxCredentialRevocation.ts";
import * as TeamImageStore from "../image/TeamImageStore.ts";
import * as RunnerBundle from "../runnerHub/RunnerBundle.ts";
import * as RunnerEndpoint from "../runnerHub/RunnerEndpoint.ts";
import { sandboxSnapshotRef, snapshotNamers } from "../mirror/CheckpointMirror.ts";
import * as MirrorSyncWorker from "../mirror/MirrorSyncWorker.ts";
import * as SandboxBootstrapSource from "./SandboxBootstrapSource.ts";
import { SANDBOX_BACKEND_MISSING_FAILURE, type SandboxEffectRequest } from "./SandboxDecisions.ts";

const SandboxEffectOperation = Schema.Literals([
  "create",
  "start",
  "stop",
  "destroy",
  "status",
  "report",
]);
type SandboxEffectOperation = typeof SandboxEffectOperation.Type;

export class SandboxEffectError extends Schema.TaggedError<SandboxEffectError>()(
  "SandboxEffectError",
  {
    sandboxId: SandboxId,
    operation: SandboxEffectOperation,
    retryable: Schema.Boolean,
    retryAfterMs: Schema.optionalKey(NonNegativeInt),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sandbox ${this.sandboxId} failed to ${this.operation}.`;
  }
}

const isSandboxEffectError = Schema.is(SandboxEffectError);
const isComputeDriverError = Schema.is(ComputeDriverError);
const isDriverNotConfigured = Schema.is(ComputeDriverRegistry.ComputeDriverNotConfiguredError);
const isBootstrapUnavailable = Schema.is(SandboxBootstrapSource.SandboxBootstrapUnavailableError);
const isRunnerBundleUnavailable = Schema.is(RunnerBundle.RunnerBundleUnavailableError);
const isRunnerRouteError = Schema.is(RunnerEndpoint.RunnerRouteError);

export const isSandboxEffectRequest = (
  request: OrchestrationEffectRequestV2,
): request is SandboxEffectRequest =>
  // `sandbox.mirror.forget-thread` shares the prefix but is a thread's effect, not a driver call.
  request.type.startsWith("sandbox.") && "generation" in request;

type DriverEffectRequest = Exclude<
  SandboxEffectRequest,
  { readonly type: "sandbox.release-waiters" | "sandbox.request-wake" }
>;

const isDriverEffectRequest = (request: SandboxEffectRequest): request is DriverEffectRequest =>
  request.type !== "sandbox.release-waiters" && request.type !== "sandbox.request-wake";

export class SandboxEffects extends Context.Service<
  SandboxEffects,
  {
    /** Bounded by the effect worker; a stale generation succeeds without calling the driver. */
    readonly execute: (request: SandboxEffectRequest) => Effect.Effect<void, SandboxEffectError>;
    /** The worker calls this once, after the last attempt failed, outside the bound. */
    readonly reportExhausted: (
      request: SandboxEffectRequest,
      cause: Cause.Cause<unknown>,
    ) => Effect.Effect<void>;
    /** Runs on the deleted owner's queue; a replay finds the record already moved. */
    readonly handOver: (input: {
      readonly sandboxId: SandboxId;
      readonly fromThreadId: ThreadId;
    }) => Effect.Effect<void, SandboxEffectError>;
  }
>()("t3/sandbox/lifecycle/SandboxEffects") {}

const DRIVER_RETRY = { schedule: Schedule.spaced("2 seconds"), times: 3 } as const;
const SNAPSHOT_TIMEOUT = Duration.seconds(15);

const operationOf = (type: DriverEffectRequest["type"]) =>
  type.slice("sandbox.".length) as Exclude<SandboxEffectOperation, "report">;

/** The worker wraps executor failures, so the sandbox error sits somewhere down the cause chain. */
const sandboxErrorIn = (cause: Cause.Cause<unknown>): SandboxEffectError | undefined => {
  let current: unknown = Option.getOrUndefined(Cause.findErrorOption(cause));
  while (current !== null && typeof current === "object") {
    if (isSandboxEffectError(current)) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
};

const failureFor = (
  request: DriverEffectRequest,
  error: SandboxEffectError | undefined,
): SandboxFailure => {
  const operation = operationOf(request.type);
  const code = `${operation}-failed`;
  if (error === undefined) {
    return { code, message: `The machine did not answer in time (${operation}).`, retryable: true };
  }
  if (isDriverNotConfigured(error.cause)) {
    return {
      code: "driver-removed",
      message: "This machine's compute driver is no longer configured in Settings.",
      retryable: false,
    };
  }
  return {
    code,
    message:
      isComputeDriverError(error.cause) ||
      isBootstrapUnavailable(error.cause) ||
      isRunnerBundleUnavailable(error.cause) ||
      isRunnerRouteError(error.cause)
        ? error.cause.message
        : error.message,
    retryable: error.retryable,
  };
};

interface SandboxSleepHooksShape {
  /** Runs once the machine's work is saved and before the driver stops it. */
  readonly beforeSleep: (input: {
    readonly sandboxId: SandboxId;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<void>;
}

/** A Reference with a no-op default, so lifecycle tests need no terminal manager. */
export const SandboxSleepHooks = Context.Reference<SandboxSleepHooksShape>(
  "t3/sandbox/lifecycle/SandboxEffects/SandboxSleepHooks",
  { defaultValue: () => ({ beforeSleep: () => Effect.void }) },
);

const make = Effect.gen(function* () {
  const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
  const bootstraps = yield* SandboxBootstrapSource.SandboxBootstrapSource;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const outbox = yield* EffectOutboxV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const credentials = yield* SandboxCredentialRevocation.SandboxCredentialRevocation;
  const drain = yield* ServerDrain.ServerDrain;
  const teamImages = yield* TeamImageStore.TeamImageStore;
  // The server provides it; lifecycle tests run without a mirror.
  const mirrorSync = yield* Effect.serviceOption(MirrorSyncWorker.MirrorSyncWorker);
  const checkpoints = yield* Effect.serviceOption(CheckpointService.CheckpointServiceV2);
  const sleepHooks = yield* SandboxSleepHooks;

  // The server provides it; without it a re-armed checkout waits for the next restart's recovery.
  const threadLaunch = yield* Effect.serviceOption(ThreadLaunch.ThreadLaunchService);

  /** The record when this request's generation is still current, otherwise null. */
  const currentRecord = Effect.fn("SandboxEffects.currentRecord")(function* (
    request: SandboxEffectRequest,
  ) {
    const record = yield* projections.getSandbox(request.sandboxId).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxEffectError({
            sandboxId: request.sandboxId,
            operation: isDriverEffectRequest(request) ? operationOf(request.type) : "report",
            retryable: true,
            cause,
          }),
      ),
    );
    if (record === null || record.generation !== request.generation) return null;
    // A wake on a destroyed record provisions a new machine.
    if (
      record.state === "destroyed" &&
      request.type !== "sandbox.destroy" &&
      request.type !== "sandbox.request-wake"
    ) {
      return null;
    }
    return record;
  });

  // Receipts drop a replayed report; one the decider already rejected was delivered too.
  const report = (record: OrchestrationV2Sandbox, command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
      Effect.mapError(
        (cause) =>
          new SandboxEffectError({
            sandboxId: record.id,
            operation: "report",
            retryable: true,
            cause,
          }),
      ),
    );

  /** Only after the driver accepted, so a stop that fails leaves the sandbox usable. */
  const revokeCredentials = Effect.fn("SandboxEffects.revokeCredentials")(
    function* (record: OrchestrationV2Sandbox, _operation: "stop" | "destroy" | "status") {
      const attached = yield* projections.listSandboxThreads(record.id);
      const threadIds = new Set([record.ownerThreadId, ...attached.map((row) => row.threadId)]);
      yield* credentials.revoke({ sandboxId: record.id, threadIds: [...threadIds] });
    },
    (effect, record, operation) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new SandboxEffectError({ sandboxId: record.id, operation, retryable: true, cause }),
        ),
      ),
  );

  /** The capture instant once every attached checkout's working tree is in the mirror, else null. */
  const snapshotBeforeSleep = Effect.fn("SandboxEffects.snapshotBeforeSleep")(
    function* (record: OrchestrationV2Sandbox) {
      if (Option.isNone(checkpoints) || Option.isNone(mirrorSync)) return null;
      const rows = yield* projections.listSandboxThreads(record.id);
      const threads: Array<{ threadId: ThreadId; worktreePath: string | null }> = [];
      for (const threadId of new Set([record.ownerThreadId, ...rows.map((row) => row.threadId)])) {
        const worktreePath = (yield* projections.getThreadShell(threadId))?.worktreePath ?? null;
        threads.push({ threadId, worktreePath });
      }
      const namers = snapshotNamers(record.ownerThreadId, threads);
      if (namers.size === 0) return null;
      const capturedAt = yield* DateTime.now;
      const synced = yield* Effect.forEach(
        namers,
        ([cwd, threadId]) => {
          const ref = sandboxSnapshotRef(threadId);
          return checkpoints.value.captureSnapshot({ cwd, ref }).pipe(
            Effect.flatMap((status) =>
              status === "ready"
                ? mirrorSync.value.syncRefs({
                    threadId,
                    cwd,
                    checkpointRefs: [ref],
                    recordHead: true,
                  })
                : Effect.succeed(false),
            ),
          );
        },
        { concurrency: "unbounded" },
      );
      return synced.every(Boolean) ? capturedAt : null;
    },
    Effect.timeoutOption(SNAPSHOT_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning(
            "The working-tree snapshot timed out; the machine sleeps without it",
          ).pipe(Effect.as(null)),
        onSome: Effect.succeed,
      }),
    ),
    // Never fails the stop: the sleep goes ahead and reads fall back to checkpoints.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.succeed(null)
        : Effect.logWarning("Could not snapshot the machine's working tree", cause).pipe(
            Effect.as(null),
          ),
    ),
  );

  const generationFields = (record: OrchestrationV2Sandbox) => ({
    threadId: record.ownerThreadId,
    sandboxId: record.id,
    generation: record.generation,
  });

  // A run another path already released or failed refuses with a receipt; that is not a failure.
  const releaseOne = (record: OrchestrationV2Sandbox, command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        OrchestratorDispatchError: (cause) =>
          Effect.logWarning("A parked run was no longer waiting on its machine", { cause }),
      }),
      Effect.mapError(
        (cause) =>
          new SandboxEffectError({
            sandboxId: record.id,
            operation: "report",
            retryable: true,
            cause,
          }),
      ),
    );

  /**
   * Runs parked on this machine: on `ready` those with no checkout to make are released and those
   * with one are re-armed (a no-op while a fiber prepares them); on `failed` the former fail.
   * Parked restores then run: on `failed` they fail on the unavailable host with its message.
   * On `ready`, every other thread's checkout is brought back if the machine came up without it.
   */
  const releaseWaiters = Effect.fn("SandboxEffects.releaseWaiters")(function* (
    record: OrchestrationV2Sandbox,
  ) {
    if (record.state !== "ready" && record.state !== "failed") return;
    const fail = (cause: unknown) =>
      new SandboxEffectError({ sandboxId: record.id, operation: "report", retryable: true, cause });
    const rows = yield* projections.listSandboxThreads(record.id).pipe(Effect.mapError(fail));
    // A drain holds new turns; the lifecycle sweep releases these after a cancel or the restart.
    const holding = record.state === "ready" && (yield* drain.current) !== null;
    for (const { threadId } of rows) {
      const { runs } = yield* projections
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError(fail));
      let rearmed = false;
      for (const run of runs) {
        if (run.status !== "preparing") continue;
        const commandId = CommandId.make(`sandbox-release:${run.id}:${record.generation}`);
        if (run.workspacePreparation !== undefined) {
          if (record.state === "ready" && Option.isSome(threadLaunch)) {
            rearmed = true;
            yield* threadLaunch.value.prepareRun({
              commandId: CommandId.make(`sandbox-rearm:${run.id}:${record.generation}`),
              threadId,
              runId: run.id,
            });
          }
          continue;
        }
        if (holding) continue;
        yield* releaseOne(
          record,
          record.state === "ready"
            ? { type: "prepared-run.release", commandId, threadId, runId: run.id }
            : {
                type: "prepared-run.fail",
                commandId,
                threadId,
                runId: run.id,
                failure: makeProviderFailure({
                  cause: record.failure,
                  message: record.failure?.message ?? "The machine failed to start.",
                  class: "validation_error",
                  retryable: record.failure?.retryable ?? false,
                }),
              },
        );
      }
      // A re-armed run makes its own checkout; a kept disk costs this one check.
      if (record.state === "ready" && !rearmed && Option.isSome(threadLaunch)) {
        yield* threadLaunch.value.restoreCheckout({
          commandId: CommandId.make(`sandbox-restore:${threadId}:${record.generation}`),
          threadId,
        });
      }
    }
    yield* outbox
      .expedite({
        threadIds: rows.map(({ threadId }) => threadId),
        effectTypes: ["provider-thread.rollback"],
      })
      .pipe(Effect.mapError(fail));
  });

  const driverFor = Effect.fn("SandboxEffects.driverFor")(function* (
    record: OrchestrationV2Sandbox,
    operation: Exclude<SandboxEffectOperation, "report">,
  ) {
    const fail = (retryable: boolean, retryAfterMs?: number) => (cause: unknown) =>
      new SandboxEffectError({
        sandboxId: record.id,
        operation,
        retryable,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        cause,
      });
    // A removed driver stays removed; a settings read may succeed next time.
    const driver = yield* registry
      .get(record.driverId)
      .pipe(Effect.mapError((cause) => fail(!isDriverNotConfigured(cause))(cause)));
    // A hinted error leaves at once: the outbox waits it out without holding a worker slot.
    const call = <A>(effect: Effect.Effect<A, ComputeDriverError>) =>
      effect.pipe(
        Effect.retry({
          ...DRIVER_RETRY,
          while: (error) => error.retryable && error.retryAfterMs === undefined,
        }),
        Effect.mapError((error) => fail(error.retryable, error.retryAfterMs)(error)),
      );
    const callIgnoringMissing = (effect: Effect.Effect<void, ComputeDriverError>) =>
      call(
        effect.pipe(
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.void,
          ),
        ),
      );
    return { fail, driver, call, callIgnoringMissing };
  });

  /**
   * The record's team build, else the base. GC keeps the build of every machine that is not
   * destroyed, so a collected one means a discarded machine came back; it boots the base, and
   * `sandbox.created` then drops the build from the record.
   */
  const bootImage = Effect.fn("SandboxEffects.bootImage")(function* (
    record: OrchestrationV2Sandbox,
  ) {
    const base = { type: "base" } as const;
    if (record.imageBuild === undefined) return base;
    const stored = yield* teamImages.build(record.imageBuild.id);
    const build = Option.isSome(stored) ? stored.value.build : null;
    if (build?.imageRef !== undefined && build.imageDeletedAt === null) {
      return { type: "build", imageRef: build.imageRef } as const;
    }
    yield* Effect.logWarning("A machine's team build was removed; it boots the base image", {
      sandboxId: record.id,
      imageBuildId: record.imageBuild.id,
    });
    return base;
  });

  const execute: SandboxEffects["Service"]["execute"] = Effect.fn("SandboxEffects.execute")(
    function* (request) {
      const record = yield* currentRecord(request);
      if (record === null) return;
      if (request.type === "sandbox.release-waiters") return yield* releaseWaiters(record);
      if (request.type === "sandbox.request-wake") {
        // Receipts match one thread, so the id names the owner; a moved owner fails and retries.
        return yield* report(record, {
          type: "sandbox.wake",
          commandId: CommandId.make(
            `sandbox-wake:${record.id}:${record.ownerThreadId}:${record.generation}`,
          ),
          threadId: record.ownerThreadId,
          sandboxId: record.id,
        });
      }
      const { fail, driver, call, callIgnoringMissing } = yield* driverFor(
        record,
        operationOf(request.type),
      );
      const bootstrap = bootstraps
        .forGeneration({
          sandboxId: record.id,
          generation: record.generation,
          driverId: record.driverId,
        })
        .pipe(Effect.mapError(fail(false)));

      switch (request.type) {
        case "sandbox.create": {
          const installId = yield* environment.getEnvironmentId;
          const image = yield* bootImage(record).pipe(Effect.mapError(fail(true)));
          const created = yield* call(
            driver.create({
              name: sandboxBackendName(installId, record.id, record.generation),
              sandboxId: record.id,
              generation: record.generation,
              image,
              size: record.size,
              tags: sandboxTags({
                installId,
                sandboxId: record.id,
                generation: record.generation,
                driverId: record.driverId,
              }),
              bootstrap: yield* bootstrap,
            }),
          );
          return yield* report(record, {
            type: "sandbox.created",
            commandId: CommandId.make(`sandbox-created:${record.id}:${record.generation}`),
            ...generationFields(record),
            driverRef: created.driverRef,
            ...(created.baseImage === null ? {} : { baseImage: created.baseImage }),
          });
        }
        case "sandbox.start": {
          const driverRef = yield* requireDriverRef(record, fail);
          // The runner's hello marks it ready; nothing to report here.
          const started = yield* call(
            driver.start(driverRef, yield* bootstrap).pipe(
              Effect.as(true),
              Effect.catchIf(
                (error) => error.reason === "not-found",
                () => Effect.succeed(false),
              ),
            ),
          );
          if (started) return;
          return yield* reportMissing(record);
        }
        case "sandbox.stop": {
          // A boot-timeout stop (`failed`) has no work to keep.
          const sleepSnapshotAt =
            record.state === "sleeping" ? yield* snapshotBeforeSleep(record) : null;
          // A settled thread's last diff must be in the mirror before its disk goes away.
          if (Option.isSome(mirrorSync)) yield* mirrorSync.value.flush(record.id);
          // Terminals record the stop now, so the reason never races the runner's disconnect.
          if (record.state === "sleeping") {
            yield* sleepHooks.beforeSleep({ sandboxId: record.id, at: yield* DateTime.now });
          }
          if (record.driverRef !== null) yield* callIgnoringMissing(driver.stop(record.driverRef));
          yield* revokeCredentials(record, "stop");
          return yield* report(record, {
            type: "sandbox.stopped",
            commandId: CommandId.make(`sandbox-stopped:${record.id}:${record.generation}`),
            ...generationFields(record),
            ...(sleepSnapshotAt === null ? {} : { sleepSnapshotAt }),
          });
        }
        case "sandbox.destroy":
          return yield* destroy(record, driver, callIgnoringMissing);
        case "sandbox.status":
          return yield* reportStatus(record, driver, call);
      }
    },
  );

  const destroy = Effect.fn("SandboxEffects.destroy")(function* (
    record: OrchestrationV2Sandbox,
    driver: ComputeDriver["Service"],
    callIgnoringMissing: (
      effect: Effect.Effect<void, ComputeDriverError>,
    ) => Effect.Effect<void, SandboxEffectError>,
  ) {
    // The thread's reads outlive the disk, so its last diff goes to the mirror first.
    if (Option.isSome(mirrorSync)) yield* mirrorSync.value.flush(record.id);
    if (record.driverRef !== null) yield* callIgnoringMissing(driver.destroy(record.driverRef));
    yield* revokeCredentials(record, "destroy");
    return yield* report(record, {
      type: "sandbox.destroyed",
      commandId: CommandId.make(`sandbox-destroyed:${record.id}:${record.generation}`),
      ...generationFields(record),
    });
  });

  const requireDriverRef = (
    record: OrchestrationV2Sandbox,
    fail: (retryable: boolean) => (cause: unknown) => SandboxEffectError,
  ) =>
    record.driverRef === null
      ? Effect.fail(fail(false)("The sandbox has no backend resource to start."))
      : Effect.succeed(record.driverRef);

  const reportMissing = (record: OrchestrationV2Sandbox) =>
    report(record, {
      type: "sandbox.failed",
      commandId: CommandId.make(`sandbox-failed:${record.id}:${record.generation}:missing`),
      ...generationFields(record),
      failure: SANDBOX_BACKEND_MISSING_FAILURE,
    });

  const reportStatus = Effect.fn("SandboxEffects.reportStatus")(function* (
    record: OrchestrationV2Sandbox,
    driver: ComputeDriver["Service"],
    call: <A>(effect: Effect.Effect<A, ComputeDriverError>) => Effect.Effect<A, SandboxEffectError>,
  ) {
    // A hello can arrive before `sandbox.created`; the boot deadline covers that window.
    if (record.driverRef === null) return;
    const backend = yield* call(driver.status(record.driverRef));
    switch (backend.status) {
      case "stopped":
        yield* revokeCredentials(record, "status");
        return yield* report(record, {
          type: "sandbox.stopped",
          commandId: CommandId.make(`sandbox-stopped:${record.id}:${record.generation}`),
          ...generationFields(record),
        });
      case "missing":
        yield* revokeCredentials(record, "status");
        return yield* reportMissing(record);
      case "failed":
        yield* revokeCredentials(record, "status");
        return yield* report(record, {
          type: "sandbox.failed",
          commandId: CommandId.make(`sandbox-failed:${record.id}:${record.generation}:lost`),
          ...generationFields(record),
          failure: {
            code: "lost",
            message: "The machine stopped and its runner did not come back.",
            retryable: true,
          },
        });
      case "starting":
      case "running":
        return;
    }
  });

  const reportExhausted: SandboxEffects["Service"]["reportExhausted"] = Effect.fn(
    "SandboxEffects.reportExhausted",
  )(
    function* (request, cause) {
      // Waiters and wakes are the threads' runs; failing to reach them says nothing about the machine.
      if (!isDriverEffectRequest(request)) return;
      const record = yield* currentRecord(request);
      if (record === null || record.state === "destroyed") return;
      yield* report(record, {
        type: "sandbox.failed",
        commandId: CommandId.make(
          `sandbox-failed:${record.id}:${record.generation}:${request.type}`,
        ),
        ...generationFields(record),
        failure: failureFor(request, sandboxErrorIn(cause)),
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record a sandbox effect's last failure", { cause }),
    ),
  );

  const handOver: SandboxEffects["Service"]["handOver"] = Effect.fn("SandboxEffects.handOver")(
    function* ({ sandboxId, fromThreadId }) {
      const fail = (cause: unknown) =>
        new SandboxEffectError({ sandboxId, operation: "report", retryable: true, cause });
      const record = yield* projections.getSandbox(sandboxId).pipe(Effect.mapError(fail));
      if (record === null || record.ownerThreadId !== fromThreadId) return;
      const candidates = yield* projections
        .listSandboxThreads(sandboxId)
        .pipe(Effect.mapError(fail));
      // One id for every candidate: a refused adopt keeps no receipt, an accepted one dedupes a replay.
      const commandId = CommandId.make(`sandbox-adopt:${sandboxId}:${fromThreadId}`);
      for (const { threadId } of candidates) {
        if (threadId === fromThreadId) continue;
        const adopted = yield* threads
          .dispatch({
            type: "sandbox.adopt",
            commandId,
            threadId,
            sandboxId,
            previousOwnerThreadId: fromThreadId,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTags({ OrchestratorSandboxCommandMovedError: () => Effect.succeed(false) }),
            Effect.mapError(fail),
          );
        if (adopted) return;
      }
      // Nobody is left: the same destroy `sandbox.destroy` runs, reported on the old owner's stream.
      if (record.state === "destroyed") return;
      const { driver, callIgnoringMissing } = yield* driverFor(record, "destroy");
      yield* destroy(record, driver, callIgnoringMissing);
    },
  );

  return SandboxEffects.of({ execute, reportExhausted, handOver });
});

export const layer: Layer.Layer<
  SandboxEffects,
  never,
  | ComputeDriverRegistry.ComputeDriverRegistry
  | SandboxBootstrapSource.SandboxBootstrapSource
  | ProjectionStore.ProjectionStoreV2
  | EffectOutboxV2
  | ThreadManagement.ThreadManagementService
  | ServerEnvironment.ServerEnvironment
  | SandboxCredentialRevocation.SandboxCredentialRevocation
  | ServerDrain.ServerDrain
  | TeamImageStore.TeamImageStore
> = Layer.effect(SandboxEffects, make);
