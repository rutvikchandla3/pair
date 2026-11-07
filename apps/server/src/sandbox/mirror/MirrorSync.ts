import {
  type CheckpointRef,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isRunnerLost, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";

const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const SEED_HEAD_REF = "refs/t3/seed/origin/HEAD";
const ORDINAL_REF = /^(.*\/ordinal\/)(\d+)$/;
const TIP_LINE = /^([0-9a-f]{40}) (\S+)$/;

export interface MirrorHooksShape {
  readonly afterCapture: (input: {
    readonly threadId: ThreadId;
    readonly scope: OrchestrationV2CheckpointScope;
    /** This effect's checkpoints, any status. */
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void>;
  readonly afterRollback: (input: {
    readonly threadId: ThreadId;
    readonly scope: OrchestrationV2CheckpointScope;
    readonly deletedRefs: ReadonlyArray<CheckpointRef>;
  }) => Effect.Effect<void>;
}

const noopHooks: MirrorHooksShape = {
  afterCapture: () => Effect.void,
  afterRollback: () => Effect.void,
};

/** A Reference with a no-op default, so capture and rollback layers keep their requirements. */
export const MirrorHooks = Context.Reference<MirrorHooksShape>("t3/sandbox/mirror/MirrorHooks", {
  defaultValue: () => noopHooks,
});

export class MirrorSyncError extends Schema.TaggedError<MirrorSyncError>()("MirrorSyncError", {
  threadId: ThreadId,
  reason: Schema.Literals(["timeout", "sandbox-unavailable", "bundle-failed", "import-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Checkpoint mirror sync failed for thread ${this.threadId}: ${this.reason}.`;
  }
}

export class MirrorSync extends Context.Service<
  MirrorSync,
  {
    /** Pulls these refs and the thread's branch into the mirror; returns the mirror's project. */
    readonly sync: (input: {
      readonly threadId: ThreadId;
      /** A checkout on the thread's sandbox host. */
      readonly cwd: string;
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<ProjectId, MirrorSyncError>;
  }
>()("t3/sandbox/mirror/MirrorSync") {}

/** The previous ordinal of each requested checkpoint ref, when not itself requested. */
const previousOrdinalRefs = (refs: ReadonlyArray<string>) => {
  const requested = new Set(refs);
  const previous = new Set<string>();
  for (const ref of refs) {
    const match = ORDINAL_REF.exec(ref);
    if (match === null || Number(match[2]) === 0) continue;
    const candidate = `${match[1]}${Number(match[2]) - 1}`;
    if (!requested.has(candidate)) previous.add(candidate);
  }
  return [...previous];
};

type BundleOutcome = "written" | "empty" | "missing-prerequisite";

export const make = Effect.fn("MirrorSync.make")(function* (
  options: { readonly maxBundleBytes?: number } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const tmpDir = path.join(stateDir, "sandbox", "tmp");
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;

  const failWith = (threadId: ThreadId, reason: MirrorSyncError["reason"]) => (cause?: unknown) =>
    new MirrorSyncError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const fromPlatform = (threadId: ThreadId) => (error: PlatformError.PlatformError) =>
    failWith(threadId, isRunnerLost(error) ? "sandbox-unavailable" : "bundle-failed")(error);

  /** Runs git as a plain process on the sandbox host (03 §4.6: no new channel). */
  const runGit = Effect.fn("MirrorSync.runGit")(function* <A>(
    threadId: ThreadId,
    host: WorkspaceHost,
    cwd: string,
    args: ReadonlyArray<string>,
    readStdout: (
      stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    ) => Effect.Effect<A, MirrorSyncError | PlatformError.PlatformError>,
  ) {
    const child = yield* host.spawner
      .spawn(ChildProcess.make("git", args, { cwd }))
      .pipe(Effect.mapError(fromPlatform(threadId)));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStdout(child.stdout),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "MirrorSyncError" ? error : fromPlatform(threadId)(error),
      ),
    );
    return { stdout, stderr: stderr.slice(-2000), exitCode };
  }, Effect.scoped);

  const readSandboxTips = (
    threadId: ThreadId,
    host: WorkspaceHost,
    cwd: string,
    refs: ReadonlyArray<string>,
  ) =>
    runGit(
      threadId,
      host,
      cwd,
      ["for-each-ref", "--format=%(objectname) %(refname)", ...refs],
      (stdout) => stdout.pipe(Stream.decodeText(), Stream.mkString),
    ).pipe(
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode !== 0) return Effect.fail(failWith(threadId, "bundle-failed")(stderr));
        const wanted = new Set(refs);
        const tips = new Map<string, string>();
        for (const line of stdout.split("\n")) {
          const match = TIP_LINE.exec(line);
          if (match !== null && wanted.has(match[2]!)) tips.set(match[2]!, match[1]!);
        }
        return Effect.succeed(tips);
      }),
    );

  const writeBundle = (
    threadId: ThreadId,
    host: WorkspaceHost,
    cwd: string,
    refs: ReadonlyArray<string>,
    prerequisites: ReadonlyArray<string>,
    file: string,
  ): Effect.Effect<BundleOutcome, MirrorSyncError> => {
    let written = 0;
    const tooLarge = failWith(
      threadId,
      "bundle-failed",
    )(`The bundle is larger than ${maxBundleBytes} bytes.`);
    return runGit(
      threadId,
      host,
      cwd,
      ["bundle", "create", "--quiet", "-", ...refs, ...prerequisites.map((oid) => `^${oid}`)],
      (stdout) =>
        stdout.pipe(
          Stream.mapEffect((chunk) => {
            written += chunk.length;
            return written > maxBundleBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk);
          }),
          Stream.run(fs.sink(file)),
        ),
    ).pipe(
      Effect.flatMap(({ stderr, exitCode }) => {
        if (exitCode === 0) return Effect.succeed<BundleOutcome>("written");
        // Every ref is reachable from a prerequisite, so the mirror holds its objects already.
        if (stderr.includes("Refusing to create empty bundle")) {
          return Effect.succeed<BundleOutcome>("empty");
        }
        // 07 §1: a prerequisite the sandbox lacks (pruned after a rollback) fails this way.
        if (stderr.includes("bad object")) {
          return Effect.succeed<BundleOutcome>("missing-prerequisite");
        }
        return Effect.fail(failWith(threadId, "bundle-failed")(stderr));
      }),
    );
  };

  const sync: MirrorSync["Service"]["sync"] = Effect.fn("MirrorSync.sync")(function* ({
    threadId,
    cwd,
    checkpointRefs,
  }) {
    const importFailed = failWith(threadId, "import-failed");
    const thread = yield* projections.getThread(threadId).pipe(Effect.mapError(importFailed));
    const host = yield* hosts
      .forPath(cwd)
      .pipe(Effect.mapError(failWith(threadId, "sandbox-unavailable")));
    const { projectId } = thread;
    yield* mirror.ensure(projectId).pipe(Effect.mapError(importFailed));

    // The server picks every ref name; the sandbox only produces bytes (06 §7).
    const branchTarget = `${CheckpointMirror.sandboxThreadRefPrefix(threadId)}branch`;
    const targets = new Map<string, string>(checkpointRefs.map((ref) => [ref, ref]));
    if (thread.branch !== null) targets.set(`refs/heads/${thread.branch}`, branchTarget);

    const sandboxTips = yield* readSandboxTips(threadId, host, cwd, [...targets.keys()]);
    const previous = previousOrdinalRefs(checkpointRefs);
    const mirrorTips = yield* mirror
      .tips(projectId, [...new Set([...targets.values(), ...previous, SEED_HEAD_REF])])
      .pipe(Effect.mapError(importFailed));

    const sources: Array<string> = [];
    const updates = new Map<string, string>();
    for (const [source, target] of targets) {
      const oid = sandboxTips.get(source);
      if (oid === undefined || mirrorTips.get(target) === oid) continue;
      sources.push(source);
      updates.set(target, oid);
    }
    if (updates.size === 0) return projectId;

    const seed = mirrorTips.get(SEED_HEAD_REF);
    const tiers: Array<ReadonlyArray<string>> = [];
    for (const tier of [
      [...previous.map((ref) => mirrorTips.get(ref)), mirrorTips.get(branchTarget), seed],
      [seed],
      [],
    ]) {
      const oids = [...new Set(tier.filter((oid) => oid !== undefined))];
      if (!tiers.some((existing) => existing.join() === oids.join())) tiers.push(oids);
    }

    yield* fs
      .makeDirectory(tmpDir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(importFailed));
    const file = path.join(
      tmpDir,
      `${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}.bundle`,
    );
    yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore));

    let outcome: BundleOutcome = "missing-prerequisite";
    for (const prerequisites of tiers) {
      outcome = yield* writeBundle(threadId, host, cwd, sources, prerequisites, file);
      if (outcome !== "missing-prerequisite") break;
    }
    if (outcome === "missing-prerequisite") {
      return yield* failWith(threadId, "bundle-failed")("No prerequisite tier worked.");
    }
    // Objects enter only through the strict import; refs then move to the sandbox's tips.
    if (outcome === "written") {
      yield* mirror
        .importBundle({ projectId, bundlePath: file, refs: [] })
        .pipe(Effect.mapError(importFailed));
    }
    yield* mirror.updateRefs(projectId, updates).pipe(Effect.mapError(importFailed));
    return projectId;
  }, Effect.scoped);

  return MirrorSync.of({ sync });
});

export const layer = Layer.effect(MirrorSync, make());
