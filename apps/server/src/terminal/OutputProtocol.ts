import {
  ORCHESTRATION_V2_WS_METHODS,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/rpc";
import { withOutputWindow as withRpcOutputWindow } from "@t3tools/shared/rpcOutputWindow";

const MAX_PENDING_BYTES = 64 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD = 128;
// Terminal output is small chunks, so its window also caps bytes. The other streams
// window by count only: sizing a multi-MB thread snapshot would serialize it twice.
const BYTE_WINDOWED_STREAMS: ReadonlySet<string> = new Set([
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
]);
// One ACK round trip per chunk stalls sync on high-latency links.
const COUNT_WINDOWED_STREAMS: ReadonlySet<string> = new Set([
  WS_METHODS.subscribeServerConfig,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
]);

const byteLengthOf = (value: unknown) => (typeof value === "string" ? Buffer.byteLength(value) : 0);

// Charges every variable-size field a terminal event can carry, so the byte
// budgets below cannot be bypassed by a large payload in an uncharged field.
const queuedSize = (event: TerminalEvent | TerminalAttachStreamEvent) =>
  EVENT_OVERHEAD +
  ("threadId" in event ? byteLengthOf(event.threadId) + byteLengthOf(event.terminalId) : 0) +
  (event.type === "output"
    ? byteLengthOf(event.data)
    : event.type === "error"
      ? byteLengthOf(event.message)
      : event.type === "activity"
        ? byteLengthOf(event.label)
        : "snapshot" in event
          ? byteLengthOf(event.snapshot.threadId) +
            byteLengthOf(event.snapshot.terminalId) +
            byteLengthOf(event.snapshot.history) +
            byteLengthOf(event.snapshot.cwd) +
            byteLengthOf(event.snapshot.worktreePath) +
            byteLengthOf(event.snapshot.label)
          : 0);

// Byte-windowed streams carry TerminalAttachStreamEvent, whose encoded form is the
// event itself, so charge it like the output queue does instead of serializing twice.
const chunkSize = (values: ReadonlyArray<unknown>) =>
  values.reduce<number>(
    (total, value) => total + queuedSize(value as TerminalAttachStreamEvent),
    EVENT_OVERHEAD,
  );

export const withOutputWindow = (protocol: RpcServer.Protocol["Service"]) =>
  withRpcOutputWindow(protocol, {
    isWindowed: (tag) => BYTE_WINDOWED_STREAMS.has(tag) || COUNT_WINDOWED_STREAMS.has(tag),
    isCountOnly: (tag) => COUNT_WINDOWED_STREAMS.has(tag),
    maxChunks: 8,
    maxBytes: MAX_PENDING_BYTES,
    sizeOf: (chunk) => chunkSize(chunk.values),
  });

const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;
// Output that follows an emission this closely waits and rides along in one batch,
// so a PTY that delivers one line per callback (ConPTY) is not sent one frame per line.
const OUTPUT_WINDOW_NANOS = 2_000_000n;

type Listener<A> = (event: A) => Effect.Effect<void>;
// Acquisition must register cleanup synchronously with installing the listener.
type Subscribe<A, E> = (
  listener: Listener<A>,
  registerCleanup: (stop: () => void) => void,
) => Effect.Effect<() => void, E>;

export function terminalOutputStream<A extends TerminalEvent | TerminalAttachStreamEvent, E>(
  subscribe: Subscribe<A, E>,
  resync?: Subscribe<A, E>,
  maxQueued = MAX_QUEUED_OUTPUT,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const ready = yield* Latch.make();
      let pending: Array<A | undefined> = [];
      let sizes: number[] = [];
      let head = 0;
      let queued = 0;
      // Pending events other than output; any of them flushes the window early.
      let lifecycle = 0;
      let deadline = 0n;
      let overflowed = false;
      let subscription = 0;
      let unsubscribe: (() => void) | null = null;
      const release = () => {
        subscription += 1;
        unsubscribe?.();
        unsubscribe = null;
        pending = [];
        sizes = [];
        head = 0;
        queued = 0;
        lifecycle = 0;
      };
      const urgent = () => lifecycle > 0 || queued >= MAX_PENDING_BYTES;
      yield* Effect.addFinalizer(() => Effect.sync(release));

      const listen = (from: Subscribe<A, E>) =>
        Effect.suspend(() => {
          const id = ++subscription;
          return from(
            (event) =>
              Effect.sync(() => {
                if (id !== subscription) return;
                const wasEmpty = head === pending.length;
                const size = queuedSize(event);
                pending.push(event);
                sizes.push(size);
                queued += size;
                if (event.type !== "output") lifecycle += 1;
                // A single snapshot must fit even when history fills the budget.
                if (queued - sizes[head]! > maxQueued) {
                  release();
                  overflowed = true;
                }
                // The current or next pull handles the pending output deadline.
                if (wasEmpty || overflowed || urgent()) ready.openUnsafe();
              }),
            (stop) => {
              // Overflow or cancellation may invalidate acquisition before registration.
              if (id === subscription) unsubscribe = stop;
              else stop();
            },
          ).pipe(
            Effect.asVoid,
            Effect.onError(() => Effect.sync(release)),
          );
        });

      const take = () => {
        const event = pending[head]!;
        pending[head] = undefined;
        head += 1;
        if (event.type !== "output") lifecycle -= 1;
        return event;
      };
      const takeBatch = (): Arr.NonEmptyReadonlyArray<A> => {
        let bytes = sizes[head]!;
        const batch: [A, ...A[]] = [take()];
        while (head < pending.length && bytes + sizes[head]! <= MAX_PENDING_BYTES) {
          bytes += sizes[head]!;
          batch.push(take());
        }
        queued -= bytes;
        if (head * 2 >= pending.length) {
          pending = pending.slice(head);
          sizes = sizes.slice(head);
          head = 0;
        }
        return batch;
      };

      const pull: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E | Cause.Done> = Effect.suspend(
        () => {
          if (overflowed) {
            overflowed = false;
            return resync ? listen(resync).pipe(Effect.andThen(pull)) : Cause.done();
          }
          ready.closeUnsafe();
          if (head === pending.length) return ready.await.pipe(Effect.andThen(pull));
          const now = clock.monotonicTimeNanosUnsafe();
          if (now >= deadline || urgent()) {
            deadline = now + OUTPUT_WINDOW_NANOS;
            return Effect.succeed(takeBatch());
          }
          return Effect.raceFirst(ready.await, Effect.sleep(Duration.nanos(deadline - now))).pipe(
            Effect.andThen(pull),
          );
        },
      );

      yield* listen(subscribe);
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
