import { assert, it } from "@effect/vitest";
import { DEFAULT_TEXT_GENERATION_MODEL } from "@t3tools/contracts";

import {
  backingThreadParams,
  formatStatus,
  homeInstructions,
  realtimeFailure,
  relayInstructions,
  STATUS_THREAD_CAP,
  triggerDigest,
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

it("describes the home thread as an owner-level operator that keeps a Summary line", () => {
  const instructions = homeInstructions();
  assert.include(instructions, "owner-level operator");
  assert.include(instructions, "delegate_task");
  assert.include(instructions, "create_threads");
  assert.include(instructions, "`t3` CLI");
  assert.include(instructions, "without trying it first");
  assert.include(instructions, "force-push");
  assert.include(
    instructions,
    "Your long-term memory is in MEMORY.md in this folder. Read it at the start of each turn when it exists, and keep it current with the `cos_memory_*` tools.",
  );
  assert.include(instructions, "prefixed `Summary:`");
  assert.include(instructions, "[Chief of staff event digest");
  assert.include(instructions, "handle them quietly");
  assert.include(instructions, "`schedule_task` for recurring briefs");
});

it("renders one line per transition and names what a cap dropped", () => {
  const digest = triggerDigest(
    [
      { threadId: "thread-1", title: "Build it", project: "Pair", kind: "finished" },
      { threadId: "thread-2", title: "Fix it", project: undefined, kind: "failed" },
      { threadId: "thread-3", title: "Check it", project: "web", kind: "interrupted" },
      { threadId: "thread-4", title: "Review", project: "web", kind: "approval" },
      { threadId: "thread-5", title: "Answer", project: "web", kind: "answer" },
    ],
    2,
  );
  assert.include(digest, "[Chief of staff event digest: automatic]");
  assert.include(digest, '- "Build it" (project "Pair"): finished (thread thread-1)');
  assert.include(digest, '- "Fix it": failed (thread thread-2)');
  assert.include(digest, '- "Check it" (project "web"): was interrupted (thread thread-3)');
  assert.include(digest, '- "Review" (project "web"): needs approval (thread thread-4)');
  assert.include(
    digest,
    '- "Answer" (project "web"): is waiting for the user\'s answer (thread thread-5)',
  );
  assert.include(digest, "2 earlier events were dropped by the rate limit");
  assert.include(digest, "`Summary: nothing needs you.`");
});

it("omits the dropped line and singularises one", () => {
  const event = [
    { threadId: "thread-1", title: "Build it", project: "Pair", kind: "finished" as const },
  ];
  assert.notInclude(triggerDigest(event, 0), "dropped by the rate limit");
  assert.include(triggerDigest(event, 1), "1 earlier event was dropped by the rate limit");
});

it("makes the voice relay to the home thread and speak its Summary", () => {
  const instructions = relayInstructions("thread:home-1");
  assert.include(instructions, "only the voice");
  assert.include(instructions, "t3_thread_send with threadId thread:home-1");
  assert.include(instructions, "t3_thread_wait");
  assert.include(instructions, "90000");
  assert.include(instructions, "t3_thread_read");
  assert.include(instructions, "Summary:");
  assert.include(instructions, "report back");
  assert.include(instructions, "confirmation");
  assert.include(instructions, "allow or decline it in the app");
});

it("keeps an unrecognised realtime refusal's own words", () => {
  const error = realtimeFailure("socket closed");
  assert.equal(error.reason, "start-failed");
  assert.include(error.message, "socket closed");
});

it("makes the voice backing thread read-only with a low-effort fast model", () => {
  const base = {
    cwd: "/workspace",
    homeThreadId: "thread:home-1",
    mcpEndpoint: "http://127.0.0.1/mcp",
    mcpAuthorizationHeader: "Bearer x",
  };
  const params = backingThreadParams({ ...base, model: "" });
  assert.equal(params.model, DEFAULT_TEXT_GENERATION_MODEL);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.sandbox, "read-only");
  assert.equal((params.config as Record<string, unknown>)["model_reasoning_effort"], "low");
  assert.include(params.developerInstructions, "thread:home-1");
  assert.deepEqual((params.config as Record<string, unknown>)["mcp_servers.t3-code"], {
    url: "http://127.0.0.1/mcp",
    http_headers: { Authorization: "Bearer x" },
    default_tools_approval_mode: "approve",
  });

  const configured = backingThreadParams({ ...base, model: "gpt-5" });
  assert.equal(configured.model, "gpt-5");
});
