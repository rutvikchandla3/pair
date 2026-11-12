import { assert, it } from "@effect/vitest";

import { formatStatus, realtimeFailure, STATUS_THREAD_CAP } from "./chiefOfStaffProtocol.ts";

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
