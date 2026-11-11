import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { GitCommandError, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as WorkspaceCheckouts from "./WorkspaceCheckouts.ts";

const roots = ["api", "web", "docs"].map((name) => ({
  projectId: ProjectId.make(`project:${name}`),
  name,
}));

const layerFor = (input: {
  readonly worktreesDir: string;
  readonly git: ReturnType<typeof fakeGit>;
}) =>
  WorkspaceCheckouts.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          defaultBranch: () => Effect.succeed("main"),
          currentBranch: () => Effect.succeed("main"),
          hasCommit: (check) => Effect.succeed(check.refName === "refs/heads/main"),
          createWorktree: input.git.createWorktree,
          removeWorktree: input.git.removeWorktree,
          deleteLocalBranch: input.git.deleteLocalBranch,
          pruneWorktrees: () => Effect.void,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => {
            const name = id.replace("project:", "");
            return Effect.succeedSome({
              id,
              title: name.toUpperCase(),
              workspaceRoot: `/repos/${name}`,
              deletedAt: null,
            } as never);
          },
        }),
        Layer.succeed(ServerConfig.ServerConfig, {
          worktreesDir: input.worktreesDir,
        } as ServerConfig.ServerConfig["Service"]),
        ServerSettings.layerTest(),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

// Claims and creates each worktree's folder as git would; fails in the repository named `failIn`.
function fakeGit(fileSystem: FileSystem.FileSystem, failIn?: string) {
  return {
    createWorktree: vi.fn(
      (
        request: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0],
        options?: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[1],
      ) =>
        request.cwd === `/repos/${failIn}`
          ? Effect.fail(
              new GitCommandError({
                operation: "createWorktree",
                command: "git worktree add",
                cwd: request.cwd,
                detail: "fatal: invalid reference",
              }),
            )
          : (options?.progress?.onWorktreeClaimed?.(request.path!) ?? Effect.void).pipe(
              Effect.andThen(fileSystem.makeDirectory(request.path!)),
              Effect.as({
                worktree: { path: request.path!, refName: request.newRefName! },
              } as never),
              Effect.orDie,
            ),
    ),
    removeWorktree: vi.fn(
      (request: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
        fileSystem.remove(request.path, { recursive: true }).pipe(Effect.orDie),
    ),
    deleteLocalBranch: vi.fn(
      (_request: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
        Effect.void,
    ),
  };
}

it.effect("creates one worktree per root on one branch, then removes them all", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
    const git = fakeGit(fileSystem);
    yield* Effect.gen(function* () {
      const checkouts = yield* WorkspaceCheckouts.WorkspaceCheckouts;
      const checkout = yield* checkouts.create({
        workspaceRoot: "/managed/workspaces/stack",
        roots,
        branch: "feature/login",
        startFromOrigin: false,
      });
      const folder = path.join(worktreesDir, "stack", "feature-login");
      assert.deepEqual(checkout, { folder, branch: "feature/login" });
      assert.deepEqual(
        git.createWorktree.mock.calls.map(([request]) => [
          request.cwd,
          request.path,
          request.newRefName,
        ]),
        roots.map((root) => [`/repos/${root.name}`, path.join(folder, root.name), "feature/login"]),
      );
      const guidance = yield* fileSystem.readFileString(path.join(folder, "AGENTS.md"));
      assert.include(guidance, "- `web/`: WEB");
      assert.equal(yield* fileSystem.readFileString(path.join(folder, "CLAUDE.md")), guidance);

      // Restoring the guidance writes a missing file and keeps one the agent or user changed.
      yield* fileSystem.writeFileString(path.join(folder, "AGENTS.md"), "edited");
      yield* fileSystem.remove(path.join(folder, "CLAUDE.md"));
      yield* checkouts.writeGuidance({ folder, roots });
      assert.equal(yield* fileSystem.readFileString(path.join(folder, "AGENTS.md")), "edited");
      assert.equal(yield* fileSystem.readFileString(path.join(folder, "CLAUDE.md")), guidance);

      yield* checkouts.remove({ folder, roots, branch: "feature/login" });
      assert.deepEqual(
        git.deleteLocalBranch.mock.calls.map(([request]) => [request.cwd, request.refName]),
        roots.map((root) => [`/repos/${root.name}`, "feature/login"]),
      );
      assert.isFalse(yield* fileSystem.exists(folder));
    }).pipe(Effect.provide(layerFor({ worktreesDir, git })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("removes the roots it created when a later root fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
    const git = fakeGit(fileSystem, "docs");
    yield* Effect.gen(function* () {
      const checkouts = yield* WorkspaceCheckouts.WorkspaceCheckouts;
      const error = yield* checkouts
        .create({
          workspaceRoot: "/managed/workspaces/stack",
          roots,
          branch: "feature",
          startFromOrigin: false,
        })
        .pipe(Effect.flip);
      assert.equal(error.operation, "create");
      const folder = path.join(worktreesDir, "stack", "feature");
      assert.deepEqual(
        git.removeWorktree.mock.calls.map(([request]) => request.path),
        [path.join(folder, "api"), path.join(folder, "web")],
      );
      assert.deepEqual(
        git.deleteLocalBranch.mock.calls.map(([request]) => [request.cwd, request.refName]),
        [
          ["/repos/api", "feature"],
          ["/repos/web", "feature"],
        ],
      );
      assert.isFalse(yield* fileSystem.exists(folder));
    }).pipe(Effect.provide(layerFor({ worktreesDir, git })));
  }).pipe(Effect.provide(NodeServices.layer)),
);
