import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  RUNNER_METHODS,
  RUNNER_PROTOCOL_VERSION,
  RunnerCoreRpcGroup,
  RunnerOpsError,
  RunnerOpsRpcGroup,
  RunnerSystemError,
  type RunnerFileInfo,
  type RunnerWatchEvent,
} from "@t3tools/contracts/runner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { HandleTable, runnerBadArgument, toSystemError } from "./HandleTable.ts";
import * as ProcessRun from "./ProcessRun.ts";
import { RunnerConfig } from "./RunnerConfig.ts";
import { RunnerCredential } from "./RunnerSocketServer.ts";

const WATCH_COALESCE = "50 millis";
const WATCH_BATCH_MAX = 1_024;

const optionToNull = <A>(option: Option.Option<A>): A | null => Option.getOrNull(option);

const toFileInfo = (info: FileSystem.File.Info): RunnerFileInfo => ({
  type: info.type,
  mtime: Option.getOrNull(Option.map(info.mtime, (date) => date.getTime())),
  atime: Option.getOrNull(Option.map(info.atime, (date) => date.getTime())),
  birthtime: Option.getOrNull(Option.map(info.birthtime, (date) => date.getTime())),
  dev: info.dev,
  ino: optionToNull(info.ino),
  mode: info.mode,
  nlink: optionToNull(info.nlink),
  uid: optionToNull(info.uid),
  gid: optionToNull(info.gid),
  rdev: optionToNull(info.rdev),
  size: BigInt(info.size),
  blksize: Option.getOrNull(Option.map(info.blksize, (size) => BigInt(size))),
  blocks: optionToNull(info.blocks),
});

/** Events within one window as one batch, the latest per path. */
export const coalesceWatchEvents = <E, R>(events: Stream.Stream<FileSystem.WatchEvent, E, R>) =>
  events.pipe(
    Stream.groupedWithin(WATCH_BATCH_MAX, WATCH_COALESCE),
    Stream.map((batch): ReadonlyArray<RunnerWatchEvent> => {
      const latest = new Map<string, RunnerWatchEvent>();
      for (const event of batch) {
        latest.delete(event.path);
        latest.set(event.path, { _tag: event._tag, path: event.path });
      }
      return [...latest.values()];
    }),
  );

const notSupported = (method: string) =>
  new RunnerSystemError({
    reason: "Unknown",
    module: "Runner",
    method,
    description: "not supported",
  });

const systemErrors = Effect.mapError(toSystemError);

export const layer = RunnerCoreRpcGroup.toLayer(
  Effect.gen(function* () {
    const table = yield* HandleTable;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* RunnerConfig;
    const credential = yield* RunnerCredential;
    const arch = yield* HostProcess.Architecture;

    const writeAtomic = Effect.fn("runner.fs.writeAtomic")(function* (
      path: string,
      data: Uint8Array,
      options: { readonly mode?: number | undefined },
    ) {
      const staging = `${path}.t3tmp-${SecureRandom.uuidV4Unsafe()}`;
      yield* fs.writeFile(staging, data, options).pipe(
        Effect.andThen(fs.rename(staging, path)),
        Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      );
    });

    return RunnerCoreRpcGroup.of({
      [RUNNER_METHODS.hello]: Effect.fn("runner.hello")(function* (input) {
        if (input.sandboxToken !== undefined) {
          yield* credential.setSandboxToken(input.sandboxToken).pipe(systemErrors);
        }
        if (arch !== "x64" && arch !== "arm64") {
          return yield* runnerBadArgument("runner.hello", `unsupported architecture ${arch}`);
        }
        return {
          runnerBootId: table.runnerBootId,
          runnerBuildId: config.runnerBuildId,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          arch,
          cpus: NodeOS.cpus().length,
          memoryBytes: NodeOS.totalmem(),
          handles: yield* table.live,
        };
      }),
      [RUNNER_METHODS.events]: () =>
        table.exited.pipe(Stream.map((handle) => ({ _tag: "handle.exited" as const, handle }))),
      [RUNNER_METHODS.drain]: ({ graceMs }) => table.drain(graceMs),

      [RUNNER_METHODS.processSpawn]: (input) => table.spawn(input),
      [RUNNER_METHODS.processOutput]: ({ handle, fd, fromSeq }) =>
        table.output(handle, `fd:${fd}`, fromSeq),
      [RUNNER_METHODS.processWrite]: ({ handle, fd, seq, data }) =>
        table
          .write(handle, `in:${fd}`, seq, { _tag: "data", data })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.processCloseInput]: ({ handle, fd, seq }) =>
        table.write(handle, `in:${fd}`, seq, { _tag: "close" }).pipe(Effect.asVoid),
      [RUNNER_METHODS.processSignal]: ({ handle, signal, group }) =>
        table.signal(handle, signal, group),
      [RUNNER_METHODS.processWait]: ({ handle }) =>
        table
          .wait(handle)
          .pipe(
            Effect.flatMap((info) =>
              info._tag === "process"
                ? Effect.succeed(info.exit)
                : Effect.fail(runnerBadArgument("process.wait", `${handle} is a PTY`)),
            ),
          ),
      [RUNNER_METHODS.processRelease]: ({ handle }) => table.release(handle),
      [RUNNER_METHODS.processRun]: (input) => ProcessRun.run(input),
      [RUNNER_METHODS.processRunStream]: (input) => ProcessRun.runStream(input),

      [RUNNER_METHODS.ptyOpen]: (input) => table.openPty(input),
      [RUNNER_METHODS.ptyOutput]: ({ handle, fromSeq }) => table.output(handle, "pty", fromSeq),
      [RUNNER_METHODS.ptyInput]: ({ handle, seq, data }) =>
        table
          .write(handle, "in:pty", seq, { _tag: "data", data })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.ptyResize]: ({ handle, seq, cols, rows }) =>
        table
          .write(handle, "in:pty", seq, { _tag: "resize", cols, rows })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.ptySignal]: ({ handle, seq, signal }) =>
        table
          .write(handle, "in:pty", seq, { _tag: "signal", signal })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.ptyWait]: ({ handle }) =>
        table
          .wait(handle)
          .pipe(
            Effect.flatMap((info) =>
              info._tag === "pty"
                ? Effect.succeed(info.exit)
                : Effect.fail(runnerBadArgument("pty.wait", `${handle} is not a PTY`)),
            ),
          ),
      [RUNNER_METHODS.ptyRelease]: ({ handle }) => table.release(handle),

      [RUNNER_METHODS.fsStat]: ({ path }) =>
        fs.stat(path).pipe(Effect.map(toFileInfo), systemErrors),
      [RUNNER_METHODS.fsReadDirectory]: ({ path, recursive }) =>
        fs.readDirectory(path, { recursive }).pipe(systemErrors),
      [RUNNER_METHODS.fsReadFile]: ({ path, offset, maxBytes }) =>
        fs.stream(path, { offset: offset ?? 0, bytesToRead: maxBytes }).pipe(
          Stream.runCollect,
          Effect.map((chunks) => Buffer.concat(chunks) as Uint8Array),
          systemErrors,
        ),
      [RUNNER_METHODS.fsWriteFile]: ({ path, data, flag, mode, atomic }) =>
        (atomic === true
          ? writeAtomic(path, data, { mode })
          : fs.writeFile(path, data, { flag, mode })
        ).pipe(systemErrors),
      [RUNNER_METHODS.fsMakeDirectory]: ({ path, recursive, mode }) =>
        fs.makeDirectory(path, { recursive, mode }).pipe(systemErrors),
      [RUNNER_METHODS.fsRemove]: ({ path, recursive, force }) =>
        fs.remove(path, { recursive, force }).pipe(systemErrors),
      [RUNNER_METHODS.fsRename]: ({ oldPath, newPath }) =>
        fs.rename(oldPath, newPath).pipe(systemErrors),
      [RUNNER_METHODS.fsCopy]: ({ fromPath, toPath, overwrite, preserveTimestamps }) =>
        fs.copy(fromPath, toPath, { overwrite, preserveTimestamps }).pipe(systemErrors),
      [RUNNER_METHODS.fsRealPath]: ({ path }) => fs.realPath(path).pipe(systemErrors),
      [RUNNER_METHODS.fsReadLink]: ({ path }) => fs.readLink(path).pipe(systemErrors),
      [RUNNER_METHODS.fsSymlink]: ({ fromPath, toPath }) =>
        fs.symlink(fromPath, toPath).pipe(systemErrors),
      [RUNNER_METHODS.fsChmod]: ({ path, mode }) => fs.chmod(path, mode).pipe(systemErrors),
      [RUNNER_METHODS.fsMakeTempDirectory]: ({ directory, prefix }) =>
        fs.makeTempDirectory({ directory, prefix }).pipe(systemErrors),
      [RUNNER_METHODS.fsReadStream]: ({ path, offset, chunkBytes }) =>
        Stream.suspend(() => {
          let seq = offset ?? 0;
          return fs.stream(path, { offset: seq, chunkSize: chunkBytes }).pipe(
            Stream.map((data) => {
              const chunk = { seq, data };
              seq += data.byteLength;
              return chunk;
            }),
            Stream.mapError(toSystemError),
          );
        }),
      [RUNNER_METHODS.fsWriteStreamOpen]: ({ path, atomic }) =>
        table
          .openFileWriter({ path, atomic: atomic === true })
          .pipe(Effect.map((handle) => ({ handle }))),
      [RUNNER_METHODS.fsWriteStreamChunk]: ({ handle, seq, data }) =>
        table
          .write(handle, "in:file", seq, { _tag: "data", data })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.fsWriteStreamClose]: ({ handle }) => table.closeFileWriter(handle),
      // The first batch is empty and means the watch is installed, as `WatchOptions.onReady` does.
      [RUNNER_METHODS.fsWatch]: ({ path, recursive }) =>
        Stream.callback<ReadonlyArray<RunnerWatchEvent>, PlatformError.PlatformError>((queue) =>
          coalesceWatchEvents(
            fs.watch(path, { recursive, onReady: () => Queue.offerUnsafe(queue, []) }),
          ).pipe(Stream.runForEach((batch) => Queue.offer(queue, batch))),
        ).pipe(Stream.mapError(toSystemError)),

      [RUNNER_METHODS.forwardOpen]: () => Effect.fail(notSupported(RUNNER_METHODS.forwardOpen)),
      [RUNNER_METHODS.forwardClose]: () => Effect.fail(notSupported(RUNNER_METHODS.forwardClose)),
      [RUNNER_METHODS.tcpRead]: () => Stream.fail(notSupported(RUNNER_METHODS.tcpRead)),
      [RUNNER_METHODS.tcpWrite]: () => Effect.fail(notSupported(RUNNER_METHODS.tcpWrite)),
      [RUNNER_METHODS.tcpClose]: () => Effect.fail(notSupported(RUNNER_METHODS.tcpClose)),
    });
  }),
);

const opsFailure = (operation: RunnerOpsError["operation"]) =>
  new RunnerOpsError({ operation, failure: "failed" });

/** Coarse operations land with their services in a later change. */
export const opsLayer = RunnerOpsRpcGroup.toLayer({
  [RUNNER_METHODS.opsSearchEntries]: () => Effect.fail(opsFailure("search.entries")),
  [RUNNER_METHODS.opsSearchContents]: () => Effect.fail(opsFailure("search.contents")),
  [RUNNER_METHODS.opsSearchRefresh]: () => Effect.fail(opsFailure("search.refresh")),
  [RUNNER_METHODS.opsEntriesBrowse]: () => Effect.fail(opsFailure("entries.browse")),
  [RUNNER_METHODS.opsProcessesTable]: () => Stream.fail(opsFailure("processes.table")),
  [RUNNER_METHODS.opsPortsListeners]: () => Stream.fail(opsFailure("ports.listeners")),
  [RUNNER_METHODS.opsCheckpointCapture]: () => Effect.fail(opsFailure("checkpoint.capture")),
});
