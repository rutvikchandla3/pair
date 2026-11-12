import { WORKSPACE_WORKTREE_BASE_REF } from "@t3tools/client-runtime/state/workspaces";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { serializeComposerMessageForServer } from "./composerContext";

import {
  buildProjectThreadStartTurnInput,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

describe("project thread title", () => {
  it.each([
    {
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      text: "![photo.png](t3-context://v1/image/photo)",
      title: "Attached image",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "",
      title: "File: report.pdf",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "[report.pdf](t3-context://v1/file/report)",
      title: "report.pdf",
    },
  ])("titles a $type-only message without changing its data", ({ text, title, ...attachment }) => {
    const uploadedAttachments = [{ ...attachment, id: "prepared-attachment", sizeBytes: 3 }];
    const wire = serializeComposerMessageForServer(text, undefined);
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "image-thread",
      commandId: "image-command",
      messageId: "image-message",
      createdAt: "2026-09-04T00:00:00Z",
      ...wire,
      titleText: text,
      uploadedAttachments,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    } satisfies ProjectThreadStartTurnSpec;
    const input = buildProjectThreadStartTurnInput(spec);

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.attachments).toEqual(uploadedAttachments);
    expect(input.message.text).toBe(wire.text);
    const relaunched = buildProjectThreadStartTurnInput({
      ...spec,
      threadId: "local-relaunch",
      text: input.message.text,
      titleText: input.bootstrap.createThread.title,
    });
    expect(relaunched.titleSeed).toBe(title);
    expect(relaunched.message.text).toBe(wire.text);
    expect(relaunched.message.attachments).toEqual(uploadedAttachments);
  });
});

describe("buildProjectThreadStartTurnInput", () => {
  it("launches a cloud task on a machine, with no local worktree or setup script", () => {
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "cloud-thread",
      commandId: "cloud-command",
      messageId: "cloud-message",
      createdAt: "2026-09-04T00:00:00Z",
      text: "Fix the flaky test",
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "cloud",
      branch: "main",
      worktreePath: "/workspace/.t3/worktrees/stale",
      startFromOrigin: true,
      worktreeBranchName: "t3code/1234abcd",
    });

    expect(input.bootstrap).toEqual({
      createThread: expect.objectContaining({ branch: "main", worktreePath: null }),
      prepareCloud: { baseRef: "main", branch: "t3code/1234abcd" },
    });
  });

  it("continues the member's branch on a routed launch, never the temporary name", () => {
    const routed = {
      projectId: ProjectId.make("pair-cloud-project"),
      projectCwd: "/checkouts/pair-cloud-project",
      threadId: "routed-thread",
      commandId: "routed-command",
      messageId: "routed-message",
      createdAt: "2026-09-04T00:00:00Z",
      text: "Fix the flaky test",
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "cloud",
      branch: "feature",
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "t3code/1234abcd",
      routedFromDefaultBranch: "main",
    } satisfies ProjectThreadStartTurnSpec;

    expect(buildProjectThreadStartTurnInput(routed).bootstrap.prepareCloud).toEqual({
      baseRef: "main",
      branch: "feature",
      existingBranch: true,
    });
    expect(
      buildProjectThreadStartTurnInput({ ...routed, branch: "main" }).bootstrap.prepareCloud,
    ).toEqual({ baseRef: "main" });
    // A workspace's branch is named by the server; each repository starts from its own default.
    expect(
      buildProjectThreadStartTurnInput({
        ...routed,
        workspace: true,
        branch: WORKSPACE_WORKTREE_BASE_REF,
        routedFromDefaultBranch: WORKSPACE_WORKTREE_BASE_REF,
      }).bootstrap,
    ).toEqual({
      createThread: expect.objectContaining({ branch: null, worktreePath: null }),
      prepareCloud: { baseRef: WORKSPACE_WORKTREE_BASE_REF },
    });
  });
});
