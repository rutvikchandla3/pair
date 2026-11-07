// @effect-diagnostics-next-line nodeBuiltinImport:off -- appends need O_NOFOLLOW, which Effect's FileSystem lacks.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- appends need O_NOFOLLOW, which Effect's FileSystem lacks.
import * as NodeFSP from "node:fs/promises";
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
  RunnerFileError,
  type RunnerFileInfo,
  type RunnerFileReadEvent,
  type RunnerForwardId,
  type RunnerWatchEvent,
} from "@t3tools/contracts/runner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as LocalWorkspaceHost from "../../workspaceHost/LocalWorkspaceHost.ts";
import type { WorkspaceHostFileError } from "../../workspaceHost/WorkspaceHost.ts";
import { HandleTable, runnerBadArgument, toSystemError } from "./HandleTable.ts";
import { listenTarget } from "./forwards.ts";
import * as ProcessRun from "./ProcessRun.ts";
import { RunnerConfig } from "./RunnerConfig.ts";
import { RunnerCredential } from "./RunnerSocketServer.ts";
import { measureRunnerStartup } from "./startupMarks.ts";

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

const systemErrors = Effect.mapError(toSystemError);

const fileErrors = Effect.mapError(
  (error: WorkspaceHostFileError) =>
    new RunnerFileError({
      operation: error.operation,
      ...(error.code === undefined ? {} : { code: error.code }),
    }),
);

/** File reads stream in chunks this size, so each frame stays under the cap. */
const FILE_CHUNK_BYTES = 128 * 1024;

// Appends keep the first write's O_NOFOLLOW: a symlink swapped in between is not followed.
const appendNoFollow = (path: string, data: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      NodeFSP.writeFile(path, data, {
        flag: NodeFS.constants.O_WRONLY | NodeFS.constants.O_APPEND | NodeFS.constants.O_NOFOLLOW,
      }),
    catch: (cause) =>
      new RunnerFileError({
        operation: "write",
        ...((cause as NodeJS.ErrnoException | undefined)?.code === undefined
          ? {}
          : { code: (cause as NodeJS.ErrnoException).code! }),
      }),
  });

export const layer = RunnerCoreRpcGroup.toLayer(
  Effect.gen(function* () {
    const table = yield* HandleTable;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* RunnerConfig;
    const credential = yield* RunnerCredential;
    const arch = yield* HostProcess.Architecture;
    let gitForward: RunnerForwardId | undefined;

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
        const { runnerBootId, handles } = yield* table.hello(input);
        measureRunnerStartup("runner.hello");
        return {
          runnerBootId,
          runnerBuildId: config.runnerBuildId,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          arch,
          cpus: NodeOS.cpus().length,
          memoryBytes: NodeOS.totalmem(),
          ...config.facts,
          handles,
        };
      }),
      [RUNNER_METHODS.events]: () => table.events,
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

      [RUNNER_METHODS.fsStat]: ({ path, noFollow }) =>
        (noFollow === true ? fs.lstat(path) : fs.stat(path)).pipe(
          Effect.map(toFileInfo),
          systemErrors,
        ),
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
        // Node answers a recursive mkdir with the first folder it made.
        fs.makeDirectory(path, { recursive, mode }).pipe(Effect.asVoid, systemErrors),
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
      [RUNNER_METHODS.fsUtimes]: ({ path, atime, mtime }) =>
        // Node reads a number as seconds.
        fs.utimes(path, atime / 1000, mtime / 1000).pipe(systemErrors),
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

      [RUNNER_METHODS.filesLstat]: ({ path }) =>
        LocalWorkspaceHost.files.lstat(path).pipe(fileErrors),
      [RUNNER_METHODS.filesReadDirectory]: ({ path }) =>
        LocalWorkspaceHost.files.readDirectory(path).pipe(fileErrors),
      [RUNNER_METHODS.filesReadFile]: ({ path, maxBytes }) =>
        Stream.unwrap(
          LocalWorkspaceHost.files.readFile(path, maxBytes).pipe(
            fileErrors,
            Effect.map((read): Stream.Stream<RunnerFileReadEvent> => {
              if (read.kind === "not-file") return Stream.make({ _tag: "not-file" });
              const chunks: Array<RunnerFileReadEvent> = [{ _tag: "file", size: read.size }];
              for (let offset = 0; offset < read.bytes.length; offset += FILE_CHUNK_BYTES) {
                chunks.push({
                  _tag: "chunk",
                  data: read.bytes.subarray(offset, offset + FILE_CHUNK_BYTES),
                });
              }
              // One element per frame: a stream chunk is one frame, under the size cap.
              return Stream.fromIterable(chunks, { chunkSize: 1 });
            }),
          ),
        ),
      [RUNNER_METHODS.filesWriteNoFollow]: ({ path, data, append }) =>
        append
          ? appendNoFollow(path, data)
          : LocalWorkspaceHost.files.writeNoFollow(path, data).pipe(fileErrors),
      [RUNNER_METHODS.filesRealPath]: ({ path }) =>
        LocalWorkspaceHost.files.realPath(path).pipe(fileErrors),
      [RUNNER_METHODS.filesRemoveEmptyDirectory]: ({ path }) =>
        LocalWorkspaceHost.files.removeEmptyDirectory(path).pipe(fileErrors),

      // The owner key is the server's to check; the runner only listens.
      [RUNNER_METHODS.forwardOpen]: Effect.fn("runner.forward.open")(function* ({ name }) {
        // A new server boot opens its own git forward at the same path.
        if (name === "git-credential" && gitForward !== undefined) {
          yield* table.closeListener(gitForward);
        }
        const opened = yield* table.openListener(
          listenTarget(name, config.stateDir, SecureRandom.uuidV4Unsafe()),
        );
        if (name === "git-credential") gitForward = opened.forwardId;
        return opened;
      }),
      [RUNNER_METHODS.forwardClose]: ({ forwardId }) => table.closeListener(forwardId),
      [RUNNER_METHODS.tcpRead]: ({ connectionId, fromSeq }) =>
        table.output(connectionId, "tcp", fromSeq),
      [RUNNER_METHODS.tcpWrite]: ({ connectionId, seq, data }) =>
        table
          .write(connectionId, "in:tcp", seq, { _tag: "data", data })
          .pipe(Effect.map((appliedThrough) => ({ appliedThrough }))),
      [RUNNER_METHODS.tcpClose]: ({ connectionId }) => table.closeTcp(connectionId),
    });
  }),
);
