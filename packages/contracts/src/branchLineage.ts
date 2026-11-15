import * as Schema from "effect/Schema";

import {
  ForwardCompatibleNullable,
  IsoDateTime,
  MemberId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

// Branch off (Spaces redesign Part 2). The "source" is the thread branched off, the "branch" the new
// thread. Unrelated to `OrchestrationV2AppThreadLineage`, which records fork and subagent parents.

export const OfferId = TrimmedNonEmptyString.check(Schema.isPattern(/^ofr_[0-9a-f]{20}$/)).pipe(
  Schema.brand("OfferId"),
);
export type OfferId = typeof OfferId.Type;

/** As git prints it, relative to the repository root; not trimmed, since a name may end in a space. */
const LineagePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
const GitSha = TrimmedNonEmptyString;

export const LineageRunsOn = Schema.Literals(["source-machine", "new-machine"]);
export type LineageRunsOn = typeof LineageRunsOn.Type;

export const LineageStartFrom = Schema.Union([
  Schema.Struct({ type: Schema.Literal("latest") }),
  Schema.Struct({ type: Schema.Literal("turn"), runId: RunId }),
  Schema.Struct({ type: Schema.Literal("branch"), branch: TrimmedNonEmptyString }),
]);
export type LineageStartFrom = typeof LineageStartFrom.Type;

export const LineageUpdateResolver = Schema.Literals(["agent", "self"]);
export type LineageUpdateResolver = typeof LineageUpdateResolver.Type;

export const LineageSourceState = Schema.Literals([
  "open",
  "shipped",
  "settled",
  "archived",
  "deleted",
]);
export type LineageSourceState = typeof LineageSourceState.Type;

/** A commit on the branch whose tree is the source's checkpoint, authored as the source's owner. */
export const LineageSnapshot = Schema.Struct({
  sha: GitSha,
  sourceRunId: Schema.NullOr(RunId),
  sourceTurn: NonNegativeInt,
  createdAt: IsoDateTime,
  state: Schema.Literals(["on-branch", "undone", "aborted", "pending"]),
  mergeCommit: Schema.NullOr(GitSha),
  undoCommit: Schema.NullOr(GitSha),
});
export type LineageSnapshot = typeof LineageSnapshot.Type;

/** One per branch, rewritten whole by `thread.branch-lineage.record` with a higher `revision`. */
export const BranchLineage = Schema.Struct({
  branchThreadId: ThreadId,
  sourceThreadId: ThreadId,
  sourceOwnerId: Schema.NullOr(MemberId),
  createdAt: IsoDateTime,
  createdBy: MemberId,
  runsOn: LineageRunsOn,
  startFrom: LineageStartFrom,
  snapshots: Schema.Array(LineageSnapshot),
  /** An Update whose merge is still open. Offer and Undo update wait for it. */
  update: Schema.NullOr(
    Schema.Struct({
      snapshotSha: GitSha,
      conflictedPaths: Schema.Array(LineagePath),
      resolver: LineageUpdateResolver,
      startedAt: IsoDateTime,
      preUpdateHead: GitSha,
      wipCommit: Schema.NullOr(GitSha),
    }),
  ),
  /** Offered until the branch's next turn. */
  undoableUpdate: Schema.NullOr(
    Schema.Struct({
      snapshotSha: GitSha,
      mergeCommit: GitSha,
      preUpdateHead: GitSha,
      wipCommit: Schema.NullOr(GitSha),
    }),
  ),
  toOffer: Schema.Struct({ count: NonNegativeInt, commits: Schema.Array(GitSha) }),
  /** The source's turns the branch doesn't have yet. */
  behind: NonNegativeInt,
  sourceState: LineageSourceState,
  shipped: Schema.NullOr(
    Schema.Struct({ url: Schema.String, number: NonNegativeInt, label: Schema.String }),
  ),
  /** Commits not in the shipped pull request. */
  unshipped: NonNegativeInt,
  reverted: Schema.NullOr(
    Schema.Struct({
      offerId: OfferId,
      keptHere: Schema.Boolean,
      commits: Schema.Array(GitSha),
    }),
  ),
  revision: NonNegativeInt,
  /** Start from main with them made it a thread of its own; the record stays for history. */
  detachedAt: Schema.optionalKey(IsoDateTime),
});
export type BranchLineage = typeof BranchLineage.Type;

export const OfferState = Schema.Literals(["open", "applied", "declined", "withdrawn", "returned"]);
export type OfferState = typeof OfferState.Type;

export const OfferReturnReason = Schema.Literals(["conflict", "retries", "source-gone"]);
export type OfferReturnReason = typeof OfferReturnReason.Type;

export const OfferCommit = Schema.Struct({
  sha: GitSha,
  subject: Schema.String,
  authorName: Schema.String,
});
export type OfferCommit = typeof OfferCommit.Type;

export const OfferFile = Schema.Struct({
  path: LineagePath,
  previousPath: Schema.optional(LineagePath),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OfferFile = typeof OfferFile.Type;

/** A record with a state, not a queue entry: an undecided offer holds nothing up. */
export const Offer = Schema.Struct({
  id: OfferId,
  sourceThreadId: ThreadId,
  branchThreadId: ThreadId,
  senderId: MemberId,
  senderKind: Schema.Literals(["person", "agent"]),
  note: Schema.NullOr(Schema.String),
  state: OfferState,
  commits: Schema.Array(OfferCommit),
  files: Schema.Array(OfferFile),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  base: GitSha,
  tip: GitSha,
  /** This offer replaced an open one, so its card says "updated". */
  replaced: Schema.Boolean,
  /** Apply was pressed during a turn; the step runs at the turn boundary. */
  armedAt: Schema.NullOr(IsoDateTime),
  returnReason: Schema.NullOr(OfferReturnReason),
  returnPaths: Schema.Array(LineagePath),
  decidedBy: Schema.NullOr(MemberId),
  decidedAt: Schema.NullOr(IsoDateTime),
  revertedAt: Schema.NullOr(IsoDateTime),
  revertedBy: Schema.NullOr(MemberId),
  waiting: Schema.NullOr(Schema.Literal("source-archived")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Offer = typeof Offer.Type;

/**
 * The structured part of a lineage `system_notice`. Clients word it for the viewer ("You" or a
 * name) from the actor ids; the notice's `message` is the third-person text older clients show.
 */
export const LineageNotice = Schema.Union([
  /** In the source. */
  Schema.Struct({
    kind: Schema.Literal("branched-off"),
    actorId: MemberId,
    branchThreadId: ThreadId,
  }),
  /** In the branch. */
  Schema.Struct({
    kind: Schema.Literal("branched-from"),
    actorId: MemberId,
    sourceThreadId: ThreadId,
    sourceOwnerId: Schema.NullOr(MemberId),
    turn: NonNegativeInt,
    uncommittedFiles: NonNegativeInt,
    runsOn: LineageRunsOn,
  }),
  Schema.Struct({
    kind: Schema.Literal("updated"),
    snapshotSha: GitSha,
    files: NonNegativeInt,
    turn: NonNegativeInt,
  }),
  Schema.Struct({ kind: Schema.Literal("update-conflict"), paths: Schema.Array(LineagePath) }),
  Schema.Struct({ kind: Schema.Literal("update-aborted") }),
  Schema.Struct({ kind: Schema.Literal("update-undone") }),
  Schema.Struct({ kind: Schema.Literal("agent-told"), text: Schema.String }),
  /** In the source: the offer card. */
  Schema.Struct({ kind: Schema.Literal("offer"), offerId: OfferId, senderId: MemberId }),
  /** In the branch. */
  Schema.Struct({ kind: Schema.Literal("offer-sent"), offerId: OfferId, senderId: MemberId }),
  Schema.Struct({
    kind: Schema.Literal("applied"),
    offerId: OfferId,
    actorId: MemberId,
    senderId: MemberId,
    files: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("declined"),
    offerId: OfferId,
    actorId: MemberId,
    senderId: MemberId,
  }),
  Schema.Struct({ kind: Schema.Literal("withdrawn"), offerId: OfferId, senderId: MemberId }),
  Schema.Struct({
    kind: Schema.Literal("returned"),
    offerId: OfferId,
    paths: Schema.Array(LineagePath),
  }),
  Schema.Struct({
    kind: Schema.Literal("reverted"),
    offerId: OfferId,
    actorId: MemberId,
    senderId: MemberId,
    files: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("credited-commit"),
    sha: GitSha,
    subject: Schema.String,
    coAuthor: MemberId,
  }),
  Schema.Struct({ kind: Schema.Literal("reverted-kept"), offerId: OfferId }),
  /** Its row carries Bring them back. */
  Schema.Struct({ kind: Schema.Literal("reverted-removed"), offerId: OfferId }),
  Schema.Struct({ kind: Schema.Literal("brought-back"), commits: Schema.Array(GitSha) }),
  Schema.Struct({ kind: Schema.Literal("moved-machine"), actorId: MemberId }),
]);
export type LineageNotice = typeof LineageNotice.Type;

/** The shell's lineage summary. Clients refetch `lineage.read` when `revision` changes. */
export const OrchestrationV2ThreadShellBranchLink = Schema.Struct({
  revision: NonNegativeInt,
  /** Set on a branch. */
  source: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      ownerId: Schema.NullOr(MemberId),
      /** Null when the viewer can't open the source. */
      title: Schema.NullOr(Schema.String),
      /** A state from a newer server decodes to null. */
      state: ForwardCompatibleNullable(
        Schema.Literals(["open", "shipped", "settled", "archived", "deleted", "unavailable"]),
      ),
      toOffer: NonNegativeInt,
      behind: NonNegativeInt,
      updateInProgress: Schema.NullOr(
        Schema.Struct({
          conflictedPaths: Schema.Array(LineagePath),
          resolver: LineageUpdateResolver,
        }),
      ),
      undoableUpdate: Schema.Boolean,
      offerState: ForwardCompatibleNullable(OfferState),
      allApplied: Schema.Boolean,
      shippedLabel: Schema.NullOr(Schema.String),
      unshipped: NonNegativeInt,
    }),
  ),
  /** As a source: offers waiting on its owner. */
  openOffers: NonNegativeInt,
});
export type OrchestrationV2ThreadShellBranchLink = typeof OrchestrationV2ThreadShellBranchLink.Type;

/**
 * A lineage step the orchestrator runs at the thread's next turn boundary, before its next queued
 * message: Apply or Revert on a source, Update on a branch. `running` once its effect is enqueued.
 */
export const BranchLineageStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  kind: Schema.Literals(["apply", "revert", "update"]),
  offerId: Schema.NullOr(OfferId),
  onConflict: Schema.NullOr(LineageUpdateResolver),
  armedBy: MemberId,
  armedAt: IsoDateTime,
  state: Schema.Literals(["armed", "running"]),
});
export type BranchLineageStep = typeof BranchLineageStep.Type;

// RPCs. Every write goes through BranchLineageService, which enforces who may act.

export const BRANCH_LINEAGE_WS_METHODS = {
  lineageRead: "lineage.read",
  threadBranchOffDraft: "thread.branchOffDraft",
  threadBranchOff: "thread.branchOff",
  threadUpdatePreview: "thread.updatePreview",
  threadUpdate: "thread.update",
  threadAbortUpdate: "thread.abortUpdate",
  threadUndoUpdate: "thread.undoUpdate",
  threadBringBack: "thread.bringBack",
  offerPreview: "offer.preview",
  offerCreate: "offer.create",
  offerWithdraw: "offer.withdraw",
  offerApply: "offer.apply",
  offerDecline: "offer.decline",
  threadRevertOffer: "thread.revertOffer",
  threadMoveToOwnMachine: "thread.moveToOwnMachine",
  threadBranchOffSummary: "thread.branchOffSummary",
  threadStartFromMain: "thread.startFromMain",
  offerDiff: "offer.diff",
} as const;

export const BranchLineageErrorReason = Schema.Literals([
  "not-found",
  "not-allowed",
  "not-owner",
  "not-source-owner",
  "not-cloud",
  "branch-of-branch",
  "busy",
  "machine-gone",
  "no-account",
  "update-open",
  "nothing-to-offer",
  "would-conflict",
  "source-unavailable",
  "turn-running",
  "failed",
]);
export type BranchLineageErrorReason = typeof BranchLineageErrorReason.Type;

/** Clients show `message`. A newer server's reason reads as null. */
export class BranchLineageError extends Schema.TaggedError<BranchLineageError>()(
  "BranchLineageError",
  {
    reason: ForwardCompatibleNullable(BranchLineageErrorReason),
    message: Schema.String,
  },
) {}

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const OfferInput = Schema.Struct({ offerId: OfferId });

export const LineageReadInput = ThreadInput;
export type LineageReadInput = typeof LineageReadInput.Type;

export const LineageWorkState = Schema.Literals(["working", "waiting", "idle", "settled"]);
export type LineageWorkState = typeof LineageWorkState.Type;

/** Viewer-filtered: only threads the caller may open are named. */
export const LineageView = Schema.Struct({
  thread: Schema.Struct({
    threadId: ThreadId,
    role: Schema.Literals(["source", "branch", "none"]),
  }),
  source: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.NullOr(Schema.String),
      ownerId: Schema.NullOr(MemberId),
      state: ForwardCompatibleNullable(LineageSourceState),
      canOpen: Schema.Boolean,
    }),
  ),
  branches: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      ownerId: Schema.NullOr(MemberId),
      branch: Schema.NullOr(Schema.String),
      runsOn: LineageRunsOn,
      toOffer: NonNegativeInt,
      behind: NonNegativeInt,
      workState: ForwardCompatibleNullable(LineageWorkState),
    }),
  ),
  lineage: Schema.NullOr(BranchLineage),
  /** For a source, offers to it, open first then the recent 20; for a branch, its recent 20. */
  offers: Schema.Array(Offer),
});
export type LineageView = typeof LineageView.Type;

export const ThreadBranchOffDraftInput = Schema.Struct({ sourceThreadId: ThreadId });
export type ThreadBranchOffDraftInput = typeof ThreadBranchOffDraftInput.Type;

export const ThreadBranchOffDraft = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optional(BranchLineageErrorReason),
  sourceTitle: Schema.String,
  sourceOwnerId: Schema.NullOr(MemberId),
  latestTurn: Schema.Struct({
    turn: NonNegativeInt,
    at: Schema.NullOr(IsoDateTime),
    uncommittedFiles: NonNegativeInt,
  }),
  turns: Schema.Array(
    Schema.Struct({
      runId: RunId,
      turn: NonNegativeInt,
      at: IsoDateTime,
      title: Schema.String,
    }),
  ),
  machine: Schema.Struct({
    state: ForwardCompatibleNullable(
      Schema.Literals(["ready", "asleep", "failed", "gone", "none"]),
    ),
    working: NonNegativeInt,
    vcpus: Schema.optional(NonNegativeInt),
    ownerId: Schema.NullOr(MemberId),
  }),
  /** Who can open the source's machine. */
  audience: Schema.Array(MemberId),
  busy: Schema.Boolean,
  suggestedBranch: Schema.String,
  taskTitle: Schema.optional(Schema.String),
});
export type ThreadBranchOffDraft = typeof ThreadBranchOffDraft.Type;

export const ThreadBranchOffInput = Schema.Struct({
  sourceThreadId: ThreadId,
  runsOn: LineageRunsOn,
  startFrom: LineageStartFrom,
  branch: TrimmedNonEmptyString,
  prompt: Schema.String.check(Schema.isMaxLength(120_000)),
  /** Already edited by the user; sent as part of the first message. */
  contextSummary: Schema.optional(Schema.String.check(Schema.isMaxLength(120_000))),
  modelSelection: Schema.optional(ModelSelection),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ThreadBranchOffInput = typeof ThreadBranchOffInput.Type;

export const ThreadBranchOffResult = Schema.Struct({ threadId: ThreadId });
export type ThreadBranchOffResult = typeof ThreadBranchOffResult.Type;

export const ThreadUpdatePreviewInput = ThreadInput;
export type ThreadUpdatePreviewInput = typeof ThreadUpdatePreviewInput.Type;

export const ThreadUpdatePreview = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: LineagePath, status: Schema.Literals(["clean", "conflict"]) }),
  ),
  conflicts: Schema.Array(LineagePath),
  behind: NonNegativeInt,
  sourceTitle: Schema.String,
});
export type ThreadUpdatePreview = typeof ThreadUpdatePreview.Type;

export const ThreadUpdateInput = Schema.Struct({
  threadId: ThreadId,
  onConflict: LineageUpdateResolver,
});
export type ThreadUpdateInput = typeof ThreadUpdateInput.Type;

export const ThreadUpdateResult = Schema.Struct({
  /** `armed`: a turn is running, and the Update runs after it. */
  result: Schema.Literals(["merged", "conflicted", "armed"]),
  files: NonNegativeInt,
  conflicts: Schema.Array(LineagePath),
});
export type ThreadUpdateResult = typeof ThreadUpdateResult.Type;

export const ThreadAbortUpdateInput = ThreadInput;
export type ThreadAbortUpdateInput = typeof ThreadAbortUpdateInput.Type;
export const ThreadUndoUpdateInput = ThreadInput;
export type ThreadUndoUpdateInput = typeof ThreadUndoUpdateInput.Type;
export const ThreadBringBackInput = ThreadInput;
export type ThreadBringBackInput = typeof ThreadBringBackInput.Type;
export const ThreadMoveToOwnMachineInput = ThreadInput;
export type ThreadMoveToOwnMachineInput = typeof ThreadMoveToOwnMachineInput.Type;

/** Written on the caller's account; the draft shows it as an editable first message. */
export const ThreadBranchOffSummaryInput = Schema.Struct({
  sourceThreadId: ThreadId,
  /** The draft's model; without it, the caller's own text generation account. */
  modelSelection: Schema.optional(ModelSelection),
});
export type ThreadBranchOffSummaryInput = typeof ThreadBranchOffSummaryInput.Type;

export const ThreadBranchOffSummary = Schema.Struct({ text: Schema.String });
export type ThreadBranchOffSummary = typeof ThreadBranchOffSummary.Type;

/** A shipped or settled branch's unshipped commits move onto the default branch. */
export const ThreadStartFromMainInput = ThreadInput;
export type ThreadStartFromMainInput = typeof ThreadStartFromMainInput.Type;

export const ThreadStartFromMainResult = Schema.Struct({
  /** The default branch the commits now sit on. */
  base: Schema.String,
  commits: NonNegativeInt,
  /** It ran on the source's machine, so it moved to the caller's own. */
  movedMachine: Schema.Boolean,
});
export type ThreadStartFromMainResult = typeof ThreadStartFromMainResult.Type;

export const OfferPreviewInput = ThreadInput;
export type OfferPreviewInput = typeof OfferPreviewInput.Type;

export const OfferPreview = Schema.Struct({
  commits: Schema.Array(OfferCommit),
  files: Schema.Array(OfferFile),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Committed first, as the sender, when the offer is sent. */
  uncommittedFiles: Schema.Array(LineagePath),
  check: Schema.Union([
    Schema.Struct({ clean: Schema.Literal(true) }),
    Schema.Struct({ clean: Schema.Literal(false), paths: Schema.Array(LineagePath) }),
  ]),
  sourceTitle: Schema.String,
  sourceOwnerId: Schema.NullOr(MemberId),
});
export type OfferPreview = typeof OfferPreview.Type;

export const OfferCreateInput = Schema.Struct({
  threadId: ThreadId,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
});
export type OfferCreateInput = typeof OfferCreateInput.Type;

export const OfferWithdrawInput = OfferInput;
export type OfferWithdrawInput = typeof OfferWithdrawInput.Type;
export const OfferApplyInput = OfferInput;
export type OfferApplyInput = typeof OfferApplyInput.Type;
export const OfferDeclineInput = OfferInput;
export type OfferDeclineInput = typeof OfferDeclineInput.Type;
export const ThreadRevertOfferInput = OfferInput;
export type ThreadRevertOfferInput = typeof ThreadRevertOfferInput.Type;

/** The offer after the action; `armedAt` set means it runs when the current turn ends. */
export const OfferResult = Schema.Struct({ offer: Offer });
export type OfferResult = typeof OfferResult.Type;

/** An offer's combined change, `base..tip`: only the sender's lines. */
export const OfferDiffInput = OfferInput;
export type OfferDiffInput = typeof OfferDiffInput.Type;

export const OfferDiffFile = Schema.Struct({
  path: LineagePath,
  previousPath: Schema.optional(LineagePath),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  /** The file's unified diff, starting at its `diff --git` line. */
  patch: Schema.String,
});
export type OfferDiffFile = typeof OfferDiffFile.Type;

export const OfferDiff = Schema.Struct({ files: Schema.Array(OfferDiffFile) });
export type OfferDiff = typeof OfferDiff.Type;
