import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2ThreadShell, SandboxId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as CloudPreparation from "./CloudPreparation.ts";

const source = SandboxId.make("sbx_00000000000000000001");
const fork = SandboxId.make("sbx_00000000000000000002");
const owner = ThreadId.make("thread:fork");

// Subprocess fixture: real git and sh on a temp folder that stands in for both machines' roots.
it.live(
  "adopts a copied disk into a fork root the new machine already wrote to, on the fork's branch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "machine-copy-" });
      const root = (id: SandboxId) => `${directory}/${id}`;
      const repo = `${root(source)}/repos/github.com/o/r`;
      const worktree = `${root(fork)}/worktrees/feat-pair`;
      const sh = (script: string) =>
        spawner.exitCode(ChildProcess.make("sh", ["-c", script], { cwd: directory }));
      const read = (path: string) => fs.readFileString(path).pipe(Effect.map((s) => s.trim()));
      // The source machine's checkout, and what the fork's machine wrote before it was adopted.
      assert.equal(
        yield* sh(`set -e
          mkdir -p "${repo}" "${root(source)}/homes/agent" "${root(fork)}/homes/agent"
          git -C "${repo}" init -q -b main
          git -C "${repo}" -c user.name=T -c user.email=t@t commit -q --allow-empty -m init
          git -C "${repo}" worktree add -q -b feat/pair "${root(source)}/worktrees/feat-pair"
          echo work > "${root(source)}/worktrees/feat-pair/uncommitted.txt"
          echo copied > "${root(source)}/homes/agent/history"
          echo stale > "${root(source)}/homes/agent/credentials"
          echo fresh > "${root(fork)}/homes/agent/credentials"`),
        0,
      );

      yield* CloudPreparation.adoptMachineCopy({
        id: fork,
        copyOf: source,
        ownerThreadId: owner,
      }).pipe(
        Effect.provideService(CloudPreparation.SandboxCheckoutRoot, root),
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({
                worktreePath: worktree,
                branch: "feat/pair-fork",
              } as OrchestrationV2ThreadShell),
          }),
        ),
      );

      assert.isFalse(yield* fs.exists(root(source)));
      assert.equal(yield* read(`${worktree}/uncommitted.txt`), "work");
      assert.equal(yield* read(`${root(fork)}/homes/agent/credentials`), "fresh");
      assert.equal(yield* read(`${root(fork)}/homes/agent/history`), "copied");
      // Both directions of git's worktree link point into the fork's root.
      assert.equal(
        yield* sh(`set -e
          test "$(git -C "${worktree}" rev-parse --abbrev-ref HEAD)" = feat/pair-fork
          test "$(cat "${root(fork)}/repos/github.com/o/r/.git/worktrees/feat-pair/gitdir")" = "${worktree}/.git"
          git -C "${root(fork)}/repos/github.com/o/r" worktree list --porcelain | grep -q "^worktree ${worktree}$"`),
        0,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.effect(
          WorkspaceHosts.WorkspaceHosts,
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const host = { spawner } as unknown as WorkspaceHost;
            return WorkspaceHosts.WorkspaceHosts.of({
              local: host,
              forPath: () => Effect.succeed(host),
              register: () => Effect.void,
            });
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
