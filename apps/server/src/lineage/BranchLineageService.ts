import {
  type BranchLineage,
  BranchLineageError,
  type BranchLineageErrorReason,
  type BranchLineageStep,
  CommandId,
  type LineageNotice,
  type LineageReadInput,
  type LineageSnapshot,
  type LineageSourceState,
  type LineageUpdateResolver,
  type LineageView,
  type MemberId,
  MessageId,
  type Offer,
  type OfferCreateInput,
  type OfferDiff,
  type OfferDiffInput,
  OfferId,
  type OfferPreview,
  type OfferPreviewInput,
  type OfferResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type ThreadAbortUpdateInput,
  type ThreadBringBackInput,
  type ThreadId,
  type ThreadUndoUpdateInput,
  type ThreadUpdateInput,
  type ThreadUpdatePreview,
  type ThreadUpdatePreviewInput,
  type ThreadUpdateResult,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import { holderOf } from "../orchestration-v2/MemberThreadState.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { appliedNote, listFiles, updatedNote } from "./LineageAgentNotes.ts";
import { lineageNoticeMessage, lineageRefusal } from "./BranchLineageDecisions.ts";
import { BranchLineageStepError } from "./BranchLineageStepExecutor.ts";
import { type LineageAuthor, LineageGit, LineageGitError } from "./LineageGit.ts";
import { type LineageCaller, LineageRepos } from "./LineageRepos.ts";

/**
 * Update, Offer, Apply and Revert (Spaces redesign Part 2). Every action checks who may act, does
 * its git work through `LineageGit` in the threads' checkouts, and records the result as one
 * orchestration command, which the Orchestrator re-decides under the thread's lock.
 */
export interface BranchLineageServiceShape {
  readonly read: (
    caller: LineageCaller,
    input: LineageReadInput,
  ) => Effect.Effect<LineageView, BranchLineageError>;
  readonly updatePreview: (
    caller: LineageCaller,
    input: ThreadUpdatePreviewInput,
  ) => Effect.Effect<ThreadUpdatePreview, BranchLineageError>;
  /**
   * During a turn it arms and runs when the turn ends, unless the branch's own agent asked from
   * that turn (`duringOwnTurn`), which then resolves any conflict itself.
   */
  readonly update: (
    caller: LineageCaller,
    input: ThreadUpdateInput,
    options?: { readonly duringOwnTurn?: boolean },
  ) => Effect.Effect<ThreadUpdateResult, BranchLineageError>;
  readonly abortUpdate: (
    caller: LineageCaller,
    input: ThreadAbortUpdateInput,
  ) => Effect.Effect<void, BranchLineageError>;
  readonly undoUpdate: (
    caller: LineageCaller,
    input: ThreadUndoUpdateInput,
  ) => Effect.Effect<void, BranchLineageError>;
  readonly bringBack: (
    caller: LineageCaller,
    input: ThreadBringBackInput,
  ) => Effect.Effect<void, BranchLineageError>;
  readonly offerPreview: (
    caller: LineageCaller,
    input: OfferPreviewInput,
  ) => Effect.Effect<OfferPreview, BranchLineageError>;
  readonly offerCreate: (
    caller: LineageCaller,
    input: OfferCreateInput,
  ) => Effect.Effect<OfferResult, BranchLineageError>;
  /** View changes: the offer's own lines, for anyone who may open its source or its branch. */
  readonly offerDiff: (
    caller: LineageCaller,
    input: OfferDiffInput,
  ) => Effect.Effect<OfferDiff, BranchLineageError>;
  readonly offerWithdraw: (
    caller: LineageCaller,
    input: { readonly offerId: OfferId },
  ) => Effect.Effect<OfferResult, BranchLineageError>;
  /** Arms; idle, the step runs at once. */
  readonly offerApply: (
    caller: LineageCaller,
    input: { readonly offerId: OfferId },
  ) => Effect.Effect<OfferResult, BranchLineageError>;
  readonly offerDecline: (
    caller: LineageCaller,
    input: { readonly offerId: OfferId },
  ) => Effect.Effect<OfferResult, BranchLineageError>;
  readonly revertOffer: (
    caller: LineageCaller,
    input: { readonly offerId: OfferId },
  ) => Effect.Effect<OfferResult, BranchLineageError>;
  /** The armed-step executor's work: idempotent, since a step replays after a restart. */
  readonly runStep: (step: BranchLineageStep) => Effect.Effect<void, BranchLineageStepError>;
  /**
   * After a thread's checkpoint commits: on a branch, the open Update, "to offer" and "behind";
   * on a source, its branches' "behind" (no git) and its credit record.
   */
  readonly afterCheckpoint: (threadId: ThreadId) => Effect.Effect<void, BranchLineageError>;
  /** The source's state changed (settled, archived, deleted, shipped): its branches follow. */
  readonly sourceChanged: (threadId: ThreadId) => Effect.Effect<void, BranchLineageError>;
  /** Branches whose owner can no longer open their source lose their open offers. */
  readonly accessChanged: (sourceThreadId: ThreadId) => Effect.Effect<void, BranchLineageError>;
}

export class BranchLineageService extends Context.Service<
  BranchLineageService,
  BranchLineageServiceShape
>()("t3/lineage/BranchLineageService") {}

const RECENT_OFFERS = 20;
const PAIR_AUTHOR: LineageAuthor = { name: "Pair", email: "pair@users.noreply.github.com" };

const isLineageError = Schema.is(BranchLineageError);
const isDispatchError = Schema.is(OrchestratorDispatchError);
const isNotFound = Schema.is(ProjectionStoreThreadNotFoundError);
const isGitError = Schema.is(LineageGitError);

const refuse = (reason: BranchLineageErrorReason, message: string) =>
  Effect.fail(lineageRefusal(reason, message));

const toLineageError = (error: unknown): BranchLineageError => {
  if (isLineageError(error)) return error;
  if (isDispatchError(error) && isLineageError(error.cause)) return error.cause;
  if (isNotFound(error)) return lineageRefusal("not-found", "That thread is gone.");
  if (isGitError(error) && error.reason === "offer-conflict")
    return lineageRefusal("would-conflict", error.message);
  return lineageRefusal("failed", error instanceof Error ? error.message : String(error));
};

const isActive = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

const isSettled = (thread: OrchestrationV2AppThread) =>
  thread.settledOverride === "settled" ||
  (thread.settledOverride !== "active" && thread.settledAt !== null);

/** The source's state as its branches show it. */
const sourceStateOf = (
  source: OrchestrationV2AppThread | null,
): {
  readonly state: LineageSourceState;
  readonly shipped: BranchLineage["shipped"];
} => {
  if (source === null || source.deletedAt !== null) return { state: "deleted", shipped: null };
  const merged = (source.pullRequests ?? []).find((pr) => pr.snapshot?.state === "merged");
  if (merged !== undefined) {
    const repository = merged.repository.split("/").at(-1) ?? merged.repository;
    return {
      state: "shipped",
      shipped: { url: merged.url, number: merged.number, label: `${repository}#${merged.number}` },
    };
  }
  if (source.archivedAt !== null) return { state: "archived", shipped: null };
  return { state: isSettled(source) ? "settled" : "open", shipped: null };
};

/** The newest snapshot still on the branch: Update's merge base and the offer's base. */
const baseSnapshot = (lineage: BranchLineage) =>
  lineage.snapshots.findLast((snapshot) => snapshot.state === "on-branch") ?? null;

/** Snapshots and the commits that undid them never travel in an offer. */
const lineageCommits = (lineage: BranchLineage) =>
  lineage.snapshots.flatMap((snapshot) => [
    snapshot.sha,
    ...(snapshot.undoCommit === null ? [] : [snapshot.undoCommit]),
  ]);

interface LatestCheckpoint {
  readonly run: OrchestrationV2Run;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly scope: OrchestrationV2CheckpointScope;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const repos = yield* LineageRepos;
  const git = yield* LineageGit;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const team = yield* Effect.serviceOption(TeamState.TeamState);
  const access = yield* Effect.serviceOption(ThreadAccess.ThreadAccess);
  const locks = yield* KeyedLock.make<ThreadId>();

  const serverOwnerId = Option.map(team, (state) => state.ownerId);
  const holder = (thread: OrchestrationV2AppThread): MemberId | null =>
    Option.match(serverOwnerId, {
      onNone: () => thread.ownerId ?? null,
      onSome: (ownerId) => holderOf(thread, ownerId),
    });
  const mayOpen = (memberId: MemberId, thread: OrchestrationV2AppThread) =>
    thread.deletedAt === null &&
    Option.match(access, {
      onNone: () => true,
      onSome: (rule) => rule.allowsThread(memberId, thread),
    });

  const lift = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toLineageError));
  const nameOf = Effect.fn("BranchLineageService.nameOf")(function* (memberId: MemberId | null) {
    if (memberId === null || Option.isNone(team)) return "Someone";
    const member = (yield* Ref.get(team.value.members)).get(memberId);
    return member === undefined
      ? "Someone"
      : member.removedAt === null
        ? member.name
        : "A former member";
  });
  const authorFor = Effect.fn("BranchLineageService.authorFor")(function* (
    memberId: MemberId | null,
  ) {
    if (memberId === null || Option.isNone(team)) return PAIR_AUTHOR;
    const author = yield* team.value.gitAuthorFor(memberId);
    return author ?? { name: yield* nameOf(memberId), email: PAIR_AUTHOR.email };
  });
  /** `Name <email>` for a Co-authored-by trailer; null without a git email of their own. */
  const coAuthorOf = Effect.fn("BranchLineageService.coAuthorOf")(function* (memberId: MemberId) {
    if (Option.isNone(team)) return null;
    const author = yield* team.value.gitAuthorFor(memberId);
    return author === undefined ? null : `${author.name} <${author.email}>`;
  });

  const uniqueId = Effect.fn("BranchLineageService.uniqueId")(function* () {
    return (yield* random.uuidV4()).replaceAll("-", "");
  });
  const commandId = (name: string) =>
    Effect.map(uniqueId(), (id) => CommandId.make(`command:lineage:${name}:${id}`));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    lift(threads.dispatch(command)).pipe(Effect.asVoid);

  const findThread = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread): OrchestrationV2AppThread | null => thread),
      Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      Effect.mapError(toLineageError),
    );

  /** A thread the caller may open; refused as a missing one, so a refusal confirms nothing. */
  const openThread = Effect.fn("BranchLineageService.openThread")(function* (
    caller: LineageCaller,
    threadId: ThreadId,
  ) {
    const thread = yield* findThread(threadId);
    if (thread === null || !mayOpen(caller.memberId, thread))
      return yield* refuse("not-found", "That thread is gone.");
    return thread;
  });

  const turnRunning = (threadId: ThreadId) =>
    lift(
      projections.getThreadRecords(threadId, ["runs"], {
        runStatuses: ["preparing", "starting", "running", "waiting"],
      }),
    ).pipe(Effect.map((records) => records.runs.some(isActive)));

  const getLineage = (threadId: ThreadId) => lift(projections.getBranchLineage(threadId));
  const getOffer = Effect.fn("BranchLineageService.getOffer")(function* (offerId: OfferId) {
    const offer = yield* lift(projections.getOffer(offerId));
    if (offer === null) return yield* refuse("not-found", "That offer is gone.");
    return offer;
  });

  /** Rewrites the record with the next revision, and records its timeline row with it. */
  const record = Effect.fn("BranchLineageService.record")(function* (
    current: BranchLineage,
    changes: Partial<Omit<BranchLineage, "revision">>,
    options: { readonly notice?: LineageNotice; readonly commandId?: CommandId } = {},
  ) {
    const next: BranchLineage = { ...current, ...changes, revision: current.revision + 1 };
    yield* dispatch({
      type: "thread.branch-lineage.record",
      commandId: options.commandId ?? (yield* commandId("record")),
      threadId: current.branchThreadId,
      lineage: next,
      ...(options.notice === undefined ? {} : { notice: options.notice }),
    });
    return next;
  });

  /** A runless row on a thread, worded here because no record command carries it. */
  const notice = Effect.fn("BranchLineageService.notice")(function* (
    threadId: ThreadId,
    lineage: LineageNotice,
    context: { readonly sourceThreadId: ThreadId; readonly branchThreadId: ThreadId },
    id?: CommandId,
  ) {
    const titles = new Map<ThreadId, string>();
    for (const candidate of [context.sourceThreadId, context.branchThreadId]) {
      titles.set(candidate, (yield* findThread(candidate))?.title ?? "a deleted thread");
    }
    const names = new Map<MemberId, string>();
    for (const memberId of [
      ...("actorId" in lineage ? [lineage.actorId] : []),
      ...("senderId" in lineage ? [lineage.senderId] : []),
      ...("coAuthor" in lineage ? [lineage.coAuthor] : []),
    ]) {
      names.set(memberId, yield* nameOf(memberId));
    }
    const message = lineageNoticeMessage(lineage, {
      ...context,
      nameOf: (memberId) => names.get(memberId) ?? "Someone",
      titleOf: (candidate) => titles.get(candidate) ?? "a thread",
      where: threadId === context.sourceThreadId ? "source" : "branch",
    });
    yield* dispatch({
      type: "thread.notice.record",
      commandId: id ?? (yield* commandId("notice")),
      threadId,
      message: message.trim() === "" ? "Lineage updated" : message,
      lineage,
    });
  });

  const tellAgent = (
    threadId: ThreadId,
    text: string,
    context: { readonly sourceThreadId: ThreadId; readonly branchThreadId: ThreadId },
    id?: CommandId,
  ) => notice(threadId, { kind: "agent-told", text }, context, id);

  const latestCheckpoint = Effect.fn("BranchLineageService.latestCheckpoint")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* lift(
      projections.getThreadRecords(threadId, ["runs", "checkpoints", "checkpointScopes"]),
    );
    const run = records.runs
      .filter((candidate) => candidate.checkpointId !== null && candidate.status !== "rolled_back")
      .reduce<OrchestrationV2Run | null>(
        (latest, candidate) =>
          latest === null || candidate.ordinal > latest.ordinal ? candidate : latest,
        null,
      );
    if (run === null) return null;
    const checkpoint = records.checkpoints.find((candidate) => candidate.id === run.checkpointId);
    if (checkpoint === undefined || checkpoint.status !== "ready") return null;
    const scope = records.checkpointScopes.find((candidate) => candidate.id === checkpoint.scopeId);
    if (scope === undefined) return null;
    return { run, checkpoint, scope } satisfies LatestCheckpoint;
  });

  /** The source's turns since a snapshot; read from records, never from git. */
  const turnsSince = Effect.fn("BranchLineageService.turnsSince")(function* (
    sourceThreadId: ThreadId,
    sourceTurn: number,
  ) {
    const records = yield* lift(projections.getThreadRecords(sourceThreadId, ["runs"]));
    return records.runs.filter(
      (run) =>
        run.checkpointId !== null && run.status !== "rolled_back" && run.ordinal > sourceTurn,
    ).length;
  });

  /**
   * The source as Apply would write to it: its latest checkpoint, or the step that followed it,
   * carried into `to`'s repository. Without a turn yet, its working tree.
   */
  const sourceTip = Effect.fn("BranchLineageService.sourceTip")(function* (
    source: OrchestrationV2AppThread,
    to: ThreadId,
  ) {
    const cwd = yield* repos.cwdFor(source.id);
    const latest = yield* latestCheckpoint(source.id);
    let commit: string | null = null;
    if (latest !== null) {
      const turnBase = yield* CheckpointService.turnBaseRefForScopeOrdinal({
        scopeId: latest.scope.id,
        ordinalWithinScope: latest.checkpoint.ordinalWithinScope,
      }).pipe(Effect.provideService(Digest.Digest, digest));
      commit =
        (yield* lift(git.resolveCommit({ cwd, rev: turnBase }))) ??
        (yield* lift(git.resolveCommit({ cwd, rev: latest.checkpoint.ref })));
    }
    if (commit === null) commit = (yield* lift(git.worktreeTree({ cwd }))).commit;
    const head = yield* lift(git.resolveCommit({ cwd, rev: `${commit}^1` }));
    if (head === null) return yield* refuse("failed", "The source has no commits yet.");
    yield* repos.carry({ from: source.id, to, commits: [commit, head] });
    return {
      commit,
      head,
      turn: latest?.run.ordinal ?? 0,
      runId: latest?.run.id ?? null,
    };
  });

  /** After a step wrote to a thread's files: the next turn's summary starts from here. */
  const captureTurnBase = Effect.fn("BranchLineageService.captureTurnBase")(function* (
    threadId: ThreadId,
  ) {
    // Mid-turn (an agent's own Update) the tree holds the turn's edits, which must still count.
    if (yield* turnRunning(threadId)) return;
    const latest = yield* latestCheckpoint(threadId);
    // Without a turn yet, the first turn's baseline is taken when it starts, after the step.
    if (latest === null) return;
    yield* lift(
      checkpoints.captureTurnBase({
        scope: latest.scope,
        ordinalWithinScope: latest.checkpoint.ordinalWithinScope,
      }),
    );
  });

  const toOfferOf = Effect.fn("BranchLineageService.toOfferOf")(function* (
    branch: OrchestrationV2AppThread,
    lineage: BranchLineage,
    tip: { readonly commit: string; readonly head: string },
  ) {
    const commits = yield* lift(
      git.offerCommits({
        cwd: yield* repos.cwdFor(branch.id),
        sourceHead: tip.head,
        sourceTree: tip.commit,
        exclude: lineageCommits(lineage),
      }),
    );
    return { commits, toOffer: { count: commits.length, commits: commits.map((c) => c.sha) } };
  });

  // Guards, per the spec's "Who can do what".

  const requireBranchOwner = Effect.fn("BranchLineageService.requireBranchOwner")(function* (
    caller: LineageCaller,
    threadId: ThreadId,
  ) {
    const branch = yield* openThread(caller, threadId);
    const lineage = yield* getLineage(threadId);
    if (lineage === null) return yield* refuse("not-found", "This thread isn't a branch.");
    if (holder(branch) !== caller.memberId)
      return yield* refuse("not-owner", "Only the branch's owner can do that.");
    return { branch, lineage };
  });

  /** The source, while the branch's owner can still reach it. */
  const requireSource = Effect.fn("BranchLineageService.requireSource")(function* (
    branch: OrchestrationV2AppThread,
    lineage: BranchLineage,
  ) {
    const source = yield* findThread(lineage.sourceThreadId);
    const brancher = holder(branch);
    if (
      source === null ||
      source.deletedAt !== null ||
      brancher === null ||
      !mayOpen(brancher, source)
    )
      return yield* refuse("source-unavailable", "The source thread isn't available anymore.");
    return source;
  });

  const requireIdle = Effect.fn("BranchLineageService.requireIdle")(function* (threadId: ThreadId) {
    if (yield* turnRunning(threadId))
      return yield* refuse("turn-running", "Wait for this turn to end.");
  });

  const requireSourceHolder = Effect.fn("BranchLineageService.requireSourceHolder")(function* (
    caller: LineageCaller,
    offer: Offer,
  ) {
    const source = yield* openThread(caller, offer.sourceThreadId);
    // No admin override, as with queued messages.
    if (holder(source) !== caller.memberId)
      return yield* refuse("not-source-owner", "Only the thread's owner can decide on an offer.");
    return source;
  });

  // Read.

  const workStateOf = Effect.fn("BranchLineageService.workStateOf")(function* (threadId: ThreadId) {
    const shell = yield* lift(projections.getThreadShell(threadId));
    if (shell === null) return "idle" as const;
    if (shell.pendingRuntimeRequest !== null) return "waiting" as const;
    if (shell.activeRunId !== null) return "working" as const;
    if (
      shell.settledOverride === "settled" ||
      (shell.settledOverride !== "active" && shell.settledAt !== null)
    )
      return "settled" as const;
    return "idle" as const;
  });

  const read: BranchLineageServiceShape["read"] = Effect.fn("BranchLineageService.read")(function* (
    caller,
    { threadId },
  ) {
    const thread = yield* openThread(caller, threadId);
    const lineage = yield* getLineage(threadId);
    const sourceId = lineage?.sourceThreadId ?? threadId;
    const listed = yield* lift(projections.listBranchesOf(sourceId));
    const branches: Array<LineageView["branches"][number]> = [];
    for (const entry of listed) {
      const branch = yield* findThread(entry.branchThreadId);
      if (branch === null || !mayOpen(caller.memberId, branch)) continue;
      branches.push({
        threadId: branch.id,
        title: branch.title,
        ownerId: branch.ownerId ?? null,
        branch: branch.branch,
        runsOn: entry.runsOn,
        toOffer: entry.toOffer.count,
        behind: entry.behind,
        workState: yield* workStateOf(branch.id),
      });
    }
    if (lineage === null) {
      const offers = yield* lift(projections.listOffersForSource(threadId, RECENT_OFFERS));
      return {
        thread: {
          threadId,
          role: listed.length > 0 || offers.length > 0 ? ("source" as const) : ("none" as const),
        },
        source: null,
        branches,
        lineage: null,
        offers,
      };
    }
    const source = yield* findThread(lineage.sourceThreadId);
    const canOpen = source !== null && mayOpen(caller.memberId, source);
    return {
      thread: { threadId: thread.id, role: "branch" as const },
      source: {
        threadId: lineage.sourceThreadId,
        title: canOpen ? source.title : null,
        ownerId: canOpen ? (source.ownerId ?? lineage.sourceOwnerId) : lineage.sourceOwnerId,
        state: lineage.sourceState,
        canOpen,
      },
      branches,
      lineage,
      offers: yield* lift(projections.listOffersForBranch(threadId, RECENT_OFFERS)),
    };
  });

  // Update.

  /** Makes the next snapshot and test-merges it, without touching the branch. */
  const prepareUpdate = Effect.fn("BranchLineageService.prepareUpdate")(function* (
    branch: OrchestrationV2AppThread,
    lineage: BranchLineage,
    source: OrchestrationV2AppThread,
  ) {
    const cwd = yield* repos.cwdFor(branch.id);
    const tip = yield* sourceTip(source, branch.id);
    const base = baseSnapshot(lineage);
    const ownerName = yield* nameOf(lineage.sourceOwnerId ?? holder(source));
    const snapshot = yield* lift(
      git.createSnapshot({
        cwd,
        checkpoint: tip.commit,
        sourceHead: tip.head,
        previousSnapshot: base?.sha ?? null,
        author: yield* authorFor(lineage.sourceOwnerId ?? holder(source)),
        message: `${ownerName}'s work in progress, turn ${tip.turn}`,
        avoid: lineage.snapshots.map((candidate) => candidate.sha),
      }),
    );
    const preview = yield* lift(git.previewUpdate({ cwd, snapshot, base: base?.sha ?? tip.head }));
    return { cwd, tip, snapshot, preview };
  });

  const updatePreview: BranchLineageServiceShape["updatePreview"] = Effect.fn(
    "BranchLineageService.updatePreview",
  )(function* (caller, { threadId }) {
    const { branch, lineage } = yield* requireBranchOwner(caller, threadId);
    const source = yield* requireSource(branch, lineage);
    const prepared = yield* prepareUpdate(branch, lineage, source);
    return {
      files: [...prepared.preview.files],
      conflicts: [...prepared.preview.conflicts],
      behind: lineage.behind,
      sourceTitle: source.title,
    };
  });

  /** Whether the source's revert of this branch's applied offer is still here after an Update. */
  const revertedOutcome = (lineage: BranchLineage, toOffer: ReadonlyArray<string>) => {
    if (lineage.reverted === null) return null;
    const kept = lineage.reverted.commits.some((sha) => toOffer.includes(sha));
    return { ...lineage.reverted, keptHere: kept };
  };

  /** Clean: merged and recorded. Conflict: the merge stays open for the agent or the person. */
  const performUpdate = Effect.fn("BranchLineageService.performUpdate")(function* (
    branchThreadId: ThreadId,
    actorId: MemberId,
    onConflict: LineageUpdateResolver,
    stepId?: string,
  ) {
    const branch = yield* findThread(branchThreadId);
    const lineage = yield* getLineage(branchThreadId);
    if (branch === null || lineage === null)
      return yield* refuse("not-found", "This thread isn't a branch.");
    if (lineage.update !== null)
      return yield* refuse("update-open", "Finish or abort the open Update first.");
    const source = yield* requireSource(branch, lineage);
    const prepared = yield* prepareUpdate(branch, lineage, source);
    const context = { sourceThreadId: source.id, branchThreadId: branch.id };
    const id = (name: string) =>
      stepId === undefined ? commandId(name) : Effect.succeed(CommandId.make(`${stepId}:${name}`));
    if (prepared.preview.files.length === 0) {
      if (lineage.behind !== 0)
        yield* record(lineage, { behind: 0 }, { commandId: yield* id("caught-up") });
      return { result: "merged" as const, files: 0, conflicts: [] };
    }
    const actorName = yield* nameOf(actorId);
    const started = yield* lift(
      git.startUpdate({
        cwd: prepared.cwd,
        snapshot: prepared.snapshot,
        author: yield* authorFor(actorId),
        message: `Update from ${source.title}`,
        wipMessage: `${actorName}'s work before the update from ${source.title}`,
      }),
    );
    const now = yield* nowIso;
    const paths = prepared.preview.files.map((file) => file.path);
    const snapshot = (state: LineageSnapshot["state"], mergeCommit: string | null) =>
      ({
        sha: prepared.snapshot,
        sourceRunId: prepared.tip.runId,
        sourceTurn: prepared.tip.turn,
        createdAt: now,
        state,
        mergeCommit,
        undoCommit: null,
      }) satisfies LineageSnapshot;
    if (started.result.type === "conflicted") {
      const conflictedPaths = [...started.result.conflictedPaths];
      yield* record(
        lineage,
        {
          snapshots: [...lineage.snapshots, snapshot("pending", null)],
          update: {
            snapshotSha: prepared.snapshot,
            conflictedPaths,
            resolver: onConflict,
            startedAt: now,
            preUpdateHead: started.preUpdateHead,
            wipCommit: started.wipCommit,
          },
          undoableUpdate: null,
          behind: 0,
        },
        {
          notice: { kind: "update-conflict", paths: conflictedPaths },
          commandId: yield* id("conflict"),
        },
      );
      yield* captureTurnBase(branch.id);
      if (onConflict === "agent") {
        yield* dispatch({
          type: "message.dispatch",
          commandId: yield* id("resolve"),
          threadId: branch.id,
          messageId: MessageId.make(`message:lineage-resolve:${yield* uniqueId()}`),
          text: `Resolve the conflict markers from the update from ${source.title} in: ${listFiles(conflictedPaths)}. Keep both sides' intent, then commit the merge. Don't abort or stash it.`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          actorId,
          createdBy: "user",
          creationSource: "web",
        });
      }
      return { result: "conflicted" as const, files: paths.length, conflicts: conflictedPaths };
    }
    const merged = {
      ...lineage,
      snapshots: [...lineage.snapshots, snapshot("on-branch", started.result.mergeCommit)],
    };
    const { toOffer } = yield* toOfferOf(branch, merged, prepared.tip);
    const reverted = revertedOutcome(lineage, toOffer.commits);
    yield* record(
      lineage,
      {
        snapshots: merged.snapshots,
        undoableUpdate: {
          snapshotSha: prepared.snapshot,
          mergeCommit: started.result.mergeCommit,
          preUpdateHead: started.preUpdateHead,
          wipCommit: started.wipCommit,
        },
        behind: 0,
        toOffer,
        unshipped: toOffer.count,
        reverted,
      },
      {
        notice: {
          kind: "updated",
          snapshotSha: prepared.snapshot,
          files: paths.length,
          turn: prepared.tip.turn,
        },
        commandId: yield* id("merged"),
      },
    );
    if (reverted !== null) {
      yield* notice(
        branch.id,
        reverted.keptHere
          ? { kind: "reverted-kept", offerId: reverted.offerId }
          : { kind: "reverted-removed", offerId: reverted.offerId },
        context,
        yield* id("reverted"),
      );
    }
    yield* tellAgent(
      branch.id,
      updatedNote({ sourceTitle: source.title, paths }),
      context,
      yield* id("told"),
    );
    yield* captureTurnBase(branch.id);
    return { result: "merged" as const, files: paths.length, conflicts: [] };
  });

  const update: BranchLineageServiceShape["update"] = Effect.fn("BranchLineageService.update")(
    function* (caller, { threadId, onConflict }, options) {
      const { branch, lineage } = yield* requireBranchOwner(caller, threadId);
      if (lineage.update !== null)
        return yield* refuse("update-open", "Finish or abort the open Update first.");
      yield* requireSource(branch, lineage);
      if (options?.duringOwnTurn !== true && (yield* turnRunning(threadId))) {
        yield* dispatch({
          type: "thread.lineage-step.arm",
          commandId: yield* commandId("update-arm"),
          threadId,
          actorId: caller.memberId,
          kind: "update",
          offerId: null,
          onConflict,
        });
        return { result: "armed" as const, files: 0, conflicts: [] };
      }
      return yield* locks.withLock(threadId, performUpdate(threadId, caller.memberId, onConflict));
    },
  );

  const abortUpdate: BranchLineageServiceShape["abortUpdate"] = Effect.fn(
    "BranchLineageService.abortUpdate",
  )(function* (caller, { threadId }) {
    const { branch } = yield* requireBranchOwner(caller, threadId);
    yield* requireIdle(threadId);
    yield* locks.withLock(
      threadId,
      Effect.gen(function* () {
        const lineage = yield* getLineage(threadId);
        const open = lineage?.update ?? null;
        if (lineage === null || open === null)
          return yield* refuse("not-allowed", "There's no update in progress.");
        yield* lift(
          git.abortUpdate({
            cwd: yield* repos.cwdFor(threadId),
            preUpdateHead: open.preUpdateHead,
            wipCommit: open.wipCommit,
          }),
        );
        yield* record(
          lineage,
          {
            snapshots: lineage.snapshots.map((snapshot) =>
              snapshot.sha === open.snapshotSha && snapshot.state === "pending"
                ? { ...snapshot, state: "aborted" as const }
                : snapshot,
            ),
            update: null,
            behind: yield* behindOf(lineage, open.snapshotSha),
          },
          { notice: { kind: "update-aborted" } },
        );
        yield* captureTurnBase(branch.id);
      }),
    );
  });

  /** "Behind" from the newest snapshot still on the branch, skipping one being dropped. */
  const behindOf = Effect.fn("BranchLineageService.behindOf")(function* (
    lineage: BranchLineage,
    droppedSha: string,
  ) {
    const base = lineage.snapshots.findLast(
      (snapshot) => snapshot.state === "on-branch" && snapshot.sha !== droppedSha,
    );
    return yield* turnsSince(lineage.sourceThreadId, base?.sourceTurn ?? 0);
  });

  const undoUpdate: BranchLineageServiceShape["undoUpdate"] = Effect.fn(
    "BranchLineageService.undoUpdate",
  )(function* (caller, { threadId }) {
    const { branch } = yield* requireBranchOwner(caller, threadId);
    yield* requireIdle(threadId);
    yield* locks.withLock(
      threadId,
      Effect.gen(function* () {
        const lineage = yield* getLineage(threadId);
        if (lineage === null) return yield* refuse("not-found", "This thread isn't a branch.");
        if (lineage.update !== null)
          return yield* refuse("update-open", "Finish or abort the open Update first.");
        const undoable = lineage.undoableUpdate;
        if (undoable === null)
          return yield* refuse("not-allowed", "That update can't be undone anymore.");
        const cwd = yield* repos.cwdFor(threadId);
        const pushed = yield* lift(git.isPushed({ cwd, commit: undoable.mergeCommit }));
        const { undoCommit } = yield* lift(
          git.undoUpdate({
            cwd,
            mergeCommit: undoable.mergeCommit,
            preUpdateHead: undoable.preUpdateHead,
            wipCommit: undoable.wipCommit,
            pushed,
            author: yield* authorFor(caller.memberId),
          }),
        );
        const snapshots = lineage.snapshots.map((snapshot) =>
          snapshot.sha === undoable.snapshotSha
            ? { ...snapshot, state: "undone" as const, undoCommit }
            : snapshot,
        );
        const undone = { ...lineage, snapshots };
        const source = yield* findThread(lineage.sourceThreadId);
        const toOffer =
          source === null
            ? lineage.toOffer
            : (yield* toOfferOf(branch, undone, yield* sourceTip(source, branch.id))).toOffer;
        yield* record(
          lineage,
          {
            snapshots,
            undoableUpdate: null,
            behind: yield* behindOf(lineage, undoable.snapshotSha),
            toOffer,
          },
          { notice: { kind: "update-undone" } },
        );
        yield* captureTurnBase(branch.id);
      }),
    );
  });

  const bringBack: BranchLineageServiceShape["bringBack"] = Effect.fn(
    "BranchLineageService.bringBack",
  )(function* (caller, { threadId }) {
    const { branch } = yield* requireBranchOwner(caller, threadId);
    yield* requireIdle(threadId);
    yield* locks.withLock(
      threadId,
      Effect.gen(function* () {
        const lineage = yield* getLineage(threadId);
        if (lineage === null) return yield* refuse("not-found", "This thread isn't a branch.");
        if (lineage.update !== null)
          return yield* refuse("update-open", "Finish or abort the open Update first.");
        const reverted = lineage.reverted;
        if (reverted === null || reverted.keptHere)
          return yield* refuse("not-allowed", "There's nothing to bring back.");
        const actorName = yield* nameOf(caller.memberId);
        const started = yield* lift(
          git.cherryPickBack({
            cwd: yield* repos.cwdFor(threadId),
            commits: reverted.commits,
            author: yield* authorFor(caller.memberId),
            wipMessage: `${actorName}'s work before bringing changes back`,
          }),
        );
        if (started.result.type === "conflicted") {
          // Resolves as an Update does; `snapshotSha` names the commit being brought back.
          const conflictedPaths = [...started.result.conflictedPaths];
          const at = reverted.commits.length - started.result.remaining.length - 1;
          yield* record(
            lineage,
            {
              update: {
                snapshotSha: reverted.commits[Math.max(0, at)]!,
                conflictedPaths,
                resolver: "self",
                startedAt: yield* nowIso,
                preUpdateHead: started.preUpdateHead,
                wipCommit: started.wipCommit,
              },
            },
            { notice: { kind: "update-conflict", paths: conflictedPaths } },
          );
          yield* captureTurnBase(branch.id);
          return;
        }
        const commits = [...started.result.commits];
        const source = yield* findThread(lineage.sourceThreadId);
        const toOffer =
          source === null
            ? lineage.toOffer
            : (yield* toOfferOf(branch, lineage, yield* sourceTip(source, branch.id))).toOffer;
        yield* record(
          lineage,
          { reverted: null, toOffer },
          { notice: { kind: "brought-back", commits } },
        );
        yield* captureTurnBase(branch.id);
      }),
    );
  });

  // Offer.

  const prepareOffer = Effect.fn("BranchLineageService.prepareOffer")(function* (
    branch: OrchestrationV2AppThread,
    lineage: BranchLineage,
    source: OrchestrationV2AppThread,
    author: LineageAuthor,
  ) {
    const cwd = yield* repos.cwdFor(branch.id);
    const tip = yield* sourceTip(source, branch.id);
    const { commits, toOffer } = yield* toOfferOf(branch, lineage, tip);
    const base = baseSnapshot(lineage)?.sha ?? tip.head;
    if (commits.length === 0) return { cwd, tip, commits, toOffer, base, built: null, check: null };
    const built = yield* lift(
      git.buildOffer({
        cwd,
        base,
        commits: commits.map((commit) => commit.sha),
        author,
        message: `${author.name}'s changes from ${branch.title}`,
      }),
    );
    const check = yield* lift(git.checkOffer({ cwd, base, tip: built.tip, against: tip.commit }));
    return { cwd, tip, commits, toOffer, base, built, check };
  });

  const offerPreview: BranchLineageServiceShape["offerPreview"] = Effect.fn(
    "BranchLineageService.offerPreview",
  )(function* (caller, { threadId }) {
    const { branch, lineage } = yield* requireBranchOwner(caller, threadId);
    if (lineage.update !== null)
      return yield* refuse("update-open", "Finish the open Update before offering.");
    const source = yield* requireSource(branch, lineage);
    const prepared = yield* prepareOffer(
      branch,
      lineage,
      source,
      yield* authorFor(caller.memberId),
    );
    return {
      commits: prepared.commits.map(({ sha, subject, authorName }) => ({
        sha,
        subject,
        authorName,
      })),
      files: [...(prepared.built?.files ?? [])],
      additions: prepared.built?.additions ?? 0,
      deletions: prepared.built?.deletions ?? 0,
      uncommittedFiles: [...(yield* lift(git.uncommittedPaths({ cwd: prepared.cwd })))],
      check:
        prepared.check === null || prepared.check.clean
          ? { clean: true as const }
          : { clean: false as const, paths: [...prepared.check.paths] },
      sourceTitle: source.title,
      sourceOwnerId: holder(source),
    };
  });

  const offerCreate: BranchLineageServiceShape["offerCreate"] = Effect.fn(
    "BranchLineageService.offerCreate",
  )(function* (caller, input) {
    const { branch, lineage } = yield* requireBranchOwner(caller, input.threadId);
    if (lineage.update !== null)
      return yield* refuse("update-open", "Finish the open Update before offering.");
    const source = yield* requireSource(branch, lineage);
    return yield* locks.withLock(
      branch.id,
      Effect.gen(function* () {
        const author = yield* authorFor(caller.memberId);
        // Uncommitted work is committed first, as the sender.
        yield* lift(
          git.commitAll({
            cwd: yield* repos.cwdFor(branch.id),
            author,
            message: input.commitMessage ?? `${branch.title}: work in progress`,
          }),
        );
        const prepared = yield* prepareOffer(branch, lineage, source, author);
        if (prepared.built === null || prepared.check === null)
          return yield* refuse("nothing-to-offer", "There's nothing new to offer.");
        if (!prepared.check.clean)
          return yield* refuse("would-conflict", `Update from ${source.title} first.`);
        const now = yield* nowIso;
        const offer: Offer = {
          id: OfferId.make(`ofr_${(yield* uniqueId()).slice(0, 20)}`),
          sourceThreadId: source.id,
          branchThreadId: branch.id,
          senderId: caller.memberId,
          senderKind: caller.authorKind === "agent" ? "agent" : "person",
          note: input.note === undefined || input.note.trim() === "" ? null : input.note,
          state: "open",
          commits: prepared.commits.map(({ sha, subject, authorName }) => ({
            sha,
            subject,
            authorName,
          })),
          files: [...prepared.built.files],
          additions: prepared.built.additions,
          deletions: prepared.built.deletions,
          base: prepared.base,
          tip: prepared.built.tip,
          replaced: false,
          armedAt: null,
          returnReason: null,
          returnPaths: [],
          decidedBy: null,
          decidedAt: null,
          revertedAt: null,
          revertedBy: null,
          waiting: source.archivedAt === null ? null : "source-archived",
          createdAt: now,
          updatedAt: now,
        };
        yield* dispatch({
          type: "offer.create",
          commandId: yield* commandId("offer-create"),
          threadId: source.id,
          offer,
        });
        const current = (yield* getLineage(branch.id)) ?? lineage;
        if (current.toOffer.count !== prepared.toOffer.count)
          yield* record(current, { toOffer: prepared.toOffer, unshipped: prepared.toOffer.count });
        return { offer: yield* getOffer(offer.id) };
      }),
    );
  });

  const offerDiff: BranchLineageServiceShape["offerDiff"] = Effect.fn(
    "BranchLineageService.offerDiff",
  )(function* (caller, { offerId }) {
    const offer = yield* getOffer(offerId);
    const source = yield* findThread(offer.sourceThreadId);
    const branch = yield* findThread(offer.branchThreadId);
    const opens = (thread: OrchestrationV2AppThread | null) =>
      thread !== null && mayOpen(caller.memberId, thread);
    if (!opens(source) && !opens(branch)) return yield* refuse("not-found", "That offer is gone.");
    // The offer's commits were built in the branch's repository; Apply carried them to the source's.
    const holder = branch !== null && branch.deletedAt === null ? branch.id : offer.sourceThreadId;
    const files = yield* lift(
      git.offerDiff({ cwd: yield* repos.cwdFor(holder), base: offer.base, tip: offer.tip }),
    );
    return { files: [...files] };
  });

  const offerWithdraw: BranchLineageServiceShape["offerWithdraw"] = Effect.fn(
    "BranchLineageService.offerWithdraw",
  )(function* (caller, { offerId }) {
    const offer = yield* getOffer(offerId);
    yield* openThread(caller, offer.branchThreadId);
    if (offer.senderId !== caller.memberId)
      return yield* refuse("not-allowed", "Only the sender can withdraw an offer.");
    yield* dispatch({
      type: "offer.withdraw",
      commandId: yield* commandId("offer-withdraw"),
      threadId: offer.sourceThreadId,
      offerId,
      actorId: caller.memberId,
    });
    return { offer: yield* getOffer(offerId) };
  });

  const offerApply: BranchLineageServiceShape["offerApply"] = Effect.fn(
    "BranchLineageService.offerApply",
  )(function* (caller, { offerId }) {
    const offer = yield* getOffer(offerId);
    yield* requireSourceHolder(caller, offer);
    yield* dispatch({
      type: "offer.arm",
      commandId: yield* commandId("offer-apply"),
      threadId: offer.sourceThreadId,
      offerId,
      actorId: caller.memberId,
    });
    return { offer: yield* getOffer(offerId) };
  });

  const offerDecline: BranchLineageServiceShape["offerDecline"] = Effect.fn(
    "BranchLineageService.offerDecline",
  )(function* (caller, { offerId }) {
    const offer = yield* getOffer(offerId);
    yield* requireSourceHolder(caller, offer);
    yield* dispatch({
      type: "offer.decline",
      commandId: yield* commandId("offer-decline"),
      threadId: offer.sourceThreadId,
      offerId,
      actorId: caller.memberId,
    });
    return { offer: yield* getOffer(offerId) };
  });

  const revertOffer: BranchLineageServiceShape["revertOffer"] = Effect.fn(
    "BranchLineageService.revertOffer",
  )(function* (caller, { offerId }) {
    const offer = yield* getOffer(offerId);
    yield* requireSourceHolder(caller, offer);
    yield* dispatch({
      type: "thread.lineage-step.arm",
      commandId: yield* commandId("revert-arm"),
      threadId: offer.sourceThreadId,
      actorId: caller.memberId,
      kind: "revert",
      offerId,
      onConflict: null,
    });
    return { offer: yield* getOffer(offerId) };
  });

  // Steps at the turn boundary.

  /** "To offer" on the branch after its source changed what it has. Best effort. */
  const refreshToOffer = Effect.fn("BranchLineageService.refreshToOffer")(function* (
    branchThreadId: ThreadId,
    changes: (lineage: BranchLineage) => Partial<BranchLineage> = () => ({}),
  ) {
    const lineage = yield* getLineage(branchThreadId);
    const branch = yield* findThread(branchThreadId);
    const source = lineage === null ? null : yield* findThread(lineage.sourceThreadId);
    if (lineage === null || branch === null || branch.deletedAt !== null || source === null) return;
    const { toOffer } = yield* toOfferOf(branch, lineage, yield* sourceTip(source, branch.id));
    yield* record(lineage, { toOffer, unshipped: toOffer.count, ...changes(lineage) });
  });

  const runApply = Effect.fn("BranchLineageService.runApply")(function* (step: BranchLineageStep) {
    if (step.offerId === null) return;
    const offer = yield* getOffer(step.offerId);
    if (offer.state !== "open" || offer.armedAt === null) return;
    const source = yield* findThread(offer.sourceThreadId);
    if (source === null) return;
    yield* repos.carry({
      from: offer.branchThreadId,
      to: source.id,
      commits: [offer.base, offer.tip],
    });
    const cwd = yield* repos.cwdFor(source.id);
    const result = yield* lift(git.applyOffer({ cwd, base: offer.base, tip: offer.tip }));
    if (result.type === "returned") {
      yield* dispatch({
        type: "offer.returned",
        commandId: CommandId.make(`${step.id}:returned`),
        threadId: source.id,
        offerId: offer.id,
        reason: result.reason,
        paths: [...result.paths],
      });
      return;
    }
    yield* captureTurnBase(source.id);
    const coAuthor = source.sandboxId === undefined ? null : yield* coAuthorOf(offer.senderId);
    if (coAuthor !== null && result.addedLines.length > 0) {
      yield* lift(git.installCreditHook({ cwd }));
      yield* lift(git.recordCredit({ cwd, coAuthor, lines: result.addedLines }));
    }
    const branch = yield* findThread(offer.branchThreadId);
    yield* tellAgent(
      source.id,
      appliedNote({
        senderName: yield* nameOf(offer.senderId),
        branchTitle: branch?.title ?? "a deleted thread",
        files: result.files.length,
      }),
      { sourceThreadId: source.id, branchThreadId: offer.branchThreadId },
      CommandId.make(`${step.id}:told`),
    );
    yield* dispatch({
      type: "offer.applied",
      commandId: CommandId.make(`${step.id}:applied`),
      threadId: source.id,
      offerId: offer.id,
      actorId: step.armedBy,
      files: result.files.length,
    });
    // Applied changes stop counting at once.
    yield* refreshToOffer(offer.branchThreadId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not recount a branch after an Apply", { cause }),
      ),
    );
  });

  const runRevert = Effect.fn("BranchLineageService.runRevert")(function* (
    step: BranchLineageStep,
  ) {
    if (step.offerId === null) return;
    const offer = yield* getOffer(step.offerId);
    if (offer.state !== "applied" || offer.revertedAt !== null) return;
    const source = yield* findThread(offer.sourceThreadId);
    if (source === null) return;
    const cwd = yield* repos.cwdFor(source.id);
    const result = yield* lift(git.revertOffer({ cwd, base: offer.base, tip: offer.tip }));
    if (result.type === "returned") {
      yield* dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`${step.id}:not-reverted`),
        threadId: source.id,
        message: `These changes couldn't be reverted, because their lines changed since: ${listFiles(result.paths)}`,
      });
      return;
    }
    yield* captureTurnBase(source.id);
    yield* dispatch({
      type: "offer.reverted",
      commandId: CommandId.make(`${step.id}:reverted`),
      threadId: source.id,
      offerId: offer.id,
      actorId: step.armedBy,
      files: result.files.length,
    });
    // The branch still has these commits until an Update brings the revert in.
    const lineage = yield* getLineage(offer.branchThreadId);
    if (lineage !== null) {
      yield* record(
        lineage,
        {
          reverted: {
            offerId: offer.id,
            keptHere: true,
            commits: offer.commits.map((commit) => commit.sha),
          },
        },
        { commandId: CommandId.make(`${step.id}:branch-reverted`) },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not mark a branch's reverted changes", { cause }),
        ),
      );
    }
  });

  const runUpdate = Effect.fn("BranchLineageService.runUpdate")(function* (
    step: BranchLineageStep,
  ) {
    const lineage = yield* getLineage(step.threadId);
    if (lineage === null || lineage.update !== null) return;
    // A replay after the Update was recorded does nothing.
    const armedAt = Date.parse(step.armedAt);
    if (lineage.snapshots.some((snapshot) => Date.parse(snapshot.createdAt) >= armedAt)) return;
    yield* performUpdate(step.threadId, step.armedBy, step.onConflict ?? "self", step.id);
  });

  const runStep: BranchLineageServiceShape["runStep"] = Effect.fn("BranchLineageService.runStep")(
    function* (step) {
      yield* locks
        .withLock(
          step.threadId,
          step.kind === "apply"
            ? runApply(step)
            : step.kind === "revert"
              ? runRevert(step)
              : runUpdate(step),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new BranchLineageStepError({ stepId: step.id, message: cause.message, cause }),
          ),
        );
    },
  );

  // After a checkpoint, and when the source changes.

  const afterBranchCheckpoint = Effect.fn("BranchLineageService.afterBranchCheckpoint")(function* (
    branch: OrchestrationV2AppThread,
    lineage: BranchLineage,
  ) {
    const cwd = yield* repos.cwdFor(branch.id);
    const changes: { -readonly [K in keyof BranchLineage]?: BranchLineage[K] } = {};
    let resolvedNotice: LineageNotice | undefined;
    // This turn was the branch's next one: Undo update is gone.
    if (lineage.undoableUpdate !== null) changes.undoableUpdate = null;
    const open = lineage.update;
    if (open !== null) {
      const state = yield* lift(git.updateState({ cwd, conflictedPaths: open.conflictedPaths }));
      if (!state.mergeOpen && state.pathsWithMarkers.length === 0) {
        const isSnapshot = lineage.snapshots.some((snapshot) => snapshot.sha === open.snapshotSha);
        changes.update = null;
        if (isSnapshot) {
          const mergeCommit = yield* lift(git.mergeOf({ cwd, snapshot: open.snapshotSha }));
          changes.snapshots = lineage.snapshots.map((snapshot) =>
            snapshot.sha !== open.snapshotSha
              ? snapshot
              : mergeCommit === null
                ? { ...snapshot, state: "aborted" as const }
                : { ...snapshot, state: "on-branch" as const, mergeCommit },
          );
          // A turn that resolved the conflict doesn't count as the next turn.
          if (mergeCommit !== null) {
            changes.undoableUpdate = {
              snapshotSha: open.snapshotSha,
              mergeCommit,
              preUpdateHead: open.preUpdateHead,
              wipCommit: open.wipCommit,
            };
            const snapshot = lineage.snapshots.find(
              (candidate) => candidate.sha === open.snapshotSha,
            );
            resolvedNotice = {
              kind: "updated",
              snapshotSha: open.snapshotSha,
              files: open.conflictedPaths.length,
              turn: snapshot?.sourceTurn ?? 0,
            };
          }
        } else {
          changes.reverted = null;
        }
      } else if (state.pathsWithMarkers.length > 0) {
        changes.update = { ...open, conflictedPaths: [...state.pathsWithMarkers] };
      }
    }
    const next = { ...lineage, ...changes };
    const source = yield* findThread(lineage.sourceThreadId);
    if (source !== null && source.deletedAt === null) {
      // The source's machine may be asleep; its work then reaches the count on a later turn.
      const counted = yield* Effect.gen(function* () {
        return (yield* toOfferOf(branch, next, yield* sourceTip(source, branch.id))).toOffer;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logInfo("Skipped recounting a branch's commits to offer", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (
        counted !== null &&
        (counted.count !== lineage.toOffer.count ||
          counted.commits.join() !== lineage.toOffer.commits.join())
      ) {
        changes.toOffer = counted;
        changes.unshipped = counted.count;
      }
    }
    const base = baseSnapshot(next);
    const behind = yield* turnsSince(lineage.sourceThreadId, base?.sourceTurn ?? 0);
    if (behind !== lineage.behind) changes.behind = behind;
    if (Object.keys(changes).length === 0) return;
    yield* record(lineage, changes, resolvedNotice === undefined ? {} : { notice: resolvedNotice });
  });

  const afterCheckpoint: BranchLineageServiceShape["afterCheckpoint"] = Effect.fn(
    "BranchLineageService.afterCheckpoint",
  )(function* (threadId) {
    const thread = yield* findThread(threadId);
    if (thread === null || thread.deletedAt !== null) return;
    yield* locks.withLock(
      threadId,
      Effect.gen(function* () {
        const lineage = yield* getLineage(threadId);
        if (lineage !== null) yield* afterBranchCheckpoint(thread, lineage);
      }),
    );
    // As a source: its branches fall behind by turns, which needs no git.
    for (const branch of yield* lift(projections.listBranchesOf(threadId))) {
      const base = baseSnapshot(branch);
      const behind = yield* turnsSince(threadId, base?.sourceTurn ?? 0);
      if (behind !== branch.behind) {
        yield* locks.withLock(
          branch.branchThreadId,
          Effect.gen(function* () {
            const current = yield* getLineage(branch.branchThreadId);
            if (current !== null && current.behind !== behind) yield* record(current, { behind });
          }),
        );
      }
    }
    if (thread.sandboxId !== undefined) {
      const offers = yield* lift(projections.listOffersForSource(threadId, RECENT_OFFERS));
      if (offers.some((offer) => offer.state === "applied" && offer.revertedAt === null)) {
        yield* lift(git.pruneCredit({ cwd: yield* repos.cwdFor(threadId) }));
      }
    }
  });

  /** Open offers go back without an actor: the server withdraws them. */
  const withdrawOpenOffers = Effect.fn("BranchLineageService.withdrawOpenOffers")(function* (
    offers: ReadonlyArray<Offer>,
  ) {
    for (const offer of offers) {
      if (offer.state !== "open" || offer.armedAt !== null) continue;
      yield* dispatch({
        type: "offer.withdraw",
        commandId: yield* commandId("offer-server-withdraw"),
        threadId: offer.sourceThreadId,
        offerId: offer.id,
      });
    }
  });

  const sourceChanged: BranchLineageServiceShape["sourceChanged"] = Effect.fn(
    "BranchLineageService.sourceChanged",
  )(function* (threadId) {
    const branches = yield* lift(projections.listBranchesOf(threadId));
    if (branches.length === 0) return;
    const source = yield* findThread(threadId);
    const { state, shipped } = sourceStateOf(source);
    for (const branch of branches) {
      if (branch.sourceState === state && (branch.shipped?.url ?? null) === (shipped?.url ?? null))
        continue;
      yield* locks.withLock(
        branch.branchThreadId,
        Effect.gen(function* () {
          const current = yield* getLineage(branch.branchThreadId);
          if (current !== null) yield* record(current, { sourceState: state, shipped });
        }),
      );
    }
    if (state === "deleted") {
      yield* withdrawOpenOffers(
        (yield* lift(projections.listOffersForSource(threadId, RECENT_OFFERS))).filter(
          (offer) => offer.state === "open",
        ),
      );
    }
  });

  const accessChanged: BranchLineageServiceShape["accessChanged"] = Effect.fn(
    "BranchLineageService.accessChanged",
  )(function* (sourceThreadId) {
    const source = yield* findThread(sourceThreadId);
    if (source === null) return;
    const offers = (yield* lift(
      projections.listOffersForSource(sourceThreadId, RECENT_OFFERS),
    )).filter((offer) => offer.state === "open");
    const lost = [];
    for (const offer of offers) {
      const branch = yield* findThread(offer.branchThreadId);
      const brancher = branch === null ? null : holder(branch);
      if (brancher === null || !mayOpen(brancher, source)) lost.push(offer);
    }
    yield* withdrawOpenOffers(lost);
  });

  return BranchLineageService.of({
    read,
    updatePreview,
    update,
    abortUpdate,
    undoUpdate,
    bringBack,
    offerPreview,
    offerDiff,
    offerCreate,
    offerWithdraw,
    offerApply,
    offerDecline,
    revertOffer,
    runStep,
    afterCheckpoint,
    sourceChanged,
    accessChanged,
  });
});

export const layer = Layer.effect(BranchLineageService, make);
