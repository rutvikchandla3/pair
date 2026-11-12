import {
  type CheckpointRef,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isRunnerLost, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import { type SandboxHeadContext, SandboxHeadContextJson } from "./SandboxHeadContext.ts";

const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const SEED_HEAD_REF = "refs/t3/seed/origin/HEAD";
const ORDINAL_REF = /^(.*\/ordinal\/)(\d+)$/;
const TIP_LINE = /^([0-9a-f]{40}) (\S+)$/;
const REMOTE_URL_LINE = /^remote\.(.+)\.url (.+)$/;
// Only a URL's repository matters here; a token an agent put in it stays out of the mirror.
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i;
const encodeHeadContext = Schema.encodeEffect(SandboxHeadContextJson);

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
  reason: Schema.Literals([
    "timeout",
    "sandbox-unavailable",
    "bundle-failed",
    "import-failed",
    "restore-failed",
    "too-large",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Checkpoint mirror sync failed for thread ${this.threadId}: ${this.reason}.`;
  }
}

export class MirrorSync extends Context.Service<
  MirrorSync,
  {
    /**
     * Pulls these refs and the thread's branch into the mirror; returns the mirrors' projects. A
     * workspace thread's `<cwd>/<root name>` goes into its root project's mirror under the same names.
     */
    readonly sync: (input: {
      readonly threadId: ThreadId;
      /** A checkout on the thread's sandbox host, or a workspace thread's folder there. */
      readonly cwd: string;
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<ReadonlyArray<ProjectId>, MirrorSyncError>;
    /**
     * Rebuilds the thread's worktree at `worktreePath` from the mirror's copy of its branch and,
     * when it sits on that branch's tip, its sleep snapshot (in the working tree, not the index).
     * Null when the mirror has no branch for the thread. Bytes flow mirror to machine only.
     */
    readonly restore: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      /** The project's clone on the sandbox host. */
      readonly clonePath: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<{ readonly snapshotAt: DateTime.Utc | null } | null, MirrorSyncError>;
    /**
     * The thread's mirror branch and, when it sits on the tip, its snapshot, as a bundle file
     * removed when the scope closes. `file` is null when the receiver has every object. Null when
     * the mirror has no branch for the thread.
     */
    readonly bundleThread: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      /** Asked only once the branch exists; those the mirror holds are tried, then none. */
      readonly prerequisites: (
        seedTip: string | null,
      ) => Effect.Effect<ReadonlyArray<string>, MirrorSyncError>;
    }) => Effect.Effect<
      {
        readonly file: string | null;
        readonly head: string;
        readonly snapshot: { readonly oid: string; readonly takenAt: DateTime.Utc } | null;
      } | null,
      MirrorSyncError,
      Scope.Scope
    >;
    /**
     * Saves the thread's branch, upstream and remotes for PR discovery while it sleeps; a
     * workspace thread's, per repository, into each root project's mirror.
     */
    readonly recordHead: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
    }) => Effect.Effect<void, MirrorSyncError>;
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

const repositoriesOf = (
  thread: {
    readonly projectId: ProjectId;
    readonly roots?:
      | ReadonlyArray<{ readonly projectId: ProjectId; readonly name: string }>
      | undefined;
  },
  cwd: string,
) =>
  thread.roots === undefined
    ? [{ projectId: thread.projectId, cwd }]
    : thread.roots.map((root) => ({ projectId: root.projectId, cwd: `${cwd}/${root.name}` }));

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

  const readHeadContext = Effect.fn("MirrorSync.readHeadContext")(function* (
    threadId: ThreadId,
    host: WorkspaceHost,
    cwd: string,
    branch: string,
  ) {
    const text = (args: ReadonlyArray<string>) =>
      runGit(threadId, host, cwd, args, (stdout) =>
        stdout.pipe(Stream.decodeText(), Stream.mkString),
      );
    const [branchRef, remoteUrls, originHead] = yield* Effect.all(
      [
        text([
          "for-each-ref",
          "--format=%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${branch}`,
        ]),
        text(["config", "--get-regexp", "^remote\\..*\\.url$"]),
        text(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    // config exits 1 when nothing matches; symbolic-ref exits 1 when origin/HEAD is unset.
    for (const result of [branchRef, ...(remoteUrls.exitCode === 1 ? [] : [remoteUrls])]) {
      if (result.exitCode !== 0) return yield* failWith(threadId, "bundle-failed")(result.stderr);
    }
    const [headOid = "", remoteName = "", remoteRef = ""] = branchRef.stdout
      .split("\n", 1)[0]!
      .split("\0");
    if (headOid === "") return null;
    const remotes = remoteUrls.stdout.split("\n").flatMap((line) => {
      const match = REMOTE_URL_LINE.exec(line);
      return match === null
        ? []
        : [{ name: match[1]!, url: match[2]!.replace(URL_USERINFO, "$1") }];
    });
    const originBranch = originHead.exitCode === 0 ? originHead.stdout.trim() : "";
    return {
      version: 1 as const,
      capturedAt: yield* DateTime.now,
      branch,
      headOid,
      upstream: remoteName !== "" && remoteRef !== "" ? { remoteName, remoteRef } : null,
      remotes,
      defaultBranch: originBranch.startsWith("origin/")
        ? originBranch.slice("origin/".length)
        : null,
    } satisfies SandboxHeadContext;
  });

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
      "too-large",
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

  const syncRepository = Effect.fn("MirrorSync.syncRepository")(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly host: WorkspaceHost;
    readonly cwd: string;
    readonly projectId: ProjectId;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) {
    const { threadId, host, cwd, projectId, checkpointRefs } = input;
    const importFailed = failWith(threadId, "import-failed");
    yield* mirror.ensure(projectId).pipe(Effect.mapError(importFailed));

    // The server picks every ref name; the sandbox only produces bytes (06 §7).
    const branchTarget = CheckpointMirror.sandboxBranchRef(threadId);
    const targets = new Map<string, string>(checkpointRefs.map((ref) => [ref, ref]));
    if (input.branch !== null) targets.set(`refs/heads/${input.branch}`, branchTarget);

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

  const sync: MirrorSync["Service"]["sync"] = Effect.fn("MirrorSync.sync")(function* ({
    threadId,
    cwd,
    checkpointRefs,
  }) {
    const thread = yield* projections
      .getThread(threadId)
      .pipe(Effect.mapError(failWith(threadId, "import-failed")));
    const host = yield* hosts
      .forPath(cwd)
      .pipe(Effect.mapError(failWith(threadId, "sandbox-unavailable")));
    return yield* Effect.forEach(repositoriesOf(thread, cwd), (repository) =>
      syncRepository({ threadId, branch: thread.branch, host, checkpointRefs, ...repository }),
    );
  });

  const bundleThread: MirrorSync["Service"]["bundleThread"] = Effect.fn("MirrorSync.bundleThread")(
    function* ({ threadId, projectId, prerequisites }) {
      const failed = failWith(threadId, "bundle-failed");
      const branchRef = CheckpointMirror.sandboxBranchRef(threadId);
      const snapshotRef = CheckpointMirror.sandboxSnapshotRef(threadId);
      const mirrorTips = yield* mirror
        .tips(projectId, [branchRef, snapshotRef, SEED_HEAD_REF])
        .pipe(Effect.mapError(failed));
      const head = mirrorTips.get(branchRef);
      if (head === undefined) return null;
      const gitDir = mirror.gitDir(projectId);
      const git = (args: ReadonlyArray<string>) =>
        runGit(threadId, hosts.local, gitDir, args, (stdout) =>
          stdout.pipe(Stream.decodeText(), Stream.mkString),
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(failed(result.stderr)),
          ),
        );

      // A snapshot taken before later commits reached the mirror would undo them.
      let snapshot: { readonly oid: string; readonly takenAt: DateTime.Utc } | null = null;
      const snapshotTip = mirrorTips.get(snapshotRef);
      if (snapshotTip !== undefined) {
        const [parents = "", seconds = ""] = (yield* git([
          "show",
          "-s",
          "--format=%P%x00%ct",
          snapshotRef,
        ]))
          .trim()
          .split("\0");
        if (parents === head) {
          snapshot = { oid: snapshotTip, takenAt: DateTime.makeUnsafe(Number(seconds) * 1000) };
        }
      }
      const refs = snapshot === null ? [branchRef] : [branchRef, snapshotRef];

      const wanted = yield* prerequisites(mirrorTips.get(SEED_HEAD_REF) ?? null);
      // One commit the mirror lacks would fail the whole tier, so keep only those it holds.
      const held =
        wanted.length === 0
          ? []
          : (yield* git(["rev-list", "--no-walk", "--ignore-missing", ...wanted]))
              .split("\n")
              .filter((line) => line !== "");

      yield* fs
        .makeDirectory(tmpDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failed));
      const file = path.join(
        tmpDir,
        `${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}.bundle`,
      );
      yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore));
      let outcome: BundleOutcome = "missing-prerequisite";
      for (const tier of held.length === 0 ? [[]] : [held, []]) {
        outcome = yield* writeBundle(threadId, hosts.local, gitDir, refs, tier, file);
        if (outcome !== "missing-prerequisite") break;
      }
      if (outcome === "missing-prerequisite") return yield* failed("No prerequisite tier worked.");
      return { file: outcome === "written" ? file : null, head, snapshot };
    },
  );

  const restore: MirrorSync["Service"]["restore"] = Effect.fn("MirrorSync.restore")(function* ({
    threadId,
    projectId,
    clonePath,
    worktreePath,
    branch,
  }) {
    const failed = failWith(threadId, "restore-failed");
    const hostFor = hosts
      .forPath(clonePath)
      .pipe(Effect.mapError(failWith(threadId, "sandbox-unavailable")));
    const bundle = yield* bundleThread({
      threadId,
      projectId,
      prerequisites: (seed) =>
        seed === null
          ? Effect.succeed([])
          : hostFor.pipe(
              Effect.flatMap((host) =>
                runGit(
                  threadId,
                  host,
                  clonePath,
                  ["cat-file", "-e", `${seed}^{commit}`],
                  () => Effect.void,
                ),
              ),
              Effect.map(({ exitCode }) => (exitCode === 0 ? [seed] : [])),
            ),
    });
    if (bundle === null) return null;
    const host = yield* hostFor;
    const git = (target: WorkspaceHost, cwd: string, args: ReadonlyArray<string>) =>
      runGit(threadId, target, cwd, args, (stdout) =>
        stdout.pipe(Stream.decodeText(), Stream.mkString),
      ).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(failed(result.stderr)),
        ),
      );
    const branchRef = CheckpointMirror.sandboxBranchRef(threadId);
    const snapshotRef = CheckpointMirror.sandboxSnapshotRef(threadId);
    const { snapshot } = bundle;

    // A worktree whose directory went with the disk still holds its branch until pruned.
    yield* git(host, clonePath, ["worktree", "prune"]);
    if (bundle.file !== null) {
      const remote = path.join(clonePath, ".git", `t3-restore-${path.basename(bundle.file)}`);
      yield* Effect.addFinalizer(() =>
        host.fileSystem.remove(remote, { force: true }).pipe(Effect.ignore),
      );
      const bytes = yield* fs.readFile(bundle.file).pipe(Effect.mapError(failed));
      yield* host.fileSystem.writeFile(remote, bytes).pipe(Effect.mapError(fromPlatform(threadId)));
      // git drops a ref its prerequisites exclude, so a branch still on the seed may be missing;
      // the snapshot's parent is the head and carries its objects.
      yield* git(host, clonePath, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        snapshot === null ? `+${branchRef}:refs/heads/${branch}` : `+${snapshotRef}:${snapshotRef}`,
      ]);
    }
    if (bundle.file === null || snapshot !== null) {
      yield* git(host, clonePath, ["branch", "--force", "--", branch, bundle.head]);
    }
    yield* git(host, clonePath, ["worktree", "add", "--quiet", "--", worktreePath, branch]);
    if (snapshot !== null) {
      yield* git(host, worktreePath, ["read-tree", "--reset", "-u", snapshot.oid]);
      yield* git(host, worktreePath, ["reset", "--quiet"]);
    }
    return { snapshotAt: snapshot?.takenAt ?? null };
  }, Effect.scoped);

  const recordHead: MirrorSync["Service"]["recordHead"] = Effect.fn("MirrorSync.recordHead")(
    function* ({ threadId, cwd }) {
      const importFailed = failWith(threadId, "import-failed");
      const thread = yield* projections.getThread(threadId).pipe(Effect.mapError(importFailed));
      if (thread.branch === null) return;
      const { branch } = thread;
      const host = yield* hosts
        .forPath(cwd)
        .pipe(Effect.mapError(failWith(threadId, "sandbox-unavailable")));
      yield* Effect.forEach(repositoriesOf(thread, cwd), (repository) =>
        readHeadContext(threadId, host, repository.cwd, branch).pipe(
          Effect.flatMap((head) =>
            head === null
              ? Effect.void
              : encodeHeadContext(head).pipe(
                  Effect.flatMap((json) =>
                    mirror.writeBlobRef(
                      repository.projectId,
                      CheckpointMirror.sandboxHeadRef(threadId),
                      json,
                    ),
                  ),
                  Effect.mapError(importFailed),
                ),
          ),
        ),
      );
    },
  );

  return MirrorSync.of({ sync, bundleThread, restore, recordHead });
});

export const layer = Layer.effect(MirrorSync, make());
