import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ProjectId,
} from "@t3tools/contracts";
import type { VcsListRefsResult } from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  branch: "main",
  worktrees: [] as string[],
  thread: {
    id: "thread",
    environmentId: "environment",
    branch: "main",
    worktreePath: null as string | null,
  },
  commits: 0,
  pushes: 0,
  metadataRequests: [] as { environmentId: string; branch: string }[],
  results: [] as { type: string; description?: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  statusRefreshes: 0,
  readRefs: vi.fn(),
  cachedRefs: [] as VcsListRefsResult["refs"],
  repositories: null as readonly unknown[] | null,
  mounted: [] as unknown[],
  branchCwds: [] as (string | null)[],
  gitCwds: [] as string[],
  stackedInputs: [] as { cwd: string | null; action: string; threadId?: string }[],
  statuses: {} as Record<string, unknown>,
  registry: null as AtomRegistry.AtomRegistry | null,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomMount: (atom: unknown) => state.mounted.push(atom),
  useAtomValue: (atom: never) => state.registry!.get(atom),
}));
vi.mock("@t3tools/client-runtime/state/vcs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // The status revalidation atom is its target here, so a test can read what it would refresh.
  createVcsStatusRevalidationAtomFamily: () => (target: unknown) => target,
}));
vi.mock("./session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadProject: { workspaceRoot: "/repo" },
  }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
  useSelectedThreadRepositories: () => state.repositories,
}));
vi.mock("./queries", () => ({
  useBranches: ({ cwd }: { cwd: string | null }) => {
    state.branchCwds.push(cwd);
    return { data: { refs: state.cachedRefs }, refresh: () => {} };
  },
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  state.registry = AtomRegistry.make();
  return { appAtomRegistry: state.registry };
});
vi.mock("./entities", () => ({
  useProject: (ref: { projectId: string } | null) =>
    ref === null ? null : { id: ref.projectId, workspaceRoot: `/projects/${ref.projectId}` },
}));
vi.mock("./use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => null,
  setPendingConnectionError: () => {},
}));
vi.mock("./use-vcs-action-state", () => ({
  showGitActionResult: (result: { type: string; description?: string }) =>
    state.results.push(result),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "action" }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { branch: string; worktreePath: string | null };
    }) => {
      state.metadataRequests.push({ environmentId, branch: input.branch });
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(Cause.fail(new Error("Task operation denied")));
      }
      Object.assign(state.thread, input);
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("./vcs", async () => {
  const { Atom } = await import("effect/reactivity");
  const runStackedAction =
    (target: { cwd: string | null }) =>
    async (input: { action: string; featureBranch?: boolean; threadId?: string }) => {
      state.stackedInputs.push({ cwd: target.cwd, action: input.action, threadId: input.threadId });
      if (input.featureBranch) state.branch = "feature";
      if (input.action === "commit") state.commits += 1;
      if (input.action === "push") state.pushes += 1;
      state.afterGitAction?.();
      return AsyncResult.success({
        branch: input.featureBranch
          ? { status: "created", name: "feature" }
          : { status: "skipped_not_requested" },
        toast: { title: "Done", description: "Done", cta: { kind: "none" } },
      });
    };
  return {
    vcsEnvironment: {
      statuses: ({ cwds }: { cwds: ReadonlyArray<string> }) =>
        Atom.make(cwds.map((cwd) => state.statuses[cwd] ?? null)),
      readRefs: state.readRefs,
      refreshStatus: async ({ input }: { input: { cwd: string } }) => {
        state.gitCwds.push(input.cwd);
        state.statusRefreshes += 1;
        return AsyncResult.success({ refName: state.branch });
      },
      switchRef: async ({ input }: { input: { cwd: string; refName: string } }) => {
        state.gitCwds.push(input.cwd);
        state.branch = input.refName;
        state.afterGitAction?.();
        return AsyncResult.success({ refName: state.branch });
      },
      createRef: async ({ input }: { input: { refName: string } }) => {
        state.branch = input.refName;
        state.afterGitAction?.();
        return AsyncResult.success({ refName: state.branch });
      },
      createWorktree: async ({ input }: { input: { newRefName: string } }) => {
        state.worktrees.push("/repo-worktree");
        state.afterGitAction?.();
        return AsyncResult.success({
          worktree: { path: "/repo-worktree", refName: input.newRefName },
        });
      },
      pull: async () => AsyncResult.success({ status: "pulled", refName: state.branch }),
    },
    vcsActionManager: {
      track: (_registry: unknown, _target: unknown, _operation: unknown, run: () => unknown) =>
        run(),
      // The hook calls the command directly; runAtomCommand calls its `run`.
      runStackedAction: (target: { cwd: string | null }) =>
        Object.assign(runStackedAction(target), {
          run: (_registry: unknown, input: Parameters<ReturnType<typeof runStackedAction>>[0]) =>
            runStackedAction(target)(input),
        }),
    },
  };
});

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";
import { selectWorkspaceRepository } from "./use-selected-thread-workspace";

describe("thread Git mutation permissions", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.branch = "main";
    state.worktrees = [];
    state.thread.branch = "main";
    state.thread.worktreePath = null;
    state.commits = 0;
    state.pushes = 0;
    state.metadataRequests = [];
    state.results = [];
    state.afterGitAction = undefined;
    state.statusRefreshes = 0;
  });

  it.each([false, true])(
    "requires task permission before creating and attaching a worktree: %s",
    async (canOperate) => {
      if (canOperate) state.scopes.add(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      const result = await actions.onCreateSelectedThreadWorktree({
        baseBranch: "main",
        newBranch: "feature/task",
      });
      expect(result).toEqual(
        canOperate ? { worktree: { path: "/repo-worktree", refName: "feature/task" } } : null,
      );
      expect(state.worktrees).toEqual(canOperate ? ["/repo-worktree"] : []);
      expect(state.thread.worktreePath).toBe(canOperate ? "/repo-worktree" : null);
      expect(state.thread.branch).toBe(canOperate ? "feature/task" : "main");
    },
  );

  it("keeps ordinary commits and pushes available without task permission", async () => {
    const actions = useSelectedThreadGitActions();
    await actions.onRunSelectedThreadGitAction({ action: "commit" });
    await actions.onRunSelectedThreadGitAction({ action: "push" });
    expect(state.commits).toBe(1);
    expect(state.pushes).toBe(1);
    expect(state.thread.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });

  it.each(["create", "checkout", "worktree", "commit"] as const)(
    "does not send thread metadata after task permission is revoked during %s",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      if (operation === "create")
        expect(await actions.onCreateSelectedThreadBranch("feature")).toBeNull();
      if (operation === "checkout")
        expect(await actions.onCheckoutSelectedThreadBranch("feature")).toBeNull();
      if (operation === "worktree")
        expect(
          await actions.onCreateSelectedThreadWorktree({
            baseBranch: "main",
            newBranch: "feature",
          }),
        ).toBeNull();
      if (operation === "commit")
        expect(
          await actions.onRunSelectedThreadGitAction({ action: "commit", featureBranch: true }),
        ).toBeNull();
      if (operation === "worktree") expect(state.worktrees).toEqual(["/repo-worktree"]);
      else expect(state.branch).toBe("feature");
      expect(state.thread.branch).toBe("main");
      expect(state.thread.worktreePath).toBeNull();
      expect(state.metadataRequests).toEqual([]);
      expect(state.results.map((result) => result.type)).toEqual(["error"]);
    },
  );

  it("refreshes the worktree status when the metadata update is denied after checkout", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
    expect(
      await useSelectedThreadGitActions().onCheckoutSelectedThreadBranch("feature"),
    ).toBeNull();
    expect(state.branch).toBe("feature");
    expect(state.statusRefreshes).toBe(1);
  });

  it.each(["create", "checkout", "worktree"] as const)(
    "returns the accepted %s result when only source-control permission is revoked after Git",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthSourceControlWriteScope);
      const actions = useSelectedThreadGitActions();
      const result =
        operation === "create"
          ? await actions.onCreateSelectedThreadBranch("feature/task")
          : operation === "checkout"
            ? await actions.onCheckoutSelectedThreadBranch("feature/task")
            : await actions.onCreateSelectedThreadWorktree({
                baseBranch: "main",
                newBranch: "feature/task",
              });
      expect(result).toEqual(
        operation === "worktree"
          ? { worktree: { path: "/repo-worktree", refName: "feature/task" } }
          : { refName: "feature/task" },
      );
      expect(state.thread.branch).toBe("feature/task");
      expect(state.metadataRequests).toHaveLength(1);
      expect(state.results).toEqual([]);
    },
  );
});

describe("automatic feature branch refs", () => {
  const empty: VcsListRefsResult = {
    refs: [],
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: 0,
  };

  it.each([false, true])("awaits fresh refs before naming, cached: %s", async (cached) => {
    const request = Promise.withResolvers<VcsListRefsResult>();
    state.cachedRefs = cached
      ? [
          {
            name: "old-branch",
            isRemote: false,
            current: false,
            isDefault: false,
            worktreePath: null,
          },
        ]
      : [];
    state.readRefs.mockReturnValue(request.promise.then(AsyncResult.success));
    let settled = false;
    const refresh = useSelectedThreadGitActions()
      .refreshSelectedThreadBranches()
      .then((refs) => {
        settled = true;
        return refs;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    const local = {
      name: "feature/update",
      isRemote: false,
      current: false,
      isDefault: false,
      worktreePath: null,
    };
    request.resolve({
      ...empty,
      refs: [
        local,
        { ...local, name: "origin/feature/update", isRemote: true, remoteName: "origin" },
      ],
      totalCount: 2,
    });
    const refs = await refresh;
    expect(refs).toEqual([local]);
    expect(resolveAutoFeatureBranchName(refs!.map((ref) => ref.name))).toBe("feature/update-2");
    expect(state.readRefs).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/repo", limit: 100, refresh: true },
    });
  });

  it("reports lookup failure instead of returning empty refs", async () => {
    state.results = [];
    state.readRefs.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Cannot list refs"))),
    );
    expect(await useSelectedThreadGitActions().refreshSelectedThreadBranches()).toBeNull();
    expect(state.results).toEqual([
      { type: "error", title: "Git action failed", description: "Cannot list refs" },
    ]);
  });
});

describe("workspace threads", () => {
  // Each case gets its own thread, since a stored repository choice outlives the hook.
  let threadCount = 0;
  const repositories = [
    { name: "api", cwd: "/workspace/api", projectId: ProjectId.make("api") },
    { name: "web", cwd: "/workspace/web", projectId: ProjectId.make("web") },
  ];
  const changed = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 2, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };

  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.commits = 0;
    state.statusRefreshes = 0;
    state.readRefs.mockReset();
    state.readRefs.mockImplementation(async ({ input }: { input: { cwd: string } }) => {
      state.gitCwds.push(input.cwd);
      return AsyncResult.success({ refs: [] });
    });
    state.mounted = [];
    state.branchCwds = [];
    state.gitCwds = [];
    state.stackedInputs = [];
    state.metadataRequests = [];
    state.results = [];
    state.afterGitAction = undefined;
    state.statuses = { "/workspace/web": changed };
    state.thread.id = `thread-${(threadCount += 1)}`;
  });

  it.each([
    ["one repository", null, { environmentId: "environment", cwd: "/repo" }, "/repo"],
    ["a workspace", [], null, null],
  ] as const)(
    "runs git in the thread's folder only for %s",
    async (_, repositories, revalidated, branchCwd) => {
      state.repositories = repositories;
      try {
        const actions = useSelectedThreadGitActions();
        expect(state.mounted).toEqual([revalidated]);
        expect(state.branchCwds).toEqual([branchCwd]);
        if (repositories === null) return;
        expect(await actions.refreshSelectedThreadGitStatus()).toBeNull();
        expect(await actions.refreshSelectedThreadBranches()).toBeNull();
        expect(await actions.onRunSelectedThreadGitAction({ action: "commit" })).toBeNull();
        expect(state.statusRefreshes).toBe(0);
        expect(state.readRefs).not.toHaveBeenCalled();
        expect(state.commits).toBe(0);
      } finally {
        state.repositories = null;
      }
    },
  );

  it.each([
    ["the first changed repository", null, "/workspace/web"],
    ["the stored choice", "api", "/workspace/api"],
  ] as const)("runs git in %s once the folder exists", async (_, chosen, cwd) => {
    state.repositories = repositories;
    try {
      if (chosen !== null) {
        selectWorkspaceRepository(useSelectedThreadGitActions().workspace!.threadKey, chosen);
        state.mounted = [];
        state.branchCwds = [];
      }
      const actions = useSelectedThreadGitActions();
      expect(actions.gitCwd).toBe(cwd);
      expect(state.mounted).toEqual([{ environmentId: "environment", cwd }]);
      expect(state.branchCwds).toEqual([cwd]);
      await actions.refreshSelectedThreadGitStatus();
      await actions.refreshSelectedThreadBranches();
      await actions.onRunSelectedThreadGitAction({ action: "commit" });
      expect(await actions.onCheckoutSelectedThreadBranch("other")).toEqual({ refName: "other" });
      expect(state.gitCwds.every((gitCwd) => gitCwd === cwd)).toBe(true);
      expect(state.gitCwds.length).toBeGreaterThan(0);
      expect(state.stackedInputs.map((input) => input.cwd)).toEqual([cwd]);
      expect(state.metadataRequests).toEqual([]);
    } finally {
      state.repositories = null;
    }
  });

  it("runs every changed repository's next step with the thread id", async () => {
    state.repositories = repositories;
    state.statuses = { "/workspace/api": changed, "/workspace/web": changed };
    try {
      const actions = useSelectedThreadGitActions();
      const plan = {
        steps: repositories.map((repository) => ({ repository, action: "commit_push" as const })),
        skipped: [],
      };
      await actions.onRunWorkspaceGitActions({ plan, commitMessage: "Ship it" });
      expect(state.stackedInputs).toEqual([
        { cwd: "/workspace/api", action: "commit_push", threadId: state.thread.id },
        { cwd: "/workspace/web", action: "commit_push", threadId: state.thread.id },
      ]);
      expect(state.results.map((result) => result.type)).toEqual(["success"]);
    } finally {
      state.repositories = null;
    }
  });
});
