import {
  CLOUD_SEED_MAX_BYTES,
  CloudStagingKey,
  cloudSeedRefs,
  MemberId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as PairCloudProjects from "../project/PairCloudProjects.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

/** What a staging key carries; 3.22 adds `context-export`. */
export type StagedCloudImportKind = "seed";

export class StagedCloudImportError extends Schema.TaggedError<StagedCloudImportError>()(
  "StagedCloudImportError",
  {
    key: CloudStagingKey,
    reason: Schema.Literals([
      "unknown-project",
      "too-large",
      "invalid-seed",
      "missing-prerequisite",
      "claimed",
      "key-in-use",
      "not-found",
      "upload-failed",
      "failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Staged cloud import ${this.key} failed: ${this.reason}.`;
  }
}

interface StagedImportRef {
  readonly key: CloudStagingKey;
  readonly kind: StagedCloudImportKind;
  readonly projectId: ProjectId;
  readonly memberId: MemberId;
}

/**
 * The only door for a member's local work into this server's mirror (07 §8). An upload stages
 * under the move's key; a launch claims it for one thread, or the sweep drops it after a day.
 */
export class StagedCloudImports extends Context.Service<
  StagedCloudImports,
  {
    /** Replaces whatever the key staged; any failure leaves nothing staged under it. */
    readonly stage: (
      input: StagedImportRef & { readonly body: Stream.Stream<Uint8Array, unknown> },
    ) => Effect.Effect<void, StagedCloudImportError>;
    /** Read-only: whether `claim` would find this import, so a launch refuses before creating. */
    readonly check: (input: StagedImportRef) => Effect.Effect<void, StagedCloudImportError>;
    /** Moves the import to the thread; claiming again for the same thread succeeds. */
    readonly claim: (
      input: StagedImportRef & { readonly threadId: ThreadId },
    ) => Effect.Effect<void, StagedCloudImportError>;
    /** Drops unclaimed imports past their TTL; claimed rows stay. Returns how many it dropped. */
    readonly sweep: Effect.Effect<number, StagedCloudImportError | PersistenceSqlError>;
  }
>()("t3/cloudMove/StagedCloudImports") {}

const ImportRow = Schema.Struct({
  kind: Schema.String,
  projectId: ProjectId,
  memberId: MemberId,
  claimedThreadId: Schema.NullOr(ThreadId),
});

const DueRow = Schema.Struct({ key: CloudStagingKey, kind: Schema.String, projectId: ProjectId });

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export const make = Effect.fn("StagedCloudImports.make")(function* (
  options: { readonly maxSeedBytes?: number; readonly unclaimedTtl?: Duration.Duration } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const pairCloudProjects = yield* PairCloudProjects.PairCloudProjects;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const tmpDir = path.join(stateDir, "sandbox", "tmp");
  const maxSeedBytes = options.maxSeedBytes ?? CLOUD_SEED_MAX_BYTES;
  const unclaimedTtl = options.unclaimedTtl ?? Duration.hours(24);
  const keyLocks = yield* KeyedLock.make<CloudStagingKey>();
  const due = DueHint.make();

  const failWith =
    (key: CloudStagingKey, reason: StagedCloudImportError["reason"]) => (cause?: unknown) =>
      new StagedCloudImportError({ key, reason, ...(cause === undefined ? {} : { cause }) });

  const findRows = SqlSchema.findAll({
    Request: CloudStagingKey,
    Result: ImportRow,
    execute: (key) => sql`
      SELECT
        kind,
        project_id AS "projectId",
        member_id AS "memberId",
        claimed_thread_id AS "claimedThreadId"
      FROM staged_cloud_imports
      WHERE staging_key = ${key}
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      key: CloudStagingKey,
      kind: Schema.String,
      projectId: ProjectId,
      memberId: MemberId,
      now: Schema.String,
    }),
    execute: ({ key, kind, projectId, memberId, now }) => sql`
      INSERT INTO staged_cloud_imports (staging_key, kind, project_id, member_id, created_at)
      VALUES (${key}, ${kind}, ${projectId}, ${memberId}, ${now})
      ON CONFLICT (staging_key, kind) DO UPDATE SET created_at = excluded.created_at
    `,
  });

  const markClaimed = SqlSchema.void({
    Request: Schema.Struct({ key: CloudStagingKey, kind: Schema.String, threadId: ThreadId }),
    execute: ({ key, kind, threadId }) => sql`
      UPDATE staged_cloud_imports
      SET claimed_thread_id = ${threadId}
      WHERE staging_key = ${key} AND kind = ${kind} AND claimed_thread_id IS NULL
    `,
  });

  const findDue = SqlSchema.findAll({
    Request: Schema.Struct({ cutoff: Schema.String }),
    Result: DueRow,
    execute: ({ cutoff }) => sql`
      SELECT staging_key AS "key", kind, project_id AS "projectId"
      FROM staged_cloud_imports
      WHERE claimed_thread_id IS NULL AND created_at <= ${cutoff}
      ORDER BY created_at
    `,
  });

  const isDue = SqlSchema.findOneOption({
    Request: Schema.Struct({ key: CloudStagingKey, kind: Schema.String, cutoff: Schema.String }),
    Result: Schema.Struct({ key: CloudStagingKey }),
    execute: ({ key, kind, cutoff }) => sql`
      SELECT staging_key AS "key"
      FROM staged_cloud_imports
      WHERE staging_key = ${key}
        AND kind = ${kind}
        AND claimed_thread_id IS NULL
        AND created_at <= ${cutoff}
    `,
  });

  const deleteDue = SqlSchema.findAll({
    Request: Schema.Struct({ key: CloudStagingKey, kind: Schema.String, cutoff: Schema.String }),
    Result: Schema.Struct({ key: CloudStagingKey }),
    execute: ({ key, kind, cutoff }) => sql`
      DELETE FROM staged_cloud_imports
      WHERE staging_key = ${key}
        AND kind = ${kind}
        AND claimed_thread_id IS NULL
        AND created_at <= ${cutoff}
      RETURNING staging_key AS "key"
    `,
  });

  const findOldestUnclaimed = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ oldest: Schema.NullOr(Schema.String) }),
    execute: () => sql`
      SELECT MIN(created_at) AS "oldest"
      FROM staged_cloud_imports
      WHERE claimed_thread_id IS NULL
    `,
  });

  /** The key's row of this kind, after refusing a key another member or project holds. */
  const ownedRow = Effect.fn("StagedCloudImports.ownedRow")(function* ({
    key,
    kind,
    projectId,
    memberId,
  }: StagedImportRef) {
    const rows = yield* findRows(key).pipe(Effect.mapError(failWith(key, "failed")));
    if (rows.some((row) => row.projectId !== projectId || row.memberId !== memberId)) {
      return yield* failWith(key, "key-in-use")();
    }
    return Option.fromNullishOr(rows.find((row) => row.kind === kind));
  });

  const fromMirror = (key: CloudStagingKey) => (error: CheckpointMirror.CheckpointMirrorError) => {
    switch (error.reason) {
      case "too-large":
        return failWith(key, "too-large")(error);
      case "invalid-objects":
        return failWith(key, "invalid-seed")(error);
      case "missing-prerequisite":
        return failWith(key, "missing-prerequisite")(error);
      case "missing-project":
        return failWith(key, "unknown-project")(error);
      case "git":
        return failWith(key, "failed")(error);
    }
  };

  const writeBody = Effect.fn("StagedCloudImports.writeBody")(function* (
    key: CloudStagingKey,
    body: Stream.Stream<Uint8Array, unknown>,
    file: string,
  ) {
    let written = 0;
    yield* body.pipe(
      Stream.mapError(failWith(key, "upload-failed")),
      Stream.mapEffect((chunk) => {
        written += chunk.length;
        return written > maxSeedBytes
          ? Effect.fail(failWith(key, "too-large")())
          : Effect.succeed(chunk);
      }),
      Stream.run(fs.sink(file)),
      Effect.mapError((error) =>
        error._tag === "StagedCloudImportError" ? error : failWith(key, "failed")(error),
      ),
    );
  });

  const stageSeed = Effect.fn("StagedCloudImports.stageSeed")(function* (
    input: StagedImportRef & { readonly body: Stream.Stream<Uint8Array, unknown> },
  ) {
    const { key, projectId, memberId, body } = input;
    const failed = failWith(key, "failed");
    const project = yield* projects.get(projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) return yield* failWith(key, "unknown-project")();
    const row = yield* ownedRow(input);
    if (Option.isSome(row) && row.value.claimedThreadId !== null) {
      return yield* failWith(key, "claimed")();
    }

    const refs = cloudSeedRefs(key);
    // From here on any failure leaves no seed under the key, so no retry finds an older one.
    yield* mirror.deleteRefs(projectId, [refs.branch, refs.snapshot]).pipe(Effect.mapError(failed));

    yield* fs.makeDirectory(tmpDir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failed));
    const file = path.join(
      tmpDir,
      `${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}.bundle`,
    );
    yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore));
    yield* writeBody(key, body, file);

    // Written before any import, so a crash leaves a row the sweep finds.
    yield* upsertRow({
      key,
      kind: "seed",
      projectId,
      memberId,
      now: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.mapError(failed));
    yield* due.invalidate;

    const importSeed = mirror.ensure(projectId).pipe(
      Effect.andThen(
        mirror.importBundle({
          projectId,
          bundlePath: file,
          refs: [
            { source: refs.branch, target: refs.branch },
            { source: refs.snapshot, target: refs.snapshot },
          ],
          exactRefs: true,
        }),
      ),
      Effect.mapError(fromMirror(key)),
    );
    const imported = yield* importSeed.pipe(
      Effect.catchIf(
        (error) => error.reason === "missing-prerequisite",
        // The base may be newer than the checkout's last fetch; `ensure` refetches its origin refs.
        () =>
          pairCloudProjects
            .fetchCheckout({ projectId, workspaceRoot: project.value.workspaceRoot, memberId })
            .pipe(Effect.andThen(importSeed)),
      ),
    );

    // MirrorSync.restore drops a snapshot that isn't on the branch tip without a word.
    const branchOid = imported.get(refs.branch);
    const snapshotOid = imported.get(refs.snapshot);
    const parents =
      snapshotOid === undefined
        ? null
        : yield* mirror.commitParents(projectId, snapshotOid).pipe(Effect.mapError(failed));
    if (parents === null || parents.length !== 1 || parents[0] !== branchOid) {
      yield* mirror
        .deleteRefs(projectId, [refs.branch, refs.snapshot])
        .pipe(Effect.mapError(failed));
      return yield* failWith(
        key,
        "invalid-seed",
      )("The snapshot must be a commit on the branch tip.");
    }
  }, Effect.scoped);

  const stage: StagedCloudImports["Service"]["stage"] = Effect.fn("StagedCloudImports.stage")(
    function* (input) {
      yield* keyLocks.withLock(input.key, stageSeed(input));
    },
  );

  const stagedTips = Effect.fn("StagedCloudImports.stagedTips")(function* (
    key: CloudStagingKey,
    projectId: ProjectId,
  ) {
    const refs = cloudSeedRefs(key);
    const tips = yield* mirror
      .tips(projectId, [refs.branch, refs.snapshot])
      .pipe(Effect.mapError(failWith(key, "failed")));
    const branch = tips.get(refs.branch);
    const snapshot = tips.get(refs.snapshot);
    if (branch === undefined || snapshot === undefined) {
      return yield* failWith(key, "not-found")();
    }
    return { branch, snapshot };
  });

  const check: StagedCloudImports["Service"]["check"] = Effect.fn("StagedCloudImports.check")(
    function* (input) {
      const row = yield* ownedRow(input);
      if (Option.isNone(row)) return yield* failWith(input.key, "not-found")();
      if (row.value.claimedThreadId !== null) return yield* failWith(input.key, "claimed")();
      yield* stagedTips(input.key, input.projectId);
    },
  );

  const claimSeed = Effect.fn("StagedCloudImports.claimSeed")(function* (
    input: StagedImportRef & { readonly threadId: ThreadId },
  ) {
    const { key, kind, projectId, threadId } = input;
    const row = yield* ownedRow(input);
    if (Option.isNone(row)) return yield* failWith(key, "not-found")();
    if (row.value.claimedThreadId === threadId) return;
    if (row.value.claimedThreadId !== null) return yield* failWith(key, "claimed")();
    const tips = yield* stagedTips(key, projectId);
    // The thread's refs first: a crash before the row update is redone by the replayed claim.
    yield* mirror
      .updateRefs(
        projectId,
        new Map([
          [CheckpointMirror.sandboxBranchRef(threadId), tips.branch],
          [CheckpointMirror.sandboxSnapshotRef(threadId), tips.snapshot],
        ]),
      )
      .pipe(Effect.mapError(failWith(key, "failed")));
    yield* markClaimed({ key, kind, threadId }).pipe(Effect.mapError(failWith(key, "failed")));
    const refs = cloudSeedRefs(key);
    yield* mirror
      .deleteRefs(projectId, [refs.branch, refs.snapshot])
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to drop a claimed seed's staged refs", { key, cause }),
        ),
      );
  });

  const claim: StagedCloudImports["Service"]["claim"] = Effect.fn("StagedCloudImports.claim")(
    function* (input) {
      yield* keyLocks.withLock(input.key, claimSeed(input));
    },
  );

  const sweep: StagedCloudImports["Service"]["sweep"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return 0;
    const readVersion = yield* due.version;
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, unclaimedTtl));
    const rows = yield* findDue({ cutoff }).pipe(
      Effect.mapError(sqlError("StagedCloudImports.sweep:list")),
    );
    let dropped = 0;
    for (const { key, kind, projectId } of rows) {
      dropped += yield* keyLocks.withLock(
        key,
        Effect.gen(function* () {
          // A stage or claim since the list may have changed the row.
          if (Option.isNone(yield* isDue({ key, kind, cutoff }))) return 0;
          if (kind === "seed") {
            const refs = cloudSeedRefs(key);
            yield* mirror.deleteRefs(projectId, [refs.branch, refs.snapshot]);
          }
          return (yield* deleteDue({ key, kind, cutoff })).length;
        }).pipe(Effect.mapError(failWith(key, "failed"))),
      );
    }
    const { oldest } = yield* findOldestUnclaimed(undefined).pipe(
      Effect.mapError(sqlError("StagedCloudImports.sweep:oldest")),
    );
    const nextDueMs =
      oldest === null
        ? Infinity
        : DateTime.toEpochMillis(DateTime.addDuration(DateTime.makeUnsafe(oldest), unclaimedTtl));
    yield* due.record(readVersion, nextDueMs, nowMs);
    return dropped;
  }).pipe(Effect.withSpan("StagedCloudImports.sweep"));

  return StagedCloudImports.of({ stage, check, claim, sweep });
});

/** Also sweeps unclaimed imports on a cloud-only server, the only kind that takes them. */
export const layer = Layer.effect(
  StagedCloudImports,
  Effect.gen(function* () {
    const service = yield* make();
    const { cloudOnly } = yield* ServerConfig.ServerConfig;
    if (cloudOnly) {
      const scheduler = yield* Scheduler.Scheduler;
      yield* scheduler.register("staged-cloud-imports", service.sweep);
    }
    return service;
  }),
);
