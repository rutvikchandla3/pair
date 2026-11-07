import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const layerDependencies = Layer.mergeAll(GitVcsDriver.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "checkpoint-mirror-test-" })),
  Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerTest = CheckpointMirror.layer.pipe(Layer.provideMerge(layerDependencies));

const git = Effect.fn("CheckpointMirrorTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  stdin?: string,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "CheckpointMirrorTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
    ...(stdin === undefined ? {} : { stdin }),
  });
  return result.stdout.trim();
});

const mirrorGit = (mirror: CheckpointMirror.CheckpointMirror["Service"], projectId: ProjectId) =>
  Effect.fn("CheckpointMirrorTest.mirrorGit")(function* (
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    const dir = mirror.gitDir(projectId);
    return yield* git(dir, [`--git-dir=${dir}`, ...args], stdin);
  });

const seedProject = Effect.fn("CheckpointMirrorTest.seedProject")(function* (
  projectId: ProjectId,
  workspaceRoot: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Mirror test', ${workspaceRoot}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

/** A checkout on `main` with a `feature` branch, a `v1` tag and an `origin/main` tracking ref. */
const makeCheckout = Effect.fn("CheckpointMirrorTest.makeCheckout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-mirror-checkout-" });
  yield* git(root, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(root, "README.md"), "hello\n");
  yield* git(root, ["add", "README.md"]);
  yield* git(root, ["commit", "--quiet", "-m", "initial"]);
  yield* git(root, ["branch", "feature"]);
  yield* git(root, ["tag", "v1"]);
  yield* git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
});

const setup = Effect.fn("CheckpointMirrorTest.setup")(function* (projectId: ProjectId) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = yield* makeCheckout();
  yield* seedProject(projectId, checkout);
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  yield* mirror.ensure(projectId);
  const bundleDir = yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-mirror-bundle-" });
  /** Bundles the given refs of the checkout against `main`. */
  const bundle = Effect.fn("CheckpointMirrorTest.bundle")(function* (
    name: string,
    refs: ReadonlyArray<string>,
  ) {
    const file = path.join(bundleDir, `${name}.bundle`);
    yield* git(checkout, ["bundle", "create", "--quiet", file, ...refs, "^main"]);
    return file;
  });
  return { checkout, mirror, mirrorGit: mirrorGit(mirror, projectId), bundle, bundleDir };
});

const commitOnBranch = Effect.fn("CheckpointMirrorTest.commitOnBranch")(function* (
  checkout: string,
  branch: string,
  from = "main",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* git(checkout, ["switch", "--quiet", "-c", branch, from]);
  yield* fs.writeFileString(path.join(checkout, `${branch}.txt`), `${branch}\n`);
  yield* git(checkout, ["add", "."]);
  yield* git(checkout, ["commit", "--quiet", "-m", branch]);
  return yield* git(checkout, ["rev-parse", "HEAD"]);
});

it.effect("seeds branches, tags and origin tracking refs into a hookless bare mirror", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectId = ProjectId.make("project:seed");
    const { checkout, mirror, mirrorGit } = yield* setup(projectId);
    const main = yield* git(checkout, ["rev-parse", "main"]);

    const refs = yield* mirrorGit(["for-each-ref", "--format=%(refname) %(objectname)"]);
    assert.deepEqual(refs.split("\n").toSorted(), [
      `refs/heads/feature ${main}`,
      `refs/heads/main ${main}`,
      `refs/t3/seed/origin/main ${main}`,
      `refs/tags/v1 ${main}`,
    ]);
    assert.isFalse(yield* fs.exists(path.join(mirror.gitDir(projectId), "hooks")));
    assert.isFalse(yield* fs.exists(`${mirror.gitDir(projectId)}.tmp`));

    // A later ensure refreshes the seed's origin refs.
    const next = yield* commitOnBranch(checkout, "upstream");
    yield* git(checkout, ["update-ref", "refs/remotes/origin/main", next]);
    yield* mirror.ensure(projectId);
    const tips = yield* mirror.tips(projectId, ["refs/t3/seed/origin/main", "refs/heads/nope"]);
    assert.deepEqual([...tips], [["refs/t3/seed/origin/main", next]]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("imports only the requested refs from a bundle whose prerequisite it has", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:import");
    const { checkout, mirror, mirrorGit, bundle } = yield* setup(projectId);
    const work = yield* commitOnBranch(checkout, "work");
    yield* commitOnBranch(checkout, "extra");
    const file = yield* bundle("work", ["refs/heads/work", "refs/heads/extra"]);
    const target = `${CheckpointMirror.sandboxThreadRefPrefix(ThreadId.make("thread:a"))}branch`;

    const moved = yield* mirror.importBundle({
      projectId,
      bundlePath: file,
      refs: [{ source: "refs/heads/work", target }],
    });

    assert.deepEqual([...moved], [[target, work]]);
    const tips = yield* mirror.tips(projectId, [target, "refs/heads/work", "refs/heads/extra"]);
    assert.deepEqual([...tips], [[target, work]]);
    assert.equal(yield* mirrorGit(["show", `${work}:work.txt`]), "work");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("refuses a bundle whose prerequisite the mirror lacks", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectId = ProjectId.make("project:missing-prerequisite");
    const { mirror, bundleDir } = yield* setup(projectId);
    const other = yield* makeCheckout();
    const base = yield* commitOnBranch(other, "unrelated");
    yield* commitOnBranch(other, "next", "unrelated");
    const file = path.join(bundleDir, "next.bundle");
    yield* git(other, ["bundle", "create", "--quiet", file, "refs/heads/next", `^${base}`]);

    const failure = yield* mirror
      .importBundle({
        projectId,
        bundlePath: file,
        refs: [{ source: "refs/heads/next", target: "refs/t3/next" }],
      })
      .pipe(Effect.flip);

    assert.equal(failure.reason, "missing-prerequisite");
    assert.deepEqual([...(yield* mirror.tips(projectId, ["refs/t3/next"]))], []);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("refuses a bundle carrying a .git tree entry and writes no ref", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectId = ProjectId.make("project:dotgit");
    const { checkout, mirror, mirrorGit, bundle } = yield* setup(projectId);
    const blob = yield* git(checkout, ["hash-object", "-w", "--stdin"], "[core]\n");
    const inner = yield* git(checkout, ["mktree"], `100644 blob ${blob}\tconfig\n`);
    const tree = yield* git(checkout, ["mktree"], `040000 tree ${inner}\t.git\n`);
    const commit = yield* git(checkout, ["commit-tree", tree, "-p", "main", "-m", "bad"]);
    yield* git(checkout, ["update-ref", "refs/heads/bad", commit]);
    const file = yield* bundle("bad", ["refs/heads/bad"]);

    const failure = yield* mirror
      .importBundle({
        projectId,
        bundlePath: file,
        refs: [{ source: "refs/heads/bad", target: "refs/t3/bad" }],
      })
      .pipe(Effect.flip);

    assert.equal(failure.reason, "invalid-objects");
    assert.deepEqual([...(yield* mirror.tips(projectId, ["refs/t3/bad"]))], []);
    const packDir = path.join(mirror.gitDir(projectId), "objects", "pack");
    const packs = yield* fs.readDirectory(packDir);
    assert.isEmpty(packs.filter((name) => name.startsWith("tmp_")));
    const lookup = yield* mirrorGit(["cat-file", "--batch-check"], `${commit}\n${tree}\n`);
    assert.equal(lookup, `${commit} missing\n${tree} missing`);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("deletes one thread's namespace, and removes the mirror idempotently", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectId = ProjectId.make("project:namespaces");
    const { checkout, mirror, mirrorGit } = yield* setup(projectId);
    const main = yield* git(checkout, ["rev-parse", "main"]);
    const first = CheckpointMirror.sandboxThreadRefPrefix(ThreadId.make("thread:first"));
    const second = CheckpointMirror.sandboxThreadRefPrefix(ThreadId.make("thread:second"));
    const refs = [`${first}branch`, `${first}snapshot`, `${second}branch`];
    for (const ref of refs) yield* mirrorGit(["update-ref", ref, main]);

    yield* mirror.deleteThreadNamespace(projectId, ThreadId.make("thread:first"));

    const tips = yield* mirror.tips(projectId, [...refs, "refs/heads/main"]);
    assert.deepEqual([...tips.keys()].toSorted(), ["refs/heads/main", `${second}branch`]);

    yield* mirror.remove(projectId);
    assert.isFalse(yield* fs.exists(mirror.gitDir(projectId)));
    yield* mirror.remove(projectId);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("keeps a project id with / and .. inside sandbox/mirrors", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const mirrorsDir = path.join(stateDir, "sandbox", "mirrors");
    const projectId = ProjectId.make("../../escape/../..");
    const { mirror } = yield* setup(projectId);

    const dir = mirror.gitDir(projectId);
    assert.equal(path.dirname(dir), mirrorsDir);
    assert.isTrue(yield* fs.exists(dir));
    assert.deepEqual(yield* fs.readDirectory(mirrorsDir), [path.basename(dir)]);
    assert.equal((yield* fs.stat(mirrorsDir)).mode & 0o777, 0o700);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("removes mirrors of deleted projects when the layer starts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const deleted = ProjectId.make("project:deleted");
    const live = ProjectId.make("project:live");
    const dirs = yield* Effect.gen(function* () {
      yield* setup(deleted);
      const { mirror } = yield* setup(live);
      return { deleted: mirror.gitDir(deleted), live: mirror.gitDir(live) };
    }).pipe(Effect.provide(CheckpointMirror.layer));
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE project_id = ${deleted}`;

    yield* CheckpointMirror.CheckpointMirror.pipe(Effect.provide(CheckpointMirror.layer));

    assert.isFalse(yield* fs.exists(dirs.deleted));
    assert.isTrue(yield* fs.exists(dirs.live));
  }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
);
