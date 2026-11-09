import {
  ComputeDriverId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { cloudAvailability, newThreadPrefersCloud } from "./sandbox.ts";

const projectId = ProjectId.make("project-a");
const driver = {
  kind: "docker",
  id: ComputeDriverId.make("local"),
  label: "Local Docker",
} as const;
const configured = (
  overrides: ServerSettings["projectSettingsOverrides"] = {},
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  sandbox: { drivers: [driver] },
  projectSettingsOverrides: overrides,
});

describe("cloudAvailability", () => {
  it.each([
    ["a server that is not cloud-only", configured(), false, "not-cloud-only"],
    ["no settings", null, true, "not-configured"],
    ["no sandbox key", DEFAULT_SERVER_SETTINGS, true, "not-configured"],
    [
      "a sandbox with no drivers",
      { ...DEFAULT_SERVER_SETTINGS, sandbox: { drivers: [] } },
      true,
      "not-configured",
    ],
    [
      "a project that disallows cloud",
      configured({ [projectId]: { sandboxAllowed: false } }),
      true,
      "project-disallowed",
    ],
    ["a configured driver", configured(), true, null],
    [
      "a project that allows cloud",
      configured({ [projectId]: { sandboxAllowed: true } }),
      true,
      null,
    ],
  ] as const)("%s", (_name, settings, cloudLaunch, reason) => {
    const result = cloudAvailability(settings, projectId, cloudLaunch);
    expect(result.available ? null : result.reason).toBe(reason);
  });

  it("ignores project overrides without a project", () => {
    expect(
      cloudAvailability(configured({ [projectId]: { sandboxAllowed: false } }), null, true)
        .available,
    ).toBe(true);
  });
});

describe("newThreadPrefersCloud", () => {
  it.each([
    ["prefers Cloud on a cloud-launch server without the old default", configured(), true, true],
    [
      "never on another server",
      configured({ [projectId]: { defaultsToCloud: true } }),
      false,
      false,
    ],
    [
      "cloud is not configured",
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultsToCloud: true } },
      },
      true,
      false,
    ],
    [
      "the project disallows cloud",
      configured({ [projectId]: { sandboxAllowed: false } }),
      true,
      false,
    ],
  ] as const)("%s", (_name, settings, cloudLaunch, expected) => {
    expect(newThreadPrefersCloud(settings, projectId, cloudLaunch)).toBe(expected);
  });
});
