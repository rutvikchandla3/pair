import {
  CommandId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  SandboxId,
  type SandboxFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { OrchestrationEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";
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
import * as RunnerBundle from "../runnerHub/RunnerBundle.ts";
import * as RunnerEndpoint from "../runnerHub/RunnerEndpoint.ts";
import * as MirrorSyncWorker from "../mirror/MirrorSyncWorker.ts";
import * as SandboxBootstrapSource from "./SandboxBootstrapSource.ts";
import type { SandboxEffectRequest } from "./SandboxDecisions.ts";

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
  { readonly type: "sandbox.release-waiters" }
>;

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
  }
>()("t3/sandbox/lifecycle/SandboxEffects") {}

const DRIVER_RETRY = { schedule: Schedule.spaced("2 seconds"), times: 3 } as const;

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

const make = Effect.gen(function* () {
  const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
  const bootstraps = yield* SandboxBootstrapSource.SandboxBootstrapSource;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const credentials = yield* SandboxCredentialRevocation.SandboxCredentialRevocation;
  // The server provides it; lifecycle tests run without a mirror.
  const mirrorSync = yield* Effect.serviceOption(MirrorSyncWorker.MirrorSyncWorker);

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
            operation:
              request.type === "sandbox.release-waiters" ? "report" : operationOf(request.type),
            retryable: true,
            cause,
          }),
      ),
    );
    if (record === null || record.generation !== request.generation) return null;
    if (record.state === "destroyed" && request.type !== "sandbox.destroy") return null;
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
   */
  const releaseWaiters = Effect.fn("SandboxEffects.releaseWaiters")(function* (
    record: OrchestrationV2Sandbox,
  ) {
    if (record.state !== "ready" && record.state !== "failed") return;
    const fail = (cause: unknown) =>
      new SandboxEffectError({ sandboxId: record.id, operation: "report", retryable: true, cause });
    const rows = yield* projections.listSandboxThreads(record.id).pipe(Effect.mapError(fail));
    for (const { threadId } of rows) {
      const { runs } = yield* projections
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError(fail));
      for (const run of runs) {
        if (run.status !== "preparing") continue;
        const commandId = CommandId.make(`sandbox-release:${run.id}:${record.generation}`);
        if (run.workspacePreparation !== undefined) {
          if (record.state === "ready" && Option.isSome(threadLaunch)) {
            yield* threadLaunch.value.prepareRun({
              commandId: CommandId.make(`sandbox-rearm:${run.id}:${record.generation}`),
              threadId,
              runId: run.id,
            });
          }
          continue;
        }
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
    }
  });

  const execute: SandboxEffects["Service"]["execute"] = Effect.fn("SandboxEffects.execute")(
    function* (request) {
      const record = yield* currentRecord(request);
      if (record === null) return;
      if (request.type === "sandbox.release-waiters") return yield* releaseWaiters(record);
      const operation = operationOf(request.type);
      const fail = (retryable: boolean) => (cause: unknown) =>
        new SandboxEffectError({ sandboxId: record.id, operation, retryable, cause });
      // A removed driver stays removed; a settings read may succeed next time.
      const driver = yield* registry
        .get(record.driverId)
        .pipe(Effect.mapError((cause) => fail(!isDriverNotConfigured(cause))(cause)));
      const call = <A>(effect: Effect.Effect<A, ComputeDriverError>) =>
        effect.pipe(
          Effect.retry({ ...DRIVER_RETRY, while: (error) => error.retryable }),
          Effect.mapError((error) => fail(error.retryable)(error)),
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
          const created = yield* call(
            driver.create({
              name: sandboxBackendName(installId, record.id, record.generation),
              sandboxId: record.id,
              generation: record.generation,
              image: { type: "base" },
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
          return yield* call(driver.start(driverRef, yield* bootstrap));
        }
        case "sandbox.stop":
          // A settled thread's last diff must be in the mirror before its disk goes away.
          if (Option.isSome(mirrorSync)) yield* mirrorSync.value.flush(record.id);
          if (record.driverRef !== null) yield* callIgnoringMissing(driver.stop(record.driverRef));
          yield* revokeCredentials(record, "stop");
          return yield* report(record, {
            type: "sandbox.stopped",
            commandId: CommandId.make(`sandbox-stopped:${record.id}:${record.generation}`),
            ...generationFields(record),
          });
        case "sandbox.destroy":
          if (record.driverRef !== null) {
            yield* callIgnoringMissing(driver.destroy(record.driverRef));
          }
          yield* revokeCredentials(record, "destroy");
          return yield* report(record, {
            type: "sandbox.destroyed",
            commandId: CommandId.make(`sandbox-destroyed:${record.id}:${record.generation}`),
            ...generationFields(record),
          });
        case "sandbox.status":
          return yield* reportStatus(record, driver, call);
      }
    },
  );

  const requireDriverRef = (
    record: OrchestrationV2Sandbox,
    fail: (retryable: boolean) => (cause: unknown) => SandboxEffectError,
  ) =>
    record.driverRef === null
      ? Effect.fail(fail(false)("The sandbox has no backend resource to start."))
      : Effect.succeed(record.driverRef);

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
      // Waiters are the threads' runs; failing to reach them says nothing about the machine.
      if (request.type === "sandbox.release-waiters") return;
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

  return SandboxEffects.of({ execute, reportExhausted });
});

export const layer: Layer.Layer<
  SandboxEffects,
  never,
  | ComputeDriverRegistry.ComputeDriverRegistry
  | SandboxBootstrapSource.SandboxBootstrapSource
  | ProjectionStore.ProjectionStoreV2
  | ThreadManagement.ThreadManagementService
  | ServerEnvironment.ServerEnvironment
  | SandboxCredentialRevocation.SandboxCredentialRevocation
> = Layer.effect(SandboxEffects, make);
