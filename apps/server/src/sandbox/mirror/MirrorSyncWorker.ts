import type { CheckpointRef, ProjectId, SandboxId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { sandboxIdFromPath } from "../../workspaceHost/WorkspaceHost.ts";
import { listLiveSandboxThreadIds } from "../lifecycle/SandboxProjection.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import * as MirrorSync from "./MirrorSync.ts";

const SYNC_TIMEOUT = Duration.seconds(15);
const RETRY_INTERVAL = Duration.seconds(30);
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

export class MirrorSyncWorker extends Context.Service<
  MirrorSyncWorker,
  {
    readonly enqueue: (threadId: ThreadId) => Effect.Effect<void>;
    /** Syncs every pending thread of this sandbox now; bounded at 15 s; never fails. */
    readonly flush: (sandboxId: SandboxId) => Effect.Effect<void>;
    /** For tests: runs one pass over every pending thread. */
    readonly drain: Effect.Effect<void>;
    /** Syncs these refs of one checkout now; false on any failure, bounded at 15 s; never fails. */
    readonly syncRefs: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
      /** Also saves the head context; a failure there is logged and does not make this false. */
      readonly recordHead?: boolean;
    }) => Effect.Effect<boolean>;
  }
>()("t3/sandbox/mirror/MirrorSyncWorker") {}

const make = Effect.gen(function* () {
  const mirrorSync = yield* MirrorSync.MirrorSync;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  // A restart loses no pending sync: every thread on a live sandbox is checked once.
  const pending = yield* Ref.make(
    new Set<ThreadId>(
      yield* listLiveSandboxThreadIds().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not list sandbox threads for the mirror sync", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
    ),
  );
  const synced = new Set<ProjectId>();
  const maintainedAt = new Map<ProjectId, number>();

  // A workspace thread's repositories each sync into their own root project's mirror.
  const mirrorsOf = (thread: {
    readonly projectId: ProjectId;
    readonly roots?: ReadonlyArray<{ readonly projectId: ProjectId }> | undefined;
  }) => thread.roots?.map((root) => root.projectId) ?? [thread.projectId];

  const bounded = (threadId: ThreadId) =>
    Effect.timeoutOrElse({
      duration: SYNC_TIMEOUT,
      orElse: () => Effect.fail(new MirrorSync.MirrorSyncError({ threadId, reason: "timeout" })),
    });

  const syncCheckpoints = (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) =>
    mirrorSync.sync(input).pipe(
      bounded(input.threadId),
      Effect.tap((projectIds) =>
        Effect.sync(() => {
          for (const projectId of projectIds) synced.add(projectId);
        }),
      ),
    );

  /** True once the mirror holds every ready ref; false keeps it pending without a log. */
  const syncThread = Effect.fn("MirrorSyncWorker.syncThread")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId);
    if (thread.deletedAt !== null || thread.sandboxId === undefined) return true;
    const context = yield* projections.getCheckpointContext(threadId);
    const cwdByScope = new Map(context.checkpointScopes.map((scope) => [scope.id, scope.cwd]));
    const refsByCwd = new Map<string, Array<CheckpointRef>>();
    for (const checkpoint of context.checkpoints) {
      const cwd = cwdByScope.get(checkpoint.scopeId);
      if (checkpoint.status !== "ready" || cwd === undefined) continue;
      if (sandboxIdFromPath(cwd) === undefined) continue;
      refsByCwd.set(cwd, [...(refsByCwd.get(cwd) ?? []), checkpoint.ref]);
    }
    const held = yield* Effect.forEach(mirrorsOf(thread), (projectId) =>
      mirror.tips(projectId, [...refsByCwd.values()].flat()),
    );
    for (const [cwd, refs] of refsByCwd) {
      const missing = refs.filter((ref) => !held.every((tips) => tips.has(ref)));
      if (missing.length === 0) continue;
      const result = yield* syncCheckpoints({ threadId, cwd, checkpointRefs: missing }).pipe(
        Effect.as(true),
        Effect.catchTags({
          MirrorSyncError: (error) =>
            error.reason === "sandbox-unavailable" ? Effect.succeed(false) : Effect.fail(error),
        }),
      );
      if (!result) return false;
    }
    return true;
  });

  const passOver = (threadIds: Iterable<ThreadId>) =>
    Effect.forEach(
      [...threadIds],
      (threadId) =>
        syncThread(threadId).pipe(
          Effect.flatMap((done) =>
            done
              ? Ref.update(pending, (current) => {
                  const next = new Set(current);
                  next.delete(threadId);
                  return next;
                })
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Checkpoint mirror sync failed; it will be retried", {
                  threadId,
                  cause,
                }),
          ),
        ),
      { discard: true },
    );

  const drain = Effect.flatMap(Ref.get(pending), passOver);

  // 07 §9: at most once an hour per mirror, after syncs.
  const maintainDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const projectId of synced) {
      if (now - (maintainedAt.get(projectId) ?? -Infinity) < MAINTENANCE_INTERVAL_MS) continue;
      synced.delete(projectId);
      maintainedAt.set(projectId, now);
      yield* mirror
        .maintain(projectId)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("Mirror maintenance failed", cause)));
    }
  });

  yield* Effect.sleep(RETRY_INTERVAL).pipe(
    Effect.andThen(drain),
    Effect.andThen(maintainDue),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );

  const enqueue: MirrorSyncWorker["Service"]["enqueue"] = (threadId) =>
    Ref.update(pending, (current) => new Set(current).add(threadId));

  const flush: MirrorSyncWorker["Service"]["flush"] = Effect.fn("MirrorSyncWorker.flush")(
    function* (sandboxId) {
      const current = yield* Ref.get(pending);
      if (current.size === 0) return;
      const rows = yield* projections.listSandboxThreads(sandboxId);
      yield* passOver(rows.map((row) => row.threadId).filter((threadId) => current.has(threadId)));
    },
    Effect.timeoutOption(SYNC_TIMEOUT),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("Checkpoint mirror flush failed", cause),
    ),
    Effect.asVoid,
  );

  const recordHead = (input: { readonly threadId: ThreadId; readonly cwd: string }) =>
    mirrorSync.recordHead(input).pipe(
      Effect.catchTags({
        MirrorSyncError: (cause) =>
          Effect.logWarning("Could not record the head context for PR discovery", {
            threadId: input.threadId,
            cause,
          }),
      }),
    );

  const syncRefs: MirrorSyncWorker["Service"]["syncRefs"] = ({ recordHead: withHead, ...input }) =>
    syncCheckpoints(input).pipe(
      Effect.tap(() => (withHead === true ? recordHead(input) : Effect.void)),
      bounded(input.threadId),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.succeed(false)
          : Effect.logWarning("Could not sync refs to the checkpoint mirror", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.as(false)),
      ),
    );

  const hooks: MirrorSync.MirrorHooksShape = {
    afterCapture: ({ threadId, scope, checkpoints }) => {
      // Local and worktree captures stop at this prefix check.
      if (sandboxIdFromPath(scope.cwd) === undefined) return Effect.void;
      const checkpointRefs = checkpoints
        .filter((checkpoint) => checkpoint.status === "ready")
        .map((checkpoint) => checkpoint.ref);
      if (checkpointRefs.length === 0) return Effect.void;
      return syncCheckpoints({ threadId, cwd: scope.cwd, checkpointRefs }).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Checkpoint mirror sync deferred to the retry worker", {
                threadId,
                cause,
              }).pipe(Effect.andThen(enqueue(threadId))),
        ),
      );
    },
    // A leftover ref is harmless: diffs read the refs the projection names, and those are stale.
    afterRollback: ({ threadId, scope, deletedRefs }) => {
      if (sandboxIdFromPath(scope.cwd) === undefined || deletedRefs.length === 0) {
        return Effect.void;
      }
      return projections.getThread(threadId).pipe(
        Effect.flatMap((thread) =>
          Effect.forEach(
            mirrorsOf(thread),
            (projectId) => mirror.deleteRefs(projectId, deletedRefs),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Could not drop rolled-back refs from the checkpoint mirror", {
                threadId,
                cause,
              }),
        ),
      );
    },
  };

  return Context.make(
    MirrorSyncWorker,
    MirrorSyncWorker.of({ enqueue, flush, drain, syncRefs }),
  ).pipe(Context.add(MirrorSync.MirrorHooks, hooks));
});

/** The retry worker and the real MirrorHooks, which hand failed syncs to it. */
export const layer = Layer.effectContext(make);
