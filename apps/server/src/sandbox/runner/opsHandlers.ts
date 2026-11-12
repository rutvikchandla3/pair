import type { DiscoveredLocalServer, ResourceMonitorProcessTableEntry } from "@t3tools/contracts";
import {
  RUNNER_METHODS,
  RUNNER_OPS_PAGE_BYTES,
  RunnerOpsError,
  RunnerOpsRpcGroup,
  type RunnerOpsCheckpointCaptureInput,
} from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointCapture from "../../checkpointing/CheckpointCapture.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { readPosixProcessTable, resolvePosixPsCommand } from "../../terminal/processTable.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";

const PROCESS_TABLE_INTERVAL = "1 second";
/** The terminal manager's own bound for one `ps` read. */
const PROCESS_TABLE_TIMEOUT = "15 seconds";

const opsFailure = (operation: RunnerOpsError["operation"]) =>
  new RunnerOpsError({ operation, failure: "failed" });

const entriesFailure =
  (operation: RunnerOpsError["operation"]) => (error: WorkspaceEntries.WorkspaceEntriesError) =>
    new RunnerOpsError({
      operation,
      failure: WorkspaceEntries.entriesFailureContext(error).failure,
    });

/**
 * Pages of about `RUNNER_OPS_PAGE_BYTES`; JSON is never smaller than the binary encoding. Each
 * goes out as its own stream chunk, since one chunk is one frame.
 */
const pages = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> => {
  const result: Array<Array<A>> = [[]];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > RUNNER_OPS_PAGE_BYTES && result.at(-1)!.length > 0) {
      result.push([]);
      bytes = 0;
    }
    result.at(-1)!.push(item);
    bytes += size;
  }
  return result;
};

const byPid = (
  left: ResourceMonitorProcessTableEntry,
  right: ResourceMonitorProcessTableEntry,
): number => left.pid - right.pid;

const sameTable = (
  left: ReadonlyArray<ResourceMonitorProcessTableEntry>,
  right: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.pid === right[index]!.pid &&
      entry.ppid === right[index]!.ppid &&
      entry.name === right[index]!.name,
  );

/** One handler per coarse operation: decode, call one service method, encode, as `ws.ts` does. */
export const layer = RunnerOpsRpcGroup.toLayer(
  Effect.gen(function* () {
    const entries = yield* WorkspaceEntries.WorkspaceEntries;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const ports = yield* PortScanner.PortDiscovery;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const host = (yield* WorkspaceHosts.WorkspaceHosts).local;
    const psCommand = yield* resolvePosixPsCommand(host);

    const readProcessTable = readPosixProcessTable(host, psCommand, PROCESS_TABLE_TIMEOUT).pipe(
      Effect.map((table) => table.toSorted(byPid)),
      Effect.tapError((cause) => Effect.logWarning("runner process table read failed", { cause })),
      Effect.mapError(() => opsFailure("processes.table")),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );

    const captureCheckpoint = Effect.fn("runner.ops.checkpointCapture")(function* (
      input: RunnerOpsCheckpointCaptureInput,
    ) {
      if (input._tag === "baseline") {
        const baseline = yield* CheckpointCapture.captureBaseline({
          cwd: input.cwd,
          roots: input.roots,
          checkpointRef: input.checkpointRef,
        });
        return { ...baseline, files: [], warnings: [] };
      }
      const turn = yield* CheckpointCapture.captureTurn({
        cwd: input.cwd,
        roots: input.roots,
        checkpointRef: input.checkpointRef,
        previousCheckpointRef: input.previousCheckpointRef,
      });
      // The kinds cross the wire; the causes stay in the runner's log.
      yield* Effect.forEach(
        turn.warnings,
        (warning) => Effect.logWarning("runner checkpoint capture warning", warning),
        { discard: true },
      );
      return { ...turn, warnings: turn.warnings.map((warning) => warning.kind) };
    });

    return RunnerOpsRpcGroup.of({
      [RUNNER_METHODS.opsSearchEntries]: (input) =>
        Stream.unwrap(
          entries.search(input).pipe(
            Effect.map((result) =>
              Stream.fromIterable(
                pages(result.entries).map((page) => ({ ...result, entries: page })),
                { chunkSize: 1 },
              ),
            ),
            Effect.mapError(entriesFailure("search.entries")),
          ),
        ),
      [RUNNER_METHODS.opsSearchContents]: (input) =>
        Stream.unwrap(
          entries.searchContents(input).pipe(
            Effect.map((result) =>
              Stream.fromIterable(
                pages(result.matches).map((page) => ({ ...result, matches: page })),
                { chunkSize: 1 },
              ),
            ),
            Effect.mapError(entriesFailure("search.contents")),
          ),
        ),
      [RUNNER_METHODS.opsEntriesBrowse]: (input) =>
        Stream.unwrap(
          entries.list(input).pipe(
            Effect.map((result) =>
              Stream.fromIterable(
                pages(result.entries).map((page) => ({ ...result, entries: page })),
                { chunkSize: 1 },
              ),
            ),
            Effect.mapError(entriesFailure("entries.browse")),
          ),
        ),
      [RUNNER_METHODS.opsSearchRefresh]: ({ cwd }) => entries.refresh(cwd),
      // Reads only while subscribed, and an unchanged table sends nothing.
      [RUNNER_METHODS.opsProcessesTable]: () =>
        Stream.tick(PROCESS_TABLE_INTERVAL).pipe(
          Stream.mapEffect(() => readProcessTable),
          Stream.changesWith(sameTable),
        ),
      [RUNNER_METHODS.opsPortsListeners]: ({ configuredUrls }) =>
        Stream.callback<ReadonlyArray<DiscoveredLocalServer>>((queue) =>
          Effect.gen(function* () {
            yield* ports.retain;
            const initial = yield* ports.scan(configuredUrls);
            yield* Queue.offer(queue, initial);
            yield* ports.subscribe({ configuredUrls, initialSnapshot: initial }, (servers) =>
              Queue.offer(queue, servers).pipe(Effect.asVoid),
            );
          }),
        ),
      [RUNNER_METHODS.opsCheckpointCapture]: (input) =>
        captureCheckpoint(input).pipe(
          Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
          Effect.tapError((cause) =>
            Effect.logWarning("runner checkpoint capture failed", { cause }),
          ),
          Effect.mapError(() => opsFailure("checkpoint.capture")),
        ),
    });
  }),
);
