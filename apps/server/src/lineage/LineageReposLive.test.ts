import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, SandboxId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import { LineageRepos } from "./LineageRepos.ts";
import * as LineageReposLive from "./LineageReposLive.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

class MachinesRoot extends Context.Service<MachinesRoot, string>()(
  "t3/lineage/LineageReposLive.test/MachinesRoot",
) {}

const projectId = ProjectId.make("project:lineage-carry");
const machineA = SandboxId.make("sbx_0000000000000000000a");
const machineB = SandboxId.make("sbx_0000000000000000000b");
const machineC = SandboxId.make("sbx_0000000000000000000c");
const kousik = ThreadId.make("thread:source");
const hanad = ThreadId.make("thread:branch");
const rutvik = ThreadId.make("thread:other-branch");
const sidecar = ThreadId.make("thread:same-machine");

/** Every "machine" is a folder under one loopback root, so its git runs through a real runner. */
const layerHosts = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "lineage-carry-" }),
    );
    return Layer.merge(
      WorkspaceHostLoopback.layerLoopback(root),
      Layer.succeed(MachinesRoot, root),
    );
  }),
);

/** Each thread's checkout and machine; machine A sleeps once `asleep` is set. */
const machines = { asleep: false };
const layerProjections = Layer.effect(
  ProjectionStore.ProjectionStoreV2,
  Effect.gen(function* () {
    const root = yield* MachinesRoot;
    const placement: Record<string, readonly [SandboxId, string]> = {
      [kousik]: [machineA, `${root}/a/repo`],
      [sidecar]: [machineA, `${root}/a/sidecar`],
      [hanad]: [machineB, `${root}/b/repo`],
      [rutvik]: [machineC, `${root}/c/repo`],
    };
    return ProjectionStore.ProjectionStoreV2.of({
      getThread: (threadId: ThreadId) =>
        Effect.succeed({
          id: threadId,
          projectId,
          sandboxId: placement[threadId]![0],
          worktreePath: placement[threadId]![1],
          deletedAt: null,
        } as never),
      getSandbox: (id: SandboxId) =>
        Effect.succeed({ id, state: id === machineA && machines.asleep ? "sleeping" : "ready" }),
    } as never);
  }),
);

const layerTest = LineageReposLive.layer.pipe(
  Layer.provideMerge(Layer.merge(CheckpointMirror.layer, layerProjections)),
  Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layer, ProjectStore.layer, VcsProcess.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "lineage-carry-test-" })),
  Layer.provideMerge(layerHosts),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = Effect.fn("LineageReposTest.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "LineageReposTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
    allowNonZeroExit: true,
  });
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
});

const has = (cwd: string, sha: string) =>
  git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
    Effect.map((result) => result.exitCode === 0),
  );

/** A project checkout with history, and a clone of it on each machine. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* MachinesRoot;
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "lineage-carry-project-" });
  yield* git(project, ["init", "--quiet", "--initial-branch=main"]);
  for (const name of ["one", "two"]) {
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
      ${projectId}, 'Lineage carry test', ${project}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  for (const machine of ["a", "b", "c"]) {
    yield* git(project, ["clone", "--quiet", "--no-local", project, `${root}/${machine}/repo`]);
  }
  yield* git(`${root}/a/repo`, ["worktree", "add", "--quiet", "-b", "side", `${root}/a/sidecar`]);
  // Kousik's own commit, on machine A only.
  const a = `${root}/a/repo`;
  yield* fs.writeFileString(path.join(a, "schema.ts"), "export const schema = 1;\n");
  yield* git(a, ["add", "."]);
  yield* git(a, ["commit", "--quiet", "-m", "Add the schema"]);
  const commit = (yield* git(a, ["rev-parse", "HEAD"])).stdout;
  return { root, commit };
});

describe("LineageRepos", () => {
  it.effect("carries a commit between two machines through the mirror, never between them", () =>
    Effect.gen(function* () {
      machines.asleep = false;
      const repos = yield* LineageRepos;
      const mirror = yield* CheckpointMirror.CheckpointMirror;
      const { root, commit } = yield* setup;
      assert.isFalse(yield* has(`${root}/b/repo`, commit));

      yield* repos.carry({ from: kousik, to: hanad, commits: [commit] });

      assert.isTrue(yield* has(`${root}/b/repo`, commit));
      const ref = LineageReposLive.lineageCommitRef(hanad, commit);
      assert.equal((yield* mirror.tips(projectId, [ref])).get(ref), commit);
      // Carrying again finds it there and moves nothing.
      yield* repos.carry({ from: kousik, to: hanad, commits: [commit] });

      // Once machine A sleeps, the mirror still serves what it already holds; nothing wakes A.
      machines.asleep = true;
      yield* repos.carry({ from: kousik, to: rutvik, commits: [commit] });
      assert.isTrue(yield* has(`${root}/c/repo`, commit));

      // A commit only the sleeping machine has can't move.
      const a = `${root}/a/repo`;
      yield* git(a, ["commit", "--quiet", "--allow-empty", "-m", "Later"]);
      const later = (yield* git(a, ["rev-parse", "HEAD"])).stdout;
      const refused = yield* repos
        .carry({ from: kousik, to: hanad, commits: [later] })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "failed");
      assert.isFalse(yield* has(`${root}/b/repo`, later));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("needs nothing between threads on one machine, and reads each thread's checkout", () =>
    Effect.gen(function* () {
      machines.asleep = false;
      const repos = yield* LineageRepos;
      const mirror = yield* CheckpointMirror.CheckpointMirror;
      const { root, commit } = yield* setup;
      yield* repos.carry({ from: kousik, to: sidecar, commits: [commit] });
      const ref = LineageReposLive.lineageCommitRef(sidecar, commit);
      assert.isFalse((yield* mirror.tips(projectId, [ref])).has(ref));
      assert.isTrue(yield* has(`${root}/a/sidecar`, commit));
      assert.equal(yield* repos.cwdFor(hanad), `${root}/b/repo`);
    }).pipe(Effect.provide(layerTest)),
  );
});
