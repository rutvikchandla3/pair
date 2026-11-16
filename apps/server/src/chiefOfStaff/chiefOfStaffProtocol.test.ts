import { assert, it } from "@effect/vitest";
import { DEFAULT_MODEL } from "@t3tools/contracts";

import {
  backingSandboxForAccess,
  backingThreadParams,
  formatStatus,
  realtimeFailure,
  STATUS_THREAD_CAP,
} from "./chiefOfStaffProtocol.ts";

it("lists the newest unsettled threads up to the cap and counts the rest", () => {
  const threads = Array.from({ length: STATUS_THREAD_CAP + 3 }, (_, index) => ({
    title: `Thread ${index}`,
    project: index === 0 ? "web" : undefined,
    status: "running",
    needs: index === 1 ? ("approval" as const) : index === 2 ? ("answer" as const) : undefined,
    updatedAt: index,
  }));
  const lines = formatStatus(threads).split("\n");
  const listed = lines.filter((line) => line.startsWith('- "'));
  assert.lengthOf(listed, STATUS_THREAD_CAP);
  assert.equal(listed[0], `- "Thread ${STATUS_THREAD_CAP + 2}": running`);
  assert.notInclude(lines, '- "Thread 0" (project "web"): running');
  assert.include(lines, "- and 3 older threads not listed");
  assert.include(formatStatus(threads.slice(0, 3)), '- "Thread 1": needs approval');
  assert.include(formatStatus(threads.slice(0, 3)), '- "Thread 2": waiting for the user\'s answer');
  assert.include(formatStatus(threads.slice(0, 1)), '- "Thread 0" (project "web"): running');
  assert.include(formatStatus([]), "- none");
});

it("keeps an unrecognised realtime refusal's own words", () => {
  const error = realtimeFailure("socket closed");
  assert.equal(error.reason, "start-failed");
  assert.include(error.message, "socket closed");
});

it("maps tool access onto Codex's sandbox and network access", () => {
  assert.deepEqual(backingSandboxForAccess("read-only"), { sandbox: "read-only", config: {} });
  assert.deepEqual(backingSandboxForAccess("full-access"), {
    sandbox: "danger-full-access",
    config: {},
  });
  // Voice has no approval UI, so every wider level writes, with network for the `t3` CLI.
  for (const access of ["approval-required", "auto-accept-edits", "auto"] as const) {
    assert.deepEqual(backingSandboxForAccess(access), {
      sandbox: "workspace-write",
      config: { sandbox_workspace_write: { network_access: true } },
    });
  }
});

it("defaults the backing thread to a strong model, keeps never, and follows access", () => {
  const base = {
    cwd: "/workspace",
    toolAccess: "auto" as const,
    t3Home: "/state",
    mcpEndpoint: "http://127.0.0.1/mcp",
    mcpAuthorizationHeader: "Bearer x",
  };
  const params = backingThreadParams({ ...base, model: "" });
  assert.equal(params.model, DEFAULT_MODEL);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal((params.config as Record<string, unknown>)["model_reasoning_effort"], "high");
  assert.deepEqual((params.config as Record<string, unknown>)["sandbox_workspace_write"], {
    network_access: true,
  });
  // The shell must run `t3` against this server, not Codex's default home.
  assert.equal(
    (params.config as Record<string, unknown>)["shell_environment_policy.set.T3CODE_HOME"],
    "/state",
  );

  const configured = backingThreadParams({ ...base, model: "gpt-5" });
  assert.equal(configured.model, "gpt-5");

  const reading = backingThreadParams({ ...base, model: "", toolAccess: "read-only" });
  assert.equal(reading.sandbox, "read-only");
  assert.notProperty(reading.config as Record<string, unknown>, "sandbox_workspace_write");
  assert.notProperty(
    reading.config as Record<string, unknown>,
    "shell_environment_policy.set.T3CODE_HOME",
  );
  assert.include(reading.developerInstructions, "read-only");
  assert.notInclude(params.developerInstructions, "read-only");
});
