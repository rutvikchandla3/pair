import { EnvironmentId, ProjectId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CloudTarget,
  type CloudTargetOption,
  cloudBranchCheck,
  resolveCloudTarget,
  routedCloudLaunch,
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
  const head = { refName: "feature", aheadCount: 0 };
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
      status: { refName: "feature", aheadCount: 2 },
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
      status: { refName: "feature", aheadCount: 3 },
      expected: { kind: "ok" },
    },
    { name: "a clean pushed branch", ref: tracked, status: head, expected: { kind: "ok" } },
    {
      name: "a branch that isn't checked out while HEAD is ahead",
      ref: tracked,
      status: { refName: "main", aheadCount: 4 },
      expected: { kind: "ok" },
    },
  ])("checks $name before a cloud send", ({ ref, status, expected }) => {
    expect(cloudBranchCheck({ branch: "feature", ref, status })).toEqual(expected);
  });
});
