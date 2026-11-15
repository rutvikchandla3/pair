import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BranchLineageService } from "./BranchLineageService.ts";
import {
  BranchLineageStepError,
  BranchLineageStepExecutor,
  type BranchLineageStepExecutorShape,
} from "./BranchLineageStepExecutor.ts";

/**
 * The effect worker is built inside the orchestration runtime, and `BranchLineageService` is built
 * on top of it, so the executor finds the service through this slot once the service registers.
 */
export interface BranchLineageStepHolder {
  current: BranchLineageStepExecutorShape | undefined;
}

class BranchLineageStepSlot extends Context.Service<
  BranchLineageStepSlot,
  BranchLineageStepHolder
>()("t3/lineage/BranchLineageStepExecutorLive/BranchLineageStepSlot") {}

/** The executor and its empty slot; provide it around the orchestration runtime. */
export const layer = Layer.effectContext(
  Effect.sync(() => {
    const holder: BranchLineageStepHolder = { current: undefined };
    return Context.make(BranchLineageStepSlot, holder).pipe(
      Context.add(
        BranchLineageStepExecutor,
        BranchLineageStepExecutor.of({
          run: Effect.fn("BranchLineageStepExecutor.run")(function* (step) {
            if (holder.current === undefined) {
              return yield* new BranchLineageStepError({
                stepId: step.id,
                message: "Branch off isn't ready yet.",
              });
            }
            return yield* holder.current.run(step);
          }),
        }),
      ),
    );
  }),
);

/** Fills the slot with the service's step runner for as long as the layer lives. */
export const layerRegister = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* BranchLineageStepSlot;
    const service = yield* BranchLineageService;
    const runner: BranchLineageStepExecutorShape = { run: service.runStep };
    slot.current = runner;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (slot.current === runner) slot.current = undefined;
      }),
    );
  }),
);
