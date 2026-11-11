import { ProjectId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultWorkspaceRepositoryName,
  describeWorkspaceGitActionOutcome,
  planWorkspaceGitActions,
  resolveSelectedRepository,
  runWorkspaceGitActions,
  threadRepositories,
  workspaceRepositoriesProblem,
} from "./workspaces.ts";

const api = ProjectId.make("api");
const web = ProjectId.make("web");

describe("defaultWorkspaceRepositoryName", () => {
  it.each([
    ["/code/api/", "api"],
    ["C:\\code\\Web", "Web"],
    ["/code/My App (v2)", "My-App-v2"],
    ["/code/###", "repository"],
  ])("names %s %s", (workspaceRoot, expected) => {
    expect(defaultWorkspaceRepositoryName(workspaceRoot)).toBe(expected);
  });
});

describe("workspaceRepositoriesProblem", () => {
  const repository = (name: string, title = name) => ({ name, title });

  it.each([
    ["too few repositories", [repository("api")], "A workspace needs 2 to 8 repositories (got 1)."],
    [
      "too many repositories",
      Array.from({ length: 9 }, (_, index) => repository(`r${index}`)),
      "A workspace needs 2 to 8 repositories (got 9).",
    ],
    [
      "a folder name with a slash",
      [repository("api"), repository("web/app", "Web")],
      'Folder name "web/app" for "Web" may use only letters, digits, ".", "_" and "-".',
    ],
    [
      "a parent folder name",
      [repository("api"), repository("..", "Web")],
      'Folder name ".." for "Web" may use only letters, digits, ".", "_" and "-".',
    ],
    [
      "folder names that differ only in case",
      [repository("api"), repository("API", "Other")],
      'Two repositories use the folder name "API".',
    ],
    ["valid names, trimmed", [repository(" api "), repository("web.app_2")], null],
  ] as const)("reports %s", (_name, repositories, expected) => {
    expect(workspaceRepositoriesProblem(repositories)).toBe(expected);
  });
});

describe("threadRepositories", () => {
  const workspace = {
    title: "Stack",
    workspaceRoot: "/t3/workspaces/stack",
    roots: [
      { projectId: api, name: "api" },
      { projectId: web, name: "web" },
    ],
  };

  it("places a workspace thread's repositories inside its own folder", () => {
    expect(
      threadRepositories(
        {
          projectId: ProjectId.make("stack"),
          worktreePath: "/t3/worktrees/stack/thread-1",
          roots: workspace.roots,
        },
        workspace,
      ),
    ).toEqual([
      { name: "api", cwd: "/t3/worktrees/stack/thread-1/api", projectId: api },
      { name: "web", cwd: "/t3/worktrees/stack/thread-1/web", projectId: web },
    ]);
  });

  it("has none before a workspace thread's folder exists", () => {
    const projectId = ProjectId.make("stack");
    expect(
      threadRepositories({ projectId, worktreePath: null, roots: workspace.roots }, workspace),
    ).toEqual([]);
    expect(threadRepositories({ projectId, worktreePath: null }, workspace)).toEqual([]);
  });

  it("gives any other thread its own checkout", () => {
    const project = { title: "API", workspaceRoot: "/code/api" };
    expect(threadRepositories({ projectId: api, worktreePath: null }, project)).toEqual([
      { name: "API", cwd: "/code/api", projectId: api },
    ]);
    expect(
      threadRepositories({ projectId: api, worktreePath: "/t3/worktrees/api/t" }, project),
    ).toEqual([{ name: "API", cwd: "/t3/worktrees/api/t", projectId: api }]);
  });
});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as VcsStatusResult;
}

const dirty = status({
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 3, deletions: 1 },
});

describe("resolveSelectedRepository", () => {
  const repositories = [{ name: "api" }, { name: "web" }, { name: "docs" }];

  it.each([
    ["the chosen repository", [dirty, null, null], "docs", "docs"],
    ["the first with changes when the choice is gone", [status(), dirty, dirty], "gone", "web"],
    ["the first with changes", [status(), status({ aheadCount: 2 }), dirty], null, "web"],
    [
      "committed branch changes",
      [status(), null, status({ branchChanges: { baseRef: "main", insertions: 1, deletions: 0 } })],
      null,
      "docs",
    ],
    ["the first while statuses load", [null, null, null], null, "api"],
    ["the first when nothing changed", [status(), status(), status()], null, "api"],
  ] as const)("picks %s", (_name, statuses, chosen, expected) => {
    expect(resolveSelectedRepository(repositories, statuses, chosen)?.name).toBe(expected);
  });

  it("selects nothing before the thread's folder exists", () => {
    expect(resolveSelectedRepository([], [], "api")).toBeNull();
  });
});

const openPullRequest = {
  number: 7,
  title: "Add search",
  url: "https://github.com/acme/ui/pull/7",
  baseRef: "main",
  headRef: "feature",
  state: "open",
} as VcsStatusResult["pr"];

describe("workspace git actions", () => {
  const repo = (name: string) => ({ name });
  const plan = planWorkspaceGitActions([
    { repository: repo("api"), status: dirty },
    { repository: repo("web"), status: status() },
    { repository: repo("docs"), status: status({ aheadCount: 1 }) },
    { repository: repo("main"), status: { ...dirty, isDefaultRef: true } },
    { repository: repo("ui"), status: { ...dirty, pr: openPullRequest } },
    { repository: repo("old"), status: status({ aheadCount: 1, behindCount: 2 }) },
    { repository: repo("slow"), status: null },
  ]);

  it("runs each repository's own action in order and says why others are skipped", () => {
    expect(plan.steps.map((step) => [step.repository.name, step.action])).toEqual([
      ["api", "commit_push_pr"],
      ["docs", "create_pr"],
      ["ui", "commit_push"],
    ]);
    expect(plan.skipped.map((skip) => [skip.repository.name, skip.reason])).toEqual([
      ["web", "No changes."],
      ["main", "On its default branch."],
      ["old", "Branch has diverged from upstream. Rebase/merge first."],
      ["slow", "Status isn't loaded yet."],
    ]);
  });

  it("stops at the first failure and reports what finished and what never ran", async () => {
    const started: string[] = [];
    const outcome = await runWorkspaceGitActions({
      plan,
      onStart: (step, index, total) =>
        started.push(`${step.repository.name} ${index + 1}/${total}`),
      run: async (step) =>
        step.repository.name === "docs" ? { ok: false, error: "Push rejected." } : { ok: true },
    });
    expect(started).toEqual(["api 1/3", "docs 2/3"]);
    expect(outcome.finished.map((step) => step.repository.name)).toEqual(["api"]);
    expect(outcome.failed).toMatchObject({ repository: { name: "docs" }, error: "Push rejected." });
    expect(outcome.notRun.map((step) => step.repository.name)).toEqual(["ui"]);
    expect(describeWorkspaceGitActionOutcome(outcome)).toEqual({
      title: "Stopped at docs",
      description: [
        "docs: Push rejected.",
        "Done: api.",
        "Not run: ui.",
        "Skipped web: No changes.",
        "Skipped main: On its default branch.",
        "Skipped old: Branch has diverged from upstream. Rebase/merge first.",
        "Skipped slow: Status isn't loaded yet.",
      ].join("\n"),
      failed: true,
    });
  });

  it("treats a thrown run as that repository's failure", async () => {
    const outcome = await runWorkspaceGitActions({
      plan: { steps: [{ repository: repo("api"), action: "commit" }], skipped: [] },
      run: () => Promise.reject(new Error("Socket closed.")),
    });
    expect(outcome.failed?.error).toBe("Socket closed.");
    expect(describeWorkspaceGitActionOutcome(outcome).title).toBe("Stopped at api");
  });

  it("reports every repository when all finish", async () => {
    const outcome = await runWorkspaceGitActions({ plan, run: async () => ({ ok: true }) });
    expect(describeWorkspaceGitActionOutcome(outcome)).toMatchObject({
      title: "Ran on 3 repositories",
      failed: false,
    });
    expect(outcome.notRun).toEqual([]);
  });
});
