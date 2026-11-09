import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** A byte allowance shared by everything that takes from it. */
interface ByteBudget {
  /** Waits on `Clock` while the bucket is overdrawn, so the caller's next pull waits too. */
  readonly take: (bytes: number) => Effect.Effect<void>;
}

/**
 * A token bucket that refills at `bytesPerSecond` up to `burstBytes`; `Infinity` is no budget. A
 * take may overdraw it and waits out its own debt, so a chunk larger than the burst still passes.
 */
export const makeByteBudget = (bytesPerSecond: number, burstBytes: number): ByteBudget => {
  if (bytesPerSecond === Number.POSITIVE_INFINITY) return { take: () => Effect.void };
  let tokens = burstBytes;
  let refilledAt: bigint | undefined;
  return {
    take: (bytes) =>
      Effect.clockWith((clock) => {
        const now = clock.monotonicTimeNanosUnsafe();
        const elapsedSeconds = refilledAt === undefined ? 0 : Number(now - refilledAt) / 1e9;
        refilledAt = now;
        tokens = Math.min(burstBytes, tokens + elapsedSeconds * bytesPerSecond) - bytes;
        return tokens >= 0
          ? Effect.void
          : Effect.sleep(Duration.millis(Math.ceil((-tokens * 1000) / bytesPerSecond)));
      }),
  };
};
