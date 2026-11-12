import { EnvironmentId, ProjectId, RunId, type ServerConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type CloudTarget,
  type CloudTargetOption,
  cloudBranchCheck,
  type ContinueInCloudOffer,
  continueInCloudOffer,
  type ContinueLocallyOffer,
  resolveCloudTarget,
  resolveContinueInCloud,
  resolveContinueLocally,
  routedCloudLaunch,
  sameContinueInCloudOffer,
} from "./cloudTarget.ts";
import type { EnvironmentProject } from "./models.ts";
import { v2Project } from "./orchestrationV2TestFixtures.ts";

const mac = EnvironmentId.make("mac");
const cloud = EnvironmentId.make("cloud");
const cloudB = EnvironmentId.make("cloud-b");

function config(cloudLaunch: boolean, disallowed: ReadonlyArray<string> = []): ServerConfig {
  return {
    environment: { capabilities: { cloudLaunch } },
    settings: {
      sandbox: { drivers: [{}] },
      projectSettingsOverrides: Object.fromEntries(
        disallowed.map((projectId) => [projectId, { sandboxAllowed: false }]),
      ),
    },
  } as unknown as ServerConfig;
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  serverConfig: ServerConfig | null,
  connected = true,
) {
  return { environmentId, label, connected, serverConfig };
}

function project(
  id: string,
  environmentId: EnvironmentId,
  remote: string | null,
  extra: { readonly origin?: string; readonly createdAt?: string; readonly archived?: true } = {},
): EnvironmentProject {
  return {
    ...v2Project,
    id: ProjectId.make(id),
    environmentId,
    repositoryIdentity:
      remote === null
        ? null
        : {
            canonicalKey: remote,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${remote}` },
            ...(extra.origin ? { origin: { canonicalKey: extra.origin } } : {}),
          },
    createdAt: extra.createdAt ?? v2Project.createdAt,
    ...(extra.archived ? { archivedAt: "2026-07-01T00:00:00.000Z" } : {}),
  };
}

const macEnv = environment(mac, "Mac", config(false));
const cloudEnv = environment(cloud, "Pair Cloud", config(true));
const repo = "github.com/acme/app";
const local = project("local", mac, repo);
const onCloud = project("on-cloud", cloud, repo);

const targets = (...options: ReadonlyArray<CloudTargetOption>): CloudTarget => ({
  kind: "targets",
  targets: options,
});

describe("resolveCloudTarget", () => {
  it.each([
    {
      name: "a Pair Cloud project itself",
      project: onCloud,
      environments: [macEnv, cloudEnv],
      projects: [local, onCloud],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: onCloud.id,
        disabledReason: null,
      }),
    },
    {
      name: "a Pair Cloud project whose server has no driver",
      project: onCloud,
      environments: [
        environment(cloud, "Pair Cloud", {
          ...config(true),
          settings: { projectSettingsOverrides: {} },
        } as unknown as ServerConfig),
      ],
      projects: [onCloud],
      expected: {
        kind: "targets",
        targets: [
          {
            environmentId: cloud,
            label: "Pair Cloud",
            projectId: onCloud.id,
            disabledReason: "Cloud is not set up on this environment.",
          },
        ],
      },
    },
    {
      name: "a local project with a match",
      project: local,
      environments: [macEnv, cloudEnv],
      projects: [local, onCloud],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: onCloud.id,
        disabledReason: null,
      }),
    },
    {
      name: "a local project with no match (Add)",
      project: local,
      environments: [macEnv, cloudEnv],
      projects: [local, project("other", cloud, "github.com/acme/other")],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: null,
        disabledReason: null,
      }),
    },
    {
      name: "a fork, which never matches the upstream's Pair Cloud project",
      project: project("fork", mac, repo, { origin: "github.com/me/app" }),
      environments: [macEnv, cloudEnv],
      projects: [onCloud],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: null,
        disabledReason: null,
      }),
    },
    {
      name: "a project with no origin",
      project: project("bare", mac, null),
      environments: [macEnv, cloudEnv],
      projects: [onCloud],
      expected: {
        kind: "unavailable",
        message: "Cloud needs this project's origin on github.com.",
      },
    },
    {
      name: "a gitlab origin",
      project: project("lab", mac, "gitlab.com/acme/app"),
      environments: [macEnv, cloudEnv],
      projects: [project("lab-cloud", cloud, "gitlab.com/acme/app")],
      expected: {
        kind: "unavailable",
        message: "Cloud needs this project's origin on github.com.",
      },
    },
    {
      name: "no cloudLaunch environment (hidden)",
      project: local,
      environments: [macEnv, environment(cloud, "Old cloud", config(false))],
      projects: [local, onCloud],
      expected: { kind: "hidden" },
    },
    {
      name: "Pair Cloud offline",
      project: local,
      environments: [macEnv, environment(cloud, "Pair Cloud", config(true), false)],
      projects: [local, onCloud],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: onCloud.id,
        disabledReason: "Pair Cloud is offline.",
      }),
    },
    {
      name: "a match with Cloud turned off for it",
      project: local,
      environments: [macEnv, environment(cloud, "Pair Cloud", config(true, ["on-cloud"]))],
      projects: [local, onCloud],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: onCloud.id,
        disabledReason: "Cloud threads are turned off for this project.",
      }),
    },
    {
      name: "two Pair Clouds (two options, by label)",
      project: local,
      environments: [macEnv, environment(cloudB, "Zeta cloud", config(true)), cloudEnv],
      projects: [local, onCloud],
      expected: targets(
        { environmentId: cloud, label: "Pair Cloud", projectId: onCloud.id, disabledReason: null },
        { environmentId: cloudB, label: "Zeta cloud", projectId: null, disabledReason: null },
      ),
    },
    {
      name: "two matching projects on one Pair Cloud (oldest)",
      project: local,
      environments: [macEnv, cloudEnv],
      projects: [
        local,
        onCloud,
        project("older", cloud, repo, { createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: ProjectId.make("older"),
        disabledReason: null,
      }),
    },
    {
      name: "an archived match ignored",
      project: local,
      environments: [macEnv, cloudEnv],
      projects: [
        local,
        project("archived", cloud, repo, {
          createdAt: "2026-01-01T00:00:00.000Z",
          archived: true,
        }),
      ],
      expected: targets({
        environmentId: cloud,
        label: "Pair Cloud",
        projectId: null,
        disabledReason: null,
      }),
    },
  ])("resolves $name", ({ project, environments, projects, expected }) => {
    expect(resolveCloudTarget({ project, environments, projects })).toEqual(expected);
  });
});

describe("resolveCloudTarget for a workspace", () => {
  const workspace = (
    id: string,
    environmentId: EnvironmentId,
    roots: ReadonlyArray<readonly [string, string]>,
    extra: { readonly createdAt?: string } = {},
  ): EnvironmentProject => ({
    ...project(id, environmentId, null, extra),
    title: "Shop",
    roots: roots.map(([projectId, name]) => ({ projectId: ProjectId.make(projectId), name })),
  });
  const api = project("api", mac, "github.com/acme/api");
  const web = project("web", mac, "github.com/Acme/Web");
  const localWorkspace = workspace("ws", mac, [
    ["api", "api"],
    ["web", "web"],
  ]);
  const cloudApi = project("cloud-api", cloud, "github.com/acme/api");
  const cloudWeb = project("cloud-web", cloud, "github.com/acme/web");
  const cloudOther = project("cloud-other", cloud, "github.com/acme/other");
  const local = [api, web, localWorkspace];
  const option = (overrides: Partial<CloudTargetOption>): CloudTarget =>
    targets({
      environmentId: cloud,
      label: "Pair Cloud",
      projectId: null,
      disabledReason: null,
      ...overrides,
    });
  const create = option({
    createWorkspace: {
      title: "Shop",
      roots: [
        { projectId: cloudApi.id, name: "api" },
        { projectId: cloudWeb.id, name: "web" },
      ],
    },
  });

  it.each([
    {
      name: "the same repositories in another order and folders",
      projects: [
        ...local,
        cloudApi,
        cloudWeb,
        workspace("cloud-ws", cloud, [
          ["cloud-web", "frontend"],
          ["cloud-api", "backend"],
        ]),
      ],
      expected: option({ projectId: ProjectId.make("cloud-ws") }),
    },
    {
      name: "the oldest of two matches",
      projects: [
        ...local,
        cloudApi,
        cloudWeb,
        workspace("cloud-ws", cloud, [
          ["cloud-api", "api"],
          ["cloud-web", "web"],
        ]),
        workspace(
          "older-ws",
          cloud,
          [
            ["cloud-api", "api"],
            ["cloud-web", "web"],
          ],
          { createdAt: "2026-01-01T00:00:00.000Z" },
        ),
      ],
      expected: option({ projectId: ProjectId.make("older-ws") }),
    },
    {
      name: "a subset workspace, which is no match (create)",
      projects: [
        ...local,
        cloudApi,
        cloudWeb,
        cloudOther,
        workspace("sub", cloud, [
          ["cloud-api", "api"],
          ["cloud-other", "other"],
        ]),
      ],
      expected: create,
    },
    {
      name: "a superset workspace, which is no match (create)",
      projects: [
        ...local,
        cloudApi,
        cloudWeb,
        cloudOther,
        workspace("super", cloud, [
          ["cloud-api", "api"],
          ["cloud-web", "web"],
          ["cloud-other", "other"],
        ]),
      ],
      expected: create,
    },
    {
      name: "every repository on Pair Cloud and no workspace (create)",
      projects: [...local, cloudApi, cloudWeb],
      expected: create,
    },
    {
      name: "a repository missing from Pair Cloud",
      projects: [...local, cloudApi],
      expected: option({ disabledReason: "Add acme/web to Pair Cloud first." }),
    },
    {
      name: "every repository missing from Pair Cloud",
      projects: [...local, cloudOther],
      expected: option({ disabledReason: "Add acme/api and acme/web to Pair Cloud first." }),
    },
    {
      name: "a match with Cloud turned off for it",
      environments: [macEnv, environment(cloud, "Pair Cloud", config(true, ["cloud-ws"]))],
      projects: [
        ...local,
        cloudApi,
        cloudWeb,
        workspace("cloud-ws", cloud, [
          ["cloud-api", "api"],
          ["cloud-web", "web"],
        ]),
      ],
      expected: option({
        projectId: ProjectId.make("cloud-ws"),
        disabledReason: "Cloud threads are turned off for this project.",
      }),
    },
    {
      name: "Pair Cloud offline",
      environments: [macEnv, environment(cloud, "Pair Cloud", config(true), false)],
      projects: [...local, cloudApi],
      expected: option({ disabledReason: "Pair Cloud is offline." }),
    },
    {
      name: "no Pair Cloud (hidden)",
      environments: [macEnv],
      projects: [...local, cloudApi, cloudWeb],
      expected: { kind: "hidden" },
    },
    {
      name: "a repository that isn't on github.com",
      projects: [api, project("web", mac, "gitlab.com/acme/web"), localWorkspace, cloudApi],
      expected: {
        kind: "unavailable",
        message: "web/ isn't a github.com repository, so this workspace can't run in Pair Cloud.",
      },
    },
    {
      name: "a repository whose project is gone",
      projects: [api, localWorkspace, cloudApi, cloudWeb],
      expected: {
        kind: "unavailable",
        message:
          "web/ belongs to a project that no longer exists. Edit the workspace's repositories.",
      },
    },
  ] as const)("resolves $name", ({ projects, expected, ...rest }) => {
    const environments = "environments" in rest ? rest.environments : [macEnv, cloudEnv];
    expect(resolveCloudTarget({ project: localWorkspace, environments, projects })).toEqual(
      expected,
    );
  });

  it("is its own target on Pair Cloud", () => {
    const onCloud = workspace("cloud-ws", cloud, [
      ["cloud-api", "api"],
      ["cloud-web", "web"],
    ]);
    expect(
      resolveCloudTarget({
        project: onCloud,
        environments: [macEnv, cloudEnv],
        projects: [cloudApi, cloudWeb, onCloud],
      }),
    ).toEqual(option({ projectId: onCloud.id }));
  });
});

describe("routedCloudLaunch", () => {
  it.each([
    { name: "the default branch", selectedBranch: "main", expected: { baseRef: "main" } },
    {
      name: "a feature branch",
      selectedBranch: "feature/login",
      expected: { baseRef: "main", branch: "feature/login", existingBranch: true },
    },
    {
      name: "origin/feature picked",
      selectedBranch: "origin/feature",
      expected: { baseRef: "main", branch: "feature", existingBranch: true },
    },
  ])("plans a routed launch for $name", ({ selectedBranch, expected }) => {
    expect(routedCloudLaunch({ selectedBranch, defaultBranch: "main" })).toEqual(expected);
  });
});

describe("cloudBranchCheck", () => {
  const tracked = { upstreamRef: "refs/remotes/origin/feature", isDefault: false };
  const head = { refName: "feature", aheadCount: 0, hasUpstream: true };
  it.each([
    {
      name: "no upstream",
      ref: { isDefault: false },
      status: head,
      expected: { kind: "block", message: "Push feature first." },
    },
    {
      name: "ahead by 2",
      ref: tracked,
      status: { refName: "feature", aheadCount: 2, hasUpstream: true },
      expected: { kind: "warn", message: "2 commits not pushed won't be included." },
    },
    {
      name: "an upstream on fork",
      ref: { upstreamRef: "refs/remotes/fork/feature", isDefault: false },
      status: head,
      expected: {
        kind: "warn",
        message: "feature tracks fork/feature, not origin/feature. Pair Cloud looks on origin.",
      },
    },
    {
      name: "an upstream with a different name",
      ref: { upstreamRef: "refs/remotes/origin/other", isDefault: false },
      status: head,
      expected: {
        kind: "warn",
        message: "feature tracks origin/other, not origin/feature. Pair Cloud looks on origin.",
      },
    },
    {
      name: "the default branch",
      ref: { isDefault: true },
      status: { refName: "feature", aheadCount: 3, hasUpstream: true },
      expected: { kind: "ok" },
    },
    { name: "a clean pushed branch", ref: tracked, status: head, expected: { kind: "ok" } },
    {
      name: "a branch that isn't checked out while HEAD is ahead",
      ref: tracked,
      status: { refName: "main", aheadCount: 4, hasUpstream: true },
      expected: { kind: "ok" },
    },
    {
      name: "a branch that isn't checked out with unpushed commits",
      ref: { ...tracked, aheadCount: 1 },
      status: { refName: "main", aheadCount: 0, hasUpstream: true },
      expected: { kind: "warn", message: "1 commit not pushed won't be included." },
    },
    {
      name: "the checked-out branch before its remote status loads",
      ref: { ...tracked, aheadCount: 2 },
      status: { refName: "feature", aheadCount: 0, hasUpstream: false },
      expected: { kind: "warn", message: "2 commits not pushed won't be included." },
    },
  ])("checks $name before a cloud send", ({ ref, status, expected }) => {
    expect(cloudBranchCheck({ branch: "feature", ref, status })).toEqual(expected);
  });
});

describe("resolveContinueLocally", () => {
  const now = DateTime.makeUnsafe("2026-11-09T12:00:00Z");
  const configs = new Map<EnvironmentId, ServerConfig>([
    [mac, config(false)],
    [
      cloud,
      {
        environment: { capabilities: { cloudLaunch: true, cloudImport: true } },
      } as unknown as ServerConfig,
    ],
    [cloudB, config(true)],
  ]);
  const cloudProject = project("cloud-app", cloud, "github.com/acme/app");
  const projects = [
    cloudProject,
    project("newer", mac, "GitHub.com/Acme/App", { createdAt: "2026-08-01T00:00:00.000Z" }),
    project("older", mac, "github.com/acme/app", { createdAt: "2026-07-01T00:00:00.000Z" }),
    project("archived", mac, "github.com/acme/app", {
      createdAt: "2026-06-01T00:00:00.000Z",
      archived: true,
    }),
  ];
  const link = {
    environmentId: cloud,
    label: "Acme Cloud",
    status: "reachable" as const,
    expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z"),
  };
  type Input = Parameters<typeof resolveContinueLocally>[0];
  const thread: Input["thread"] = {
    environmentId: cloud,
    projectId: cloudProject.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" as never },
    runtime: null,
    source: { sandboxId: "sbx_1" },
  };
  const base: Input = {
    thread,
    primaryEnvironmentId: mac,
    serverConfigs: configs,
    canMove: true,
    projects,
    links: [link],
    now,
  };

  it.each<{
    readonly name: string;
    readonly input: Partial<Input>;
    readonly expected: ContinueLocallyOffer;
  }>([
    {
      name: "ready in the oldest unarchived project with the origin",
      input: {},
      expected: { kind: "ready", localEnvironmentId: mac, projectId: ProjectId.make("older") },
    },
    {
      name: "hidden without a primary environment",
      input: { primaryEnvironmentId: null },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden on the thread's own environment",
      input: { primaryEnvironmentId: cloud },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden when the primary is a Pair Cloud",
      input: { primaryEnvironmentId: cloudB },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden without the toLocal permission",
      input: { canMove: false },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden for a side chat",
      input: { thread: { ...thread, lineage: { ...thread.lineage, sideChat: true } } },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden for a thread with no machine",
      input: { thread: { ...thread, source: {} } },
      expected: { kind: "hidden" },
    },
    {
      name: "hidden when the thread's environment doesn't report cloudImport",
      input: { thread: { ...thread, environmentId: cloudB } },
      expected: { kind: "hidden" },
    },
    { name: "hidden without a link to it", input: { links: [] }, expected: { kind: "hidden" } },
    {
      name: "disabled when the link expired",
      input: { links: [{ ...link, expiresAt: now }] },
      expected: {
        kind: "disabled",
        label: "link expired",
        reason: "The link to Acme Cloud expired. Link it again in Settings → Environments.",
      },
    },
    {
      name: "disabled without a project with the origin",
      input: { projects: [cloudProject, project("other", mac, "github.com/acme/other")] },
      expected: {
        kind: "disabled",
        label: "no matching project",
        reason: "No project on this computer has origin github.com/acme/app.",
      },
    },
    {
      name: "disabled during a turn",
      input: { thread: { ...thread, runtime: { activeRunId: RunId.make("run-1") } as never } },
      expected: {
        kind: "disabled",
        label: "turn running",
        reason: "Wait for the turn to end, or stop it.",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveContinueLocally({ ...base, ...input })).toEqual(expected);
  });
});

describe("continueInCloudOffer", () => {
  const offline = environment(cloud, "Pair Cloud", config(true), false);
  it.each<{
    readonly name: string;
    readonly project?: EnvironmentProject;
    readonly environments?: ReadonlyArray<ReturnType<typeof environment>>;
    readonly projects?: ReadonlyArray<EnvironmentProject>;
    readonly sandboxId?: string;
    readonly runActive?: boolean;
    readonly imports?: boolean;
    readonly expected: ContinueInCloudOffer;
  }>([
    {
      name: "ready on a matching local project",
      expected: {
        kind: "ready",
        targets: [
          {
            environmentId: cloud,
            label: "Pair Cloud",
            projectId: onCloud.id,
            disabledReason: null,
          },
        ],
      },
    },
    { name: "hidden for a cloud thread", sandboxId: "sandbox-1", expected: { kind: "hidden" } },
    { name: "hidden for a thread on Pair Cloud", project: onCloud, expected: { kind: "hidden" } },
    { name: "hidden with no Pair Cloud", environments: [macEnv], expected: { kind: "hidden" } },
    {
      name: "hidden for a Pair Cloud that doesn't import",
      imports: false,
      expected: { kind: "hidden" },
    },
    {
      name: "disabled while a turn runs",
      runActive: true,
      expected: {
        kind: "disabled",
        label: "a turn is running",
        reason: "A turn is running. Continue in cloud once it ends.",
      },
    },
    {
      name: "disabled while Pair Cloud is offline",
      environments: [macEnv, offline],
      expected: { kind: "disabled", label: "not available", reason: "Pair Cloud is offline." },
    },
    {
      name: "disabled with no matching project",
      projects: [local, project("other", cloud, "github.com/acme/other")],
      expected: {
        kind: "disabled",
        label: "not available",
        reason: "Add acme/app to Pair Cloud first.",
      },
    },
    {
      name: "disabled for a non-GitHub origin",
      project: project("lab", mac, "gitlab.com/acme/app"),
      expected: {
        kind: "disabled",
        label: "Pair Cloud unavailable",
        reason: "Cloud needs this project's origin on github.com.",
      },
    },
  ])("$name", (row) => {
    const subject = row.project ?? local;
    const cloudTarget = resolveCloudTarget({
      project: subject,
      environments: row.environments ?? [macEnv, cloudEnv],
      projects: row.projects ?? [local, onCloud],
    });
    expect(
      continueInCloudOffer({
        thread: {
          environmentId: subject.environmentId,
          ...(row.sandboxId === undefined ? {} : { sandboxId: row.sandboxId }),
          runActive: row.runActive ?? false,
          originKey: subject.repositoryIdentity?.canonicalKey ?? null,
        },
        cloud: cloudTarget,
        importsTo: () => row.imports ?? true,
      }),
    ).toEqual(row.expected);
  });
});

describe("resolveContinueInCloud", () => {
  const presentations = new Map(
    [
      [mac, "Mac", config(false)],
      [cloud, "Pair Cloud", config(true, [])],
    ].map(([environmentId, label, serverConfig]) => {
      const capabilities = (serverConfig as ServerConfig).environment.capabilities;
      return [
        environmentId as EnvironmentId,
        {
          entry: { target: { label } },
          connection: { phase: "connected" },
          serverConfig: {
            ...(serverConfig as ServerConfig),
            environment: { capabilities: { ...capabilities, cloudImport: true } },
          },
        },
      ];
    }),
  ) as unknown as Parameters<typeof resolveContinueInCloud>[0]["presentations"];
  const shell = (activeRunId: RunId | null) =>
    ({
      environmentId: mac,
      projectId: local.id,
      runtime: activeRunId === null ? null : { activeRunId },
      source: {},
    }) as unknown as Parameters<typeof resolveContinueInCloud>[0]["thread"];

  it("reads the project, the paired environments and the running turn", () => {
    const input = { projects: [local, onCloud], presentations };
    expect(resolveContinueInCloud({ ...input, thread: shell(null) }).kind).toBe("ready");
    expect(resolveContinueInCloud({ ...input, thread: shell(RunId.make("run-1")) })).toMatchObject({
      kind: "disabled",
      label: "a turn is running",
    });
    expect(resolveContinueInCloud({ ...input, thread: shell(null), projects: [] })).toEqual({
      kind: "hidden",
    });
    const workspace = { ...local, roots: [] } as EnvironmentProject;
    expect(
      resolveContinueInCloud({ ...input, thread: shell(null), projects: [workspace, onCloud] }),
    ).toEqual({ kind: "hidden" });
  });
});

describe("sameContinueInCloudOffer", () => {
  const option = {
    environmentId: cloud,
    label: "Pair Cloud",
    projectId: onCloud.id,
    disabledReason: null,
  };
  const ready = (...targets: ReadonlyArray<typeof option>): ContinueInCloudOffer => ({
    kind: "ready",
    targets,
  });
  const disabled = (reason: string): ContinueInCloudOffer => ({
    kind: "disabled",
    label: "not available",
    reason,
  });

  it.each<readonly [string, ContinueInCloudOffer, ContinueInCloudOffer, boolean]>([
    ["hidden twice", { kind: "hidden" }, { kind: "hidden" }, true],
    ["different kinds", { kind: "hidden" }, disabled("x"), false],
    ["the same reason", disabled("x"), disabled("x"), true],
    ["another reason", disabled("x"), disabled("y"), false],
    ["equal targets", ready(option), ready({ ...option }), true],
    ["another label", ready(option), ready({ ...option, label: "Other" }), false],
    ["a target gone", ready(option, { ...option, environmentId: cloudB }), ready(option), false],
  ])("%s", (_name, left, right, expected) => {
    expect(sameContinueInCloudOffer(left, right)).toBe(expected);
  });
});
