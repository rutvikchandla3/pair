import type { OrchestrationV2Command, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";

/**
 * Thread commands a space sends for a member (Pair's task messages, Undo's inverse commands). They
 * pass the same intake guards as the member's own UI: access, assignment and delete permissions.
 */
type SpaceIntakeError = Effect.Error<ReturnType<typeof ThreadMessageIntake.dispatchPairCommand>>;

export class SpaceIntake extends Context.Service<
  SpaceIntake,
  {
    readonly dispatch: (
      command: OrchestrationV2Command,
    ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, SpaceIntakeError>;
  }
>()("t3/space/SpaceIntake") {}

export const layer = Layer.effect(
  SpaceIntake,
  Effect.gen(function* () {
    const context =
      yield* Effect.context<
        Effect.Services<ReturnType<typeof ThreadMessageIntake.dispatchPairCommand>>
      >();
    return SpaceIntake.of({
      dispatch: Effect.fn("SpaceIntake.dispatch")(function* (command) {
        const result = yield* ThreadMessageIntake.dispatchPairCommand(command).pipe(
          Effect.provide(context),
        );
        return result as Orchestrator.OrchestratorV2DispatchResult;
      }),
    });
  }),
);

/** Straight to the orchestrator, for tests that don't model team permissions. */
export const layerDirect = Layer.effect(
  SpaceIntake,
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    SpaceIntake.of({
      dispatch: Effect.fn("SpaceIntake.dispatchDirect")(function* (command) {
        return yield* orchestrator.dispatch(command as OrchestrationV2ServerCommand);
      }),
    }),
  ),
);
