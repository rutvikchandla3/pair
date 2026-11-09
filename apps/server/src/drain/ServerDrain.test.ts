import { assert, it } from "@effect/vitest";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerDrain from "./ServerDrain.ts";

/** Each `run.updated` pulls the next count, so a test fixes every count up front. */
const makeDrain = Effect.fn("ServerDrainTest.makeDrain")(function* (
  counts: ReadonlyArray<number>,
  runUpdates: number,
) {
  const countQueue = yield* Queue.unbounded<number>();
  yield* Queue.offerAll(countQueue, counts);
  const counted = yield* Deferred.make<void>();
  const streamed = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const drain = yield* ServerDrain.ServerDrain.pipe(
    Effect.provide(
      ServerDrain.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EventSink.EventSinkV2)({
              latestSequence: () => Effect.succeed(7),
              stream: (input) =>
                Stream.fromEffect(Ref.update(streamed, (inputs) => [...inputs, input])).pipe(
                  Stream.drain,
                  Stream.concat(
                    Stream.range(1, runUpdates).pipe(
                      // The watch reads only that a run changed, never the event.
                      Stream.as({} as OrchestrationV2StoredEvent),
                    ),
                  ),
                  Stream.concat(Stream.never),
                ),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              countRunningRuns: () =>
                Queue.take(countQueue).pipe(Effect.tap(() => Deferred.succeed(counted, undefined))),
            }),
          ),
        ),
      ),
    ),
  );
  return { drain, counted, streamed };
});

it.effect("watch counts running turns after each run change and completes at zero", () =>
  Effect.gen(function* () {
    const { drain, streamed } = yield* makeDrain([2, 2, 1, 0, 4], 4);
    assert.deepEqual(Array.from(yield* Stream.runCollect(drain.watch)), []);

    const { since } = yield* drain.start(null);
    assert.strictEqual(yield* drain.start(null).pipe(Effect.map((state) => state.since)), since);
    const statuses = yield* Stream.runCollect(drain.watch);
    assert.deepEqual(Array.from(statuses), [
      { since, runningTurns: 2 },
      { since, runningTurns: 1 },
      { since, runningTurns: 0 },
    ]);
    assert.deepEqual(yield* Ref.get(streamed), [{ afterSequence: 7, eventType: "run.updated" }]);
  }),
);

it.effect("a cancel ends the watch with turns still running", () =>
  Effect.gen(function* () {
    const { drain, counted } = yield* makeDrain([3], 0);
    yield* drain.start(null);
    const watching = yield* Stream.runDrain(drain.watch).pipe(Effect.forkChild);
    yield* Deferred.await(counted);
    yield* drain.cancel;
    yield* Fiber.join(watching);
    assert.isNull(yield* drain.current);
  }),
);
