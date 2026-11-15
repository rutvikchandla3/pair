import type { BranchLineageStep } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { BranchLineageStepExecutor } from "./BranchLineageStepExecutor.ts";

/** The steps the recording executor was asked to run, in order. */
export class RecordedLineageSteps extends Context.Service<
  RecordedLineageSteps,
  Ref.Ref<ReadonlyArray<BranchLineageStep>>
>()("t3/lineage/BranchLineageStepExecutor.testkit/RecordedLineageSteps") {}

/** Tests only: an executor that records each step and does no git work. */
export const layerRecording = Layer.effectContext(
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<BranchLineageStep>>([]);
    return Context.make(RecordedLineageSteps, recorded).pipe(
      Context.add(
        BranchLineageStepExecutor,
        BranchLineageStepExecutor.of({
          run: (step) => Ref.update(recorded, (steps) => [...steps, step]),
        }),
      ),
    );
  }),
);
