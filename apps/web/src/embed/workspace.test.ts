import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import {
  embedShownThreadId,
  embedThreadSummaries,
  resolveEmbedWorkspaceProject,
} from "./workspace";

const ENVIRONMENT = EnvironmentId.make("environment-test");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-other");

function project(id: string, overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENVIRONMENT,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/projects/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("embedThreadSummaries", () => {
  it("lists the environment's top-level live threads, newest first", () => {
    const root = ThreadId.make("root");
    const threads = [
      makeThreadFixture({
        id: root,
        title: "Fix login",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("running"),
        title: "Add tests",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        runtime: {
          status: "running",
          activeRunId: RunId.make("run"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      }),
      makeThreadFixture({
        id: ThreadId.make("subagent"),
        lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "subagent" },
      }),
      makeThreadFixture({ id: ThreadId.make("archived"), archivedAt: "2026-01-04T00:00:00.000Z" }),
      makeThreadFixture({ id: ThreadId.make("elsewhere"), environmentId: OTHER_ENVIRONMENT }),
    ];

    expect(embedThreadSummaries(threads, ENVIRONMENT)).toEqual([
      {
        id: "running",
        title: "Add tests",
        createdAt: Date.parse("2026-01-03T00:00:00.000Z"),
        updatedAt: Date.parse("2026-01-03T00:00:00.000Z"),
        working: true,
      },
      {
        id: "root",
        title: "Fix login",
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-01-02T00:00:00.000Z"),
        working: false,
      },
    ]);
  });
});

describe("resolveEmbedWorkspaceProject", () => {
  const input: Omit<Parameters<typeof resolveEmbedWorkspaceProject>[0], "projects"> = {
    environmentId: ENVIRONMENT,
    threads: [],
    bootstrapProjectId: null,
    serverCwd: null,
  };

  it("prefers the bootstrapped project, then the server's directory, then recent activity", () => {
    const projects = [
      project("recent", { updatedAt: "2026-02-01T00:00:00.000Z" }),
      project("cwd"),
      project("bootstrap"),
    ];
    const resolve = (overrides: Partial<typeof input>) =>
      resolveEmbedWorkspaceProject({ ...input, projects, ...overrides })?.id;

    expect(
      resolve({ bootstrapProjectId: ProjectId.make("bootstrap"), serverCwd: "/projects/cwd" }),
    ).toBe("bootstrap");
    expect(
      resolve({ bootstrapProjectId: ProjectId.make("gone"), serverCwd: "/projects/cwd" }),
    ).toBe("cwd");
    expect(resolve({})).toBe("recent");
  });

  it("never picks an archived project or one in another environment", () => {
    expect(
      resolveEmbedWorkspaceProject({
        ...input,
        bootstrapProjectId: ProjectId.make("archived"),
        projects: [
          project("archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
          project("elsewhere", { environmentId: OTHER_ENVIRONMENT }),
        ],
      }),
    ).toBeNull();
  });
});

describe("embedShownThreadId", () => {
  const thread = ThreadId.make("thread-1");
  const draft = { kind: "draft", draftId: "draft-1" as DraftId } as const;

  it.each([
    [{ kind: "server", threadRef: scopeThreadRef(ENVIRONMENT, thread) } as const, null, thread],
    [{ kind: "server", threadRef: scopeThreadRef(OTHER_ENVIRONMENT, thread) } as const, null, null],
    [draft, null, null],
    [draft, scopeThreadRef(ENVIRONMENT, thread), thread],
    [null, null, null],
  ])("reports %j promoted to %j as %s", (target, draftPromotedTo, expected) => {
    expect(embedShownThreadId({ target, draftPromotedTo, environmentId: ENVIRONMENT })).toBe(
      expected,
    );
  });
});
