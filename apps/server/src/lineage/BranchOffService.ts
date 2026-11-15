import type {
  BranchLineageError,
  ThreadBranchOffDraft,
  ThreadBranchOffDraftInput,
  ThreadBranchOffInput,
  ThreadBranchOffResult,
  ThreadBranchOffSummary,
  ThreadBranchOffSummaryInput,
  ThreadMoveToOwnMachineInput,
  ThreadStartFromMainInput,
  ThreadStartFromMainResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { LineageCaller } from "./LineageRepos.ts";

export interface BranchOffServiceShape {
  readonly draft: (
    caller: LineageCaller,
    input: ThreadBranchOffDraftInput,
  ) => Effect.Effect<ThreadBranchOffDraft, BranchLineageError>;
  readonly branchOff: (
    caller: LineageCaller,
    input: ThreadBranchOffInput,
  ) => Effect.Effect<ThreadBranchOffResult, BranchLineageError>;
  readonly moveToOwnMachine: (
    caller: LineageCaller,
    input: ThreadMoveToOwnMachineInput,
  ) => Effect.Effect<void, BranchLineageError>;
  /** "Start with a summary of …": written by a model on the caller's own account. */
  readonly summary: (
    caller: LineageCaller,
    input: ThreadBranchOffSummaryInput,
  ) => Effect.Effect<ThreadBranchOffSummary, BranchLineageError>;
  /** A shipped or settled branch becomes a thread of its own, its commits on the default branch. */
  readonly startFromMain: (
    caller: LineageCaller,
    input: ThreadStartFromMainInput,
  ) => Effect.Effect<ThreadStartFromMainResult, BranchLineageError>;
}

/** Creates branches and moves threads between machines; the rest of lineage is `BranchLineageService`. */
export class BranchOffService extends Context.Service<BranchOffService, BranchOffServiceShape>()(
  "t3/lineage/BranchOffService",
) {}
