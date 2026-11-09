import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import * as commandPalette from "../commandPaletteBus";
import * as settings from "../hooks/useSettings";
import * as threadActions from "../lib/chatThreadActions";
import * as entities from "../state/entities";
import * as sandbox from "../state/sandbox";
import type { Project } from "../types";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as dispatcher from "./dispatcher";

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("new thread commands", () => {
  it.each([
    { mode: "normal", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 1, command: "chat.new", picker: false },
    { mode: "legacy", count: 2, command: "chat.new", picker: false },
    { mode: "boring", count: 2, command: "chat.newLocal", picker: false },
    { mode: "boring", count: 2, command: "chat.newCloud", picker: false, cloud: true },
    { mode: "boring", count: 2, command: "chat.newCloud", picker: false, cloud: false },
  ] as const)("$mode sidebar, $count projects, $command: picker=$picker", (scenario) => {
    const cloud = "cloud" in scenario ? scenario.cloud : undefined;
    // Pair Cloud has this repo (launch) or not yet (Add only, which doesn't start a cloud draft).
    using _cloud = vi.spyOn(sandbox, "readCloudTarget").mockReturnValue({
      kind: "targets",
      targets: [
        {
          environmentId: EnvironmentId.make("pair-cloud"),
          label: "Pair Cloud",
          projectId: cloud === true ? ProjectId.make("on-cloud") : null,
          disabledReason: null,
        },
      ],
    });
    using _settings = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
    });
    using _projects = vi
      .spyOn(entities, "readProjects")
      .mockReturnValue([project("active"), project("idle")].slice(0, scenario.count));
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = { state: { matches: [] } } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls[0]![0];
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    commands[scenario.command]!(event);

    if (scenario.picker) {
      expect(openPicker).toHaveBeenCalledWith({ open: "new-thread-in" });
      expect(startLocal).not.toHaveBeenCalled();
    } else if (cloud !== undefined) {
      expect(openPicker).not.toHaveBeenCalled();
      expect(startLocal.mock.calls.map((call) => call[1])).toEqual(
        cloud ? [{ envMode: "cloud" }] : [],
      );
    } else {
      expect(openPicker).not.toHaveBeenCalled();
      expect(startLocal).toHaveBeenCalledOnce();
    }
  });
});
