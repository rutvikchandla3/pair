import { CommandId, MemberId, ProjectId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { spaceThreadActivity, type SpaceThreadActivityInput } from "./spaceThreadActivity.ts";

const owner = MemberId.make("member:kousik");
const runId = RunId.make("run:1");
const at = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");
const started: SpaceThreadActivityInput = {
  latestRunId: runId,
  status: "running",
  pendingRuntimeRequest: null,
  lastError: null,
  lastErrorClass: null,
  limitRecovery: null,
  ownerId: owner,
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

const table: ReadonlyArray<readonly [string, Partial<SpaceThreadActivityInput>, string]> = [
  ["no turn yet", { latestRunId: null, status: "idle" }, "idle"],
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
    } as Partial<SpaceThreadActivityInput>,
    "limited",
  ],
  ["stopped", { status: "interrupted" }, "stopped"],
  ["cancelled", { status: "cancelled" }, "stopped"],
  ["turn ended, no PR", { status: "completed" }, "idle"],
  [
    "turn ended with a pull request open",
    { status: "completed", linkedPullRequest: pullRequest } as Partial<SpaceThreadActivityInput>,
    "idle",
  ],
  [
    "turn ended after the thread settled",
    { status: "idle", settledAt: at } as Partial<SpaceThreadActivityInput>,
    "idle",
  ],
];

describe("spaceThreadActivity", () => {
  it.each(table)("%s", (_case, change, expected) => {
    const activity = spaceThreadActivity({ ...started, ...change });
    expect(activity.type === "needs" ? `needs:${activity.reason}` : activity.type).toBe(expected);
  });

  it("names the owner as the person a thread needs", () => {
    expect(spaceThreadActivity({ ...started, pendingRuntimeRequest: request("command") })).toEqual({
      type: "needs",
      memberId: owner,
      reason: "approval",
    });
  });

  it("carries the error as the failure summary", () => {
    expect(
      spaceThreadActivity({ ...started, status: "failed", lastError: "fixtures.test.ts failed" }),
    ).toEqual({ type: "failed", summary: "fixtures.test.ts failed" });
  });
});
