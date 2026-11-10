import {
  type CloudMoveContinuedInput,
  CommandId,
  isListedThreadLineage,
  type MemberId,
  type OrchestrationV2ContextExport,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ThreadShell,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as ContextExports from "../orchestration-v2/ContextExports.ts";
import { holderOf } from "../orchestration-v2/MemberThreadState.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { hasNoDisk } from "../sandbox/lifecycle/SandboxDecisions.ts";
import { sandboxSnapshotRef, snapshotNamers } from "../sandbox/mirror/CheckpointMirror.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as MirrorSyncWorker from "../sandbox/mirror/MirrorSyncWorker.ts";
import * as TeamState from "../team/TeamState.ts";

/** As long as the pre-sleep snapshot may take (2.7). */
const SNAPSHOT_TIMEOUT = Duration.seconds(15);

export const CLOUD_MOVE_SOURCE_MESSAGES = {
  "not-found": "This cloud thread no longer exists.",
  "side-chat": "Continue locally from the thread this one belongs to.",
  "not-cloned": "This thread's machine hasn't cloned the repository yet.",
  "run-active": "A turn is running or waiting for an answer. Continue locally once it ends.",
  "snapshot-missing":
    "Pair Cloud has no saved copy of this thread's uncommitted changes. Wake the machine, then try again.",
  "snapshot-failed": "Couldn't save the machine's uncommitted changes. Try again in a moment.",
  "too-large": "The download would be over 512 MB. Fetch origin on this computer, then try again.",
  failed: "Pair Cloud couldn't prepare this thread to continue locally. Try again.",
} as const;

/** Every message is the user's words, read on the laptop; none carries git output. */
export class CloudMoveSourceError extends Schema.TaggedError<CloudMoveSourceError>()(
  "CloudMoveSourceError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "not-found",
      "not-movable",
      "run-active",
      "snapshot-missing",
      "snapshot-failed",
      "too-large",
      "failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** What a seed download sends: the bundle (null when the laptop has every object) and its facts. */
export interface CloudMoveSeed {
  readonly file: string | null;
  readonly head: string;
  readonly snapshot: { readonly oid: string; readonly takenAt: DateTime.Utc } | null;
  /** `move` for the thread's holder; anyone else continues a copy. */
  readonly mode: "move" | "copy";
  readonly branch: string;
  readonly baseRef: string | null;
  readonly origin: string;
}

/** Pair Cloud's side of moving a cloud thread out (07 §8). Pair Cloud never calls the laptop. */
export class CloudMoveSource extends Context.Service<
  CloudMoveSource,
  {
    readonly contextExport: (input: {
      readonly threadId: ThreadId;
      readonly memberId: MemberId;
    }) => Effect.Effect<OrchestrationV2ContextExport, CloudMoveSourceError>;
    /** An awake machine is snapshotted first; an asleep one is read from the mirror only. */
    readonly seed: (input: {
      readonly threadId: ThreadId;
      readonly memberId: MemberId;
      readonly haves: ReadonlyArray<string>;
    }) => Effect.Effect<CloudMoveSeed, CloudMoveSourceError, Scope.Scope>;
    /** Records the move on the cloud thread and, for its holder, settles it. Replays are no-ops. */
    readonly continued: (input: {
      readonly threadId: ThreadId;
      readonly memberId: MemberId;
      readonly input: CloudMoveContinuedInput;
    }) => Effect.Effect<{ readonly settled: boolean }, CloudMoveSourceError>;
  }
>()("t3/cloudMove/CloudMoveSource") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const contextExports = yield* ContextExports.ContextExports;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const mirrorWorker = yield* MirrorSyncWorker.MirrorSyncWorker;
  const mirrorSync = yield* MirrorSync.MirrorSync;
  const projects = yield* ProjectService.ProjectService;
  const team = yield* Effect.serviceOption(TeamState.TeamState);

  const fail =
    (
      threadId: ThreadId,
      reason: CloudMoveSourceError["reason"],
      message?: keyof typeof CLOUD_MOVE_SOURCE_MESSAGES,
    ) =>
    (cause?: unknown) =>
      new CloudMoveSourceError({
        threadId,
        reason,
        message:
          CLOUD_MOVE_SOURCE_MESSAGES[message ?? (reason === "not-movable" ? "not-cloned" : reason)],
        ...(cause === undefined ? {} : { cause }),
      });

  /** No team means one member, who holds every thread. */
  const isHolder = (shell: Pick<OrchestrationV2ThreadShell, "ownerId">, memberId: MemberId) =>
    Option.isNone(team) || holderOf(shell, team.value.ownerId) === memberId;

  const readShell = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.mapError(fail(threadId, "failed")),
      Effect.filterOrFail(
        (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
        () => fail(threadId, "not-found")(),
      ),
    );

  const movable = Effect.fn("CloudMoveSource.movable")(function* (threadId: ThreadId) {
    const shell = yield* readShell(threadId);
    if (!isListedThreadLineage(shell.lineage)) {
      return yield* fail(threadId, "not-movable", "side-chat")();
    }
    const { sandboxId, branch, worktreePath } = shell;
    if (sandboxId === undefined || branch === null || worktreePath === null) {
      return yield* fail(threadId, "not-movable")();
    }
    const records = yield* projections
      .getThreadRecords(threadId, ["runs", "runtimeRequests"])
      .pipe(Effect.mapError(fail(threadId, "failed")));
    if (threadHasUnfinishedWork(records)) return yield* fail(threadId, "run-active")();
    return { shell, sandboxId, branch, worktreePath, runs: records.runs };
  });

  /** The thread whose snapshot ref holds this checkout: its owner's when they share it (2.7). */
  const checkoutNamer = Effect.fn("CloudMoveSource.checkoutNamer")(function* (
    record: OrchestrationV2Sandbox,
    worktreePath: string,
  ) {
    const rows = yield* projections.listSandboxThreads(record.id);
    const attached: Array<{ threadId: ThreadId; worktreePath: string | null }> = [];
    for (const threadId of new Set([record.ownerThreadId, ...rows.map((row) => row.threadId)])) {
      attached.push({
        threadId,
        worktreePath: (yield* projections.getThreadShell(threadId))?.worktreePath ?? null,
      });
    }
    return snapshotNamers(record.ownerThreadId, attached).get(worktreePath);
  });

  const contextExport: CloudMoveSource["Service"]["contextExport"] = Effect.fn(
    "CloudMoveSource.contextExport",
  )(function* ({ threadId }) {
    yield* movable(threadId);
    return yield* contextExports
      .build(threadId)
      .pipe(
        Effect.mapError((error) =>
          fail(threadId, error.reason === "not-found" ? "not-found" : "failed")(error),
        ),
      );
  });

  const seed: CloudMoveSource["Service"]["seed"] = Effect.fn("CloudMoveSource.seed")(function* ({
    threadId,
    memberId,
    haves,
  }) {
    const failed = fail(threadId, "failed");
    const { shell, sandboxId, branch, worktreePath, runs } = yield* movable(threadId);
    const record = yield* projections.getSandbox(sandboxId).pipe(Effect.mapError(failed));
    if (record === null) return yield* failed("The thread's machine has no record.");
    const namer =
      (yield* checkoutNamer(record, worktreePath).pipe(Effect.mapError(failed))) ?? threadId;
    const noDisk = hasNoDisk(record);

    if (record.state === "ready" && record.runnerLostAt === null) {
      const ref = sandboxSnapshotRef(namer);
      const synced = yield* checkpoints.captureSnapshot({ cwd: worktreePath, ref }).pipe(
        Effect.flatMap((status) =>
          status === "ready"
            ? mirrorWorker.syncRefs({
                threadId: namer,
                cwd: worktreePath,
                checkpointRefs: [ref],
                recordHead: true,
              })
            : Effect.succeed(false),
        ),
        Effect.timeoutOption(SNAPSHOT_TIMEOUT),
      );
      if (Option.isNone(synced) || !synced.value) return yield* fail(threadId, "snapshot-failed")();
    } else if (!noDisk && (record.sleepSnapshotAt ?? null) === null) {
      // Its stop is still running, or that snapshot failed (2.7): never move without the files.
      return yield* fail(threadId, "snapshot-missing")();
    }

    const bundle = yield* mirrorSync
      .bundleThread({
        threadId: namer,
        projectId: shell.projectId,
        prerequisites: () => Effect.succeed(haves),
      })
      .pipe(
        Effect.mapError((error) =>
          fail(threadId, error.reason === "too-large" ? "too-large" : "failed")(error),
        ),
      );
    // A destroyed disk has no uncommitted files to lose, so it moves what the mirror holds.
    if (bundle === null || (!noDisk && bundle.snapshot === null)) {
      return yield* fail(threadId, "snapshot-missing")();
    }

    const project = yield* projects.getResolvedShell(shell.projectId).pipe(Effect.mapError(failed));
    const identity = Option.getOrUndefined(project)?.repositoryIdentity ?? null;
    if (identity === null) return yield* failed("The project has no repository identity.");
    const firstCheckout = runs
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .find((run) => run.workspacePreparation?.type === "worktree")?.workspacePreparation;
    return {
      ...bundle,
      mode: isHolder(shell, memberId) ? "move" : "copy",
      branch,
      baseRef: firstCheckout?.type === "worktree" ? firstCheckout.baseRef : null,
      origin: repositoryGroupingKeyOf(identity),
    } satisfies CloudMoveSeed;
  });

  const continued: CloudMoveSource["Service"]["continued"] = Effect.fn("CloudMoveSource.continued")(
    function* ({ threadId, memberId, input }) {
      const failed = fail(threadId, "failed");
      const shell = yield* readShell(threadId);
      const copy = input.copy || !isHolder(shell, memberId);
      const actorName = Option.isNone(team)
        ? undefined
        : (yield* Ref.get(team.value.members)).get(memberId);
      yield* threads
        .dispatch({
          type: "thread.move.record",
          commandId: CommandId.make(`cloud-move:${input.moveId}:record`),
          threadId,
          to: input.thread,
          message: copy
            ? `${actorName?.removedAt === null ? actorName.name : "A teammate"} copied this thread to ${input.environmentLabel}`
            : `Continued locally on ${input.environmentLabel}`,
          ...(copy ? { copy: true as const } : {}),
          actorId: memberId,
        })
        .pipe(Effect.mapError(failed));
      if (copy) return { settled: false };

      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "runtimeRequests"])
        .pipe(Effect.mapError(failed));
      if (threadHasUnfinishedWork(records)) return { settled: false };
      // No actor: the row above says who moved it, so no lifecycle notice joins it.
      return yield* threads
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`cloud-move:${input.moveId}:settle`),
          threadId,
        })
        .pipe(
          Effect.as({ settled: true }),
          Effect.catchTags({
            OrchestratorDispatchError: () => Effect.succeed({ settled: false }),
            OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed({ settled: false }),
          }),
          Effect.mapError(failed),
        );
    },
  );

  return CloudMoveSource.of({ contextExport, seed, continued });
});

export const layer = Layer.effect(CloudMoveSource, make);
