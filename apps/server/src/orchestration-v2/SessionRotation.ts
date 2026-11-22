import type { MessageId, OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export interface SessionRotationInput {
  readonly threadId: ThreadId;
  /** The message the turn answers. */
  readonly messageId: MessageId;
  /** The turn's run: messages from later runs are still queued. */
  readonly runOrdinal: number;
  /** The current native session's last reported context; null when it reported none. */
  readonly usage: {
    readonly usedTokens: number;
    readonly promptCacheExpiresAt: string | null;
  } | null;
}

/**
 * The current native session's context: its latest turn's usage where the provider reports it per
 * turn (Claude), else the provider thread's (ACP agents report it per session).
 */
export const currentSessionUsage = (
  latestTurn:
    | {
        readonly usage: { readonly usedTokens: number };
        readonly promptCacheExpiresAt?: string | undefined;
      }
    | undefined,
  providerThread: Pick<OrchestrationV2ProviderThread, "contextUsage">,
): SessionRotationInput["usage"] => {
  if (latestTurn !== undefined) {
    return {
      usedTokens: latestTurn.usage.usedTokens,
      promptCacheExpiresAt: latestTurn.promptCacheExpiresAt ?? null,
    };
  }
  const thread = providerThread.contextUsage;
  return thread == null ? null : { usedTokens: thread.usedTokens, promptCacheExpiresAt: null };
};

export interface SessionRotationShape {
  /**
   * The text a turn's fresh native session starts with, or null to resume the current one. Asked
   * only for a thread whose provider thread already has a native session.
   */
  readonly freshSessionSeed: (input: SessionRotationInput) => Effect.Effect<string | null>;
}

/** Optional for the turn start: without one, every turn resumes its native session. */
export class SessionRotation extends Context.Service<SessionRotation, SessionRotationShape>()(
  "t3/orchestration-v2/SessionRotation",
) {}

interface SessionRotationHolder {
  current: SessionRotationShape | undefined;
}

class SessionRotationSlot extends Context.Service<SessionRotationSlot, SessionRotationHolder>()(
  "t3/orchestration-v2/SessionRotation/SessionRotationSlot",
) {}

/**
 * The turn start is built inside the orchestration runtime and what decides rotation (bots) is
 * built on top of it, so the turn start reaches it through this slot once it registers.
 */
export const layerSlot = Layer.effectContext(
  Effect.sync(() => {
    const holder: SessionRotationHolder = { current: undefined };
    return Context.make(SessionRotationSlot, holder).pipe(
      Context.add(
        SessionRotation,
        SessionRotation.of({
          freshSessionSeed: Effect.fn("SessionRotation.freshSessionSeed")(function* (input) {
            if (holder.current === undefined) return null;
            return yield* holder.current.freshSessionSeed(input);
          }),
        }),
      ),
    );
  }),
);

/**
 * Finds the slot where its caller is built. The returned register fills it for as long as the
 * scope it runs in lives; without a slot (a runtime with no turn start), it does nothing.
 */
export const makeRegister = Effect.gen(function* () {
  const slot = yield* Effect.serviceOption(SessionRotationSlot);
  return Effect.fn("SessionRotation.register")(function* (shape: SessionRotationShape) {
    if (Option.isNone(slot)) return;
    const holder = slot.value;
    holder.current = shape;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (holder.current === shape) holder.current = undefined;
      }),
    );
  });
});
