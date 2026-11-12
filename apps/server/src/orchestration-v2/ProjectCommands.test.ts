import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("keeps the first pin and archive time, and clears both on undo", () => {
    const earlier = "2025-12-01T00:00:00.000Z";
    const update = (project: ProjectRow, change: { pinned?: boolean; archived?: boolean }) =>
      payloadOf(
        plan(
          {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-organize"),
            projectId,
            ...change,
          },
          { project },
        ),
      );
    assert.deepInclude(update(row(), { pinned: true, archived: true }), {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const organized = row({ pinnedAt: earlier, archivedAt: earlier });
    assert.deepInclude(update(organized, { pinned: true, archived: true }), {
      pinnedAt: earlier,
      archivedAt: earlier,
    });
    assert.deepInclude(update(organized, { pinned: false, archived: false }), {
      pinnedAt: null,
      archivedAt: null,
    });
    const untouched = update(organized, {});
    assert.notProperty(untouched, "pinnedAt");
    assert.notProperty(untouched, "archivedAt");
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("names a workspace's repositories and refuses the roots v1 cannot run", () => {
    const repo = (id: string, workspaceRoot: string, overrides: Partial<ProjectRow> = {}) =>
      row({ projectId: ProjectId.make(id), title: id, workspaceRoot, ...overrides });
    const rootProjects = [
      repo("api", "/code/api"),
      repo("web", "C:\\code\\Web"),
      repo("web-copy", "/other/web"),
      repo("spaced", "/code/My App (v2)"),
      repo("spaced-copy", "/other/My App  v2"),
      repo("symbols", "/code/###"),
      repo("checkout", "/data/checkouts/checkout", { title: "shop-api" }),
      repo("gone", "/code/gone", { deletedAt: "2026-01-01T00:00:00.000Z" }),
      repo("nested", "/managed/nested", {
        roots: [{ projectId: ProjectId.make("api"), name: "api" }],
      }),
    ];
    const workspaceId = ProjectId.make("workspace");
    const create = (roots: ReadonlyArray<{ projectId: string; name?: string }>) =>
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-workspace"),
          projectId: workspaceId,
          title: "Workspace",
          workspaceRoot: "/managed/workspace",
          roots: roots.map((root) => ({ ...root, projectId: ProjectId.make(root.projectId) })),
        },
        { rootProjects },
      );
    assert.deepEqual(payloadOf(create([{ projectId: "api" }, { projectId: "web" }])).roots, [
      { projectId: "api", name: "api" },
      { projectId: "web", name: "Web" },
    ]);
    // A Pair Cloud checkout's folder is its project id, so the title names it.
    assert.deepEqual(payloadOf(create([{ projectId: "api" }, { projectId: "checkout" }])).roots, [
      { projectId: "api", name: "api" },
      { projectId: "checkout", name: "shop-api" },
    ]);
    assert.deepEqual(payloadOf(create([{ projectId: "spaced" }, { projectId: "symbols" }])).roots, [
      { projectId: "spaced", name: "My-App-v2" },
      { projectId: "symbols", name: "repository" },
    ]);
    for (const [roots, detail] of [
      [[{ projectId: "api" }], "needs 2 to 8"],
      [Array.from({ length: 9 }, (_, index) => ({ projectId: `p${index}` })), "needs 2 to 8"],
      [[{ projectId: "api" }, { projectId: "workspace" }], "cannot contain itself"],
      [[{ projectId: "api" }, { projectId: "api", name: "api2" }], "only once"],
      [[{ projectId: "api" }, { projectId: "gone" }], "was not found"],
      [[{ projectId: "api" }, { projectId: "nested" }], "is a workspace"],
      [[{ projectId: "api" }, { projectId: "web", name: "my web" }], "may use only"],
      [[{ projectId: "api" }, { projectId: "web", name: ".." }], "may use only"],
      [[{ projectId: "web" }, { projectId: "web-copy" }], "folder name"],
      [[{ projectId: "spaced" }, { projectId: "spaced-copy" }], 'folder name "My-App-v2"'],
    ] as const) {
      const failure = failureOf(create(roots));
      assert.equal(failure._tag, "ProjectRootsInvalidError");
      assert.include(failure.message, detail);
    }

    const workspace = repo("workspace", "/managed/workspace", {
      roots: [
        { projectId: ProjectId.make("api"), name: "api" },
        { projectId: ProjectId.make("web"), name: "web" },
      ],
    });
    const update = (project: ProjectRow, change: { workspaceRoot?: string; roots?: [] }) =>
      failureOf(
        plan(
          {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-workspace-update"),
            projectId: project.projectId,
            ...change,
          },
          { project, rootProjects },
        ),
      ).message;
    assert.include(update(workspace, { workspaceRoot: "/elsewhere" }), "cannot be moved");
    assert.include(update(rootProjects[0]!, { roots: [] }), "Only a workspace");

    const removeApi = failureOf(
      plan(
        {
          type: "project.delete",
          commandId: CommandId.make("cmd-delete-root"),
          projectId: ProjectId.make("api"),
        },
        { project: rootProjects[0], referencingWorkspaces: [workspace] },
      ),
    );
    assert.equal(removeApi._tag, "ProjectReferencedByWorkspaceError");
    assert.include(removeApi.message, 'workspace "workspace"');
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });
});
