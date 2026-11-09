import {
  type RunnerCallError,
  type RunnerForwardId,
  type RunnerForwardName,
  type RunnerHandleId,
  type RunnerInfo,
  RunnerLostError,
  type RunnerRpcGroup,
  type RunnerSignal,
} from "@t3tools/contracts/runner";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import type { CoarseOperations } from "../../workspaceHost/WorkspaceHost.ts";
import { makeByteBudget } from "./ByteBudget.ts";

export type RunnerClient = RpcClient.FromGroup<typeof RunnerRpcGroup, RpcClientError>;

/** Output streams by `RunnerHandleState.next` key. */
export type RunnerOutputKey = `fd:${number}` | "pty" | "tcp";

/** At most this much input waits per pipe before `write` suspends (03 4.5). */
const WRITER_QUEUE_BYTES = 1024 * 1024;
/** One write frame carries at most this much, well inside the runner's frame cap. */
const WRITE_FRAME_UNITS = 128 * 1024;

export interface RunnerPipeWriter {
  /** Suspends while 1 MiB is queued; fails once the writer has failed. */
  readonly write: (data: Uint8Array) => Effect.Effect<void, RunnerCallError>;
  /** Closes the input after everything queued, and waits until the runner applied it. */
  readonly close: Effect.Effect<void, RunnerCallError>;
}

/** Synchronous like `PtyProcess`: calls queue past the cap, since terminal input is human-sized. */
export interface RunnerPtyWriter {
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly signal: (signal: RunnerSignal) => void;
  /** Fails with the error that stopped the writer. */
  readonly failed: Effect.Effect<never, RunnerCallError>;
}

/** One connection accepted by a forward in the sandbox. */
export interface RunnerTcpConnection {
  /** What the sandbox side sent, resumed across socket drops; ends at its EOF. */
  readonly read: Stream.Stream<Uint8Array, RunnerCallError>;
  readonly write: (data: Uint8Array) => Effect.Effect<void, RunnerCallError>;
  /** Ends the connection after everything written. Closing the scope instead drops unsent bytes. */
  readonly close: Effect.Effect<void, RunnerCallError>;
}

/**
 * One runner boot as seen by the server, across socket drops inside the lease. `output` and
 * `writer` resume on the next socket of the same boot; they fail with `RunnerLostError` once the
 * boot is gone (lease expiry, a runner restart, revoke).
 */
export interface RunnerConnection {
  readonly info: RunnerInfo;
  readonly ops: CoarseOperations;
  /** The live socket's client; waits out a reconnect. Use it for one call, never keep it. */
  readonly client: Effect.Effect<RunnerClient, RunnerLostError>;
  /** An idempotent call on the live client, sent again on the next socket after a drop. */
  readonly idempotent: <A, E>(
    call: (client: RunnerClient) => Effect.Effect<A, E | RpcClientError>,
  ) => Effect.Effect<A, Exclude<E, RpcClientError> | RunnerLostError>;
  readonly output: {
    (
      handle: RunnerHandleId,
      stream: "pty",
      fromSeq?: number,
    ): Stream.Stream<string, RunnerCallError>;
    (
      handle: RunnerHandleId,
      stream: `fd:${number}` | "tcp",
      fromSeq?: number,
    ): Stream.Stream<Uint8Array, RunnerCallError>;
  };
  /** One writer fiber per input, in the caller's scope. */
  readonly pipeWriter: (
    handle: RunnerHandleId,
    fd: number,
  ) => Effect.Effect<RunnerPipeWriter, never, Scope.Scope>;
  readonly ptyWriter: (
    handle: RunnerHandleId,
  ) => Effect.Effect<RunnerPtyWriter, never, Scope.Scope>;
  /**
   * Listens in the sandbox until the scope closes and returns the in-sandbox address. `serve` runs
   * once per accepted connection, in a scope of its own inside the caller's.
   */
  readonly openForward: (input: {
    readonly name: RunnerForwardName;
    readonly ownerKey: string;
    readonly serve: (connection: RunnerTcpConnection) => Effect.Effect<void, never, Scope.Scope>;
  }) => Effect.Effect<string, RunnerCallError, Scope.Scope>;
  /** Completes once this boot is gone. */
  readonly ended: Effect.Effect<void>;
}

/**
 * The client of this boot's next live socket other than `failed`; fails once the boot is gone.
 * The hub's lease bounds the wait, so nothing here keeps a timer.
 */
export type AwaitClient = (
  failed: RunnerClient | undefined,
) => Effect.Effect<RunnerClient, RunnerLostError>;

/**
 * A dropped socket fails a call with `RpcClientError`, or with an interrupt when the hub closed
 * the socket's client first; either way the call is retried on the next socket.
 */
const isTransportFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ||
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      (reason.error as { readonly _tag?: unknown } | null)?._tag === "RpcClientError",
  );

/** Marks the span of whoever spawned the handle (their `RunnerConnection.spawn`, if they made one). */
const markFirstByte = (handle: RunnerHandleId, stream: RunnerOutputKey) =>
  Effect.currentSpan.pipe(
    Effect.zipWith(Clock.currentTimeNanos, (span, now) =>
      span.event("first-byte", now, { handle, stream }),
    ),
    Effect.ignore,
  );

const sliceFrom = <A extends Uint8Array | string>(data: A, offset: number): A =>
  (typeof data === "string" ? data.slice(offset) : data.subarray(offset)) as A;

type WriteOp =
  | { readonly _tag: "data"; readonly data: Uint8Array | string }
  | { readonly _tag: "close"; readonly done: Deferred.Deferred<void, RunnerCallError> }
  | { readonly _tag: "resize"; readonly cols: number; readonly rows: number }
  | { readonly _tag: "signal"; readonly signal: RunnerSignal };

const concat = (parts: ReadonlyArray<Uint8Array | string>): Uint8Array | string => {
  if (parts.length === 1) return parts[0]!;
  if (typeof parts[0] === "string") return parts.join("");
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts as ReadonlyArray<Uint8Array>) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Consecutive data ops become frames of at most `WRITE_FRAME_UNITS`; others stay single. */
const toFrames = (ops: ReadonlyArray<WriteOp>): Array<WriteOp> => {
  const frames: Array<WriteOp> = [];
  let parts: Array<Uint8Array | string> = [];
  let size = 0;
  const flush = () => {
    if (parts.length > 0) frames.push({ _tag: "data", data: concat(parts) });
    parts = [];
    size = 0;
  };
  for (const op of ops) {
    if (op._tag !== "data") {
      flush();
      frames.push(op);
      continue;
    }
    for (let offset = 0; offset < op.data.length;) {
      const take = Math.min(op.data.length - offset, WRITE_FRAME_UNITS - size);
      parts.push(
        typeof op.data === "string"
          ? op.data.slice(offset, offset + take)
          : op.data.subarray(offset, offset + take),
      );
      size += take;
      offset += take;
      if (size >= WRITE_FRAME_UNITS) flush();
    }
  }
  flush();
  return frames;
};

const opSize = (op: WriteOp) => (op._tag === "data" ? op.data.length : 0);

export const makeRunnerConnection = (
  info: RunnerInfo,
  awaitClient: AwaitClient,
  ops: CoarseOperations,
  boot: {
    /** Lives as long as the hub; holds the boot's `runner.events` subscription. */
    readonly scope: Scope.Scope;
    readonly ended: Effect.Effect<void>;
  },
  ingressBytesPerSecond: number,
): RunnerConnection => {
  // One allowance for every output stream of this sandbox.
  const ingress = makeByteBudget(ingressBytesPerSecond, ingressBytesPerSecond / 16);

  /** Runs `call` on the live client, again on the next socket after a transport failure. */
  const onLiveClient = <A, E>(
    call: (client: RunnerClient) => Effect.Effect<A, E | RpcClientError>,
  ): Effect.Effect<A, Exclude<E, RpcClientError> | RunnerLostError> => {
    const attempt = (
      failed: RunnerClient | undefined,
    ): Effect.Effect<A, Exclude<E, RpcClientError> | RunnerLostError> =>
      awaitClient(failed).pipe(
        Effect.flatMap((client) =>
          call(client).pipe(
            Effect.catchCause((cause) =>
              isTransportFailure(cause)
                ? attempt(client)
                : Effect.failCause(cause as Cause.Cause<Exclude<E, RpcClientError>>),
            ),
          ),
        ),
      );
    return attempt(undefined);
  };

  const output = (<A extends Uint8Array | string>(
    handle: RunnerHandleId,
    stream: RunnerOutputKey,
    fromSeq = 0,
  ): Stream.Stream<A, RunnerCallError> =>
    Stream.suspend(() => {
      let next = fromSeq;
      let firstByte = false;
      const open = (client: RunnerClient) =>
        (stream === "pty"
          ? client["pty.output"]({ handle, fromSeq: next })
          : stream === "tcp"
            ? client["tcp.read"]({ connectionId: handle, fromSeq: next })
            : client["process.output"]({
                handle,
                fd: Number(stream.slice(3)),
                fromSeq: next,
              })) as Stream.Stream<
          { readonly seq: number; readonly data: A },
          RunnerCallError | RpcClientError
        >;
      const from = (failed: RunnerClient | undefined): Stream.Stream<A, RunnerCallError> =>
        Stream.unwrap(
          awaitClient(failed).pipe(
            Effect.map((client) =>
              open(client).pipe(
                Stream.mapEffect((chunk) => {
                  if (chunk.seq > next) {
                    return Effect.fail(
                      new RunnerLostError({ reason: "resume-behind-buffer", handle }),
                    );
                  }
                  // A resubscribe can repeat what the dropped socket already delivered.
                  const data = sliceFrom(chunk.data, next - chunk.seq);
                  next = Math.max(next, chunk.seq + chunk.data.length);
                  if (data.length === 0) return Effect.succeed(data);
                  const taken = ingress.take(data.length).pipe(Effect.as(data));
                  if (firstByte) return taken;
                  firstByte = true;
                  return markFirstByte(handle, stream).pipe(Effect.andThen(taken));
                }),
                Stream.filter((data) => data.length > 0),
                Stream.catchCause((cause) =>
                  isTransportFailure(cause)
                    ? from(client)
                    : Stream.failCause(cause as Cause.Cause<RunnerCallError>),
                ),
              ),
            ),
          ),
        );
      return from(undefined);
    })) as RunnerConnection["output"];

  const makeWriter = Effect.fnUntraced(function* (
    send: (
      client: RunnerClient,
      seq: number,
      op: WriteOp,
    ) => Effect.Effect<unknown, RunnerCallError | RpcClientError>,
  ) {
    const queue = yield* Queue.unbounded<WriteOp>();
    const room = Latch.makeUnsafe(true);
    const failure = yield* Deferred.make<never, RunnerCallError>();
    let queued = 0;
    let seq = 0;

    const enqueue = (op: WriteOp) => {
      queued += opSize(op);
      if (queued >= WRITER_QUEUE_BYTES) room.closeUnsafe();
      Queue.offerUnsafe(queue, op);
    };

    // One fiber per input: seqs go out in order and a resend reuses the seq it failed with.
    yield* Effect.gen(function* () {
      while (true) {
        const ops = yield* Queue.takeAll(queue);
        for (const frame of toFrames(ops)) {
          const n = ++seq;
          yield* onLiveClient((client) => send(client, n, frame));
          if (frame._tag === "close") yield* Deferred.succeed(frame.done, undefined);
        }
        for (const op of ops) queued -= opSize(op);
        if (queued < WRITER_QUEUE_BYTES) room.openUnsafe();
      }
    }).pipe(
      Effect.catch((error: RunnerCallError) => Deferred.fail(failure, error)),
      Effect.forkScoped,
    );

    const failed = Deferred.await(failure);
    const whenRoom: Effect.Effect<void, RunnerCallError> = Effect.suspend(() =>
      queued < WRITER_QUEUE_BYTES
        ? Effect.void
        : Effect.raceFirst(room.await, failed).pipe(Effect.andThen(whenRoom)),
    );
    const checkFailed = Effect.suspend(() =>
      Deferred.isDoneUnsafe(failure) ? failed : Effect.void,
    );
    return { enqueue, whenRoom, failed, checkFailed };
  });

  const byteWriter = Effect.fnUntraced(function* (
    send: (
      client: RunnerClient,
      seq: number,
      op: { readonly _tag: "data"; readonly data: Uint8Array } | { readonly _tag: "close" },
    ) => Effect.Effect<unknown, RunnerCallError | RpcClientError>,
  ) {
    const writer = yield* makeWriter((client, seq, op) =>
      op._tag === "data"
        ? send(client, seq, { _tag: "data", data: op.data as Uint8Array })
        : send(client, seq, { _tag: "close" }),
    );
    return {
      write: (data) =>
        writer.checkFailed.pipe(
          Effect.andThen(writer.whenRoom),
          Effect.andThen(Effect.sync(() => writer.enqueue({ _tag: "data", data }))),
        ),
      close: Effect.gen(function* () {
        yield* writer.checkFailed;
        const done = yield* Deferred.make<void, RunnerCallError>();
        writer.enqueue({ _tag: "close", done });
        yield* Effect.raceFirst(Deferred.await(done), writer.failed);
      }),
    } satisfies RunnerPipeWriter;
  });

  const pipeWriter: RunnerConnection["pipeWriter"] = (handle, fd) =>
    byteWriter((client, seq, op) =>
      op._tag === "data"
        ? client["process.write"]({ handle, fd, seq, data: op.data })
        : client["process.closeInput"]({ handle, fd, seq }),
    );

  const ptyWriter: RunnerConnection["ptyWriter"] = Effect.fnUntraced(function* (handle) {
    const writer = yield* makeWriter((client, seq, op) => {
      switch (op._tag) {
        case "data":
          return client["pty.input"]({ handle, seq, data: op.data as string });
        case "resize":
          return client["pty.resize"]({ handle, seq, cols: op.cols, rows: op.rows });
        case "signal":
          return client["pty.signal"]({ handle, seq, signal: op.signal });
        case "close":
          return Effect.void;
      }
    });
    return {
      write: (data) => writer.enqueue({ _tag: "data", data }),
      resize: (cols, rows) => writer.enqueue({ _tag: "resize", cols, rows }),
      signal: (signal) => writer.enqueue({ _tag: "signal", signal }),
      failed: writer.failed,
    } satisfies RunnerPtyWriter;
  });

  // Accepts by forward. The runner repeats unclaimed accepts on every subscription and may announce
  // one before `forward.open` has answered, so early ones wait and repeats are dropped.
  const routes = new Map<RunnerForwardId, Queue.Queue<RunnerHandleId>>();
  const early = new Map<RunnerForwardId, Set<RunnerHandleId>>();
  const routed = new Set<RunnerHandleId>();
  let subscribed = false;

  const route = (forwardId: RunnerForwardId, connectionId: RunnerHandleId) => {
    if (routed.has(connectionId)) return;
    const accepts = routes.get(forwardId);
    if (accepts === undefined) {
      const waiting = early.get(forwardId) ?? new Set();
      waiting.add(connectionId);
      early.set(forwardId, waiting);
      return;
    }
    routed.add(connectionId);
    Queue.offerUnsafe(accepts, connectionId);
  };

  const events = (failed: RunnerClient | undefined): Stream.Stream<void, RunnerCallError> =>
    Stream.unwrap(
      awaitClient(failed).pipe(
        Effect.map((client) =>
          client["runner.events"]({}).pipe(
            Stream.map((event) => {
              if (event._tag === "forward.accepted") route(event.forwardId, event.connectionId);
            }),
            Stream.catchCause((cause) =>
              isTransportFailure(cause)
                ? events(client)
                : Stream.failCause(cause as Cause.Cause<RunnerCallError>),
            ),
          ),
        ),
      ),
    );

  const subscribe = Effect.suspend(() => {
    if (subscribed) return Effect.void;
    subscribed = true;
    // Ends with the boot (`RunnerLostError`).
    return events(undefined).pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(boot.scope));
  });

  const serveConnection = Effect.fn("RunnerConnection.serveForwardConnection")(
    function* (
      connectionId: RunnerHandleId,
      serve: (connection: RunnerTcpConnection) => Effect.Effect<void, never, Scope.Scope>,
    ) {
      const writer = yield* byteWriter((client, seq, op) =>
        op._tag === "data"
          ? client["tcp.write"]({ connectionId, seq, data: op.data })
          : client["tcp.close"]({ connectionId }),
      );
      yield* serve({ read: output(connectionId, "tcp"), ...writer });
    },
    Effect.scoped,
    // Idempotent on the runner; after a `close` this one fails and is ignored.
    (effect, connectionId) =>
      effect.pipe(
        Effect.ensuring(
          awaitClient(undefined).pipe(
            Effect.flatMap((client) => client["tcp.close"]({ connectionId })),
            Effect.ignore,
          ),
        ),
        Effect.ensuring(Effect.sync(() => routed.delete(connectionId))),
      ),
  );

  const openForward: RunnerConnection["openForward"] = Effect.fn("RunnerConnection.openForward")(
    function* ({ name, ownerKey, serve }) {
      const scope = yield* Effect.scope;
      yield* subscribe;
      // Not retried: a lost answer would leave a second listener behind.
      const { forwardId, address } = yield* awaitClient(undefined).pipe(
        Effect.flatMap((client) => client["forward.open"]({ name, ownerKey })),
        Effect.catchTags({
          RpcClientError: () => Effect.fail(new RunnerLostError({ reason: "runner-restarted" })),
        }),
      );
      const accepts = yield* Queue.unbounded<RunnerHandleId>();
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          routes.delete(forwardId);
          early.delete(forwardId);
          return onLiveClient((client) => client["forward.close"]({ forwardId })).pipe(
            Effect.ignore,
          );
        }),
      );
      routes.set(forwardId, accepts);
      for (const connectionId of early.get(forwardId) ?? []) route(forwardId, connectionId);
      early.delete(forwardId);
      yield* Queue.take(accepts).pipe(
        Effect.flatMap((connectionId) =>
          serveConnection(connectionId, serve).pipe(Effect.forkIn(scope)),
        ),
        Effect.forever,
        Effect.forkIn(scope),
      );
      return address;
    },
  );

  return {
    info,
    ops,
    client: awaitClient(undefined),
    idempotent: onLiveClient,
    output,
    pipeWriter,
    ptyWriter,
    openForward,
    ended: boot.ended,
  };
};
