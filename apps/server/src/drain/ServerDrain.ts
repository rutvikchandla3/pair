import type { MemberId, ServerDrainStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export interface DrainState {
  readonly since: DateTime.Utc;
  readonly actorId: MemberId | null;
}

/**
 * Holds new cloud turns and machine starts before an upgrade (`t3 drain`). In memory only: a
 * restart ends the drain, and that is what releases the held work.
 */
export class ServerDrain extends Context.Service<
  ServerDrain,
  {
    readonly current: Effect.Effect<DrainState | null>;
    /** The current state first, then each change. */
    readonly changes: Stream.Stream<DrainState | null>;
    /** Idempotent: a second start keeps the first one's state. */
    readonly start: (actorId: MemberId | null) => Effect.Effect<DrainState>;
    readonly cancel: Effect.Effect<void>;
    /** Emits on start and on each run change; completes when no turn is running or on a cancel. */
    readonly watch: Stream.Stream<
      ServerDrainStatus,
      ProjectionStore.ProjectionStoreV2Error | EventSink.EventSinkV2Error
    >;
  }
>()("t3/drain/ServerDrain") {}

export const layer = Layer.effect(
  ServerDrain,
  Effect.gen(function* () {
    const events = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const state = yield* SubscriptionRef.make<DrainState | null>(null);

    const start = Effect.fn("ServerDrain.start")(function* (actorId: MemberId | null) {
      const next = { since: yield* DateTime.now, actorId };
      return yield* SubscriptionRef.modifySome(state, (current) =>
        current === null ? [next, Option.some(next)] : [current, Option.none()],
      );
    });

    const cancel = SubscriptionRef.updateSome(state, (current) =>
      current === null ? Option.none() : Option.some(null),
    ).pipe(Effect.withSpan("ServerDrain.cancel"));

    const cancelled = SubscriptionRef.changes(state).pipe(
      Stream.filter((current) => current === null),
      Stream.runHead,
    );

    const watch = Stream.unwrap(
      Effect.gen(function* () {
        const drain = yield* SubscriptionRef.get(state);
        if (drain === null) return Stream.empty;
        // The sequence is read before the first count, so a run that ends between them still
        // sends the event that re-counts.
        const afterSequence = yield* events.latestSequence();
        return Stream.concat(
          Stream.succeed(undefined),
          events.stream({ afterSequence, eventType: "run.updated" }),
        ).pipe(
          Stream.mapEffect(() => projections.countRunningRuns()),
          Stream.changes,
          Stream.map((runningTurns) => ({ since: drain.since, runningTurns })),
          Stream.takeUntil((status) => status.runningTurns === 0),
          Stream.interruptWhen(cancelled),
        );
      }),
    );

    return ServerDrain.of({
      current: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      start,
      cancel,
      watch,
    });
  }),
);

/** The real state over stub stores, for tests that start and cancel but never `watch`. */
export const layerTest = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(EventSink.EventSinkV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    ),
  ),
);
