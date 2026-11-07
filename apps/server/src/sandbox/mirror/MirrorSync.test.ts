import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, ProjectId, SandboxId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../../vcs/VcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../../workspaceHost/WorkspaceHostLoopback.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import * as MirrorCheckpointReader from "./MirrorCheckpointReader.ts";
import * as MirrorSync from "./MirrorSync.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

class SandboxRoot extends Context.Service<SandboxRoot, string>()(
  "t3/sandbox/mirror/MirrorSync.test/SandboxRoot",
) {}

/** Only this temp folder is the "sandbox": git there runs through a real runner over loopback. */
const layerHosts = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "mirror-sync-sandbox-" }),
    );
    return Layer.merge(WorkspaceHostLoopback.layerLoopback(root), Layer.succeed(SandboxRoot, root));
  }),
);

const projectFor = (threadId: ThreadId) => ProjectId.make(`project:${threadId}`);

// The thread's sandbox checkout sits on branch `work`.
const layerProjections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThread: (threadId) =>
    Effect.succeed({
      id: threadId,
      projectId: projectFor(threadId),
      branch: "work",
      sandboxId: SandboxId.make("sbx_00000000000000000100"),
      deletedAt: null,
    } as never),
});

const layerDependencies = MirrorCheckpointReader.layer.pipe(
  // The reader falls back here only when the mirror lacks a ref.
  Layer.provide(
    Layer.mock(CheckpointStore.CheckpointStore)({
      diffCheckpoints: () => Effect.die("the diff must come from the mirror"),
    }),
  ),
  Layer.provideMerge(Layer.merge(CheckpointMirror.layer, GitVcsDriver.layerVcs)),
  Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layer, ProjectStore.layer, VcsProcess.layer)),
  Layer.provideMerge(layerProjections),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "mirror-sync-test-" })),
  Layer.provideMerge(layerHosts),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerWith = (options: { readonly maxBundleBytes?: number } = {}) =>
  Layer.effect(MirrorSync.MirrorSync, MirrorSync.make(options)).pipe(
    Layer.provideMerge(layerDependencies),
  );

const git = Effect.fn("MirrorSyncTest.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "MirrorSyncTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
  });
  return result.stdout.trim();
});

const ordinalRef = (ordinal: number) =>
  CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/c2NvcGU/ordinal/${ordinal}`);

/**
 * A project checkout on this machine with three commits, and a clone of it in the sandbox on
 * branch `work`. The mirror is seeded from the project checkout.
 */
const setup = Effect.fn("MirrorSyncTest.setup")(function* (threadId: ThreadId) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const projectId = projectFor(threadId);
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "mirror-sync-project-" });
  yield* git(project, ["init", "--quiet", "--initial-branch=main"]);
  for (const name of ["one", "two", "three"]) {
    yield* fs.writeFileString(path.join(project, `${name}.txt`), `${name}\n`);
    yield* git(project, ["add", "."]);
    yield* git(project, ["commit", "--quiet", "-m", name]);
  }
  yield* git(project, ["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Mirror sync test', ${project}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  const sandbox = path.join(yield* SandboxRoot, threadId.replaceAll(":", "-"));
  yield* git(project, ["clone", "--quiet", "--no-local", project, sandbox]);
  yield* git(sandbox, ["switch", "--quiet", "-c", "work"]);

  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const vcs = yield* VcsDriver.VcsDriver;
  const mirrorGit = (args: ReadonlyArray<string>) =>
    git(mirror.gitDir(projectId), [`--git-dir=${mirror.gitDir(projectId)}`, ...args]);
  /** A real capture in the sandbox checkout, with one file changed first. */
  const capture = Effect.fn("MirrorSyncTest.capture")(function* (ordinal: number) {
    if (ordinal > 0) {
      yield* fs.writeFileString(path.join(sandbox, "agent.txt"), `edit ${ordinal}\n`);
    }
    const checkpointRef = ordinalRef(ordinal);
    yield* vcs.checkpoints.captureCheckpoint({ cwd: sandbox, checkpointRef });
    return checkpointRef;
  });
  const inPack = Effect.gen(function* () {
    const stats = yield* mirrorGit(["count-objects", "-v"]);
    return Number(/^in-pack: (\d+)$/m.exec(stats)?.[1]);
  });
  return { projectId, sandbox, mirror, mirrorGit, capture, inPack };
});

it.effect(
  "pulls a capture's refs and the branch with only new objects, and the diff reads from the mirror",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:first-sync");
      const { projectId, sandbox, mirror, capture, inPack } = yield* setup(threadId);
      yield* mirror.ensure(projectId);
      const packedBefore = yield* inPack;
      const baseline = yield* capture(0);
      const turn = yield* capture(1);
      yield* git(sandbox, ["branch", "unrelated"]);
      const branchTarget = `${CheckpointMirror.sandboxThreadRefPrefix(threadId)}branch`;

      const sync = yield* MirrorSync.MirrorSync;
      yield* sync.sync({ threadId, cwd: sandbox, checkpointRefs: [baseline, turn] });

      const sandboxTips = yield* git(sandbox, ["rev-parse", baseline, turn, "HEAD"]);
      const tips = yield* mirror.tips(projectId, [
        baseline,
        turn,
        branchTarget,
        "refs/heads/unrelated",
      ]);
      assert.deepEqual(
        [tips.get(baseline), tips.get(turn), tips.get(branchTarget)].join("\n"),
        sandboxTips,
      );
      assert.isFalse(tips.has("refs/heads/unrelated"));
      // The seed's origin/HEAD was the prerequisite: two commits, one tree and one blob, not the
      // project's history again.
      assert.equal((yield* inPack) - packedBefore, 4);

      const placement = yield* MirrorCheckpointReader.CheckpointDiffPlacement;
      const reader = Option.getOrThrow(yield* placement.readerFor(threadId));
      const diff = yield* reader.diffCheckpoints({
        cwd: sandbox,
        fromCheckpointRef: baseline,
        toCheckpointRef: turn,
        ignoreWhitespace: false,
      });
      assert.include(diff, "+edit 1");
    }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

it.effect("falls back a prerequisite tier when the sandbox pruned one the mirror holds", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:fallback");
    const { projectId, sandbox, mirror, capture } = yield* setup(threadId);
    const sync = yield* MirrorSync.MirrorSync;
    const first = yield* capture(1);
    yield* sync.sync({ threadId, cwd: sandbox, checkpointRefs: [first] });
    // After a rollback deletes the ref, gc drops the commit the mirror would name as `^<oid>`.
    yield* git(sandbox, ["update-ref", "-d", first]);
    yield* git(sandbox, ["gc", "--quiet", "--prune=now"]);

    const second = yield* capture(2);
    yield* sync.sync({ threadId, cwd: sandbox, checkpointRefs: [second] });

    const tips = yield* mirror.tips(projectId, [second]);
    assert.equal(tips.get(second), yield* git(sandbox, ["rev-parse", second]));
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

it.effect("fails an oversized bundle as bundle-failed and leaves no temp file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread:too-large");
    const { projectId, sandbox, mirror, capture } = yield* setup(threadId);
    const turn = yield* capture(1);

    const sync = yield* MirrorSync.MirrorSync;
    const failure = yield* sync
      .sync({ threadId, cwd: sandbox, checkpointRefs: [turn] })
      .pipe(Effect.flip);

    assert.equal(failure.reason, "bundle-failed");
    assert.deepEqual(yield* fs.readDirectory(path.join(stateDir, "sandbox", "tmp")), []);
    assert.deepEqual([...(yield* mirror.tips(projectId, [turn]))], []);
  }).pipe(Effect.scoped, Effect.provide(layerWith({ maxBundleBytes: 64 }))),
);
