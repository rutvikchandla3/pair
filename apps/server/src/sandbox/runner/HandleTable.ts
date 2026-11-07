import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
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
  type RunnerEvent,
  type RunnerHandleState,
  type RunnerLimits,
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

const sliceFrom = <A extends Uint8Array | string>(data: A, offset: number, end?: number): A =>
  (typeof data === "string" ? data.slice(offset, end) : data.subarray(offset, end)) as A;

const concat = <A extends Uint8Array | string>(parts: ReadonlyArray<A>): A => {
  if (parts.length === 1) return parts[0]!;
  if (typeof parts[0] === "string") return parts.join("") as A;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts as ReadonlyArray<Uint8Array>) {
    out.set(part, offset);
    offset += part.length;
  }
  return out as A;
};

/** One `output` element holds at most this much (03 4.5 batching). */
const BATCH_UNITS = 64 * 1024;
/** Lease expiry: SIGTERM every group, SIGKILL this long after. */
const LEASE_KILL_GRACE_MS = 10_000;

/** The hub's values; a runner uses them until its first `runner.hello` says otherwise. */
const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  windowBytes: 256 * 1024,
  windowChunks: 16,
  handleBufferBytes: 4 * 1024 * 1024,
  ptyBufferBytes: 1024 * 1024,
  sandboxBufferBytes: 64 * 1024 * 1024,
};

export interface RunnerPressure {
  readonly bufferedBytes: number;
  readonly pausedHandles: number;
}

export interface RunnerBufferStats extends RunnerPressure {
  readonly highWater: number;
  readonly pausedMs: number;
}

/**
 * Table-wide accounting of unsent output. A buffer pauses its source at its own limit and every
 * source pauses at the sandbox cap; each resumes below half (03 4.5).
 */
class Flow {
  limits = DEFAULT_RUNNER_LIMITS;
  unsent = 0;
  highWater = 0;
  sandboxPaused = false;
  pausedHandles = 0;
  pausedMsTotal = 0;
  readonly buffers = new Set<OutputBuffer<Uint8Array | string>>();

  readonly now: () => number;
  private readonly publish: (pressure: RunnerPressure) => void;

  constructor(now: () => number, publish: (pressure: RunnerPressure) => void) {
    this.now = now;
    this.publish = publish;
  }

  added(buffer: OutputBuffer<Uint8Array | string>, delta: number): void {
    this.unsent += delta;
    if (this.unsent > this.highWater) this.highWater = this.unsent;
    this.evaluate(buffer);
  }

  evaluate(buffer?: OutputBuffer<Uint8Array | string>): void {
    const cap = this.limits.sandboxBufferBytes;
    let all = buffer === undefined;
    if (!this.sandboxPaused && cap > 0 && this.unsent >= cap) {
      this.sandboxPaused = all = true;
    } else if (this.sandboxPaused && this.unsent < cap / 2) {
      this.sandboxPaused = false;
      all = true;
    }
    const before = this.pausedHandles;
    if (all) for (const each of this.buffers) each.settle(this.sandboxPaused);
    else buffer?.settle(this.sandboxPaused);
    if (all || this.pausedHandles !== before) {
      this.publish({ bufferedBytes: this.unsent, pausedHandles: this.pausedHandles });
    }
  }

  pausedMs(): number {
    let total = this.pausedMsTotal;
    const now = this.now();
    for (const buffer of this.buffers) if (buffer.paused) total += now - buffer.pausedAt;
    return total;
  }
}

/**
 * One output stream's bytes (or UTF-16 units), stamped with their offset. Readers never hold the
 * handle's scope. It keeps every unit the newest reader has not taken plus a tail of taken ones
 * that covers what the window and one batch can have in flight, so a resume never falls behind.
 */
class OutputBuffer<A extends Uint8Array | string> {
  private chunks: Array<OutputChunk<A> | undefined> = [];
  private head = 0;
  private baseSeq = 0;
  nextSeq = 0;
  private cursor = 0;
  private confirmed = 0;
  private reader = 0;
  private eof = false;
  private lost: RunnerLostError | undefined;
  private wake = Deferred.makeUnsafe<void>();
  readonly ended = Deferred.makeUnsafe<void>();
  private overLimit = false;
  paused = false;
  pausedAt = 0;
  /** Open while the source may be read. */
  readonly gate = Latch.makeUnsafe(true);

  private readonly flow: Flow;
  private readonly limit: (limits: RunnerLimits) => number;
  private readonly onPause: (paused: boolean) => void;

  constructor(
    flow: Flow,
    limit: (limits: RunnerLimits) => number,
    onPause: (paused: boolean) => void = () => undefined,
  ) {
    this.flow = flow;
    this.limit = limit;
    this.onPause = onPause;
    flow.buffers.add(this as OutputBuffer<Uint8Array | string>);
  }

  private get self(): OutputBuffer<Uint8Array | string> {
    return this as OutputBuffer<Uint8Array | string>;
  }

  push(data: A): void {
    if (data.length === 0 || this.lost !== undefined) return;
    this.chunks.push({ seq: this.nextSeq, data });
    this.nextSeq += data.length;
    this.flow.added(this.self, data.length);
    this.notify();
  }

  end(): void {
    this.eof = true;
    Deferred.doneUnsafe(this.ended, Exit.void);
    this.flow.evaluate(this.self);
    this.notify();
  }

  /** Fails every reader, frees the buffer and lets the source run to EOF unread. */
  discard(error: RunnerLostError): void {
    this.lost ??= error;
    this.chunks = [];
    this.head = 0;
    const unsent = this.nextSeq - this.cursor;
    this.cursor = this.nextSeq;
    this.flow.added(this.self, -unsent);
    this.settle(false);
    this.flow.buffers.delete(this.self);
    this.notify();
  }

  /** Recomputes the pause from this buffer's limit and the sandbox cap. */
  settle(sandboxPaused: boolean): void {
    const limit = this.limit(this.flow.limits);
    const unsent = this.nextSeq - this.cursor;
    if (!this.overLimit && limit > 0 && unsent >= limit) this.overLimit = true;
    else if (this.overLimit && unsent < limit / 2) this.overLimit = false;
    const paused = !this.eof && this.lost === undefined && (this.overLimit || sandboxPaused);
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pausedAt = this.flow.now();
      this.flow.pausedHandles += 1;
      this.gate.closeUnsafe();
    } else {
      this.flow.pausedMsTotal += this.flow.now() - this.pausedAt;
      this.flow.pausedHandles -= 1;
      this.gate.openUnsafe();
    }
    this.onPause(paused);
  }

  read(handle: RunnerHandleId, fromSeq: number): Stream.Stream<OutputChunk<A>, RunnerLostError> {
    return Stream.suspend(() => {
      if (this.lost !== undefined) return Stream.fail(this.lost);
      if (fromSeq < this.baseSeq || fromSeq > this.nextSeq) {
        return Stream.fail(new RunnerLostError({ reason: "resume-behind-buffer", handle }));
      }
      // The server holds everything below `fromSeq`, and this reader replaces any older one.
      const reader = ++this.reader;
      this.confirmed = fromSeq;
      const delta = this.cursor - fromSeq;
      this.cursor = fromSeq;
      this.flow.added(this.self, delta);
      this.trim();
      return Stream.paginate(fromSeq, (cursor) =>
        Effect.suspend(() => this.pull(handle, reader, cursor)),
      );
    });
  }

  private pull(
    handle: RunnerHandleId,
    reader: number,
    cursor: number,
  ): Effect.Effect<
    readonly [ReadonlyArray<OutputChunk<A>>, Option.Option<number>],
    RunnerLostError
  > {
    if (this.lost !== undefined) return Effect.fail(this.lost);
    if (cursor < this.baseSeq) {
      return Effect.fail(new RunnerLostError({ reason: "resume-behind-buffer", handle }));
    }
    if (cursor < this.nextSeq) {
      const parts: Array<A> = [];
      let end = cursor;
      for (
        let index = this.firstChunkEndingAfter(cursor);
        index < this.chunks.length && end - cursor < BATCH_UNITS;
        index++
      ) {
        const chunk = this.chunks[index]!;
        const from = end - chunk.seq;
        const to = Math.min(chunk.data.length, from + BATCH_UNITS - (end - cursor));
        parts.push(
          from === 0 && to === chunk.data.length ? chunk.data : sliceFrom(chunk.data, from, to),
        );
        end += to - from;
      }
      if (reader === this.reader && end > this.cursor) {
        const taken = end - this.cursor;
        this.cursor = end;
        this.flow.added(this.self, -taken);
        this.trim();
      }
      return Effect.succeed([[{ seq: cursor, data: concat(parts) }], Option.some(end)] as const);
    }
    if (this.eof) return Effect.succeed([[], Option.none()] as const);
    return Deferred.await(this.wake).pipe(Effect.as([[], Option.some(cursor)] as const));
  }

  private firstChunkEndingAfter(seq: number): number {
    let low = this.head;
    let high = this.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const chunk = this.chunks[middle]!;
      if (chunk.seq + chunk.data.length <= seq) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Frees whole chunks below the tail; unsent units are never freed. */
  private trim(): void {
    const tail = this.flow.limits.windowBytes + 2 * BATCH_UNITS;
    const floor = Math.min(this.cursor, Math.max(this.confirmed, this.cursor - tail));
    let head = this.head;
    while (head < this.chunks.length) {
      const chunk = this.chunks[head]!;
      if (chunk.seq + chunk.data.length > floor) break;
      this.chunks[head] = undefined;
      head += 1;
    }
    if (head === this.head) return;
    this.head = head;
    this.baseSeq = this.chunks[head]?.seq ?? this.nextSeq;
    if (head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(head);
      this.head = 0;
    }
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
    /**
     * Answers `runner.hello`: takes its lease and limits and returns the boot id and live handles.
     * A new `serverBootId` first kills every handle of the old one and mints a new boot id.
     */
    readonly hello: (input: {
      readonly serverBootId: string;
      readonly leaseMs: number;
      readonly limits: RunnerLimits;
    }) => Effect.Effect<{
      readonly runnerBootId: string;
      readonly handles: ReadonlyArray<RunnerHandleState>;
    }>;
    /**
     * Wraps one socket's life. When the last socket ends the lease starts; a hello stops it, and
     * expiry kills every group and mints a new boot id, so each boot id attaches once.
     */
    readonly session: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
    /** The current limits; the output window reads them per chunk. */
    readonly limits: () => RunnerLimits;
    /** `handle.exited`, and `resource.pressure` whenever the paused set changes. */
    readonly events: Stream.Stream<RunnerEvent>;
    /** The current pressure, then each change. */
    readonly pressure: Stream.Stream<RunnerPressure>;
    readonly stats: Effect.Effect<RunnerBufferStats>;
  }
>()("t3/sandbox/runner/HandleTable") {}

const fdLimit = (limits: RunnerLimits) => limits.handleBufferBytes;
const ptyLimit = (limits: RunnerLimits) => limits.ptyBufferBytes;

const make = Effect.fn("HandleTable.make")(function* () {
  const tableScope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const fs = yield* FileSystem.FileSystem;
  const clock = yield* Clock.Clock;
  let runnerBootId = SecureRandom.uuidV4Unsafe();
  const events = yield* PubSub.unbounded<RunnerEvent>();
  const pressure = yield* PubSub.unbounded<RunnerPressure>({ replay: 1 });
  const flow = new Flow(
    () => clock.currentTimeMillisUnsafe(),
    (current) => {
      PubSub.publishUnsafe(pressure, current);
      PubSub.publishUnsafe(events, { _tag: "resource.pressure", ...current });
    },
  );
  PubSub.publishUnsafe(pressure, { bufferedBytes: 0, pausedHandles: 0 });
  const entries = new Map<RunnerHandleId, Entry>();
  let counter = 0;
  let drained = false;
  let serverBootId: string | undefined;
  let leaseMs: number | undefined;
  let lease: Fiber.Fiber<void> | undefined;
  let sockets = 0;
  // Boot changes (hello, lease expiry, drain) run one at a time.
  const bootLocked = Semaphore.withPermit(Semaphore.makeUnsafe(1));

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
      PubSub.publishUnsafe(events, { _tag: "handle.exited", handle });
    };

  const pump = (
    scope: Scope.Scope,
    buffer: OutputBuffer<Uint8Array>,
    source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) =>
    // Waiting on the gate stops reading the pipe, so a paused child blocks on its write.
    Stream.runForEach(source, (chunk) =>
      Effect.andThen(
        Effect.sync(() => buffer.push(chunk)),
        buffer.gate.await,
      ),
    ).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => buffer.end())), Effect.forkIn(scope));

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
          const buffer = new OutputBuffer<Uint8Array>(flow, fdLimit);
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
          const buffer = new OutputBuffer<string>(flow, ptyLimit, (paused) =>
            paused ? pty.pause?.() : pty.resume?.(),
          );
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
      for (const buffer of entry.outputs.values()) buffer.discard(error);
      return Scope.close(entry.scope, Exit.void);
    });

  const release: HandleTable["Service"]["release"] = (handle) =>
    Effect.suspend(() => {
      const entry = entries.get(handle);
      return entry === undefined
        ? Effect.void
        : closeEntry(handle, entry, new RunnerLostError({ reason: "runner-restarted", handle }));
    });

  /** SIGTERM to every group, SIGKILL after `graceMs`, then every handle fails with `reason`. */
  const terminateAll = Effect.fnUntraced(function* (
    reason: RunnerLostError["reason"],
    graceMs: number,
  ) {
    const all = [...entries];
    // Unread output must not hold a dying child on a paused pipe.
    for (const [handle, entry] of all) {
      for (const buffer of entry.outputs.values()) {
        buffer.discard(new RunnerLostError({ reason, handle }));
      }
    }
    const live = all.filter(([, entry]) => entry.kind !== "file");
    for (const [, entry] of live) yield* Effect.ignore(signalPid(reason, -entry.pid, "SIGTERM"));
    yield* Effect.forEach(live, ([, entry]) => Deferred.await(entry.exit), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ignore, Effect.timeoutOption(graceMs));
    for (const [, entry] of live) yield* Effect.ignore(signalPid(reason, -entry.pid, "SIGKILL"));
    for (const [handle, entry] of all) {
      const error = new RunnerLostError({ reason, handle });
      yield* Deferred.fail(entry.exit, error);
      yield* closeEntry(handle, entry, error);
    }
  });

  const drain: HandleTable["Service"]["drain"] = Effect.fn("HandleTable.drain")(function* (
    graceMs,
  ) {
    drained = true;
    yield* terminateAll("drained", graceMs);
  }, bootLocked);

  const live: HandleTable["Service"]["live"] = Effect.sync(() =>
    [...entries].map(([handle, entry]) => {
      const next: Record<string, number> = {};
      for (const [key, buffer] of entry.outputs) next[key] = buffer.nextSeq;
      for (const [key, channel] of entry.inputs) next[key] = channel.appliedThrough;
      return { handle, next };
    }),
  );

  const expireLease = Effect.fn("HandleTable.expireLease")(function* () {
    lease = undefined;
    yield* Effect.logWarning("runner lease expired; stopping every process", {
      handles: entries.size,
    });
    yield* terminateAll("lease-expired", LEASE_KILL_GRACE_MS);
    runnerBootId = SecureRandom.uuidV4Unsafe();
  }, bootLocked);

  const stopLease = Effect.suspend(() => {
    const running = lease;
    lease = undefined;
    return running === undefined ? Effect.void : Fiber.interrupt(running);
  });

  const hello: HandleTable["Service"]["hello"] = Effect.fn("HandleTable.hello")(function* (input) {
    yield* stopLease;
    if (serverBootId !== undefined && serverBootId !== input.serverBootId) {
      // A server restart, or a lease the server expired first: nobody owns these handles.
      yield* terminateAll("server-restarted", LEASE_KILL_GRACE_MS);
      runnerBootId = SecureRandom.uuidV4Unsafe();
    }
    serverBootId = input.serverBootId;
    leaseMs = input.leaseMs;
    flow.limits = input.limits;
    flow.evaluate();
    return { runnerBootId, handles: yield* live };
  }, bootLocked);

  const socketEnded = Effect.suspend(() => {
    sockets -= 1;
    if (sockets > 0 || leaseMs === undefined || lease !== undefined || drained) return Effect.void;
    return Effect.sleep(leaseMs).pipe(
      Effect.andThen(expireLease()),
      // Sleeping before the socket's end returns, so the lease counts from the drop.
      Effect.forkIn(tableScope, { startImmediately: true }),
      Effect.tap((fiber) =>
        Effect.sync(() => {
          lease = fiber;
        }),
      ),
    );
  });

  const session: HandleTable["Service"]["session"] = (effect) =>
    Effect.suspend(() => {
      sockets += 1;
      return effect;
    }).pipe(Effect.ensuring(socketEnded));

  const stats: HandleTable["Service"]["stats"] = Effect.sync(() => ({
    bufferedBytes: flow.unsent,
    highWater: flow.highWater,
    pausedHandles: flow.pausedHandles,
    pausedMs: flow.pausedMs(),
  }));

  return HandleTable.of({
    hello,
    session,
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
    limits: () => flow.limits,
    events: Stream.fromPubSub(events),
    pressure: Stream.fromPubSub(pressure),
    stats,
  });
});

export const layer = Layer.effect(HandleTable, make());
