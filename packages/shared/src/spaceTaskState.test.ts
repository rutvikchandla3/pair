import { CommandId, MemberId, ProjectId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { spaceTaskState, type SpaceTaskStateInput } from "./spaceTaskState.ts";

const owner = MemberId.make("member:kousik");
const runId = RunId.make("run:1");
const at = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");
const started: SpaceTaskStateInput = {
  latestRunId: runId,
  status: "running",
  pendingRuntimeRequest: null,
  lastErrorClass: null,
  limitRecovery: null,
  ownerId: owner,
  linkedPullRequest: null,
  branchPullRequest: null,
  pullRequests: [],
  settledAt: null,
};
const request = (kind: "user_input" | "command", blocking?: boolean) => ({
  id: RuntimeRequestId.make("request:1"),
  kind,
  createdAt: at,
  ...(blocking === undefined ? {} : { blocking }),
});
const pullRequest = {
  projectId: ProjectId.make("project:a"),
  repository: "acme/app",
  number: 482,
  url: "https://github.com/acme/app/pull/482",
};

const table: ReadonlyArray<readonly [string, Partial<SpaceTaskStateInput>, string]> = [
  ["never started", { latestRunId: null, status: "idle" }, "not-started"],
  ["running", {}, "working"],
  ["queued behind a turn", { status: "queued" }, "working"],
  [
    "asks a question",
    { status: "waiting", pendingRuntimeRequest: request("user_input") },
    "needs:answer",
  ],
  [
    "asks to run a command",
    { status: "waiting", pendingRuntimeRequest: request("command") },
    "needs:approval",
  ],
  [
    "an async question it works past",
    { pendingRuntimeRequest: request("user_input", false) },
    "working",
  ],
  ["failed", { status: "failed", lastErrorClass: "provider_error" }, "failed"],
  ["hit a usage limit", { status: "failed", lastErrorClass: "usage_limit" }, "limited"],
  [
    "waits for its limit to reset",
    {
      status: "waiting",
      limitRecovery: { requestId: CommandId.make("c"), runId, resetAt: "2026-11-12T11:00:00.000Z" },
    } as Partial<SpaceTaskStateInput>,
    "limited",
  ],
  ["stopped", { status: "interrupted" }, "stopped"],
  ["cancelled", { status: "cancelled" }, "stopped"],
  [
    "finished with a pull request open",
    { status: "completed", linkedPullRequest: pullRequest },
    "in-review",
  ],
  [
    "finished with a stacked pull request",
    { status: "completed", pullRequests: [{} as never] },
    "in-review",
  ],
  [
    "settled after review",
    { status: "completed", linkedPullRequest: pullRequest, settledAt: at },
    "done",
  ],
  ["finished without a pull request", { status: "completed" }, "done"],
];

describe("spaceTaskState", () => {
  it.each(table)("%s", (_case, change, expected) => {
    const state = spaceTaskState({ ...started, ...change });
    expect(state.type === "needs" ? `needs:${state.reason}` : state.type).toBe(expected);
  });

  it("names the owner as the person a task needs", () => {
    expect(spaceTaskState({ ...started, pendingRuntimeRequest: request("command") })).toEqual({
      type: "needs",
      memberId: owner,
      reason: "approval",
    });
  });
});
