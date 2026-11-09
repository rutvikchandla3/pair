import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CloudStagingKey,
  cloudSeedRefs,
  MemberId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairCloudProjects from "../project/PairCloudProjects.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import * as StagedCloudImports from "./StagedCloudImports.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const projectId = ProjectId.make("project:seed");
const member = MemberId.make("member:a");
const keyOf = (digit: string) => CloudStagingKey.make(`mv_${digit.repeat(32)}`);
const key = keyOf("a");

class SandboxRoot extends Context.Service<SandboxRoot, string>()(
  "t3/cloudMove/StagedCloudImports.test/SandboxRoot",
) {}

/** Only this temp folder is a machine: git there runs through a real runner over loopback. */
const layerHosts = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "staged-imports-machine-" }),
    );
    return Layer.merge(WorkspaceHostLoopback.layerLoopback(root), Layer.succeed(SandboxRoot, root));
  }),
);

type FetchCheckout = PairCloudProjects.PairCloudProjects["Service"]["fetchCheckout"];

const layerWith = (fetchCheckout: FetchCheckout = () => Effect.void) =>
  Layer.effect(
    StagedCloudImports.StagedCloudImports,
    StagedCloudImports.make({ maxSeedBytes: 64 * 1024 }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(MirrorSync.MirrorSync, MirrorSync.make()).pipe(
        Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
      ),
    ),
    Layer.provideMerge(Layer.mock(PairCloudProjects.PairCloudProjects)({ fetchCheckout })),
    Layer.provideMerge(Layer.merge(CheckpointMirror.layer, GitVcsDriver.layerVcs)),
    Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layer, ProjectStore.layer, VcsProcess.layer)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "staged-imports-test-" })),
    Layer.provideMerge(layerHosts),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const git = Effect.fn("StagedCloudImportsTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  stdin?: string,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "StagedCloudImportsTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
    ...(stdin === undefined ? {} : { stdin }),
  });
  return result.stdout.trim();
});

const insertProject = Effect.fn("StagedCloudImportsTest.insertProject")(function* (
  id: ProjectId,
  workspaceRoot: string,
  deletedAt: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${id}, 'Seed test', ${workspaceRoot}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}
    )
  `;
});

/**
 * GitHub's `origin`, Pair Cloud's checkout of it (the project), and a member's laptop clone on
 * branch `feature` with an unpushed commit, an edit and an untracked file.
 */
const setup = Effect.fn("StagedCloudImportsTest.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsDriver.VcsDriver;
  const staged = yield* StagedCloudImports.StagedCloudImports;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const temp = (prefix: string) => fs.makeTempDirectoryScoped({ prefix });
  const origin = yield* temp("staged-imports-origin-");
  yield* git(origin, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(origin, "README.md"), "hello\n");
  yield* git(origin, ["add", "."]);
  yield* git(origin, ["commit", "--quiet", "-m", "initial"]);
  const checkout = path.join(yield* temp("staged-imports-checkout-"), "repo");
  yield* git(origin, ["clone", "--quiet", "--no-local", origin, checkout]);
  yield* insertProject(projectId, checkout);
  const laptop = path.join(yield* temp("staged-imports-laptop-"), "repo");
  yield* git(origin, ["clone", "--quiet", "--no-local", origin, laptop]);
  yield* git(laptop, ["switch", "--quiet", "-c", "feature"]);
  yield* fs.writeFileString(path.join(laptop, "committed.txt"), "unpushed\n");
  yield* git(laptop, ["add", "."]);
  yield* git(laptop, ["commit", "--quiet", "-m", "unpushed"]);
  yield* fs.writeFileString(path.join(laptop, "README.md"), "edited\n");
  yield* fs.writeFileString(path.join(laptop, "untracked.txt"), "untracked\n");
  const bundleDir = yield* temp("staged-imports-bundles-");
  let bundles = 0;

  /** Captures the working tree onto the key's snapshot ref and bundles both refs, as 3.23 will. */
  const seed = Effect.fn("StagedCloudImportsTest.seed")(function* (
    seedKey: CloudStagingKey,
    extra: ReadonlyArray<string> = [],
  ) {
    const refs = cloudSeedRefs(seedKey);
    yield* vcs.checkpoints.captureCheckpoint({
      cwd: laptop,
      checkpointRef: CheckpointRef.make(refs.snapshot),
    });
    yield* git(laptop, ["update-ref", refs.branch, "HEAD"]);
    return yield* bundleOf([refs.branch, refs.snapshot, ...extra]);
  });
  const bundleOf = Effect.fn("StagedCloudImportsTest.bundleOf")(function* (
    refs: ReadonlyArray<string>,
  ) {
    const file = path.join(bundleDir, `${bundles++}.bundle`);
    yield* git(laptop, ["bundle", "create", "--quiet", file, ...refs, "^origin/main"]);
    return file;
  });
  const stage = (
    file: string,
    input: { readonly key?: CloudStagingKey; readonly memberId?: MemberId } = {},
  ) =>
    staged.stage({
      key: input.key ?? key,
      kind: "seed",
      projectId,
      memberId: input.memberId ?? member,
      body: fs.stream(file),
    });
  const stagedTips = (stagingKey: CloudStagingKey) => {
    const refs = cloudSeedRefs(stagingKey);
    return mirror
      .tips(projectId, [refs.branch, refs.snapshot])
      .pipe(Effect.map((tips) => Object.fromEntries(tips)));
  };
  const laptopTips = (stagingKey: CloudStagingKey) =>
    Effect.gen(function* () {
      const refs = cloudSeedRefs(stagingKey);
      return {
        [refs.branch]: yield* git(laptop, ["rev-parse", refs.branch]),
        [refs.snapshot]: yield* git(laptop, ["rev-parse", refs.snapshot]),
      };
    });
  const rows = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly staging_key: string;
      readonly claimed_thread_id: string | null;
    }>`SELECT staging_key, claimed_thread_id FROM staged_cloud_imports ORDER BY staging_key`;
  });
  return {
    origin,
    checkout,
    laptop,
    staged,
    mirror,
    seed,
    bundleOf,
    stage,
    stagedTips,
    laptopTips,
    rows,
  };
});

it.effect("stages a seed under its key and replaces it on a retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { laptop, seed, stage, stagedTips, laptopTips, rows } = yield* setup();

    yield* stage(yield* seed(key));
    const first = yield* laptopTips(key);
    assert.deepEqual(yield* stagedTips(key), first);

    yield* fs.writeFileString(path.join(laptop, "untracked.txt"), "changed again\n");
    yield* stage(yield* seed(key));
    const second = yield* laptopTips(key);
    assert.notEqual(second[cloudSeedRefs(key).snapshot], first[cloudSeedRefs(key).snapshot]);
    assert.deepEqual(yield* stagedTips(key), second);
    assert.deepEqual(yield* rows, [{ staging_key: key, claimed_thread_id: null }]);
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

type Setup = Effect.Success<ReturnType<typeof setup>>;

it.effect.each<{
  readonly name: string;
  readonly reason: StagedCloudImports.StagedCloudImportError["reason"];
  /** A bundle file, or raw bytes. */
  readonly body: (
    context: Setup,
  ) => Effect.Effect<string | Uint8Array, Error, GitVcsDriver.GitVcsDriver>;
}>([
  {
    name: "a third ref",
    reason: "invalid-seed",
    body: ({ seed }) => seed(key, ["refs/heads/feature"]),
  },
  { name: "a ref under another key", reason: "invalid-seed", body: ({ seed }) => seed(keyOf("b")) },
  { name: "HEAD", reason: "invalid-seed", body: ({ seed }) => seed(key, ["HEAD"]) },
  {
    name: "a snapshot whose parent isn't the branch tip",
    reason: "invalid-seed",
    body: ({ laptop, bundleOf }) =>
      Effect.gen(function* () {
        const refs = cloudSeedRefs(key);
        yield* git(laptop, ["commit", "--quiet", "--allow-empty", "-m", "later"]);
        yield* git(laptop, ["update-ref", refs.branch, "HEAD"]);
        return yield* bundleOf([refs.branch, refs.snapshot]);
      }),
  },
  {
    name: "a body over the cap",
    reason: "too-large",
    body: () => Effect.succeed(new Uint8Array(65 * 1024)),
  },
  {
    name: "a .git tree entry",
    reason: "invalid-seed",
    body: ({ laptop, bundleOf }) =>
      Effect.gen(function* () {
        const refs = cloudSeedRefs(key);
        const blob = yield* git(laptop, ["hash-object", "-w", "--stdin"], "[core]\n");
        const inner = yield* git(laptop, ["mktree"], `100644 blob ${blob}\tconfig\n`);
        const tree = yield* git(laptop, ["mktree"], `040000 tree ${inner}\t.git\n`);
        const commit = yield* git(laptop, ["commit-tree", tree, "-p", refs.branch, "-m", "bad"]);
        yield* git(laptop, ["update-ref", refs.snapshot, commit]);
        return yield* bundleOf([refs.branch, refs.snapshot]);
      }),
  },
])("refuses $name and leaves no seed", ({ reason, body }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* setup();
    yield* context.stage(yield* context.seed(key));
    assert.lengthOf(Object.keys(yield* context.stagedTips(key)), 2);

    const bytes = yield* body(context);
    const failure = yield* context.staged
      .stage({
        key,
        kind: "seed",
        projectId,
        memberId: member,
        body: typeof bytes === "string" ? fs.stream(bytes) : Stream.make(bytes),
      })
      .pipe(Effect.flip);

    assert.equal(failure.reason, reason);
    assert.deepEqual(yield* context.stagedTips(key), {});
    assert.deepEqual(yield* context.stagedTips(keyOf("b")), {});
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

it.effect.each([
  { name: "imports after the fetch brings the base", fetchBrings: true },
  { name: "asks for full history when the fetch doesn't", fetchBrings: false },
])("fetches the checkout once on a missing prerequisite: $name", ({ fetchBrings }) => {
  const fetchCheckout = vi.fn<FetchCheckout>();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { origin, checkout, laptop, seed, stage, stagedTips, laptopTips } = yield* setup();
    // origin moves on after Pair Cloud's checkout last fetched; the laptop builds on the new main.
    yield* fs.writeFileString(path.join(origin, "upstream.txt"), "upstream\n");
    yield* git(origin, ["add", "."]);
    yield* git(origin, ["commit", "--quiet", "-m", "upstream"]);
    yield* git(laptop, ["fetch", "--quiet", "origin"]);
    yield* git(laptop, ["rebase", "--quiet", "--autostash", "origin/main"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    fetchCheckout.mockImplementation(() =>
      fetchBrings
        ? driver
            .execute({
              operation: "StagedCloudImportsTest.fetch",
              cwd: checkout,
              args: ["fetch", "--quiet", "origin"],
            })
            .pipe(Effect.orDie, Effect.asVoid)
        : Effect.void,
    );

    const result = yield* stage(yield* seed(key)).pipe(Effect.flip, Effect.option);

    assert.equal(fetchCheckout.mock.calls.length, 1);
    assert.deepEqual(fetchCheckout.mock.calls[0]![0], {
      projectId,
      workspaceRoot: checkout,
      memberId: member,
    });
    if (fetchBrings) {
      assert.isTrue(result._tag === "None");
      assert.deepEqual(yield* stagedTips(key), yield* laptopTips(key));
    } else {
      assert.equal(result._tag === "Some" ? result.value.reason : null, "missing-prerequisite");
      assert.deepEqual(yield* stagedTips(key), {});
    }
  }).pipe(Effect.scoped, Effect.provide(layerWith((input) => fetchCheckout(input))));
});

it.effect("refuses another member's or project's key and a deleted project", () =>
  Effect.gen(function* () {
    const { checkout, staged, seed, stage, stagedTips, laptopTips } = yield* setup();
    const file = yield* seed(key);
    yield* stage(file);
    const other = ProjectId.make("project:other");
    const deleted = ProjectId.make("project:deleted");
    yield* insertProject(other, checkout);
    yield* insertProject(deleted, checkout, "2026-02-01T00:00:00.000Z");
    const fs = yield* FileSystem.FileSystem;
    const attempt = (input: { readonly memberId: MemberId; readonly projectId: ProjectId }) =>
      staged.stage({ key, kind: "seed", ...input, body: fs.stream(file) }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );

    assert.deepEqual(
      [
        yield* attempt({ memberId: MemberId.make("member:b"), projectId }),
        yield* attempt({ memberId: member, projectId: other }),
        yield* staged
          .stage({
            key: keyOf("c"),
            kind: "seed",
            projectId: deleted,
            memberId: member,
            body: fs.stream(file),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      ],
      ["key-in-use", "key-in-use", "unknown-project"],
    );
    assert.deepEqual(yield* stagedTips(key), yield* laptopTips(key));
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

it.effect("claims a seed for one thread, which then restores it in a machine", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { origin, laptop, staged, mirror, seed, stage, stagedTips, laptopTips, rows } =
      yield* setup();
    yield* stage(yield* seed(key));
    const seeded = yield* laptopTips(key);
    const refs = cloudSeedRefs(key);
    const threadA = ThreadId.make("thread:a");
    const ref = { key, kind: "seed" as const, projectId };
    const reasonOf = <A>(effect: Effect.Effect<A, StagedCloudImports.StagedCloudImportError>) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    const otherMember = MemberId.make("member:b");

    yield* staged.check({ ...ref, memberId: member });
    assert.equal(yield* reasonOf(staged.check({ ...ref, memberId: otherMember })), "key-in-use");
    assert.equal(
      yield* reasonOf(staged.claim({ ...ref, memberId: otherMember, threadId: threadA })),
      "key-in-use",
    );

    yield* staged.claim({ ...ref, memberId: member, threadId: threadA });
    const threadRefs = [
      CheckpointMirror.sandboxBranchRef(threadA),
      CheckpointMirror.sandboxSnapshotRef(threadA),
    ];
    const threadTips = Effect.map(mirror.tips(projectId, threadRefs), (tips) => [...tips.values()]);
    assert.deepEqual(yield* threadTips, [seeded[refs.branch], seeded[refs.snapshot]]);
    assert.deepEqual(yield* stagedTips(key), {});
    assert.deepEqual(yield* rows, [{ staging_key: key, claimed_thread_id: threadA }]);

    // A replayed launch claims again; another thread, a check or a restage can't.
    yield* staged.claim({ ...ref, memberId: member, threadId: threadA });
    assert.deepEqual(yield* threadTips, [seeded[refs.branch], seeded[refs.snapshot]]);
    assert.equal(
      yield* reasonOf(
        staged.claim({ ...ref, memberId: member, threadId: ThreadId.make("thread:b") }),
      ),
      "claimed",
    );
    assert.equal(yield* reasonOf(staged.check({ ...ref, memberId: member })), "claimed");
    assert.equal(yield* reasonOf(stage(yield* seed(key))), "claimed");

    // 07 §10 #21: the machine gets the unpushed commit, the edit and the untracked file, unstaged.
    const root = yield* SandboxRoot;
    const clonePath = path.join(root, "clone");
    const worktreePath = path.join(root, "worktree");
    yield* git(root, ["clone", "--quiet", "--no-local", origin, clonePath]);
    const sync = yield* MirrorSync.MirrorSync;
    const restored = yield* sync.restore({
      threadId: threadA,
      projectId,
      clonePath,
      worktreePath,
      branch: "feature",
    });
    assert.isNotNull(restored?.snapshotAt);
    assert.equal(
      yield* git(worktreePath, ["rev-parse", "HEAD"]),
      yield* git(laptop, ["rev-parse", "HEAD"]),
    );
    assert.equal(yield* fs.readFileString(path.join(worktreePath, "committed.txt")), "unpushed\n");
    assert.equal(yield* fs.readFileString(path.join(worktreePath, "README.md")), "edited\n");
    assert.equal(yield* fs.readFileString(path.join(worktreePath, "untracked.txt")), "untracked\n");
    assert.equal(yield* git(worktreePath, ["diff", "--cached", "--name-only"]), "");
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);

it.effect("sweeps unclaimed seeds after a day and keeps claimed ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { staged, mirror, seed, stage, stagedTips, laptopTips, rows } = yield* setup();
    const claimedKey = keyOf("c");
    const threadA = ThreadId.make("thread:a");
    yield* stage(yield* seed(key));
    yield* stage(yield* seed(claimedKey), { key: claimedKey });
    yield* staged.claim({
      key: claimedKey,
      kind: "seed",
      projectId,
      memberId: member,
      threadId: threadA,
    });

    assert.equal(yield* staged.sweep, 0);
    yield* TestClock.adjust("25 hours");
    assert.equal(yield* staged.sweep, 1);

    assert.deepEqual(yield* stagedTips(key), {});
    assert.deepEqual(yield* rows, [{ staging_key: claimedKey, claimed_thread_id: threadA }]);
    const thread = yield* mirror.tips(projectId, [CheckpointMirror.sandboxBranchRef(threadA)]);
    assert.equal(
      thread.get(CheckpointMirror.sandboxBranchRef(threadA)),
      (yield* laptopTips(claimedKey))[cloudSeedRefs(claimedKey).branch],
    );

    // Nothing is due, so the next sweep skips SQL: a row written behind its back stays.
    yield* sql`
      INSERT INTO staged_cloud_imports (staging_key, kind, project_id, member_id, created_at)
      VALUES (${keyOf("d")}, 'seed', ${projectId}, ${member}, '1970-01-01T00:00:00.000Z')
    `;
    assert.equal(yield* staged.sweep, 0);
    assert.lengthOf(yield* rows, 2);
  }).pipe(Effect.scoped, Effect.provide(layerWith())),
);
