import type { SandboxId } from "@t3tools/contracts";
import {
  type RunnerFileError,
  type RunnerFileInfo,
  type RunnerLostError,
  type RunnerProcessSpawnInput,
  RunnerSignal,
  type RunnerSystemError,
} from "@t3tools/contracts/runner";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ByteSize from "effect/ByteSize";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import type { RunnerConnection } from "../sandbox/runnerHub/RunnerConnection.ts";
import { sandboxBaseEnvironment } from "../sandbox/credentials/SandboxProcessEnvironment.ts";
import {
  type WorkspaceHost,
  WorkspaceHostError,
  WorkspaceHostFileError,
  type WorkspaceHostFiles,
  type WorkspaceHostId,
  type WorkspaceHostInfo,
} from "./WorkspaceHost.ts";

type CallError = RunnerLostError | RunnerSystemError | RunnerFileError | RpcClientError;

/** Writes go out in frames of at most this much, well inside the runner's 256 KiB cap. */
const WRITE_FRAME_BYTES = 128 * 1024;
const MODULE = "SandboxWorkspaceHost";

const encoder = new TextEncoder();
const isRunnerSignal = Schema.is(RunnerSignal);

/**
 * The runner's own error rebuilt as the `PlatformError` a local call would give. A gone boot is
 * `BadResource` with the `RunnerLostError` as cause, which `isRunnerLost` reads.
 */
const toPlatformError =
  (method: string, pathOrDescriptor?: string | number) =>
  (error: CallError): PlatformError.PlatformError => {
    switch (error._tag) {
      case "RunnerSystemError":
        return error.reason === "BadArgument"
          ? PlatformError.badArgument({
              module: error.module,
              method: error.method,
              description: error.description,
              cause: error,
            })
          : PlatformError.systemError({
              _tag: error.reason,
              module: error.module,
              method: error.method,
              description: error.description,
              syscall: error.syscall,
              pathOrDescriptor: error.pathOrDescriptor ?? pathOrDescriptor,
              cause: error,
            });
      case "RunnerLostError":
        return PlatformError.systemError({
          _tag: "BadResource",
          module: MODULE,
          method,
          description: `the sandbox's runner is gone (${error.reason})`,
          pathOrDescriptor,
          cause: error,
        });
      case "RunnerFileError":
        return PlatformError.systemError({
          _tag: error.code === "ENOENT" ? "NotFound" : "Unknown",
          module: MODULE,
          method,
          description: error.code,
          pathOrDescriptor,
          cause: error,
        });
      default:
        return PlatformError.systemError({
          _tag: "Unknown",
          module: MODULE,
          method,
          pathOrDescriptor,
          cause: error,
        });
    }
  };

const unsupported = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: MODULE,
    method,
    description: "not supported on a sandbox host",
  });

const fileError =
  (operation: WorkspaceHostFileError["operation"]) =>
  (error: CallError): WorkspaceHostFileError =>
    new WorkspaceHostFileError({
      operation,
      code: error._tag === "RunnerFileError" ? error.code : undefined,
      cause: error,
    });

// @effect-diagnostics-next-line globalDate:off -- `File.Info` carries `Date`s.
const toDate = (ms: number) => new Date(ms);

const toFileInfo = (info: RunnerFileInfo): FileSystem.File.Info => ({
  type: info.type,
  mtime: Option.map(Option.fromNullishOr(info.mtime), toDate),
  atime: Option.map(Option.fromNullishOr(info.atime), toDate),
  birthtime: Option.map(Option.fromNullishOr(info.birthtime), toDate),
  dev: info.dev,
  ino: Option.fromNullishOr(info.ino),
  mode: info.mode,
  nlink: Option.fromNullishOr(info.nlink),
  uid: Option.fromNullishOr(info.uid),
  gid: Option.fromNullishOr(info.gid),
  rdev: Option.fromNullishOr(info.rdev),
  size: ByteSize.bytes(info.size),
  blksize: Option.map(Option.fromNullishOr(info.blksize), ByteSize.bytes),
  blocks: Option.fromNullishOr(info.blocks),
});

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const frames = (data: Uint8Array): Array<Uint8Array> => {
  const out: Array<Uint8Array> = [];
  for (let offset = 0; offset < data.length; offset += WRITE_FRAME_BYTES) {
    out.push(data.subarray(offset, offset + WRITE_FRAME_BYTES));
  }
  return out.length === 0 ? [data] : out;
};

const plainEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
};

type StdioMode = "pipe" | "ignore";

const stdioMode = (stream: unknown): StdioMode =>
  stream === "ignore" || stream === "inherit" ? "ignore" : "pipe";

/**
 * A sandbox as a `WorkspaceHost`: every member is one call on the runner connection of one boot.
 * Its scope is that boot's: PTYs and the process table live in it, and a new boot is a new host.
 */
export const make = Effect.fn("SandboxWorkspaceHost.make")(function* (
  sandboxId: SandboxId,
  connection: RunnerConnection,
  /** A named forward on this sandbox's runner (`RunnerForwards`), handed in by the hub. */
  exposeServerEndpoint: WorkspaceHost["exposeServerEndpoint"],
): Effect.fn.Return<WorkspaceHost, never, Scope.Scope> {
  const hostScope = yield* Effect.scope;
  const runner = connection.info;
  const id = sandboxId as string as WorkspaceHostId;
  const info: WorkspaceHostInfo = {
    platform: "linux",
    architecture: runner.arch,
    homeDirectory: runner.agent.homeDirectory,
    environment: sandboxBaseEnvironment(runner),
    userId: runner.agent.uid ?? undefined,
    executablePath: `${runner.bundleDirectory}/t3`,
  };
  const agentUser = runner.agent.uid === null ? {} : { uid: runner.agent.uid };
  const once = <A, E>(
    f: (client: Effect.Success<RunnerConnection["client"]>) => Effect.Effect<A, E | RpcClientError>,
  ) => Effect.flatMap(connection.client, f);
  const stream = <A, E>(
    f: (client: Effect.Success<RunnerConnection["client"]>) => Stream.Stream<A, E>,
  ) => Stream.unwrap(Effect.map(connection.client, f));

  const environmentFor = (options: ChildProcess.CommandOptions): Record<string, string> => {
    if (options.env === undefined) return plainEnv(info.environment);
    const env: Record<string, string> =
      options.extendEnv === true ? plainEnv(info.environment) : {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete env[key];
      else env[key] = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    }
    return env;
  };

  const spawnStandard = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const { options } = command;
    const badArgument = (description: string) =>
      PlatformError.badArgument({ module: MODULE, method: "spawn", description });
    const args = command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg));
    const shell = options.shell === true ? "/bin/sh" : options.shell || undefined;
    if (shell !== undefined && args.length > 0) {
      return yield* badArgument("The shell option cannot be combined with arguments");
    }
    const stdinConfig =
      options.stdin === undefined ||
      typeof options.stdin === "string" ||
      Stream.isStream(options.stdin)
        ? { stream: options.stdin ?? "pipe", endOnDone: true }
        : { stream: options.stdin.stream, endOnDone: options.stdin.endOnDone ?? true };
    const outputConfig = (option: ChildProcess.CommandOptions["stdout"]) =>
      option === undefined || typeof option === "string" || Sink.isSink(option)
        ? (option ?? "pipe")
        : (option.stream ?? "pipe");
    const stdoutConfig = outputConfig(options.stdout);
    const stderrConfig = outputConfig(options.stderr);
    const extraFds: Array<RunnerProcessSpawnInput["extraFds"][number]> = [];
    const inputFdStreams = new Map<
      number,
      Stream.Stream<Uint8Array, PlatformError.PlatformError>
    >();
    const outputFdSinks = new Map<
      number,
      Sink.Sink<Uint8Array, Uint8Array, never, PlatformError.PlatformError>
    >();
    for (const [name, config] of Object.entries(options.additionalFds ?? {})) {
      const fd = Number(name.slice(2));
      // fd 3 carries the runner's group watcher.
      if (!Number.isInteger(fd) || fd < 4) {
        return yield* badArgument(`additional fd ${name} must be fd4 or above in a sandbox`);
      }
      if (config.type === "duplex") return yield* badArgument("duplex fds are not supported");
      extraFds.push({ fd, direction: config.type });
      if (config.type === "input" && config.stream) inputFdStreams.set(fd, config.stream);
      if (config.type === "output" && config.sink) outputFdSinks.set(fd, config.sink);
    }
    const frame: RunnerProcessSpawnInput = {
      command: shell ?? command.command,
      args: shell === undefined ? args : ["-c", command.command],
      cwd: options.cwd ?? info.homeDirectory,
      env: environmentFor(options),
      ...agentUser,
      stdin: Stream.isStream(stdinConfig.stream) ? "pipe" : stdioMode(stdinConfig.stream),
      stdout: Sink.isSink(stdoutConfig) ? "pipe" : stdioMode(stdoutConfig),
      stderr: Sink.isSink(stderrConfig) ? "pipe" : stdioMode(stderrConfig),
      extraFds: extraFds.toSorted((left, right) => left.fd - right.fd),
      ...(options.killSignal === undefined || !isRunnerSignal(options.killSignal)
        ? {}
        : { killSignal: options.killSignal }),
      ...(options.forceKillAfter === undefined
        ? {}
        : {
            forceKillAfterMs: Duration.toMillis(Duration.fromInputUnsafe(options.forceKillAfter)),
          }),
    };
    const processError = (method: string) => toPlatformError(method, command.command);

    // Never resent: a spawn whose reply a drop lost may have started, and a second would double it.
    const { handle, pid } = yield* Effect.acquireRelease(
      once((client) => client["process.spawn"](frame)).pipe(Effect.mapError(processError("spawn"))),
      // Kills the group with the spawn's killSignal and forceKillAfter on the runner's clock.
      ({ handle }) =>
        connection
          .idempotent((client) => client["process.release"]({ handle }))
          .pipe(Effect.ignore),
    );

    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>();
    yield* connection
      .idempotent((client) => client["process.wait"]({ handle }))
      .pipe(
        Effect.mapError(processError("exitCode")),
        Effect.flatMap(({ exitCode, signal }) =>
          exitCode !== null
            ? Effect.succeed(ChildProcessSpawner.ExitCode(exitCode))
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "ChildProcess",
                  method: "exitCode",
                  description: `Process interrupted due to receipt of signal: '${signal}'`,
                }),
              ),
        ),
        Effect.exit,
        Effect.flatMap((result) => Deferred.done(exit, result)),
        Effect.forkScoped,
      );

    const output = (fd: number) =>
      connection.output(handle, `fd:${fd}`).pipe(Stream.mapError(processError(`fd${fd}`)));
    const inputSink = (fd: number, endOnDone: boolean) =>
      Sink.unwrap(
        connection.pipeWriter(handle, fd).pipe(
          Effect.map((writer) =>
            Sink.forEach((chunk: Uint8Array) => writer.write(chunk)).pipe(
              Sink.mapEffect(() => (endOnDone ? writer.close : Effect.void)),
              Sink.mapError(processError(`fd${fd}`)),
            ),
          ),
        ),
      );

    let stdout = frame.stdout === "pipe" ? output(1) : Stream.empty;
    let stderr = frame.stderr === "pipe" ? output(2) : Stream.empty;
    if (Sink.isSink(stdoutConfig)) stdout = Stream.transduce(stdout, stdoutConfig);
    if (Sink.isSink(stderrConfig)) stderr = Stream.transduce(stderr, stderrConfig);
    const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> =
      frame.stdin === "pipe" ? inputSink(0, stdinConfig.endOnDone) : Sink.drain;
    if (Stream.isStream(stdinConfig.stream)) {
      yield* Stream.run(stdinConfig.stream, stdin).pipe(Effect.ignore, Effect.forkScoped);
    }
    for (const [fd, source] of inputFdStreams) {
      yield* Stream.run(source, inputSink(fd, true)).pipe(Effect.ignore, Effect.forkScoped);
    }

    const signal = (killSignal: RunnerSignal) =>
      connection
        .idempotent((client) =>
          client["process.signal"]({ handle, signal: killSignal, group: true }),
        )
        .pipe(Effect.mapError(processError("kill")));

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode: Deferred.await(exit),
      isRunning: Effect.map(Deferred.isDone(exit), (done) => !done),
      kill: Effect.fnUntraced(function* (killOptions) {
        const first = killOptions?.killSignal ?? "SIGTERM";
        yield* signal(isRunnerSignal(first) ? first : "SIGTERM");
        if (killOptions?.forceKillAfter !== undefined) {
          const exited = yield* Deferred.await(exit).pipe(
            Effect.exit,
            Effect.timeoutOption(killOptions.forceKillAfter),
          );
          if (Option.isNone(exited)) yield* signal("SIGKILL");
        }
        yield* Deferred.await(exit).pipe(Effect.ignore);
      }),
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: (fd) => inputSink(fd, true),
      getOutputFd: (fd) => {
        const source = output(fd);
        const sink = outputFdSinks.get(fd);
        return sink === undefined ? source : Stream.transduce(source, sink);
      },
      unref: Effect.succeed(Effect.void),
    });
  });

  const spawner = ChildProcessSpawner.make((command) =>
    command._tag === "PipedCommand"
      ? Effect.fail(
          PlatformError.badArgument({
            module: MODULE,
            method: "spawn",
            description: "piped commands are not supported on a sandbox host",
          }),
        )
      : spawnStandard(command),
  );

  const files: WorkspaceHostFiles = {
    realPath: (path) =>
      connection
        .idempotent((client) => client["files.realPath"]({ path }))
        .pipe(Effect.mapError(fileError("realpath"))),
    lstat: (path) =>
      connection
        .idempotent((client) => client["files.lstat"]({ path }))
        .pipe(Effect.mapError(fileError("lstat"))),
    readDirectory: (path) =>
      connection
        .idempotent((client) => client["files.readDirectory"]({ path }))
        .pipe(Effect.mapError(fileError("readdir"))),
    readFile: (path, maxBytes) =>
      stream((client) => client["files.readFile"]({ path, maxBytes })).pipe(
        Stream.runCollect,
        Effect.mapError(fileError("read")),
        Effect.map((events) => {
          const head = events[0];
          if (head?._tag !== "file") return { kind: "not-file" } as const;
          const chunks = events.flatMap((event) => (event._tag === "chunk" ? [event.data] : []));
          return { kind: "file", size: head.size, bytes: concatBytes(chunks) } as const;
        }),
      ),
    writeNoFollow: (path, contents) =>
      Effect.forEach(
        frames(typeof contents === "string" ? encoder.encode(contents) : contents),
        (data, index) =>
          index === 0
            ? connection.idempotent((client) =>
                client["files.writeNoFollow"]({ path, data, append: false }),
              )
            : once((client) => client["files.writeNoFollow"]({ path, data, append: true })),
        { discard: true },
      ).pipe(Effect.mapError(fileError("write"))),
    removeEmptyDirectory: (path) =>
      once((client) => client["files.removeEmptyDirectory"]({ path })).pipe(
        Effect.mapError(fileError("rmdir")),
      ),
  };

  const stat = (path: string, noFollow: boolean) =>
    connection
      .idempotent((client) => client["fs.stat"](noFollow ? { path, noFollow } : { path }))
      .pipe(
        Effect.map(toFileInfo),
        Effect.mapError(toPlatformError(noFollow ? "lstat" : "stat", path)),
      );

  const readStream = (path: string, offset: number, chunkBytes: number | undefined) =>
    stream((client) =>
      client["fs.readStream"]({
        path,
        offset,
        ...(chunkBytes === undefined ? {} : { chunkBytes }),
      }),
    ).pipe(
      Stream.map((chunk) => chunk.data),
      Stream.mapError(toPlatformError("stream", path)),
    );

  const writeFile = Effect.fnUntraced(function* (
    path: string,
    data: Uint8Array,
    options?: {
      readonly flag?: FileSystem.OpenFlag | undefined;
      readonly mode?: number | undefined;
    },
  ) {
    const replaces = options?.flag === undefined || options.flag === "w";
    if (data.length <= WRITE_FRAME_BYTES) {
      const write = (client: Effect.Success<RunnerConnection["client"]>) =>
        client["fs.writeFile"]({
          path,
          data,
          ...(options?.flag === undefined ? {} : { flag: options.flag }),
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
        });
      return yield* (replaces ? connection.idempotent(write) : once(write)).pipe(
        Effect.mapError(toPlatformError("writeFile", path)),
      );
    }
    if (!replaces || options?.mode !== undefined) {
      return yield* PlatformError.badArgument({
        module: MODULE,
        method: "writeFile",
        description: "a large write must replace the file with its default mode",
      });
    }
    // Larger contents stream through a writer handle, one frame per chunk.
    const { handle } = yield* once((client) => client["fs.writeStream.open"]({ path })).pipe(
      Effect.mapError(toPlatformError("writeFile", path)),
    );
    yield* Effect.forEach(
      frames(data),
      (chunk, index) =>
        connection.idempotent((client) =>
          client["fs.writeStream.chunk"]({ handle, seq: index + 1, data: chunk }),
        ),
      { discard: true },
    ).pipe(
      Effect.andThen(connection.idempotent((client) => client["fs.writeStream.close"]({ handle }))),
      Effect.mapError(toPlatformError("writeFile", path)),
    );
  });

  const makeTempDirectory = (options?: {
    readonly directory?: string | undefined;
    readonly prefix?: string | undefined;
  }) =>
    once((client) =>
      client["fs.makeTempDirectory"]({
        ...(options?.directory === undefined ? {} : { directory: options.directory }),
        ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      }),
    ).pipe(Effect.mapError(toPlatformError("makeTempDirectory")));

  const remove = (
    path: string,
    options?: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined },
  ) => {
    const run = (client: Effect.Success<RunnerConnection["client"]>) =>
      client["fs.remove"]({
        path,
        ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
        ...(options?.force === undefined ? {} : { force: options.force }),
      });
    return (options?.force === true ? connection.idempotent(run) : once(run)).pipe(
      Effect.mapError(toPlatformError("remove", path)),
    );
  };

  const makeTempFile = Effect.fnUntraced(function* (options?: {
    readonly directory?: string | undefined;
    readonly prefix?: string | undefined;
    readonly suffix?: string | undefined;
  }) {
    const directory = yield* makeTempDirectory({
      directory: options?.directory,
      prefix: options?.prefix,
    });
    const file = `${directory}/${options?.prefix ?? "tmp"}${options?.suffix ?? ""}`;
    yield* writeFile(file, new Uint8Array(0));
    return file;
  });

  // A read-only file whose reads are ranged `fs.readFile` calls (02 open question 4).
  const openReadOnly = Effect.fnUntraced(function* (path: string) {
    yield* stat(path, false);
    let position = 0n;
    const readAt = (size: number, at: bigint) =>
      connection
        .idempotent((client) => client["fs.readFile"]({ path, offset: Number(at), maxBytes: size }))
        .pipe(Effect.mapError(toPlatformError("read", path)));
    const readAlloc = Effect.fnUntraced(function* (
      size: number,
      options?: FileSystem.File.ReadOptions,
    ) {
      const at = options?.position ?? position;
      const bytes = yield* readAt(size, at);
      if (options?.position === undefined) position = at + BigInt(bytes.length);
      return bytes.length === 0 && size > 0 ? Option.none() : Option.some(bytes);
    });
    const readOnly = (method: string) => Effect.fail(unsupported(method));
    return {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: stat(path, false),
      seek: (offset: bigint, from: FileSystem.SeekMode) =>
        Effect.sync(() => {
          position = from === "start" ? offset : position + offset;
          return position;
        }),
      sync: Effect.void,
      read: (buffer: Uint8Array, options?: FileSystem.File.ReadOptions) =>
        readAlloc(buffer.length, options).pipe(
          Effect.map((bytes) => {
            if (Option.isNone(bytes)) return 0;
            buffer.set(bytes.value);
            return bytes.value.length;
          }),
        ),
      readAlloc,
      truncate: () => readOnly("truncate"),
      write: () => readOnly("write"),
      writeAll: () => readOnly("writeAll"),
    } satisfies FileSystem.File;
  });

  const fileSystemImpl = FileSystem.make({
    access: (path) => stat(path, false).pipe(Effect.asVoid),
    copy: (fromPath, toPath, options) =>
      once((client) =>
        client["fs.copy"]({
          fromPath,
          toPath,
          ...(options?.overwrite === undefined ? {} : { overwrite: options.overwrite }),
          ...(options?.preserveTimestamps === undefined
            ? {}
            : { preserveTimestamps: options.preserveTimestamps }),
        }),
      ).pipe(Effect.mapError(toPlatformError("copy", fromPath))),
    copyFile: (fromPath, toPath) =>
      connection
        .idempotent((client) => client["fs.copy"]({ fromPath, toPath, overwrite: true }))
        .pipe(Effect.mapError(toPlatformError("copyFile", fromPath))),
    chmod: (path, mode) =>
      connection
        .idempotent((client) => client["fs.chmod"]({ path, mode }))
        .pipe(Effect.mapError(toPlatformError("chmod", path))),
    chown: () => Effect.fail(unsupported("chown")),
    link: () => Effect.fail(unsupported("link")),
    lstat: (path) => stat(path, true),
    makeDirectory: (path, options) => {
      const run = (client: Effect.Success<RunnerConnection["client"]>) =>
        client["fs.makeDirectory"]({
          path,
          ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
        });
      return (options?.recursive === true ? connection.idempotent(run) : once(run)).pipe(
        Effect.mapError(toPlatformError("makeDirectory", path)),
      );
    },
    makeTempDirectory,
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(makeTempDirectory(options), (directory) =>
        remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    makeTempFile,
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(makeTempFile(options), (file) =>
        remove(file.slice(0, file.lastIndexOf("/")), { recursive: true, force: true }).pipe(
          Effect.ignore,
        ),
      ),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r"
        ? openReadOnly(path)
        : Effect.fail(unsupported(`open(${options.flag})`)),
    readDirectory: (path, options) =>
      connection
        .idempotent((client) =>
          client["fs.readDirectory"](
            options?.recursive === undefined ? { path } : { path, recursive: options.recursive },
          ),
        )
        .pipe(
          Effect.map((names) => [...names]),
          Effect.mapError(toPlatformError("readDirectory", path)),
        ),
    readDirectoryEntries: (path) =>
      connection
        .idempotent((client) => client["files.readDirectory"]({ path }))
        .pipe(
          Effect.map((entries) =>
            entries.map((entry) => ({
              name: entry.name,
              type: entry.kind === "Other" ? ("Unknown" as const) : entry.kind,
            })),
          ),
          Effect.mapError(toPlatformError("readDirectoryEntries", path)),
        ),
    readFile: (path) =>
      readStream(path, 0, undefined).pipe(Stream.runCollect, Effect.map(concatBytes)),
    readLink: (path) =>
      connection
        .idempotent((client) => client["fs.readLink"]({ path }))
        .pipe(Effect.mapError(toPlatformError("readLink", path))),
    realPath: (path) =>
      connection
        .idempotent((client) => client["fs.realPath"]({ path }))
        .pipe(Effect.mapError(toPlatformError("realPath", path))),
    remove,
    rename: (oldPath, newPath) =>
      once((client) => client["fs.rename"]({ oldPath, newPath })).pipe(
        Effect.mapError(toPlatformError("rename", oldPath)),
      ),
    stat: (path) => stat(path, false),
    symlink: (fromPath, toPath) =>
      once((client) => client["fs.symlink"]({ fromPath, toPath })).pipe(
        Effect.mapError(toPlatformError("symlink", toPath)),
      ),
    truncate: () => Effect.fail(unsupported("truncate")),
    utimes: (path, atime, mtime) =>
      connection
        .idempotent((client) =>
          client["fs.utimes"]({
            path,
            // A number is seconds, as Node's `utimes` reads it.
            atime: typeof atime === "number" ? atime * 1000 : atime.getTime(),
            mtime: typeof mtime === "number" ? mtime * 1000 : mtime.getTime(),
          }),
        )
        .pipe(Effect.mapError(toPlatformError("utimes", path))),
    // The runner's first batch is empty: the watch is installed.
    watch: (path, options) =>
      stream((client) => client["fs.watch"]({ path, recursive: options?.recursive === true })).pipe(
        Stream.mapError(toPlatformError("watch", path)),
        Stream.tap((batch) =>
          batch.length === 0 ? Effect.sync(() => options?.onReady?.()) : Effect.void,
        ),
        Stream.flatMap((batch) => Stream.fromIterable(batch)),
      ),
    writeFile,
  });
  // One stream call instead of a ranged read per chunk.
  const fileSystem: FileSystem.FileSystem = {
    ...fileSystemImpl,
    stream: (path, options) => {
      const offset =
        options?.offset === undefined ? 0 : Number(ByteSize.fromInputUnsafe(options.offset));
      const source = readStream(path, offset, options?.chunkSize);
      if (options?.bytesToRead === undefined) return source;
      let left = Number(ByteSize.fromInputUnsafe(options.bytesToRead));
      return source.pipe(
        Stream.takeWhile(() => left > 0),
        Stream.map((chunk) => {
          const kept = chunk.subarray(0, left);
          left -= kept.length;
          return kept;
        }),
      );
    },
  };

  // Untraced: runs inside `ptySpawn`'s span.
  const openPty = Effect.fnUntraced(function* (
    input: PtyAdapter.PtySpawnInput,
    scope: Scope.Closeable,
  ) {
    const { handle, pid } = yield* once((client) =>
      client["pty.open"]({
        shell: input.shell,
        ...(input.args === undefined ? {} : { args: input.args }),
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: plainEnv(input.env),
        ...agentUser,
      }),
    );
    yield* Scope.addFinalizer(
      scope,
      connection.idempotent((client) => client["pty.release"]({ handle })).pipe(Effect.ignore),
    );
    const writer = yield* connection.ptyWriter(handle).pipe(Scope.provide(scope));
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
    // Held until the first listener, so output before `onData` is not lost.
    let pending: Array<string> | undefined = [];
    let exited: PtyAdapter.PtyExitEvent | undefined;
    const exit = (event: PtyAdapter.PtyExitEvent) =>
      Effect.sync(() => {
        if (exited !== undefined) return;
        exited = event;
        for (const listener of exitListeners) listener(event);
      });
    // A lost runner, or the host going, still ends the PTY for its listeners.
    const lost = { exitCode: 1, signal: null };
    yield* Effect.gen(function* () {
      yield* connection.output(handle, "pty").pipe(
        Stream.runForEach((data) =>
          Effect.sync(() => {
            if (pending !== undefined) pending.push(data);
            else for (const listener of dataListeners) listener(data);
          }),
        ),
        Effect.ignore,
      );
      yield* exit(
        yield* connection
          .idempotent((client) => client["pty.wait"]({ handle }))
          .pipe(Effect.orElseSucceed(() => lost)),
      );
    }).pipe(
      Effect.ensuring(exit(lost).pipe(Effect.andThen(Scope.close(scope, Exit.void)))),
      Effect.forkIn(hostScope),
    );
    return {
      pid,
      write: writer.write,
      resize: writer.resize,
      kill: (signal) =>
        writer.signal(signal !== undefined && isRunnerSignal(signal) ? signal : "SIGHUP"),
      onData: (listener) => {
        dataListeners.add(listener);
        if (pending !== undefined) {
          const buffered = pending;
          pending = undefined;
          for (const data of buffered) listener(data);
        }
        return () => dataListeners.delete(listener);
      },
      onExit: (listener) => {
        if (exited !== undefined) listener(exited);
        else exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    } satisfies PtyAdapter.PtyProcess;
  });

  const pty = PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("SandboxWorkspaceHost.ptySpawn")(
      function* (input) {
        // `PtyAdapter.spawn` is not scoped: each PTY lives until it exits or the host goes.
        const scope = yield* Scope.fork(hostScope);
        return yield* openPty(input, scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      },
      (effect, input) =>
        Effect.mapError(
          effect,
          (cause) =>
            new PtyAdapter.PtySpawnError({ adapter: "sandbox", shell: input.shell, cause }),
        ),
    ),
  });

  return {
    id,
    kind: "sandbox",
    info: Effect.succeed(info),
    spawner,
    fileSystem,
    pty,
    // The sandbox is its own scope (02 §1).
    agentScope: AgentScope.defaultValue(),
    files,
    spawnProcessGroup: () => {
      throw new Error("A sandbox host starts process groups through its spawner (1.12's bridge).");
    },
    processes: {
      // The sandbox's own `kill`, as root: a sandbox pid is never one of the server's.
      signalGroup: (pid, signal) =>
        (pid <= 1
          ? Effect.fail(Object.assign(new Error(`not a process group (${pid})`), { code: "ESRCH" }))
          : Effect.void
        ).pipe(
          Effect.andThen(
            once((client) =>
              client["process.run"]({
                command: "/bin/sh",
                args: [
                  "-c",
                  'kill -s "$1" -- "-$2"',
                  "t3-signal-group",
                  signal.slice(3),
                  String(pid),
                ],
                cwd: "/",
                env: plainEnv(info.environment),
              }),
            ),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  Object.assign(new Error(new TextDecoder().decode(result.stderr).trim()), {
                    code: /no such process/i.test(new TextDecoder().decode(result.stderr))
                      ? "ESRCH"
                      : undefined,
                  }),
                ),
          ),
          Effect.mapError(
            (cause) =>
              new WorkspaceHostError({ hostId: id, operation: "processes.signalGroup", cause }),
          ),
        ),
    },
    exposeServerEndpoint,
    invoke: connection.ops,
  } satisfies WorkspaceHost;
});
