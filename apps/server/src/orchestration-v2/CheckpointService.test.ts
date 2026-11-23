// @effect-diagnostics nodeBuiltinImport:off -- the loopback root is the test's temp folder.
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provide(WorkspaceHostTesting.layerFromContext),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect.each([
  { name: "a repository", roots: undefined },
  { name: "a workspace's repositories", roots: ["api", "web"] },
])(
  "captures a sandbox's baseline and turn of $name in its runner, not with the server's git",
  ({ roots }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-loopback-" });
      const repositories = roots ?? [""];
      const at = (root: string) => (root === "" ? cwd : `${cwd}/${root}`);
      for (const root of repositories) {
        const git = (...args: ReadonlyArray<string>) =>
          spawner.string(
            ChildProcess.make("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], {
              cwd: at(root),
            }),
          );
        yield* fs.makeDirectory(at(root), { recursive: true });
        yield* git("init");
        yield* fs.writeFileString(`${at(root)}/a.txt`, "one\n");
        yield* git("add", ".");
        yield* git("commit", "-m", "initial");
      }

      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:loopback"),
        threadId: ThreadId.make("thread:loopback"),
        runId: RunId.make("run:loopback:1"),
        nodeId: NodeId.make("node:loopback:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:loopback"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd,
        ...(roots === undefined ? {} : { roots }),
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const serverGit = () => Effect.die("a sandbox capture must not run the server's git");
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
        for (const root of repositories) {
          yield* fs.writeFileString(`${at(root)}/a.txt`, "one\ntwo\n");
        }
        const checkpoint = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        });
        assert.equal(checkpoint.status, "ready");
        assert.deepEqual(
          checkpoint.files,
          repositories.map((root) => ({
            path: root === "" ? "a.txt" : `${root}/a.txt`,
            kind: "modified",
            additions: 1,
            deletions: 0,
          })),
        );
      }).pipe(
        Effect.provide(
          CheckpointService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                IdAllocator.layer,
                NodeCrypto.layer,
                Layer.mock(CheckpointStore.CheckpointStore)({
                  isGitRepository: serverGit,
                  captureCheckpoint: serverGit,
                  hasCheckpointRef: serverGit,
                  listAuthoredPaths: serverGit,
                }),
              ),
            ),
            Layer.provide(WorkspaceHostLoopback.layerLoopback(NodeOS.tmpdir())),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a second snapshot of a sandbox checkout moves its ref to the newer tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-snapshot-" });
    const git = (...args: ReadonlyArray<string>) =>
      spawner.string(
        ChildProcess.make("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd }),
      );
    yield* git("init");
    yield* fs.writeFileString(`${cwd}/a.txt`, "one\n");
    yield* git("add", ".");
    yield* git("commit", "-m", "initial");
    const ref = CheckpointRef.make("refs/t3/sandbox/dGhyZWFk/snapshot");
    // A workspace folder whose `web` repository is missing from the disk.
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-workspace-" });
    yield* fs.makeDirectory(`${folder}/api`);
    yield* spawner.string(ChildProcess.make("git", ["init"], { cwd: `${folder}/api` }));
    yield* fs.writeFileString(`${folder}/api/a.txt`, "api\n");

    const snapshots = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* fs.writeFileString(`${cwd}/a.txt`, "one\ntwo\n");
      const first = yield* checkpoints.captureSnapshot({ cwd, ref });
      yield* fs.writeFileString(`${cwd}/b.txt`, "new\n");
      const second = yield* checkpoints.captureSnapshot({ cwd, ref });
      const workspace = yield* checkpoints.captureSnapshot({
        cwd: folder,
        roots: ["api", "web"],
        ref,
      });
      return [first.status, second.status, workspace];
    }).pipe(
      Effect.provide(
        CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              NodeCrypto.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({}),
            ),
          ),
          Layer.provide(WorkspaceHostLoopback.layerLoopback(NodeOS.tmpdir())),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );

    assert.deepEqual(snapshots, ["ready", "ready", { status: "ready", uncaptured: ["web"] }]);
    assert.equal(yield* git("show", `${ref}:a.txt`), "one\ntwo\n");
    assert.equal(yield* git("show", `${ref}:b.txt`), "new\n");
    assert.equal(
      (yield* git("rev-parse", `${ref}^`)).trim(),
      (yield* git("rev-parse", "HEAD")).trim(),
    );
    // The working tree and index are untouched: both edits are still uncommitted.
    assert.equal(yield* git("status", "--porcelain"), " M a.txt\n?? b.txt\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a lineage step's turn base keeps its files out of the next turn and out of Revert", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-turn-base-" });
    const git = (...args: ReadonlyArray<string>) =>
      spawner.string(
        ChildProcess.make("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd }),
      );
    yield* git("init");
    yield* fs.writeFileString(`${cwd}/turn.txt`, "one\n");
    yield* fs.writeFileString(`${cwd}/applied.txt`, "one\n");
    yield* git("add", ".");
    yield* git("commit", "-m", "initial");
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:turn-base"),
      threadId: ThreadId.make("thread:turn-base"),
      runId: RunId.make("run:turn-base:1"),
      nodeId: NodeId.make("node:turn-base:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:turn-base"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd,
      createdAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
    };
    const turn = (ordinalWithinScope: number) => ({
      scope,
      ordinalWithinScope,
      runId: RunId.make(`run:turn-base:${ordinalWithinScope}`),
      nodeId: scope.nodeId!,
      appRunOrdinal: ordinalWithinScope,
      capturedAt: scope.createdAt,
      turnBase: true,
    });
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      yield* fs.writeFileString(`${cwd}/turn.txt`, "one\nturn one\n");
      const first = yield* checkpoints.capture(turn(1));
      // An Apply between turns 1 and 2.
      yield* fs.writeFileString(`${cwd}/applied.txt`, "one\napplied\n");
      yield* checkpoints.captureTurnBase({ scope, ordinalWithinScope: 1 });
      yield* fs.writeFileString(`${cwd}/turn.txt`, "one\nturn one\nturn two\n");
      const second = yield* checkpoints.capture(turn(2));
      assert.deepEqual(
        second.files.map((file) => file.path),
        ["turn.txt"],
      );

      // Revert to turn 1, which was before the Apply, discards the applied file too.
      yield* checkpoints.restore({ scope, checkpoint: first });
      assert.equal(yield* fs.readFileString(`${cwd}/applied.txt`), "one\n");
      yield* checkpoints.deleteStaleRefs({ scope, checkpoints: [second] });
      const turnBase = yield* CheckpointService.turnBaseRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 1,
      });
      const left = yield* spawner.exitCode(
        ChildProcess.make("git", ["rev-parse", "--verify", "--quiet", turnBase], { cwd }),
      );
      assert.notEqual(left, 0);
      // Without a turn base, a turn diffs from the previous checkpoint as before.
      yield* fs.writeFileString(`${cwd}/applied.txt`, "one\napplied again\n");
      const third = yield* checkpoints.capture(turn(2));
      assert.deepEqual(
        third.files.map((file) => file.path),
        ["applied.txt"],
      );
    }).pipe(
      Effect.provide(
        CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              CheckpointStore.layer.pipe(
                Layer.provide(
                  VcsDriverRegistry.layer.pipe(
                    Layer.provide(VcsProcess.layer),
                    Layer.provide(ServerConfig.layerTest(cwd, { prefix: "t3-turn-base-" })),
                    Layer.provide(WorkspaceHostTesting.layerFromContext),
                  ),
                ),
              ),
            ),
          ),
          Layer.provide(WorkspaceHostTesting.layerFromContext),
          Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provide(WorkspaceHostTesting.layerFromContext),
      Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);
