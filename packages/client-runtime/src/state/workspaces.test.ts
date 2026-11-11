import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultWorkspaceRepositoryName,
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
