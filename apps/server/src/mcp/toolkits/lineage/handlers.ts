import { type BranchLineageError, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BranchLineageService from "../../../lineage/BranchLineageService.ts";
import * as BranchOffService from "../../../lineage/BranchOffService.ts";
import type { LineageCaller } from "../../../lineage/LineageRepos.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { LineageToolkit } from "./tools.ts";

const failure = (error: BranchLineageError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not-found"
        ? "thread_not_found"
        : error.reason === "failed" || error.reason === null
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

/** The member an agent acts for: its thread's owner, or the member who connected the client. */
const lineageCaller = Effect.gen(function* () {
  const loaded = yield* readCaller();
  const memberId = loaded.caller?.ownerId ?? loaded.scope.client?.memberId;
  if (memberId === undefined || memberId === null) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Branch off needs a member; this credential has none.",
    });
  }
  const caller: LineageCaller = { memberId, authorKind: "agent" };
  return {
    caller,
    callingThreadId: loaded.caller?.id,
    lineage: yield* BranchLineageService.BranchLineageService,
    branchOff: yield* BranchOffService.BranchOffService,
  };
});

const targetOf = (threadId: ThreadId | undefined, callingThreadId: ThreadId | undefined) =>
  (threadId ?? callingThreadId)
    ? Effect.succeed((threadId ?? callingThreadId)!)
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "target_required",
          message: "Name the thread with `threadId`; this call has no calling thread.",
        }),
      );

export const layer = McpToolAccess.toLayer(LineageToolkit, {
  t3_thread_update_from_source: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { caller, callingThreadId, lineage } = yield* lineageCaller;
      const threadId = yield* targetOf(input.threadId, callingThreadId);
      if (input.abort === true) {
        yield* lineage.abortUpdate(caller, { threadId }).pipe(Effect.mapError(failure));
        return { files: [], conflicts: [], behind: 0, outcome: "aborted" as const };
      }
      const preview = yield* lineage
        .updatePreview(caller, { threadId })
        .pipe(Effect.mapError(failure));
      const summary = {
        files: preview.files.map((file) => file.path),
        conflicts: [...preview.conflicts],
        behind: preview.behind,
      };
      if (preview.conflicts.length > 0 && input.onConflict !== "resolve") {
        return { ...summary, outcome: "not-started" as const };
      }
      // The branch's own agent resolves in this turn; any other caller's Update waits for it.
      const result = yield* lineage
        .update(
          caller,
          { threadId, onConflict: "self" },
          { duringOwnTurn: threadId === callingThreadId },
        )
        .pipe(Effect.mapError(failure));
      return { ...summary, outcome: result.result };
    }),
  ),
  t3_thread_offer_changes: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { caller, callingThreadId, lineage } = yield* lineageCaller;
      const threadId = yield* targetOf(input.threadId, callingThreadId);
      if (input.withdraw === true) {
        const view = yield* lineage.read(caller, { threadId }).pipe(Effect.mapError(failure));
        const open = view.offers.find(
          (offer) => offer.branchThreadId === threadId && offer.state === "open",
        );
        if (open === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This branch has no open offer to withdraw.",
          });
        }
        const { offer } = yield* lineage
          .offerWithdraw(caller, { offerId: open.id })
          .pipe(Effect.mapError(failure));
        return {
          offerId: offer.id,
          state: offer.state,
          commits: offer.commits.length,
          files: offer.files.map((file) => file.path),
        };
      }
      const { offer } = yield* lineage
        .offerCreate(caller, {
          threadId,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
        })
        .pipe(Effect.mapError(failure));
      return {
        offerId: offer.id,
        state: offer.state,
        commits: offer.commits.length,
        files: offer.files.map((file) => file.path),
      };
    }),
  ),
  t3_thread_branch_off: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { caller, callingThreadId, branchOff } = yield* lineageCaller;
      const sourceThreadId = yield* targetOf(input.sourceThreadId, callingThreadId);
      const draft = yield* branchOff
        .draft(caller, { sourceThreadId })
        .pipe(Effect.mapError(failure));
      if (!draft.allowed) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This thread can't be branched off${draft.reason === undefined ? "" : ` (${draft.reason})`}.`,
        });
      }
      // Nobody's machine time is spent unattended: only the caller's own member's machine.
      const runsOn =
        (input.runsOn ?? "source-machine") === "source-machine" &&
        draft.machine.ownerId === caller.memberId
          ? "source-machine"
          : "new-machine";
      const { threadId } = yield* branchOff
        .branchOff(caller, {
          sourceThreadId,
          runsOn,
          startFrom: input.startFrom ?? { type: "latest" },
          branch: input.branch ?? draft.suggestedBranch,
          prompt: input.prompt,
        })
        .pipe(Effect.mapError(failure));
      return { threadId, runsOn };
    }),
  ),
});
