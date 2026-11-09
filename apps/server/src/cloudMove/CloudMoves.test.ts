import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type CloudMoveContinuedInput,
  EnvironmentId,
  type OrchestrationV2ContextExport,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
  ThreadMoveError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as CloudMoveClient from "./CloudMoveClient.ts";
import * as CloudMoves from "./CloudMoves.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const CLOUD = EnvironmentId.make("env-cloud");
const LAPTOP = EnvironmentId.make("env-laptop");
const PROJECT = ProjectId.make("project-local");
const LOCAL_THREAD = ThreadId.make("thread-local");
const ORIGIN_KEY = "github.com/acme/app";
const BRANCH_REF = "refs/t3/sandbox/dGhyZWFk/branch";
const SNAPSHOT_REF = "refs/t3/sandbox/dGhyZWFk/snapshot";

const contextExport = {
  version: 1,
  source: {
    environmentId: CLOUD,
    environmentLabel: "Acme Pair Cloud",
    threadId: ThreadId.make("thread-cloud"),
    title: "Fix the login form",
  },
  exportedAt: DateTime.makeUnsafe("2026-11-09T14:00:00Z"),
  messages: [],
  omittedMessageCount: 0,
} as unknown as OrchestrationV2ContextExport;

/** What the mocked services answer and what they saw. */
interface World {
  root: string;
  facts: CloudMoveClient.CloudMoveSeedFacts;
  bundle: string | null;
  launchFails: boolean;
  reportFailures: number;
  readonly downloads: Array<{ readonly haves: ReadonlyArray<string>; readonly copied: boolean }>;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly reports: Array<CloudMoveContinuedInput>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

const layerGit = Layer.mergeAll(GitVcsDriver.layer, GitVcsDriver.layerVcs).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cloud-moves-test-" })),
  Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerFor = (world: World, reports?: Queue.Queue<void>) =>
  CloudMoves.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          return Layer.mergeAll(
            Layer.mock(CloudMoveClient.CloudMoveClient)({
              contextExport: () => Effect.succeed(contextExport),
              downloadSeed: ({ haves, file, check }) =>
                Effect.gen(function* () {
                  const download = { haves, copied: false };
                  world.downloads.push(download);
                  yield* check(world.facts);
                  if (world.bundle === null) return { facts: world.facts, written: false };
                  yield* fs.copyFile(world.bundle, file).pipe(Effect.orDie);
                  world.downloads[world.downloads.length - 1] = { ...download, copied: true };
                  return { facts: world.facts, written: true };
                }),
              reportContinued: ({ body }) =>
                Effect.gen(function* () {
                  world.reports.push(body);
                  if (reports !== undefined) yield* Queue.offer(reports, undefined);
                  if (world.reports.length <= world.reportFailures) {
                    return yield* new ThreadMoveError({ reason: "failed", message: "No answer." });
                  }
                  return { settled: !body.copy };
                }),
            }),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: (input) =>
                Effect.gen(function* () {
                  world.launches.push(input);
                  if (world.launchFails) {
                    return yield* new ThreadLaunch.ThreadLaunchError({
                      operation: "create-thread",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: "The provider is off.",
                    });
                  }
                  return { threadId: LOCAL_THREAD, resumed: false } as never;
                }),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  world.dispatched.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getShell: () =>
                Effect.succeedSome({
                  id: PROJECT,
                  workspaceRoot: world.root,
                  repositoryIdentity: {
                    canonicalKey: ORIGIN_KEY,
                    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
                  },
                } as never),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId: LAPTOP,
                label: "Kim's MacBook Pro",
              } as never),
            }),
            // The routing layer adds only host checks; the git work is the driver's.
            Layer.mock(GitWorkflow.GitWorkflowService)({
              createWorktree: (input) => driver.createWorktree(input),
              removeWorktree: (input) => driver.removeWorktree(input),
              deleteLocalBranch: (input) => driver.deleteLocalBranch(input),
              remoteBranchExists: (input) => driver.remoteBranchExists(input),
            }),
          );
        }),
      ),
    ),
    Layer.provideMerge(layerGit),
  );

const git = Effect.fn("CloudMovesTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  allowNonZeroExit = false,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "CloudMovesTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
    allowNonZeroExit,
  });
  return allowNonZeroExit ? `${result.exitCode}:${result.stdout.trim()}` : result.stdout.trim();
});

/**
 * An origin, a "cloud" clone whose `work` branch has two commits not on origin plus an edit and an
 * untracked file, bundled as `bundleThread` bundles it; this project is another clone of origin.
 */
const setup = Effect.fn("CloudMovesTest.setup")(function* (world: World) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-moves-" });
  const origin = path.join(dir, "origin");
  yield* fs.makeDirectory(origin);
  yield* git(origin, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(origin, "one.txt"), "one\n");
  yield* git(origin, ["add", "."]);
  yield* git(origin, ["commit", "--quiet", "-m", "one"]);
  const originTip = yield* git(origin, ["rev-parse", "HEAD"]);

  const cloud = path.join(dir, "cloud");
  yield* git(dir, ["clone", "--quiet", origin, cloud]);
  yield* git(cloud, ["switch", "--quiet", "-c", "work"]);
  for (const name of ["two", "three"]) {
    yield* fs.writeFileString(path.join(cloud, `${name}.txt`), `${name}\n`);
    yield* git(cloud, ["add", "."]);
    yield* git(cloud, ["commit", "--quiet", "-m", name]);
  }
  yield* fs.writeFileString(path.join(cloud, "one.txt"), "changed\n");
  yield* fs.writeFileString(path.join(cloud, "new.txt"), "untracked\n");
  // The snapshot: the working tree as a commit on HEAD, through a scratch index.
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const scratchIndex = { ...GIT_IDENTITY, GIT_INDEX_FILE: path.join(dir, "snapshot-index") };
  const inScratch = (args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "CloudMovesTest.snapshot", cwd: cloud, args, env: scratchIndex })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* inScratch(["add", "-A"]);
  const tree = yield* inScratch(["write-tree"]);
  const head = yield* git(cloud, ["rev-parse", "HEAD"]);
  const snapshot = yield* git(cloud, ["commit-tree", tree, "-p", head, "-m", "snapshot"]);
  yield* git(cloud, ["update-ref", BRANCH_REF, head]);
  yield* git(cloud, ["update-ref", SNAPSHOT_REF, snapshot]);
  const bundle = path.join(dir, "seed.bundle");
  yield* git(cloud, [
    "bundle",
    "create",
    "--quiet",
    bundle,
    BRANCH_REF,
    SNAPSHOT_REF,
    `^${originTip}`,
  ]);

  const root = path.join(dir, "local");
  yield* git(dir, ["clone", "--quiet", origin, root]);
  world.root = root;
  world.bundle = bundle;
  world.facts = { ...world.facts, head, snapshot };
  return { root, cloud, head, snapshot, originTip, dir };
});

const makeWorld = (): World => ({
  root: "",
  facts: {
    mode: "move",
    branch: "work",
    baseRef: "main",
    origin: ORIGIN_KEY,
    head: "",
    snapshot: null,
  },
  bundle: null,
  launchFails: false,
  reportFailures: 0,
  downloads: [],
  launches: [],
  reports: [],
  dispatched: [],
});

const moveInput = (commandId: string) => ({
  commandId: CommandId.make(commandId),
  source: { environmentId: CLOUD, threadId: ThreadId.make("thread-cloud") },
  projectId: PROJECT,
  modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

const worktreePaths = (root: string) =>
  git(root, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
    ),
  );

it.effect("brings the branch, its commits and the uncommitted files into a new worktree", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, head, originTip } = yield* setup(world);
    const moves = yield* CloudMoves.CloudMoves;

    const result = yield* moves.continueLocally(moveInput("command-1"));

    const launch = world.launches[0]!;
    assert.equal(launch.workspaceStrategy.type, "existing_worktree");
    const worktree =
      launch.workspaceStrategy.type === "existing_worktree"
        ? launch.workspaceStrategy.worktreePath
        : "";
    assert.deepEqual(result, {
      threadId: LOCAL_THREAD,
      branch: "work",
      copy: false,
      reported: true,
    });
    assert.equal(yield* git(worktree, ["rev-parse", "HEAD"]), head);
    assert.equal(yield* git(worktree, ["branch", "--show-current"]), "work");
    assert.deepEqual((yield* git(worktree, ["status", "--porcelain"])).split("\n"), [
      "M one.txt",
      "?? new.txt",
    ]);
    assert.equal(yield* git(root, ["for-each-ref", "refs/t3/moves/"]), "");
    assert.include(world.downloads[0]!.haves, originTip);
    assert.deepEqual(launch.contextExport, { value: contextExport });
    assert.deepEqual(
      [launch.commandId, launch.title, launch.createdBy],
      [world.launches[0]!.commandId, "Fix the login form", "user"],
    );
    const digest = yield* Digest.Digest;
    const moveId = `mv_${Hex.encode(
      yield* digest.digest(Digest.sha256, new TextEncoder().encode("command-1")),
    ).slice(0, 32)}`;
    assert.equal(launch.commandId, `move:${moveId}`);
    assert.deepEqual(world.reports, [
      {
        moveId,
        thread: { environmentId: LAPTOP, threadId: LOCAL_THREAD },
        environmentLabel: "Kim's MacBook Pro",
        copy: false,
      } as never,
    ]);
    assert.isFalse(
      yield* (yield* FileSystem.FileSystem).exists(
        `${(yield* ServerConfig.ServerConfig).stateDir}/cloud-moves/${moveId}.bundle`,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("a copy gets a branch of its own, tracking nothing", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* setup(world);
    world.facts = { ...world.facts, mode: "copy" };
    const moves = yield* CloudMoves.CloudMoves;

    const first = yield* moves.continueLocally(moveInput("command-1"));
    const second = yield* moves.continueLocally(moveInput("command-2"));

    assert.deepEqual(
      [first, second].map(({ branch, copy }) => ({ branch, copy })),
      [
        { branch: "work-copy", copy: true },
        { branch: "work-copy-2", copy: true },
      ],
    );
    assert.deepEqual(world.launches[0]!.contextExport, { value: contextExport, copy: true });
    const worktree = world.launches[0]!.workspaceStrategy;
    assert.isTrue(
      (yield* git(
        worktree.type === "existing_worktree" ? worktree.worktreePath : "",
        ["rev-parse", "--abbrev-ref", "@{u}"],
        true,
      )).startsWith("128:"),
    );
    assert.deepEqual(
      world.reports.map((report) => report.copy),
      [true, true],
    );
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("the holder's branch, checked out here already, gets the next name", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root } = yield* setup(world);
    yield* git(root, ["branch", "work"]);
    const moves = yield* CloudMoves.CloudMoves;

    assert.equal((yield* moves.continueLocally(moveInput("command-1"))).branch, "work-2");
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("an empty bundle uses objects already here, and fails when they aren't", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, cloud } = yield* setup(world);
    world.bundle = null;
    world.facts = { ...world.facts, snapshot: null };
    const moves = yield* CloudMoves.CloudMoves;

    const missing = yield* moves.continueLocally(moveInput("command-1")).pipe(Effect.flip);
    assert.equal(missing.reason, "failed");
    assert.deepEqual(yield* worktreePaths(root), [root]);
    assert.equal(
      yield* git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/work"], true),
      "1:",
    );

    yield* git(root, ["fetch", "--quiet", cloud, "work:refs/remotes/elsewhere/work"]);
    const moved = yield* moves.continueLocally(moveInput("command-2"));
    assert.equal(moved.branch, "work");
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("refuses a project with another origin before the bundle", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root } = yield* setup(world);
    world.facts = { ...world.facts, origin: "github.com/someone/else" };
    const moves = yield* CloudMoves.CloudMoves;

    const refused = yield* moves.continueLocally(moveInput("command-1")).pipe(Effect.flip);

    assert.deepEqual(
      { reason: refused.reason, message: refused.message },
      {
        reason: "project-mismatch",
        message:
          "The cloud thread's origin, github.com/someone/else, doesn't match this project's.",
      },
    );
    assert.deepEqual(
      world.downloads.map((download) => download.copied),
      [false],
    );
    assert.deepEqual(yield* worktreePaths(root), [root]);
    assert.deepEqual(world.launches, []);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("undoes the worktree and branch when the launch fails", () => {
  const world = makeWorld();
  world.launchFails = true;
  return Effect.gen(function* () {
    const { root } = yield* setup(world);
    const moves = yield* CloudMoves.CloudMoves;

    const failed = yield* moves.continueLocally(moveInput("command-1")).pipe(Effect.flip);

    assert.equal(failed.reason, "failed");
    assert.equal(world.launches.length, 1);
    assert.deepEqual(yield* worktreePaths(root), [root]);
    assert.equal(
      yield* git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/work"], true),
      "1:",
    );
    assert.equal(yield* git(root, ["for-each-ref", "refs/t3/moves/"]), "");
    assert.deepEqual(world.reports, []);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("keeps the local thread when Pair Cloud doesn't hear about it", () => {
  const world = makeWorld();
  world.reportFailures = 3;
  return Effect.gen(function* () {
    yield* setup(world);
    const reports = yield* Queue.unbounded<void>();
    const services = yield* Layer.build(layerFor(world, reports));
    const moves = Context.get(services, CloudMoves.CloudMoves);

    const fiber = yield* Effect.forkChild(moves.continueLocally(moveInput("command-1")));
    yield* Queue.take(reports);
    yield* TestClock.adjust("2 seconds");
    yield* Queue.take(reports);
    yield* TestClock.adjust("2 seconds");
    yield* Queue.take(reports);
    const result = yield* Fiber.join(fiber);

    assert.deepEqual(result, {
      threadId: LOCAL_THREAD,
      branch: "work",
      copy: false,
      reported: false,
    });
    assert.equal(world.reports.length, 3);
    assert.deepEqual(
      world.dispatched.map((command) =>
        command.type === "thread.notice.record" ? [command.threadId, command.message] : null,
      ),
      [
        [
          LOCAL_THREAD,
          "Pair Cloud didn't record this move, so the cloud thread there stays as it was and doesn't link here.",
        ],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerGit));
});
