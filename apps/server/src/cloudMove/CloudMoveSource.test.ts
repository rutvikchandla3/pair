import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CloudStagingKey,
  EnvironmentId,
  MemberId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as ContextExports from "../orchestration-v2/ContextExports.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as MirrorSyncWorker from "../sandbox/mirror/MirrorSyncWorker.ts";
import * as TeamState from "../team/TeamState.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import * as CloudMoveSource from "./CloudMoveSource.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const OWNER = MemberId.make("member:owner");
const TEAMMATE = MemberId.make("member:teammate");
const SANDBOX = SandboxId.make("sbx_00000000000000000100");
const MOVE_ID = CloudStagingKey.make(`mv_${"c".repeat(32)}`);

class SandboxRoot extends Context.Service<SandboxRoot, string>()(
  "t3/cloudMove/CloudMoveSource.test/SandboxRoot",
) {}

/** What the mocked projections answer; each test fills it before calling the service. */
interface World {
  shell: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  runtimeRequests: Array<Record<string, unknown>>;
  readonly captures: Array<{ readonly cwd: string; readonly ref: string }>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  settleRejected: boolean;
}

const makeWorld = (threadId: ThreadId): World => ({
  shell: {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    branch: "work",
    worktreePath: null,
    sandboxId: SANDBOX,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    ownerId: OWNER,
    deletedAt: null,
  },
  sandbox: {
    id: SANDBOX,
    ownerThreadId: threadId,
    state: "sleeping",
    runnerLostAt: null,
    driverRef: "container-1",
    sleepSnapshotAt: DateTime.makeUnsafe("2026-11-09T14:00:00Z"),
  },
  runs: [
    {
      ordinal: 1,
      status: "completed",
      workspacePreparation: { type: "worktree", baseRef: "main" },
    },
  ],
  runtimeRequests: [],
  captures: [],
  dispatched: [],
  settleRejected: false,
});

const layerHosts = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "cloud-move-source-sandbox-" }),
    );
    return Layer.merge(WorkspaceHostLoopback.layerLoopback(root), Layer.succeed(SandboxRoot, root));
  }),
);

const layerFor = (world: World, options: { readonly team: boolean } = { team: true }) => {
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThread: () => Effect.sync(() => world.shell as never),
    getThreadShell: (threadId) =>
      Effect.sync(() => (threadId === world.shell.id ? (world.shell as never) : null)),
    getThreadRecords: () =>
      Effect.sync(() => ({ runs: world.runs, runtimeRequests: world.runtimeRequests }) as never),
    getSandbox: () => Effect.sync(() => world.sandbox as never),
    listSandboxThreads: () => Effect.succeed([]),
  });
  const base = Layer.mergeAll(CheckpointMirror.layer, GitVcsDriver.layerVcs).pipe(
    Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layer, ProjectStore.layer, VcsProcess.layer)),
    Layer.provideMerge(projections),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cloud-move-source-" })),
    Layer.provideMerge(layerHosts),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const mirror = Layer.effect(MirrorSync.MirrorSync, MirrorSync.make()).pipe(
    Layer.provideMerge(base),
  );
  // The real capture and sync, so an awake machine's snapshot is the one the bundle carries.
  const capture = Layer.unwrap(
    Effect.gen(function* () {
      const vcs = yield* VcsDriver.VcsDriver;
      return Layer.mock(CheckpointService.CheckpointServiceV2)({
        captureSnapshot: ({ cwd, ref }) =>
          Effect.sync(() => world.captures.push({ cwd, ref })).pipe(
            Effect.andThen(vcs.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref })),
            Effect.as("ready" as const),
            Effect.orDie,
          ),
      });
    }),
  );
  const worker = Layer.unwrap(
    Effect.gen(function* () {
      const sync = yield* MirrorSync.MirrorSync;
      return Layer.mock(MirrorSyncWorker.MirrorSyncWorker)({
        syncRefs: ({ threadId, cwd, checkpointRefs }) =>
          sync.sync({ threadId, cwd, checkpointRefs }).pipe(Effect.as(true), Effect.orDie),
      });
    }),
  );
  const others = Layer.mergeAll(
    Layer.mock(ContextExports.ContextExports)({
      build: (threadId) => Effect.succeed({ source: { threadId } } as never),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          world.dispatched.push(command);
          if (command.type === "thread.settle" && world.settleRejected) {
            return yield* Effect.fail({
              _tag: "OrchestratorCommandPreviouslyRejectedError",
            } as never);
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () =>
        Effect.succeedSome({
          repositoryIdentity: {
            canonicalKey: "github.com/acme/app",
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
          },
        } as never),
    }),
    options.team
      ? Layer.effect(
          TeamState.TeamState,
          Effect.gen(function* () {
            const members = yield* Ref.make(
              new Map([
                [OWNER, { id: OWNER, name: "Kim", removedAt: null }],
                [TEAMMATE, { id: TEAMMATE, name: "Sam", removedAt: null }],
              ] as never),
            );
            return { ownerId: OWNER, members } as never;
          }),
        )
      : Layer.empty,
  );
  return CloudMoveSource.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(capture, worker).pipe(Layer.provideMerge(mirror))),
    Layer.provideMerge(others),
  );
};

const git = Effect.fn("CloudMoveSourceTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "CloudMoveSourceTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
  });
  return result.stdout.trim();
});

/**
 * An origin with one commit, and the machine's checkout of it on `work` with an unpushed commit
 * and uncommitted changes. The mirror holds the branch and a snapshot on its tip, as after a sleep.
 */
const setup = Effect.fn("CloudMoveSourceTest.setup")(function* (world: World) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const threadId = world.shell.id as ThreadId;
  const projectId = world.shell.projectId as ProjectId;
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-move-source-origin-" });
  yield* git(project, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(project, "one.txt"), "one\n");
  yield* git(project, ["add", "."]);
  yield* git(project, ["commit", "--quiet", "-m", "one"]);
  yield* git(project, ["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Cloud move source test', ${project}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  const checkout = path.join(yield* SandboxRoot, threadId.replaceAll(":", "-"));
  yield* git(project, ["clone", "--quiet", "--no-local", project, checkout]);
  yield* git(checkout, ["switch", "--quiet", "-c", "work"]);
  yield* fs.writeFileString(path.join(checkout, "two.txt"), "two\n");
  yield* git(checkout, ["add", "."]);
  yield* git(checkout, ["commit", "--quiet", "-m", "two"]);
  yield* fs.writeFileString(path.join(checkout, "one.txt"), "changed\n");
  world.shell = { ...world.shell, worktreePath: checkout };

  const vcs = yield* VcsDriver.VcsDriver;
  const sync = yield* MirrorSync.MirrorSync;
  const snapshotRef = CheckpointMirror.sandboxSnapshotRef(threadId);
  yield* vcs.checkpoints.captureCheckpoint({ cwd: checkout, checkpointRef: snapshotRef });
  yield* sync.sync({ threadId, cwd: checkout, checkpointRefs: [CheckpointRef.make(snapshotRef)] });
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const mirrorGit = (args: ReadonlyArray<string>) =>
    git(mirror.gitDir(projectId), [`--git-dir=${mirror.gitDir(projectId)}`, ...args]);
  return {
    checkout,
    sync,
    snapshotRef,
    mirrorGit,
    originTip: yield* git(project, ["rev-parse", "HEAD"]),
    sleptSnapshot: yield* git(checkout, ["rev-parse", snapshotRef]),
  };
});

type Setup = Effect.Success<ReturnType<typeof setup>>;

const seedCases: ReadonlyArray<{
  readonly name: string;
  readonly team?: boolean;
  readonly memberId?: MemberId;
  readonly haves?: (setup: Setup) => ReadonlyArray<string>;
  readonly arrange?: (
    world: World,
    setup: Setup,
  ) => Effect.Effect<void, never, GitVcsDriver.GitVcsDriver | FileSystem.FileSystem>;
  readonly expected:
    | { readonly refused: CloudMoveSource.CloudMoveSourceError["reason"] }
    | {
        readonly mode: "move" | "copy";
        readonly captured: boolean;
        readonly snapshot: "slept" | "fresh" | "none";
        readonly prerequisite: boolean;
      };
}> = [
  {
    name: "an awake machine",
    arrange: (world, { checkout }) =>
      Effect.gen(function* () {
        world.sandbox = { ...world.sandbox, state: "ready", sleepSnapshotAt: null };
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${checkout}/fresh.txt`, "since the sleep\n");
      }).pipe(Effect.orDie),
    expected: { mode: "move", captured: true, snapshot: "fresh", prerequisite: true },
  },
  {
    name: "an asleep machine with a snapshot on the tip",
    expected: { mode: "move", captured: false, snapshot: "slept", prerequisite: true },
  },
  {
    name: "a solo server, whose member holds every thread",
    team: false,
    memberId: TEAMMATE,
    expected: { mode: "move", captured: false, snapshot: "slept", prerequisite: true },
  },
  {
    name: "an asleep machine whose snapshot never reached the mirror",
    arrange: (world) =>
      Effect.sync(() => (world.sandbox = { ...world.sandbox, sleepSnapshotAt: null })),
    expected: { refused: "snapshot-missing" },
  },
  {
    name: "an asleep machine with a snapshot behind the tip",
    arrange: (world, { checkout, sync }) =>
      Effect.gen(function* () {
        yield* git(checkout, ["commit", "--quiet", "-am", "later"]);
        yield* sync.sync({
          threadId: world.shell.id as ThreadId,
          cwd: checkout,
          checkpointRefs: [],
        });
      }).pipe(Effect.orDie),
    expected: { refused: "snapshot-missing" },
  },
  {
    name: "a destroyed disk",
    arrange: (world, { checkout, sync }) =>
      Effect.gen(function* () {
        yield* git(checkout, ["commit", "--quiet", "-am", "later"]);
        yield* sync.sync({
          threadId: world.shell.id as ThreadId,
          cwd: checkout,
          checkpointRefs: [],
        });
        world.sandbox = { ...world.sandbox, state: "destroyed", sleepSnapshotAt: null };
      }).pipe(Effect.orDie),
    expected: { mode: "move", captured: false, snapshot: "none", prerequisite: true },
  },
  {
    name: "a running turn",
    arrange: (world) =>
      Effect.sync(() => {
        world.sandbox = { ...world.sandbox, state: "ready" };
        world.runs = [...world.runs, { ordinal: 2, status: "running" }];
      }),
    expected: { refused: "run-active" },
  },
  {
    name: "a queued turn",
    arrange: (world) =>
      Effect.sync(() => (world.runs = [...world.runs, { ordinal: 2, status: "queued" }])),
    expected: { refused: "run-active" },
  },
  {
    name: "an open request",
    arrange: (world) => Effect.sync(() => (world.runtimeRequests = [{ status: "pending" }])),
    expected: { refused: "run-active" },
  },
  {
    name: "a side chat",
    arrange: (world) =>
      Effect.sync(() => {
        world.shell = {
          ...world.shell,
          lineage: { ...(world.shell.lineage as object), sideChat: true },
        };
      }),
    expected: { refused: "not-movable" },
  },
  {
    name: "another member",
    memberId: TEAMMATE,
    expected: { mode: "copy", captured: false, snapshot: "slept", prerequisite: true },
  },
  {
    name: "a have the mirror lacks",
    haves: () => ["f".repeat(40)],
    expected: { mode: "move", captured: false, snapshot: "slept", prerequisite: false },
  },
];

it.effect.each(seedCases)("seeds a move from $name", (testCase) => {
  const threadId = ThreadId.make(`thread:${testCase.name.replaceAll(/\W+/g, "-")}`);
  const world = makeWorld(threadId);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const prepared = yield* setup(world);
    yield* testCase.arrange?.(world, prepared) ?? Effect.void;
    const source = yield* CloudMoveSource.CloudMoveSource;

    const result = yield* Effect.scoped(
      source
        .seed({
          threadId,
          memberId: testCase.memberId ?? OWNER,
          haves: testCase.haves?.(prepared) ?? [prepared.originTip],
        })
        .pipe(
          Effect.flatMap((seed) =>
            Effect.gen(function* () {
              assert.isNotNull(seed.file);
              const heads = (yield* git(prepared.checkout, ["bundle", "list-heads", seed.file!]))
                .split("\n")
                .map((line) => line.split(" ")[1]);
              const verified = yield* prepared.mirrorGit(["bundle", "verify", seed.file!]);
              return { seed, heads, verified, file: seed.file! };
            }),
          ),
          Effect.result,
        ),
    );

    const expected = testCase.expected;
    if ("refused" in expected) {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, expected.refused);
      }
      assert.deepEqual(world.captures, []);
      return;
    }
    assert.equal(result._tag, "Success");
    if (result._tag !== "Success") return;
    const { seed, heads, verified, file } = result.success;
    assert.isFalse(yield* fs.exists(file));
    assert.deepEqual(
      world.captures,
      expected.captured ? [{ cwd: prepared.checkout, ref: prepared.snapshotRef }] : [],
    );
    assert.deepEqual(
      {
        mode: seed.mode,
        branch: seed.branch,
        baseRef: seed.baseRef,
        origin: seed.origin,
        head: seed.head,
      },
      {
        mode: expected.mode,
        branch: "work",
        baseRef: "main",
        origin: "github.com/acme/app",
        head: yield* git(prepared.checkout, ["rev-parse", "HEAD"]),
      },
    );
    const snapshotNow = yield* git(prepared.checkout, ["rev-parse", prepared.snapshotRef]);
    assert.equal(
      seed.snapshot?.oid ?? null,
      expected.snapshot === "none"
        ? null
        : expected.snapshot === "slept"
          ? prepared.sleptSnapshot
          : snapshotNow,
    );
    if (expected.snapshot === "fresh") assert.notEqual(snapshotNow, prepared.sleptSnapshot);
    assert.include(heads, CheckpointMirror.sandboxBranchRef(threadId));
    assert.equal(heads.includes(prepared.snapshotRef), expected.snapshot !== "none");
    if (expected.prerequisite) assert.include(verified, prepared.originTip);
    else assert.include(verified, "complete history");
  }).pipe(Effect.scoped, Effect.provide(layerFor(world, { team: testCase.team ?? true })));
});

const continuedCases: ReadonlyArray<{
  readonly name: string;
  readonly memberId: MemberId;
  readonly copy?: boolean;
  readonly arrange?: (world: World) => void;
  readonly expected: {
    readonly message: string;
    readonly copy: boolean;
    readonly settled: boolean;
    readonly commands: ReadonlyArray<string>;
  };
}> = [
  {
    name: "the holder",
    memberId: OWNER,
    expected: {
      message: "Continued locally on Kim's MacBook Pro",
      copy: false,
      settled: true,
      commands: ["thread.move.record", "thread.settle"],
    },
  },
  {
    name: "another member",
    memberId: TEAMMATE,
    expected: {
      message: "Sam copied this thread to Kim's MacBook Pro",
      copy: true,
      settled: false,
      commands: ["thread.move.record"],
    },
  },
  {
    name: "the holder asking for a copy",
    memberId: OWNER,
    copy: true,
    expected: {
      message: "Kim copied this thread to Kim's MacBook Pro",
      copy: true,
      settled: false,
      commands: ["thread.move.record"],
    },
  },
  {
    name: "the holder while a run started meanwhile",
    memberId: OWNER,
    arrange: (world) => (world.runs = [...world.runs, { ordinal: 2, status: "starting" }]),
    expected: {
      message: "Continued locally on Kim's MacBook Pro",
      copy: false,
      settled: false,
      commands: ["thread.move.record"],
    },
  },
  {
    name: "the holder whose settle was refused before",
    memberId: OWNER,
    arrange: (world) => (world.settleRejected = true),
    expected: {
      message: "Continued locally on Kim's MacBook Pro",
      copy: false,
      settled: false,
      commands: ["thread.move.record", "thread.settle"],
    },
  },
];

it.effect.each(continuedCases)("records a move back from $name", (testCase) => {
  const threadId = ThreadId.make("thread:continued");
  const world = makeWorld(threadId);
  testCase.arrange?.(world);
  return Effect.gen(function* () {
    const source = yield* CloudMoveSource.CloudMoveSource;
    const to = {
      environmentId: EnvironmentId.make("env-laptop"),
      threadId: ThreadId.make("local-1"),
    };
    const report = source.continued({
      threadId,
      memberId: testCase.memberId,
      input: {
        moveId: MOVE_ID,
        thread: to,
        environmentLabel: "Kim's MacBook Pro",
        copy: testCase.copy ?? false,
      },
    });

    assert.deepEqual(yield* report, { settled: testCase.expected.settled });
    const first = [...world.dispatched];
    assert.deepEqual(
      first.map((command) => command.type),
      testCase.expected.commands,
    );
    assert.deepEqual(first[0], {
      type: "thread.move.record",
      commandId: `cloud-move:${MOVE_ID}:record`,
      threadId,
      to,
      message: testCase.expected.message,
      ...(testCase.expected.copy ? { copy: true } : {}),
      actorId: testCase.memberId,
    } as never);
    if (first[1] !== undefined) {
      assert.deepEqual(first[1], {
        type: "thread.settle",
        commandId: `cloud-move:${MOVE_ID}:settle`,
        threadId,
      } as never);
    }

    // A retried report sends the same command ids, which the orchestrator replays.
    yield* report;
    assert.deepEqual(
      world.dispatched.slice(first.length).map((command) => command.commandId),
      first.map((command) => command.commandId),
    );
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});
