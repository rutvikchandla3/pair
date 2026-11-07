import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  RunnerHandleId,
  RunnerLostError,
  RunnerSystemError,
  type RunnerCallError,
  type RunnerHandleState,
  type RunnerProcessExit,
  type RunnerProcessSpawnInput,
  type RunnerPtyExit,
  type RunnerPtyOpenInput,
  type RunnerSignal,
} from "@t3tools/contracts/runner";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import * as GroupWatcher from "./GroupWatcher.ts";

/** Output streams by `RunnerHandleState.next` key. */
export type StreamKey = `fd:${number}` | "pty";
/** Input channels by `RunnerHandleState.next` key; `in:file` is an `fs.writeStream` handle. */
export type InputKey = `in:${number}` | "in:pty" | "in:file";

export type InputOp =
  | { readonly _tag: "data"; readonly data: Uint8Array | string }
  | { readonly _tag: "close" }
  | { readonly _tag: "resize"; readonly cols: number; readonly rows: number }
  | { readonly _tag: "signal"; readonly signal: RunnerSignal };

export type ExitInfo =
  | { readonly _tag: "process"; readonly exit: RunnerProcessExit }
  | { readonly _tag: "pty"; readonly exit: RunnerPtyExit };

export interface OutputChunk<A extends Uint8Array | string> {
  readonly seq: number;
  readonly data: A;
}

type OutputData<K extends StreamKey> = K extends "pty" ? string : Uint8Array;

export const toSystemError = (error: PlatformError.PlatformError): RunnerSystemError => {
  const reason = error.reason;
  return new RunnerSystemError({
    reason: reason._tag === "BadArgument" ? "BadArgument" : reason._tag,
    module: reason.module,
    method: reason.method,
    ...(reason.description === undefined ? {} : { description: reason.description }),
    ...(reason._tag !== "BadArgument" && reason.syscall !== undefined
      ? { syscall: reason.syscall }
      : {}),
    ...(reason._tag !== "BadArgument" && reason.pathOrDescriptor !== undefined
      ? { pathOrDescriptor: reason.pathOrDescriptor }
      : {}),
  });
};

export const runnerBadArgument = (method: string, description: string) =>
  new RunnerSystemError({ reason: "BadArgument", module: "Runner", method, description });

const signalError = (method: string, cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new RunnerSystemError({
    reason: code === "ESRCH" ? "NotFound" : code === "EPERM" ? "PermissionDenied" : "Unknown",
    module: "Runner",
    method,
    description: cause instanceof Error ? cause.message : String(cause),
    ...(code === undefined ? {} : { syscall: "kill" }),
  });
};

const signalPid = (method: string, pid: number, signal: RunnerSignal) =>
  Effect.try({
    try: () => {
      process.kill(pid, signal);
    },
    catch: (cause) => signalError(method, cause),
  });

const sliceFrom = <A extends Uint8Array | string>(data: A, offset: number): A =>
  (typeof data === "string" ? data.slice(offset) : data.subarray(offset)) as A;

/**
 * One output stream's bytes (or UTF-16 units), stamped with their offset. Readers never hold the
 * handle's scope. It frees only below the latest `fromSeq` asked for; 1.8 bounds it.
 */
class OutputBuffer<A extends Uint8Array | string> {
  private chunks: Array<OutputChunk<A>> = [];
  private baseSeq = 0;
  nextSeq = 0;
  private eof = false;
  private lost: RunnerLostError | undefined;
  private wake = Deferred.makeUnsafe<void>();
  readonly ended = Deferred.makeUnsafe<void>();

  push(data: A): void {
    if (data.length === 0) return;
    this.chunks.push({ seq: this.nextSeq, data });
    this.nextSeq += data.length;
    this.notify();
  }

  end(): void {
    this.eof = true;
    Deferred.doneUnsafe(this.ended, Exit.void);
    this.notify();
  }

  fail(error: RunnerLostError): void {
    this.lost ??= error;
    this.notify();
  }

  read(handle: RunnerHandleId, fromSeq: number): Stream.Stream<OutputChunk<A>, RunnerLostError> {
    return Stream.suspend(() => {
      if (fromSeq < this.baseSeq) {
        return Stream.fail(new RunnerLostError({ reason: "resume-behind-buffer", handle }));
      }
      this.freeBelow(Math.min(fromSeq, this.nextSeq));
      return Stream.paginate(fromSeq, (cursor) => Effect.suspend(() => this.pull(handle, cursor)));
    });
  }

  private pull(
    handle: RunnerHandleId,
    cursor: number,
  ): Effect.Effect<
    readonly [ReadonlyArray<OutputChunk<A>>, Option.Option<number>],
    RunnerLostError
  > {
    if (this.lost !== undefined) return Effect.fail(this.lost);
    if (cursor < this.baseSeq) {
      return Effect.fail(new RunnerLostError({ reason: "resume-behind-buffer", handle }));
    }
    const out: Array<OutputChunk<A>> = [];
    for (let index = this.firstChunkEndingAfter(cursor); index < this.chunks.length; index++) {
      const chunk = this.chunks[index]!;
      const offset = Math.max(0, cursor - chunk.seq);
      out.push(offset === 0 ? chunk : { seq: cursor, data: sliceFrom(chunk.data, offset) });
    }
    if (out.length > 0) return Effect.succeed([out, Option.some(this.nextSeq)] as const);
    if (this.eof) return Effect.succeed([[], Option.none()] as const);
    return Deferred.await(this.wake).pipe(Effect.as([[], Option.some(cursor)] as const));
  }

  private firstChunkEndingAfter(seq: number): number {
    let low = 0;
    let high = this.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const chunk = this.chunks[middle]!;
      if (chunk.seq + chunk.data.length <= seq) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private freeBelow(seq: number): void {
    if (seq <= this.baseSeq) return;
    const keep = this.firstChunkEndingAfter(seq);
    this.chunks = this.chunks.slice(keep);
    const first = this.chunks[0];
    if (first !== undefined && first.seq < seq) {
      this.chunks[0] = { seq, data: sliceFrom(first.data, seq - first.seq) };
    }
    this.baseSeq = seq;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(wake, Exit.void);
  }
}

interface InputChannel {
  appliedThrough: number;
  closed: boolean;
  readonly lock: Semaphore.Semaphore;
  readonly apply: (op: InputOp) => Effect.Effect<void, RunnerSystemError>;
}

interface Entry {
  readonly kind: "process" | "pty" | "file";
  readonly scope: Scope.Closeable;
  readonly pid: number;
  readonly outputs: ReadonlyMap<StreamKey, OutputBuffer<Uint8Array> | OutputBuffer<string>>;
  readonly inputs: ReadonlyMap<InputKey, InputChannel>;
  readonly exit: Deferred.Deferred<ExitInfo, RunnerLostError>;
  /** `fs.writeStream.close`: close the file and, when atomic, rename it into place. */
  readonly commit: Effect.Effect<void, RunnerSystemError>;
}

const makeInput = (apply: InputChannel["apply"]): InputChannel => ({
  appliedThrough: 0,
  closed: false,
  lock: Semaphore.makeUnsafe(1),
  apply,
});

export class HandleTable extends Context.Service<
  HandleTable,
  {
    /** Minted per runner process: handle ids from any other boot are unknown. */
    readonly runnerBootId: string;
    readonly spawn: (
      input: RunnerProcessSpawnInput,
    ) => Effect.Effect<{ readonly handle: RunnerHandleId; readonly pid: number }, RunnerCallError>;
    readonly openPty: (
      input: RunnerPtyOpenInput,
    ) => Effect.Effect<{ readonly handle: RunnerHandleId; readonly pid: number }, RunnerCallError>;
    readonly openFileWriter: (input: {
      readonly path: string;
      readonly atomic: boolean;
    }) => Effect.Effect<RunnerHandleId, RunnerCallError>;
    readonly closeFileWriter: (handle: RunnerHandleId) => Effect.Effect<void, RunnerCallError>;
    /** Units from `fromSeq`; ends after the source's EOF is read. Never holds the handle's scope. */
    readonly output: <K extends StreamKey>(
      handle: RunnerHandleId,
      stream: K,
      fromSeq: number,
    ) => Stream.Stream<OutputChunk<OutputData<K>>, RunnerCallError>;
    /** Applies `seq` once, in order (seqs start at 1); answers the last applied seq. */
    readonly write: (
      handle: RunnerHandleId,
      input: InputKey,
      seq: number,
      op: InputOp,
    ) => Effect.Effect<number, RunnerCallError>;
    readonly signal: (
      handle: RunnerHandleId,
      signal: RunnerSignal,
      group: boolean,
    ) => Effect.Effect<void, RunnerCallError>;
    /** Resolves after the exit and the EOF of every output stream. */
    readonly wait: (handle: RunnerHandleId) => Effect.Effect<ExitInfo, RunnerLostError>;
    /** Kills the handle's group and frees its buffers. Idempotent. */
    readonly release: (handle: RunnerHandleId) => Effect.Effect<void>;
    /** SIGTERM to every group, SIGKILL after `graceMs`; then refuses new work. */
    readonly drain: (graceMs: number) => Effect.Effect<void>;
    readonly live: Effect.Effect<ReadonlyArray<RunnerHandleState>>;
    readonly exited: Stream.Stream<RunnerHandleId>;
  }
>()("t3/sandbox/runner/HandleTable") {}

const make = Effect.fn("HandleTable.make")(function* () {
  const tableScope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const fs = yield* FileSystem.FileSystem;
  const runnerBootId = SecureRandom.uuidV4Unsafe();
  const exits = yield* PubSub.unbounded<RunnerHandleId>();
  const entries = new Map<RunnerHandleId, Entry>();
  let counter = 0;
  let drained = false;

  const lostError = (handle: RunnerHandleId) =>
    new RunnerLostError({ reason: drained ? "drained" : "runner-restarted", handle });

  const lookup = (handle: RunnerHandleId) =>
    Effect.suspend(() => {
      const entry = entries.get(handle);
      return entry === undefined ? Effect.fail(lostError(handle)) : Effect.succeed(entry);
    });

  /** A fresh id and a scope owned by the table, never by the calling RPC fiber. */
  const allocate = Effect.suspend(() => {
    if (drained) return Effect.fail(new RunnerLostError({ reason: "drained" }));
    counter += 1;
    const handle = RunnerHandleId.make(`${runnerBootId}:${counter}`);
    return Scope.fork(tableScope, "sequential").pipe(Effect.map((scope) => ({ handle, scope })));
  });

  const register = <A, E, R>(
    allocated: { readonly handle: RunnerHandleId; readonly scope: Scope.Closeable },
    build: Effect.Effect<readonly [Entry, A], E, R>,
  ) =>
    build.pipe(
      Effect.map(([entry, result]) => {
        entries.set(allocated.handle, entry);
        return result;
      }),
      Effect.onError(() => Scope.close(allocated.scope, Exit.void)),
    );

  const finish =
    (handle: RunnerHandleId, exit: Deferred.Deferred<ExitInfo, RunnerLostError>) =>
    (info: ExitInfo) => {
      Deferred.doneUnsafe(exit, Exit.succeed(info));
      PubSub.publishUnsafe(exits, handle);
    };

  const pump = (
    scope: Scope.Scope,
    buffer: OutputBuffer<Uint8Array>,
    source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) =>
    Stream.runForEach(source, (chunk) => Effect.sync(() => buffer.push(chunk))).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => buffer.end())),
      Effect.forkIn(scope),
    );

  const spawn: HandleTable["Service"]["spawn"] = Effect.fn("HandleTable.spawn")(function* (input) {
    const allocated = yield* allocate;
    return yield* register(
      allocated,
      Effect.gen(function* () {
        const inputs = new Map<InputKey, InputChannel>();
        const inputQueues: Array<Queue.Queue<Uint8Array, Cause.Done>> = [];
        const inputStream = Effect.fnUntraced(function* (key: InputKey) {
          const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          inputQueues.push(queue);
          inputs.set(
            key,
            makeInput((op) =>
              op._tag === "close"
                ? Queue.end(queue).pipe(Effect.asVoid)
                : op._tag === "data" && typeof op.data !== "string"
                  ? Queue.offer(queue, op.data).pipe(Effect.asVoid)
                  : Effect.fail(
                      runnerBadArgument("process.write", `${op._tag} is not a pipe write`),
                    ),
            ),
          );
          return Stream.fromQueue(queue);
        });

        const additionalFds: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {};
        for (const extra of input.extraFds) {
          additionalFds[`fd${extra.fd}`] =
            extra.direction === "input"
              ? { type: "input", stream: yield* inputStream(`in:${extra.fd}`) }
              : { type: "output" };
        }
        const stdin = input.stdin === "pipe" ? yield* inputStream("in:0") : "ignore";

        const child = yield* GroupWatcher.spawnWatched({
          command: input.command,
          args: input.args,
          uid: input.uid,
          gid: input.gid,
          cwd: input.cwd,
          env: input.env,
          stdin,
          stdout: input.stdout,
          stderr: input.stderr,
          additionalFds,
          killSignal: input.killSignal,
          forceKillAfterMs: input.forceKillAfterMs,
        }).pipe(
          Scope.provide(allocated.scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(toSystemError),
        );

        const outputs = new Map<StreamKey, OutputBuffer<Uint8Array>>();
        const sources: Array<
          readonly [StreamKey, Stream.Stream<Uint8Array, PlatformError.PlatformError>]
        > = [];
        if (input.stdout === "pipe") sources.push(["fd:1", child.stdout]);
        if (input.stderr === "pipe") sources.push(["fd:2", child.stderr]);
        for (const extra of input.extraFds) {
          if (extra.direction === "output") {
            sources.push([`fd:${extra.fd}`, child.getOutputFd(extra.fd)]);
          }
        }
        for (const [key, source] of sources) {
          const buffer = new OutputBuffer<Uint8Array>();
          outputs.set(key, buffer);
          yield* pump(allocated.scope, buffer, source);
        }

        const exit = yield* Deferred.make<ExitInfo, RunnerLostError>();
        // Outside the handle's scope, so a release still reports the exit it caused.
        yield* GroupWatcher.exitOf(child).pipe(
          Effect.tap(() =>
            Effect.forEach(outputs.values(), (buffer) => Deferred.await(buffer.ended)),
          ),
          Effect.tap(() => Effect.forEach(inputQueues, (queue) => Queue.end(queue))),
          Effect.flatMap((info) =>
            Effect.sync(() => finish(allocated.handle, exit)({ _tag: "process", exit: info })),
          ),
          Effect.forkIn(tableScope),
        );

        const entry: Entry = {
          kind: "process",
          scope: allocated.scope,
          pid: child.pid,
          outputs,
          inputs,
          exit,
          commit: Effect.fail(runnerBadArgument("fs.writeStream.close", "not a file writer")),
        };
        return [entry, { handle: allocated.handle, pid: child.pid }] as const;
      }),
    );
  });

  const openPty: HandleTable["Service"]["openPty"] = Effect.fn("HandleTable.openPty")(
    function* (input) {
      const allocated = yield* allocate;
      return yield* register(
        allocated,
        Effect.gen(function* () {
          const arm = yield* GroupWatcher.watchGroup().pipe(
            Scope.provide(allocated.scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(toSystemError),
          );
          const [shell, args] = GroupWatcher.commandLine({
            command: input.shell,
            args: input.args ?? [],
            uid: input.uid,
            gid: input.gid,
          });
          const pty = yield* ptyAdapter
            .spawn({
              shell,
              args,
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: input.env,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new RunnerSystemError({
                    reason: "Unknown",
                    module: "Pty",
                    method: "spawn",
                    description: error.message,
                  }),
              ),
            );
          // Listen before any await: node-pty drops output emitted with no listener.
          const buffer = new OutputBuffer<string>();
          const exit = Deferred.makeUnsafe<ExitInfo, RunnerLostError>();
          const stopData = pty.onData((data) => buffer.push(data));
          pty.onExit((event) => {
            stopData();
            buffer.end();
            finish(
              allocated.handle,
              exit,
            )({
              _tag: "pty",
              exit: { exitCode: event.exitCode, signal: event.signal },
            });
          });
          // node-pty makes the shell a session leader, so its pid is its group.
          yield* arm(pty.pid).pipe(Effect.mapError(toSystemError));
          // Interactive shells ignore TERM; HUP ends them and the jobs they started.
          yield* Scope.addFinalizer(
            allocated.scope,
            Effect.ignore(signalPid("pty.release", -pty.pid, "SIGHUP")),
          );

          yield* Scope.addFinalizer(
            allocated.scope,
            Effect.sync(() => {
              stopData();
              buffer.end();
            }),
          );

          const inputs = new Map<InputKey, InputChannel>([
            [
              "in:pty",
              makeInput((op) =>
                Effect.try({
                  try: () => {
                    switch (op._tag) {
                      case "data":
                        if (typeof op.data !== "string") throw new Error("PTY input is text");
                        pty.write(op.data);
                        return;
                      case "resize":
                        pty.resize(op.cols, op.rows);
                        return;
                      case "signal":
                        pty.kill(op.signal);
                        return;
                      case "close":
                        throw new Error("a PTY has no input to close");
                    }
                  },
                  catch: (cause) => signalError("pty.input", cause),
                }),
              ),
            ],
          ]);
          const entry: Entry = {
            kind: "pty",
            scope: allocated.scope,
            pid: pty.pid,
            outputs: new Map([["pty", buffer]]),
            inputs,
            exit,
            commit: Effect.fail(runnerBadArgument("fs.writeStream.close", "not a file writer")),
          };
          return [entry, { handle: allocated.handle, pid: pty.pid }] as const;
        }),
      );
    },
  );

  const openFileWriter: HandleTable["Service"]["openFileWriter"] = Effect.fn(
    "HandleTable.openFileWriter",
  )(function* (input) {
    const allocated = yield* allocate;
    return yield* register(
      allocated,
      Effect.gen(function* () {
        const target = input.atomic
          ? `${input.path}.t3tmp-${SecureRandom.uuidV4Unsafe()}`
          : input.path;
        let committed = false;
        if (input.atomic) {
          yield* Scope.addFinalizer(
            allocated.scope,
            Effect.suspend(() =>
              committed ? Effect.void : fs.remove(target, { force: true }).pipe(Effect.ignore),
            ),
          );
        }
        const file = yield* fs
          .open(target, { flag: "w" })
          .pipe(Scope.provide(allocated.scope), Effect.mapError(toSystemError));
        const commit = Effect.suspend(() => {
          committed = true;
          return Scope.close(allocated.scope, Exit.void);
        }).pipe(
          Effect.andThen(
            input.atomic
              ? fs.rename(target, input.path).pipe(
                  Effect.tapError(() => fs.remove(target, { force: true }).pipe(Effect.ignore)),
                  Effect.mapError(toSystemError),
                )
              : Effect.void,
          ),
        );
        const entry: Entry = {
          kind: "file",
          scope: allocated.scope,
          pid: 0,
          outputs: new Map(),
          inputs: new Map([
            [
              "in:file",
              makeInput((op) =>
                op._tag === "data" && typeof op.data !== "string"
                  ? file.writeAll(op.data).pipe(Effect.mapError(toSystemError))
                  : Effect.fail(runnerBadArgument("fs.writeStream.chunk", "expected bytes")),
              ),
            ],
          ]),
          exit: yield* Deferred.make<ExitInfo, RunnerLostError>(),
          commit,
        };
        return [entry, allocated.handle] as const;
      }),
    );
  });

  const closeFileWriter: HandleTable["Service"]["closeFileWriter"] = (handle) =>
    lookup(handle).pipe(
      Effect.tap(() => Effect.sync(() => entries.delete(handle))),
      Effect.flatMap((entry) => entry.commit),
    );

  const output: HandleTable["Service"]["output"] = (handle, key, fromSeq) =>
    Stream.unwrap(
      lookup(handle).pipe(
        Effect.flatMap((entry) => {
          const buffer = entry.outputs.get(key);
          return buffer === undefined
            ? Effect.fail(runnerBadArgument("output", `${key} is not an output of ${handle}`))
            : Effect.succeed(
                buffer.read(handle, fromSeq) as unknown as Stream.Stream<
                  OutputChunk<OutputData<typeof key>>,
                  RunnerLostError
                >,
              );
        }),
      ),
    );

  const write: HandleTable["Service"]["write"] = (handle, key, seq, op) =>
    lookup(handle).pipe(
      Effect.flatMap((entry) => {
        const channel = entry.inputs.get(key);
        if (channel === undefined) {
          return Effect.fail(runnerBadArgument("write", `${key} is not an input of ${handle}`));
        }
        return channel.lock.withPermit(
          Effect.suspend(() => {
            if (seq <= channel.appliedThrough) return Effect.succeed(channel.appliedThrough);
            if (seq !== channel.appliedThrough + 1) {
              return Effect.fail(
                runnerBadArgument("write", `seq ${seq} skips ${channel.appliedThrough + 1}`),
              );
            }
            if (channel.closed) {
              return Effect.fail(runnerBadArgument("write", `${key} is closed`));
            }
            return channel.apply(op).pipe(
              Effect.map(() => {
                channel.appliedThrough = seq;
                if (op._tag === "close") channel.closed = true;
                return seq;
              }),
            );
          }),
        );
      }),
    );

  const signal: HandleTable["Service"]["signal"] = (handle, sig, group) =>
    lookup(handle).pipe(
      Effect.flatMap((entry) =>
        entry.kind === "file"
          ? Effect.fail(runnerBadArgument("signal", `${handle} is not a process`))
          : signalPid("process.signal", group ? -entry.pid : entry.pid, sig),
      ),
    );

  const wait: HandleTable["Service"]["wait"] = (handle) =>
    lookup(handle).pipe(Effect.flatMap((entry) => Deferred.await(entry.exit)));

  const closeEntry = (handle: RunnerHandleId, entry: Entry, error: RunnerLostError) =>
    Effect.suspend(() => {
      entries.delete(handle);
      for (const buffer of entry.outputs.values()) buffer.fail(error);
      return Scope.close(entry.scope, Exit.void);
    });

  const release: HandleTable["Service"]["release"] = (handle) =>
    Effect.suspend(() => {
      const entry = entries.get(handle);
      return entry === undefined
        ? Effect.void
        : closeEntry(handle, entry, new RunnerLostError({ reason: "runner-restarted", handle }));
    });

  const drain: HandleTable["Service"]["drain"] = Effect.fn("HandleTable.drain")(
    function* (graceMs) {
      drained = true;
      const live = [...entries].filter(([, entry]) => entry.kind !== "file");
      for (const [, entry] of live) yield* Effect.ignore(signalPid("drain", -entry.pid, "SIGTERM"));
      yield* Effect.forEach(live, ([, entry]) => Deferred.await(entry.exit), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.ignore, Effect.timeoutOption(graceMs));
      for (const [, entry] of live) yield* Effect.ignore(signalPid("drain", -entry.pid, "SIGKILL"));
      for (const [handle, entry] of entries) {
        const error = new RunnerLostError({ reason: "drained", handle });
        yield* Deferred.fail(entry.exit, error);
        yield* closeEntry(handle, entry, error);
      }
    },
  );

  const live: HandleTable["Service"]["live"] = Effect.sync(() =>
    [...entries].map(([handle, entry]) => {
      const next: Record<string, number> = {};
      for (const [key, buffer] of entry.outputs) next[key] = buffer.nextSeq;
      for (const [key, channel] of entry.inputs) next[key] = channel.appliedThrough;
      return { handle, next };
    }),
  );

  return HandleTable.of({
    runnerBootId,
    spawn,
    openPty,
    openFileWriter,
    closeFileWriter,
    output,
    write,
    signal,
    wait,
    release,
    drain,
    live,
    exited: Stream.fromPubSub(exits),
  });
});

export const layer = Layer.effect(HandleTable, make());
