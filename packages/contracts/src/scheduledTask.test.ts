import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const encodeTask = Schema.encodeSync(ScheduledTask);
const decodeUpsertInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

describe("a scheduled task's access", () => {
  const stored = {
    id: "task-1",
    title: "Nightly",
    prompt: "Run the suite",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  it("is absent on a task from before, which reads as team", () => {
    expect(decodeTask(stored).access).toBeUndefined();
  });

  it("round-trips, and an audience from a newer server reads as null", () => {
    const access = { audience: "members", memberIds: ["member-ada"] };
    const task = decodeTask({ ...stored, createdByMemberId: "member-rutvik", access });
    expect(encodeTask(task)).toMatchObject({
      createdByMemberId: "member-rutvik",
      access,
    });
    expect(decodeTask({ ...stored, access: { audience: "groups", memberIds: [] } }).access).toEqual(
      { audience: null, memberIds: [] },
    );
  });

  it("is chosen on save from the two known audiences", () => {
    const { id: _id, createdAt: _c, ...input } = stored;
    expect(
      decodeUpsertInput({ ...input, access: { audience: "team", memberIds: [] } }).access,
    ).toEqual({
      audience: "team",
      memberIds: [],
    });
    expect(() =>
      decodeUpsertInput({ ...input, access: { audience: "groups", memberIds: [] } }),
    ).toThrow();
  });
});
