import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { Space, SpaceSystemLine, SpaceTask, ThreadSpace } from "./space.ts";

const json = (schema: Schema.Codec<unknown, unknown>) => {
  const codec = Schema.toCodecJson(schema);
  return {
    roundTrip: (value: unknown) => Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(value)),
    decodes: (value: unknown) => Schema.decodeUnknownExit(codec)(value)._tag === "Success",
  };
};

const taskId = "stk_0123456789abcdef0123";
const at = "2026-11-13T10:00:00.000Z";
const task = {
  id: taskId,
  spaceId: "spc_0123456789abcdef0123",
  title: "Question schema v2",
  description: "Move questions to the v2 schema.",
  ownerId: "member:kousik",
  createdBy: "member:rutvik",
  createdAt: at,
  assignedBy: "member:rutvik",
  status: "in-review",
  statusVersion: 3,
  statusChangedAt: at,
  statusChangedBy: { type: "pair", runId: "run:1", actionId: "act_1" },
  handedBack: null,
  remindedAt: null,
  via: { runId: "run:1", roomMessageId: "message:1" },
  updatedAt: at,
  deletedAt: null,
};

describe("space task contracts", () => {
  it.each([
    { name: "a task", change: {}, valid: true },
    {
      name: "a task id from another table",
      change: { id: "spc_0123456789abcdef0123" },
      valid: false,
    },
    { name: "status version 0", change: { statusVersion: 0 }, valid: false },
    { name: "a v1 status", change: { status: "not-started" }, valid: false },
  ])("$name", ({ change, valid }) => {
    const value = { ...task, ...change };
    const codec = json(SpaceTask);
    expect(codec.decodes(value)).toBe(valid);
    if (valid) expect(codec.roundTrip(value)).toEqual(value);
  });

  it.each([
    {
      name: "a task link",
      space: {
        kind: "task",
        spaceId: task.spaceId,
        taskId,
        linkedBy: "member:kousik",
        linkedAt: at,
        via: "attach",
      },
      valid: true,
    },
    {
      name: "a v1 task thread",
      space: {
        kind: "task",
        spaceId: task.spaceId,
        createdBy: "member:rutvik",
        description: "Move questions.",
        base: { baseRef: "main" },
      },
      valid: false,
    },
  ])("reads $name on a thread", ({ space, valid }) => {
    expect(json(ThreadSpace).decodes(space)).toBe(valid);
    if (valid) expect(json(ThreadSpace).roundTrip(space)).toEqual(space);
  });

  it.each([
    { type: "task-created", taskId, ownerId: "member:kousik" },
    { type: "task-handed-back", taskId, reason: "No time this week" },
    { type: "task-assigned", taskId, from: null, to: "member:hanad" },
    { type: "task-edited", taskId },
    {
      type: "task-status",
      taskId,
      from: "in-progress",
      to: "in-review",
      by: { type: "agent", threadId: "thread:1" },
      askedBy: "member:kousik",
      version: 2,
      undoOf: null,
    },
    {
      type: "task-thread-added",
      taskId,
      threadId: "thread:1",
      threadOwnerId: "member:kousik",
      via: "move",
    },
    { type: "task-thread-removed", taskId, threadId: "thread:1", threadOwnerId: "member:kousik" },
    { type: "member-removed", memberId: "member:hanad", reassignedTo: "member:rutvik", tasks: 2 },
    { type: "left", reassignedTo: null, tasks: 0 },
    {
      type: "repositories-changed",
      repositoryIds: ["project:fe", "project:be"],
      projectId: "project:ws",
    },
  ])("round-trips a $type line", (line) => {
    expect(json(SpaceSystemLine).roundTrip(line)).toEqual(line);
  });

  it("reads a v1 removal line as nothing reassigned, and drops lines v2 removed", () => {
    expect(
      json(SpaceSystemLine).roundTrip({ type: "member-removed", memberId: "member:hanad" }),
    ).toEqual({ type: "member-removed", memberId: "member:hanad", reassignedTo: null, tasks: 0 });
    expect(json(SpaceSystemLine).roundTrip({ type: "left" })).toEqual({
      type: "left",
      reassignedTo: null,
      tasks: 0,
    });
    expect(
      json(SpaceSystemLine).decodes({ type: "billing-changed", pairBilling: { type: "team" } }),
    ).toBe(false);
    expect(
      json(SpaceSystemLine).decodes({ type: "project-changed", projectId: "project:be" }),
    ).toBe(false);
  });

  it.each([
    { count: 0, valid: false },
    { count: 1, valid: true },
    { count: 8, valid: true },
    { count: 9, valid: false },
  ])("takes $count repositories: $valid", ({ count, valid }) => {
    const space = {
      id: task.spaceId,
      roomThreadId: "thread:room",
      name: "Question creation",
      brief: "",
      repositoryIds: Array.from({ length: count }, (_, i) => `project:${i}`),
      projectId: "project:ws",
      ownerId: "member:rutvik",
      members: [],
      joinRequests: [],
      createdBy: "member:rutvik",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      archivedBy: null,
    };
    expect(json(Space).decodes(space)).toBe(valid);
  });
});
