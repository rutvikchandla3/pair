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
    ["no settings", null, "not-configured"],
    ["no sandbox key", DEFAULT_SERVER_SETTINGS, "not-configured"],
    [
      "a sandbox with no drivers",
      { ...DEFAULT_SERVER_SETTINGS, sandbox: { drivers: [] } },
      "not-configured",
    ],
    [
      "a project that disallows cloud",
      configured({ [projectId]: { sandboxAllowed: false } }),
      "project-disallowed",
    ],
    ["a configured driver", configured(), null],
    ["a project that allows cloud", configured({ [projectId]: { sandboxAllowed: true } }), null],
  ] as const)("%s", (_name, settings, reason) => {
    const result = cloudAvailability(settings, projectId);
    expect(result.available ? null : result.reason).toBe(reason);
  });

  it("ignores project overrides without a project", () => {
    expect(
      cloudAvailability(configured({ [projectId]: { sandboxAllowed: false } }), null).available,
    ).toBe(true);
  });
});

describe("newThreadPrefersCloud", () => {
  it.each([
    ["the project defaults to cloud", configured({ [projectId]: { defaultsToCloud: true } }), true],
    ["no project default", configured(), false],
    [
      "cloud is not configured",
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultsToCloud: true } },
      },
      false,
    ],
    [
      "the project disallows cloud",
      configured({ [projectId]: { defaultsToCloud: true, sandboxAllowed: false } }),
      false,
    ],
  ] as const)("%s", (_name, settings, expected) => {
    expect(newThreadPrefersCloud(settings, projectId)).toBe(expected);
  });
});
