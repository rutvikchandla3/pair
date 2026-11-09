import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { TeamImageEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";
import type { OrchestrationEffectExecutionError } from "../../orchestration-v2/EffectWorker.ts";

export class TeamImageEffects extends Context.Service<
  TeamImageEffects,
  {
    /** Bounded by the effect worker, except run-program, which returns once its program is spawned. */
    readonly execute: (
      effect: TeamImageEffectV2,
      options?: { readonly willRetry: boolean },
    ) => Effect.Effect<void, OrchestrationEffectExecutionError>;
    /** The worker calls this once, after the last attempt failed, outside the bound. */
    readonly reportExhausted: (
      effect: TeamImageEffectV2,
      cause: Cause.Cause<OrchestrationEffectExecutionError>,
    ) => Effect.Effect<void>;
  }
>()("t3/sandbox/image/TeamImageEffects") {}
