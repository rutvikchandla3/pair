import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    // Only the server's launch gate makes a machine.
    const sandboxId = "sbx_0123456789abcdef0123";
    const delegated = {
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: "delegate-1",
      parentThreadId: "thread-1",
      parentRunId: "run-1",
      parentNodeId: "node-1",
      task: "Look into it",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    for (const forged of [
      delegated,
      { ...delegated, sandbox: { sandboxId, driverId: "docker", size: "default" } },
      {
        type: "sandbox.provision",
        commandId: "provision-1",
        threadId: "thread-1",
        sandboxId,
        projectId: "project-1",
        driverId: "docker",
        size: "default",
      },
      {
        type: "sandbox.admit",
        commandId: "admit-1",
        threadId: "thread-1",
        sandboxId,
        generation: 1,
      },
    ]) {
      expect(Exit.isFailure(decode(forged)), forged.type).toBe(true);
    }
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
