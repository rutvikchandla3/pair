import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type CloudMoveCheckInput,
  type CloudMoveContinuedInput,
  type CloudMoveLaunchInput,
  type CloudStagingKey,
  cloudSeedRefs,
  EnvironmentId,
  type OrchestrationV2ContextExport,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  PeerLinkError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  ThreadMoveError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ContextExports from "../orchestration-v2/ContextExports.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
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
  /** Continue in cloud: the local thread, the link here, and the fake routes' answers. */
  shell: ThreadShell | null;
  linked: boolean;
  checkRefusal: string | null;
  readonly seedAnswers: Array<"stored" | "claimed" | "missing-prerequisite">;
  readonly launchAnswers: Array<"branch-not-pushed" | ThreadMoveError>;
  launchHold: Deferred.Deferred<void> | null;
  launchStarted: Deferred.Deferred<void> | null;
  uploadDelay: Duration.Input | null;
  readonly turnItems: Array<OrchestrationV2TurnItem>;
  readonly routeCalls: Array<RouteCall>;
}

interface ThreadShell {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly activeRunId: RunId | null;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly deletedAt: null;
  readonly sandboxId?: string;
}

type RouteCall =
  | { readonly kind: "check"; readonly body: CloudMoveCheckInput }
  | {
      readonly kind: "putSeed";
      readonly key: CloudStagingKey;
      readonly copy: string;
      readonly bytes: number;
    }
  | { readonly kind: "putContextExport"; readonly key: CloudStagingKey }
  | { readonly kind: "launch"; readonly key: CloudStagingKey; readonly body: CloudMoveLaunchInput };

const CLOUD_PROJECT = ProjectId.make("project-cloud");
const CLOUD_THREAD = ThreadId.make("thread-cloud");
const MOVED = ThreadId.make("thread-moving");

const layerGit = Layer.mergeAll(
  GitVcsDriver.layer,
  GitVcsDriver.layerVcs,
  CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)),
).pipe(
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
              check: (_link, body) =>
                Effect.suspend(() => {
                  world.routeCalls.push({ kind: "check", body });
                  return world.checkRefusal === null
                    ? Effect.succeed({
                        projectId: CLOUD_PROJECT,
                        modelSelection: {
                          instanceId: ProviderInstanceId.make("codex"),
                          model: "gpt-5",
                        },
                      })
                    : Effect.fail(
                        new ThreadMoveError({ reason: "refused", message: world.checkRefusal }),
                      );
                }),
              putSeed: (_link, { key, file }) =>
                Effect.gen(function* () {
                  const copy = `${file}.${world.routeCalls.length}.sent`;
                  yield* fs.copyFile(file, copy).pipe(Effect.orDie);
                  const bytes = Number((yield* fs.stat(file).pipe(Effect.orDie)).size);
                  world.routeCalls.push({ kind: "putSeed", key, copy, bytes });
                  if (world.uploadDelay !== null) yield* TestClock.adjust(world.uploadDelay);
                  return world.seedAnswers.shift() ?? "stored";
                }),
              putContextExport: (_link, { key }) =>
                Effect.sync(() => {
                  world.routeCalls.push({ kind: "putContextExport", key });
                  return { outcome: "stored" as const, bytes: 1234 };
                }),
              launch: (_link, { key, body }) =>
                Effect.gen(function* () {
                  world.routeCalls.push({ kind: "launch", key, body });
                  if (world.launchStarted !== null)
                    yield* Deferred.succeed(world.launchStarted, undefined);
                  if (world.launchHold !== null) yield* Deferred.await(world.launchHold);
                  const answer = world.launchAnswers.shift();
                  if (typeof answer === "object") return yield* answer;
                  return answer ?? { threadId: CLOUD_THREAD };
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
                  if (command.type === "thread.move.record") {
                    world.turnItems.push({
                      type: "move",
                      direction: "to",
                      thread: command.to,
                    } as never);
                  }
                  return { sequence: 1, storedEvents: [] };
                }),
              getThreadShell: () => Effect.succeed(world.shell as never),
              getThreadRecords: () => Effect.succeed({ turnItems: world.turnItems } as never),
            }),
            Layer.mock(PeerLinks.PeerLinks)({
              agentLinks: Effect.sync(() => new Set(world.linked ? [CLOUD] : [])),
              get: () =>
                Effect.sync(() =>
                  world.linked
                    ? Option.some({
                        environmentId: CLOUD,
                        label: "Acme Pair Cloud",
                        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
                      } as never)
                    : Option.none(),
                ),
              resolve: () =>
                world.linked
                  ? Effect.succeed({
                      link: { environmentId: CLOUD, label: "Acme Pair Cloud" },
                      url: "http://cloud.test",
                      token: "token",
                      capabilities: { cloudImport: true },
                    } as never)
                  : Effect.fail(new PeerLinkError({ reason: "unknown_link", message: "No link." })),
            }),
            Layer.mock(ContextExports.ContextExports)({
              build: () => Effect.succeed(contextExport),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                {
                  instanceId: ProviderInstanceId.make("codex"),
                  driver: ProviderDriverKind.make("codex"),
                },
              ] as never),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ providerInstances: {} } as never),
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
  shell: null,
  linked: true,
  checkRefusal: null,
  seedAnswers: [],
  launchAnswers: [],
  launchHold: null,
  launchStarted: null,
  uploadDelay: null,
  turnItems: [],
  routeCalls: [],
});

const moveInput = (commandId: string) => ({
  commandId: CommandId.make(commandId),
  source: { environmentId: CLOUD, threadId: ThreadId.make("thread-cloud") },
  projectId: PROJECT,
  modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

/** Real paths: git prints them resolved, and macOS's temp folder is behind a symlink. */
const worktreePaths = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* git(root, ["worktree", "list", "--porcelain"]);
    const paths = text
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    return { paths, root: yield* fs.realPath(root) };
  }).pipe(
    Effect.map(({ paths, root: real }) => paths.map((entry) => (entry === real ? root : entry))),
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

/**
 * Continue in cloud: origin with two commits on main and `.env` ignored; this project is a clone
 * on `feature`, two commits past origin/main, with an edit, two untracked files and a `.env`.
 */
const setupLocal = Effect.fn("CloudMovesTest.setupLocal")(function* (world: World) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-moves-out-" });
  const origin = path.join(dir, "origin");
  yield* fs.makeDirectory(origin);
  yield* git(origin, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(origin, "one.txt"), "one\n");
  yield* git(origin, ["add", "."]);
  yield* git(origin, ["commit", "--quiet", "-m", "one"]);
  yield* fs.writeFileString(path.join(origin, ".gitignore"), ".env\n");
  yield* git(origin, ["add", "."]);
  yield* git(origin, ["commit", "--quiet", "-m", "ignore"]);

  const root = path.join(dir, "local");
  yield* git(dir, ["clone", "--quiet", origin, root]);
  world.root = root;
  world.shell = {
    projectId: PROJECT,
    title: "Fix the login form",
    worktreePath: root,
    activeRunId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    deletedAt: null,
  };
  const commitOn = (name: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(root, `${name}.txt`), `${name}\n`);
      yield* git(root, ["add", "."]);
      yield* git(root, ["commit", "--quiet", "-m", name]);
    });
  const dirty = Effect.gen(function* () {
    yield* fs.writeFileString(path.join(root, "one.txt"), "changed\n");
    yield* fs.writeFileString(path.join(root, "new.txt"), "untracked\n");
    yield* fs.writeFileString(path.join(root, "secret.txt"), "leave me\n");
    yield* fs.writeFileString(path.join(root, ".env"), "TOKEN=1\n");
  });
  return { dir, origin, root, commitOn, dirty };
});

const toCloud = (overrides: Partial<CloudMoves.ContinueInCloudInput> = {}) =>
  Effect.flatMap(CloudMoves.CloudMoves, (moves) =>
    moves.continueInCloud({
      threadId: MOVED,
      cloudEnvironmentId: CLOUD,
      cloudProjectId: CLOUD_PROJECT,
      excludePaths: [],
      message: "Continue from where the conversation left off.",
      createdBy: "user",
      creationSource: "web",
      ...overrides,
    }),
  );

const expectedKey = (moves: number) =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const hash = yield* digest.digest(
      Digest.sha256,
      new TextEncoder().encode(`${LAPTOP}\0${MOVED}\0${moves}`),
    );
    return `mv_${Hex.encode(hash).slice(0, 32)}`;
  });

const kinds = (world: World) => world.routeCalls.map((call) => call.kind);
const seedsSent = (world: World) =>
  world.routeCalls.flatMap((call) => (call.kind === "putSeed" ? [call] : []));
const launchesSent = (world: World) =>
  world.routeCalls.flatMap((call) => (call.kind === "launch" ? [call] : []));

/** Fetches a sent bundle into a fresh clone of origin, as Pair Cloud's mirror would. */
const fetchSeed = (dir: string, origin: string, bundle: string, key: CloudStagingKey) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const mirror = path.join(dir, `mirror-${path.basename(bundle)}`);
    yield* git(dir, ["clone", "--quiet", origin, mirror]);
    yield* git(mirror, ["bundle", "verify", "--quiet", bundle]);
    yield* git(mirror, ["fetch", "--quiet", bundle, "refs/t3/staged/*:refs/t3/staged/*"]);
    const refs = cloudSeedRefs(key);
    return {
      mirror,
      heads: (yield* git(mirror, ["bundle", "list-heads", bundle]))
        .split("\n")
        .map((line) => line.split(" ")[1])
        .toSorted(),
      branch: yield* git(mirror, ["rev-parse", refs.branch]),
      snapshotParent: yield* git(mirror, ["rev-parse", `${refs.snapshot}^`]),
      files: (yield* git(mirror, ["ls-tree", "--name-only", refs.snapshot])).split("\n"),
      one: yield* git(mirror, ["show", `${refs.snapshot}:one.txt`]),
    };
  });

const noTempLeft = (root: string) =>
  Effect.gen(function* () {
    assert.equal(yield* git(root, ["for-each-ref", "refs/t3/staged/"]), "");
    const fs = yield* FileSystem.FileSystem;
    const seeds = `${(yield* ServerConfig.ServerConfig).stateDir}/cloud-move-seeds`;
    const left = (yield* fs.exists(seeds)) ? yield* fs.readDirectory(seeds) : [];
    assert.deepEqual(
      left.filter((name) => name.endsWith(".bundle")),
      [],
    );
  });

it.effect(
  "previews commits ahead of origin's base and changed files, and leaves out ignored ones",
  () => {
    const world = makeWorld();
    world.linked = false;
    return Effect.gen(function* () {
      const { root, commitOn, dirty } = yield* setupLocal(world);
      yield* git(root, ["switch", "--quiet", "-c", "feature"]);
      yield* commitOn("two");
      yield* commitOn("three");
      yield* dirty;
      const moves = yield* CloudMoves.CloudMoves;

      const preview = yield* moves.preview({ threadId: MOVED, cloudEnvironmentId: CLOUD });

      assert.deepEqual(
        {
          branch: preview.branch,
          baseRef: preview.baseRef,
          pushed: preview.pushed,
          commits: preview.commits.map((commit) => commit.subject),
          files: preview.files.map((file) => file.path).toSorted(),
          link: preview.link,
          moving: preview.moving,
        },
        {
          branch: "feature",
          baseRef: "main",
          pushed: false,
          commits: ["three", "two"],
          files: ["new.txt", "one.txt", "secret.txt"],
          link: { status: "missing", message: "Link Kim's MacBook Pro to Pair Cloud first." },
          moving: false,
        },
      );
      world.linked = true;
      assert.deepEqual(
        (yield* moves.preview({ threadId: MOVED, cloudEnvironmentId: CLOUD })).link,
        { status: "linked" },
      );
    }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
  },
);

it.effect("moves unpushed work as the two staged refs against the merge-base", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { dir, origin, root, commitOn, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* commitOn("two");
    yield* commitOn("three");
    yield* dirty;
    const head = yield* git(root, ["rev-parse", "HEAD"]);

    const result = yield* toCloud({ excludePaths: ["secret.txt"] });

    assert.deepEqual(result, {
      cloudThread: { environmentId: CLOUD, threadId: CLOUD_THREAD },
      seeded: true,
    });
    assert.deepEqual(kinds(world), ["check", "putSeed", "putContextExport", "launch"]);
    const key = yield* expectedKey(0);
    const [seed] = seedsSent(world);
    assert.equal(seed!.key, key);
    const fetched = yield* fetchSeed(dir, origin, seed!.copy, seed!.key);
    assert.deepEqual(fetched.heads, [
      cloudSeedRefs(seed!.key).branch,
      cloudSeedRefs(seed!.key).snapshot,
    ]);
    assert.equal(fetched.branch, head);
    assert.equal(fetched.snapshotParent, head);
    assert.include(fetched.files, "new.txt");
    assert.notInclude(fetched.files, "secret.txt");
    assert.notInclude(fetched.files, ".env");
    assert.equal(fetched.one, "changed");
    const [launch] = launchesSent(world);
    assert.deepEqual(
      [launch!.key, launch!.body.seeded, launch!.body.branch, launch!.body.existingBranch],
      [key, true, "feature", undefined],
    );
    assert.deepEqual(world.routeCalls[0], {
      kind: "check",
      body: {
        projectId: CLOUD_PROJECT,
        originKey: ORIGIN_KEY,
        model: { driver: ProviderDriverKind.make("codex"), model: "gpt-5" },
      },
    });
    assert.deepEqual(
      world.dispatched.map((command) =>
        command.type === "thread.move.record"
          ? [command.commandId, command.threadId, command.to, command.message]
          : null,
      ),
      [
        [
          `cloud-move:${key}:local`,
          MOVED,
          { environmentId: CLOUD, threadId: CLOUD_THREAD },
          "Continued in cloud on Acme Pair Cloud",
        ],
      ],
    );
    // The user's own checkout is as it was.
    assert.equal(yield* git(root, ["rev-parse", "HEAD"]), head);
    assert.equal(yield* git(root, ["diff", "--cached", "--name-only"]), "");
    yield* noTempLeft(root);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("a branch with no commits past the base keeps its branch ref", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { dir, origin, root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;

    yield* toCloud();

    const [seed] = seedsSent(world);
    const fetched = yield* fetchSeed(dir, origin, seed!.copy, seed!.key);
    assert.deepEqual(fetched.heads, [
      cloudSeedRefs(seed!.key).branch,
      cloudSeedRefs(seed!.key).snapshot,
    ]);
    assert.equal(fetched.branch, yield* git(root, ["rev-parse", "HEAD"]));
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("renames a seed on the base branch", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* dirty;

    yield* toCloud();
    const key = yield* expectedKey(0);
    assert.equal(launchesSent(world)[0]!.body.branch, `t3/${key.slice(3, 11)}`);

    // Clean and pushed on main: M2's fresh launch, with no branch.
    yield* git(root, ["checkout", "--quiet", "--", "one.txt"]);
    yield* toCloud({ excludePaths: ["new.txt", "secret.txt"] });
    const body = launchesSent(world)[1]!.body;
    assert.deepEqual(
      [body.seeded, body.branch, body.existingBranch],
      [false, undefined, undefined],
    );
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("launches a pushed, clean branch without a seed", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, commitOn, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* commitOn("two");
    yield* git(root, ["push", "--quiet", "-u", "origin", "feature"]);

    const clean = yield* toCloud();
    yield* dirty;
    const excluded = yield* toCloud({ excludePaths: ["one.txt", "new.txt", "secret.txt"] });

    assert.deepEqual([clean.seeded, excluded.seeded], [false, false]);
    assert.deepEqual(kinds(world), [
      "check",
      "putContextExport",
      "launch",
      "check",
      "putContextExport",
      "launch",
    ]);
    for (const { body } of launchesSent(world)) {
      assert.deepEqual([body.seeded, body.branch, body.existingBranch], [false, "feature", true]);
    }
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("resends full history on a missing prerequisite", () => {
  const world = makeWorld();
  world.seedAnswers.push("missing-prerequisite");
  return Effect.gen(function* () {
    const logs: Array<unknown> = [];
    const { dir, root, commitOn, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* commitOn("two");
    yield* dirty;

    yield* toCloud().pipe(
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => void logs.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    );

    const [first, second] = seedsSent(world);
    assert.equal(first!.key, second!.key);
    yield* git(dir, ["init", "--quiet", "empty"]);
    // With no prerequisites the bundle verifies in a repository with no commits.
    yield* git(`${dir}/empty`, ["bundle", "verify", "--quiet", second!.copy]);
    assert.isTrue(
      (yield* git(`${dir}/empty`, ["bundle", "verify", "--quiet", first!.copy], true)).startsWith(
        "1",
      ),
    );
    const fields = logs.flatMap((message) =>
      Array.isArray(message) && message[0] === "cloud move" ? [message[1]] : [],
    );
    assert.deepInclude(fields[0], {
      "cloudMove.fullHistory": true,
      "cloudMove.outcome": "launched",
    });
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("resends only the launch once a key is claimed", () => {
  const world = makeWorld();
  world.seedAnswers.push("claimed");
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;

    yield* toCloud();

    assert.deepEqual(kinds(world), ["check", "putSeed", "launch"]);
    assert.equal(world.dispatched.length, 1);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("falls back to a seed when origin lost the branch", () => {
  const world = makeWorld();
  world.launchAnswers.push("branch-not-pushed");
  return Effect.gen(function* () {
    const { root, commitOn } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* commitOn("two");
    yield* git(root, ["push", "--quiet", "-u", "origin", "feature"]);

    const result = yield* toCloud();

    assert.isTrue(result.seeded);
    assert.deepEqual(kinds(world), ["check", "putContextExport", "launch", "putSeed", "launch"]);
    assert.deepEqual(
      launchesSent(world).map(({ body }) => [body.seeded, body.branch, body.existingBranch]),
      [
        [false, "feature", true],
        [true, "feature", undefined],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("asks Pair Cloud before uploading anything", () => {
  const world = makeWorld();
  world.checkRefusal = "Add an account on Pair Cloud, on your row in Settings → Team.";
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;

    const refused = yield* toCloud().pipe(Effect.flip);

    assert.deepEqual(
      { reason: refused.reason, message: refused.message },
      { reason: "refused", message: world.checkRefusal },
    );
    assert.deepEqual(kinds(world), ["check"]);
    assert.deepEqual(world.dispatched, []);
    yield* noTempLeft(root);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("refuses a running thread, except the calling agent's own run", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;
    world.shell = { ...world.shell!, activeRunId: RunId.make("run-1") };

    const refused = yield* toCloud().pipe(Effect.flip);
    assert.deepEqual(
      { reason: refused.reason, message: refused.message },
      { reason: "run-active", message: "Wait for the turn to end, or stop it." },
    );
    assert.deepEqual(world.routeCalls, []);

    const moved = yield* toCloud({ allowRunId: RunId.make("run-1"), createdBy: "agent" });
    assert.isTrue(moved.seeded);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("a retry reuses its key and the next move gets a new one", () => {
  const world = makeWorld();
  world.launchAnswers.push(new ThreadMoveError({ reason: "refused", message: "Not now." }));
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;

    yield* toCloud().pipe(Effect.flip);
    yield* toCloud();
    yield* toCloud();

    const keys = launchesSent(world).map((call) => call.key);
    assert.deepEqual(keys, [yield* expectedKey(0), yield* expectedKey(0), yield* expectedKey(1)]);
    assert.notEqual(keys[1], keys[2]);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("a second call joins the move in flight", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;
    world.launchHold = yield* Deferred.make<void>();
    world.launchStarted = yield* Deferred.make<void>();
    const moves = yield* CloudMoves.CloudMoves;

    const first = yield* Effect.forkChild(toCloud());
    yield* Deferred.await(world.launchStarted);
    const second = yield* Effect.forkChild(toCloud({ excludePaths: ["one.txt"] }));
    assert.isTrue((yield* moves.preview({ threadId: MOVED, cloudEnvironmentId: CLOUD })).moving);
    yield* Deferred.succeed(world.launchHold, undefined);

    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(kinds(world), ["check", "putSeed", "putContextExport", "launch"]);
    assert.isFalse((yield* moves.preview({ threadId: MOVED, cloudEnvironmentId: CLOUD })).moving);
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});

it.effect("records seed size and upload time on the span", () => {
  const world = makeWorld();
  world.uploadDelay = "1500 millis";
  return Effect.gen(function* () {
    const logs: Array<unknown> = [];
    const { root, dirty } = yield* setupLocal(world);
    yield* git(root, ["switch", "--quiet", "-c", "feature"]);
    yield* dirty;

    yield* toCloud().pipe(
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => void logs.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    );

    const fields = logs.flatMap((message) =>
      Array.isArray(message) && message[0] === "cloud move" ? [message[1]] : [],
    );
    assert.deepInclude(fields[0], {
      "cloudMove.key": yield* expectedKey(0),
      "cloudMove.outcome": "launched",
      "cloudMove.seeded": true,
      "cloudMove.fullHistory": false,
      "cloudMove.seedBytes": seedsSent(world)[0]!.bytes,
      "cloudMove.exportBytes": 1234,
      "cloudMove.uploadMs": 1500,
    });
  }).pipe(Effect.scoped, Effect.provide(layerFor(world)));
});
