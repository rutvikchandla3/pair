import type { ResourceMonitorProcessTableEntry } from "@t3tools/contracts";
import {
  RUNNER_METHODS,
  RunnerLostError,
  RunnerOpsError,
  type RunnerSystemError,
} from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import type { CoarseOperationError, CoarseOperations } from "../../workspaceHost/WorkspaceHost.ts";
import type { RunnerClient } from "./RunnerConnection.ts";

type ProcessTable = ReadonlyArray<ResourceMonitorProcessTableEntry>;

const isRunnerOpsError = Schema.is(RunnerOpsError);
const isRunnerLostError = Schema.is(RunnerLostError);

const toOperationError =
  (operation: RunnerOpsError["operation"]) =>
  (
    error: RunnerLostError | RunnerSystemError | RunnerOpsError | RpcClientError,
  ): CoarseOperationError =>
    isRunnerOpsError(error) || isRunnerLostError(error)
      ? error
      : new RunnerOpsError({ operation, failure: "failed" });

/**
 * The coarse operations of one runner boot, each on the live socket's client. List results arrive
 * in pages and are joined here. The process table subscription starts on the first read and lives
 * in the given scope, so a poll costs no round trip; a drop fails it and the next read restarts it.
 */
export const make = Effect.fn("RunnerOpsClient.make")(function* (
  liveClient: Effect.Effect<RunnerClient, RunnerLostError>,
) {
  const call = <A, E>(f: (client: RunnerClient) => Effect.Effect<A, E>) =>
    Effect.flatMap(liveClient, f);
  const stream = <A, E>(f: (client: RunnerClient) => Stream.Stream<A, E>) =>
    Stream.unwrap(Effect.map(liveClient, f));
  const scope = yield* Effect.scope;
  const table = yield* SubscriptionRef.make(
    Option.none<Exit.Exit<ProcessTable, CoarseOperationError>>(),
  );
  const starting = yield* Semaphore.make(1);
  let subscription: Fiber.Fiber<void> | undefined;

  const subscribeTable = stream((client) => client[RUNNER_METHODS.opsProcessesTable]({})).pipe(
    Stream.runForEach((entries) => SubscriptionRef.set(table, Option.some(Exit.succeed(entries)))),
    Effect.catch((error) =>
      SubscriptionRef.set(
        table,
        Option.some(Exit.fail(toOperationError("processes.table")(error))),
      ),
    ),
  );

  const startTable = Effect.gen(function* () {
    const latest = yield* SubscriptionRef.get(table);
    // A failed subscription is retried by the next read.
    if (subscription !== undefined && !(Option.isSome(latest) && Exit.isFailure(latest.value))) {
      return;
    }
    if (subscription !== undefined) yield* Fiber.interrupt(subscription);
    yield* SubscriptionRef.set(table, Option.none());
    subscription = yield* Effect.forkIn(subscribeTable, scope);
  });

  const processTable: CoarseOperations["processTable"] = Effect.gen(function* () {
    yield* starting.withPermits(1)(startTable);
    const first = yield* SubscriptionRef.changes(table).pipe(
      Stream.filter(Option.isSome),
      Stream.runHead,
    );
    return yield* Option.getOrThrow(first).value;
  });

  return {
    searchEntries: (input) =>
      stream((client) => client[RUNNER_METHODS.opsSearchEntries](input)).pipe(
        Stream.runCollect,
        Effect.map((pages) => ({ ...pages[0]!, entries: pages.flatMap((page) => page.entries) })),
        Effect.mapError(toOperationError("search.entries")),
      ),
    searchContents: (input) =>
      stream((client) => client[RUNNER_METHODS.opsSearchContents](input)).pipe(
        Stream.runCollect,
        Effect.map((pages) => ({ ...pages[0]!, matches: pages.flatMap((page) => page.matches) })),
        Effect.mapError(toOperationError("search.contents")),
      ),
    listEntries: (input) =>
      stream((client) => client[RUNNER_METHODS.opsEntriesBrowse](input)).pipe(
        Stream.runCollect,
        Effect.map((pages) => ({ ...pages[0]!, entries: pages.flatMap((page) => page.entries) })),
        Effect.mapError(toOperationError("entries.browse")),
      ),
    refreshSearch: (cwd) =>
      call((client) => client[RUNNER_METHODS.opsSearchRefresh]({ cwd })).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to refresh workspace search index", { cwd, cause }),
        ),
      ),
    processTable,
    portListeners: (configuredUrls) =>
      stream((client) => client[RUNNER_METHODS.opsPortsListeners]({ configuredUrls })).pipe(
        Stream.mapError(toOperationError("ports.listeners")),
      ),
    checkpointCapture: (input) =>
      call((client) => client[RUNNER_METHODS.opsCheckpointCapture](input)).pipe(
        Effect.mapError(toOperationError("checkpoint.capture")),
      ),
  } satisfies CoarseOperations;
});
