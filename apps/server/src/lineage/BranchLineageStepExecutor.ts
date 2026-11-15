import type { BranchLineageStep } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BranchLineageStepError extends Schema.TaggedError<BranchLineageStepError>()(
  "BranchLineageStepError",
  {
    stepId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface BranchLineageStepExecutorShape {
  /**
   * Runs one lineage step at its thread's turn boundary: the git work, and the records it leaves
   * (`offer.applied`, `offer.returned`, `offer.reverted`, `thread.branch-lineage.record`). The
   * effect worker then dispatches `thread.lineage-step.complete`, which releases the queue. A step
   * replays after a restart and on retry, so it must be idempotent.
   */
  readonly run: (step: BranchLineageStep) => Effect.Effect<void, BranchLineageStepError>;
}

/** Optional for the effect worker: without one, a step completes without doing anything. */
export class BranchLineageStepExecutor extends Context.Service<
  BranchLineageStepExecutor,
  BranchLineageStepExecutorShape
>()("t3/lineage/BranchLineageStepExecutor") {}
