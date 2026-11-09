import type { ComputeDriverId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ComputeDriverRegistry from "../compute/ComputeDriverRegistry.ts";

/** 04 §4 and D5; there is no member cap in M1. */
export const STARTS_PER_MINUTE = 10;
const TOKEN_INTERVAL_MS = 60_000 / STARTS_PER_MINUTE;

export interface AdmissionSnapshot {
  /** Sandboxes on this driver that are ready, or provisioning or waking without admission. */
  readonly running: number;
  /** Sandboxes on this driver waiting for admission; a new start queues behind them. */
  readonly waiting: number;
  readonly cap: number;
  /** The start-rate bucket holds a token now. */
  readonly startAvailable: boolean;
}

export class SandboxAdmission extends Context.Service<
  SandboxAdmission,
  {
    /** Process-wide; always taken before any thread lock. Not reentrant. */
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Only under `withLock`. Counts the sandbox projection, so a shared sandbox counts once. */
    readonly snapshot: (
      driverId: ComputeDriverId,
    ) => Effect.Effect<AdmissionSnapshot, ProjectionStore.ProjectionStoreV2Error>;
    /** Only under `withLock`, after a commit that starts a machine. */
    readonly takeStart: Effect.Effect<void>;
    /** When the bucket next gains a token, or null while it is full. */
    readonly nextStartAt: Effect.Effect<DateTime.Utc | null>;
  }
>()("t3/sandbox/lifecycle/SandboxAdmission") {}

export const layer = Layer.effect(
  SandboxAdmission,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
    const lock = yield* Semaphore.make(1);
    // In memory: a restart refills the bucket, which is fine for a spend guard.
    let tokens = STARTS_PER_MINUTE;
    let refilledAtMs = 0;

    const refill = Effect.fnUntraced(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (tokens >= STARTS_PER_MINUTE) {
        refilledAtMs = nowMs;
        return;
      }
      const earned = Math.floor((nowMs - refilledAtMs) / TOKEN_INTERVAL_MS);
      if (earned <= 0) return;
      tokens = Math.min(STARTS_PER_MINUTE, tokens + earned);
      refilledAtMs += earned * TOKEN_INTERVAL_MS;
    });

    const snapshot = Effect.fn("SandboxAdmission.snapshot")(function* (driverId: ComputeDriverId) {
      const counts = yield* projections.countSandboxAdmission(driverId);
      // A removed driver queues nothing: its start fails with `driver-removed` instead.
      const cap = yield* registry.runningCap(driverId).pipe(Effect.orElseSucceed(() => Infinity));
      yield* refill();
      return { ...counts, cap, startAvailable: tokens > 0 } satisfies AdmissionSnapshot;
    });

    return SandboxAdmission.of({
      withLock: lock.withPermits(1),
      snapshot,
      takeStart: refill().pipe(
        Effect.andThen(
          Effect.sync(() => {
            tokens = Math.max(0, tokens - 1);
          }),
        ),
      ),
      nextStartAt: refill().pipe(
        Effect.map(() =>
          tokens >= STARTS_PER_MINUTE
            ? null
            : DateTime.makeUnsafe(refilledAtMs + TOKEN_INTERVAL_MS),
        ),
      ),
    });
  }),
);
