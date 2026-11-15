import {
  LineageRunsOn,
  LineageStartFrom,
  NonNegativeInt,
  OfferId,
  OfferState,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BranchLineageService from "../../../lineage/BranchLineageService.ts";
import * as BranchOffService from "../../../lineage/BranchOffService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BranchLineageService.BranchLineageService,
    BranchOffService.BranchOffService,
  ],
};

const UpdateFromSourceTool = Tool.make("t3_thread_update_from_source", {
  ...shared,
  description:
    "Merge the source thread's latest work into this branch. Returns the preflight: files it changes and those conflicting with yours. With conflicts it stops unless `onConflict` is `resolve`, which leaves markers for you to resolve and commit; never abort or stash it. `abort: true` aborts an open update. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    onConflict: Schema.optional(Schema.Literals(["resolve", "abort"])),
    abort: Schema.optional(Schema.Literal(true)),
  }),
  success: Schema.Struct({
    files: Schema.Array(Schema.String),
    conflicts: Schema.Array(Schema.String),
    behind: NonNegativeInt,
    outcome: Schema.Literals(["merged", "conflicted", "not-started", "armed", "aborted"]),
  }),
})
  .annotate(Tool.Title, "Update from source")
  .annotate(Tool.Destructive, false);

const OfferChangesTool = Tool.make("t3_thread_offer_changes", {
  ...shared,
  description:
    "Offer this branch's own commits to its source thread's owner, who applies or declines. Commits uncommitted work first. Refused if it wouldn't apply cleanly: update from the source first. Replaces the open offer; `withdraw: true` withdraws it. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
    commitMessage: Schema.optional(TrimmedNonEmptyString),
    withdraw: Schema.optional(Schema.Literal(true)),
  }),
  success: Schema.Struct({
    offerId: OfferId,
    state: OfferState,
    commits: NonNegativeInt,
    files: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Title, "Offer changes")
  .annotate(Tool.Destructive, false);

const BranchOffTool = Tool.make("t3_thread_branch_off", {
  ...shared,
  description:
    "Start your own thread on a cloud thread's work, with its own worktree and branch, from its latest checkpoint or `startFrom`, running `prompt` first. Runs on a new machine unless the source's is your own. Not on a branch. Omit `sourceThreadId` for this thread.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120_000)),
    branch: Schema.optional(TrimmedNonEmptyString),
    startFrom: Schema.optional(LineageStartFrom),
    runsOn: Schema.optional(LineageRunsOn),
  }),
  success: Schema.Struct({ threadId: ThreadId, runsOn: LineageRunsOn }),
})
  .annotate(Tool.Title, "Branch off")
  .annotate(Tool.Destructive, false);

export const LineageToolkit = Toolkit.make(UpdateFromSourceTool, OfferChangesTool, BranchOffTool);
