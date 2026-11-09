import type { CloudTargetOption } from "@t3tools/client-runtime/state/cloud-target";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NO_NEW_TASK_CLOUD, resolveNewTaskCloud } from "./new-task-cloud";

const mac = EnvironmentId.make("mac");
const cloud = EnvironmentId.make("cloud");
const cloudB = EnvironmentId.make("cloud-b");
const macProject = {
  environmentId: mac,
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app",
    },
  },
};

function option(
  environmentId: EnvironmentId,
  label: string,
  projectId: string | null,
  disabledReason: string | null = null,
): CloudTargetOption {
  return {
    environmentId,
    label,
    projectId: projectId === null ? null : ProjectId.make(projectId),
    disabledReason,
  };
}

describe("resolveNewTaskCloud", () => {
  it.each([
    {
      name: "a phone paired only with the Mac (nothing new)",
      cloudTarget: { kind: "hidden" as const },
      cloudEnvironmentId: undefined,
      expected: NO_NEW_TASK_CLOUD,
    },
    {
      name: "an origin off github.com",
      cloudTarget: { kind: "unavailable" as const, message: "Cloud needs github.com." },
      cloudEnvironmentId: undefined,
      expected: { ...NO_NEW_TASK_CLOUD, offered: true, message: "Cloud needs github.com." },
    },
    {
      name: "a matching Pair Cloud project (routed)",
      cloudTarget: { kind: "targets" as const, targets: [option(cloud, "Pair Cloud", "p1")] },
      cloudEnvironmentId: undefined,
      expected: {
        offered: true,
        options: [{ environmentId: cloud, title: "Cloud", disabledReason: null }],
        available: true,
        message: null,
        target: { environmentId: cloud, projectId: ProjectId.make("p1"), label: "Pair Cloud" },
        routed: true,
      },
    },
    {
      name: "no match, which names the repo to add",
      cloudTarget: { kind: "targets" as const, targets: [option(cloud, "Pair Cloud", null)] },
      cloudEnvironmentId: undefined,
      expected: {
        offered: true,
        options: [
          {
            environmentId: cloud,
            title: "Cloud",
            disabledReason: "Add acme/app to Pair Cloud first.",
          },
        ],
        available: false,
        message: "Add acme/app to Pair Cloud first.",
        target: null,
        routed: false,
      },
    },
    {
      name: "two Pair Clouds, the first launchable one by default",
      cloudTarget: {
        kind: "targets" as const,
        targets: [
          option(cloud, "Pair Cloud", "p1", "Pair Cloud is offline."),
          option(cloudB, "Zeta", "p2"),
        ],
      },
      cloudEnvironmentId: undefined,
      expected: expect.objectContaining({
        options: [
          {
            environmentId: cloud,
            title: "Cloud on Pair Cloud",
            disabledReason: "Pair Cloud is offline.",
          },
          { environmentId: cloudB, title: "Cloud on Zeta", disabledReason: null },
        ],
        available: true,
        target: { environmentId: cloudB, projectId: ProjectId.make("p2"), label: "Zeta" },
      }),
    },
    {
      name: "two Pair Clouds with the picked one offline",
      cloudTarget: {
        kind: "targets" as const,
        targets: [
          option(cloud, "Pair Cloud", "p1", "Pair Cloud is offline."),
          option(cloudB, "Zeta", "p2"),
        ],
      },
      cloudEnvironmentId: cloud,
      expected: expect.objectContaining({
        available: false,
        message: "Pair Cloud is offline.",
        target: null,
      }),
    },
    {
      name: "a Pair Cloud project's own Cloud (not routed)",
      project: { ...macProject, environmentId: cloud },
      cloudTarget: { kind: "targets" as const, targets: [option(cloud, "Pair Cloud", "p1")] },
      cloudEnvironmentId: undefined,
      expected: expect.objectContaining({ available: true, routed: false }),
    },
  ])("maps $name", ({ cloudTarget, cloudEnvironmentId, expected, ...row }) => {
    const project = row.project ?? macProject;
    expect(resolveNewTaskCloud({ cloudTarget, project, cloudEnvironmentId })).toEqual(expected);
  });
});
