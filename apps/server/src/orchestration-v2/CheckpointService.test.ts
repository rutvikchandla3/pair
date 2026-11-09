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
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect("captures a sandbox's baseline and turn in its runner, not with the server's git", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-loopback-" });
    const git = (...args: ReadonlyArray<string>) =>
      spawner.string(
        ChildProcess.make("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd }),
      );
    yield* git("init");
    yield* fs.writeFileString(`${cwd}/a.txt`, "one\n");
    yield* git("add", ".");
    yield* git("commit", "-m", "initial");

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
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const serverGit = () => Effect.die("a sandbox capture must not run the server's git");
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      yield* fs.writeFileString(`${cwd}/a.txt`, "one\ntwo\n");
      const checkpoint = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      assert.equal(checkpoint.status, "ready");
      assert.deepEqual(checkpoint.files, [
        { path: "a.txt", kind: "modified", additions: 1, deletions: 0 },
      ]);
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

    const snapshots = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* fs.writeFileString(`${cwd}/a.txt`, "one\ntwo\n");
      const first = yield* checkpoints.captureSnapshot({ cwd, ref });
      yield* fs.writeFileString(`${cwd}/b.txt`, "new\n");
      const second = yield* checkpoints.captureSnapshot({ cwd, ref });
      return [first, second];
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

    assert.deepEqual(snapshots, ["ready", "ready"]);
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
