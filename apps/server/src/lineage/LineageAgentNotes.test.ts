import { assert, it } from "@effect/vitest";
import { type OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { pendingAgentNotes } from "./LineageAgentNotes.ts";

const threadId = ThreadId.make("thread:prompt-builder");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const told = (id: string, iso: string, text: string): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at(iso),
  completedAt: at(iso),
  updatedAt: at(iso),
  type: "system_notice",
  message: text,
  lineage: { kind: "agent-told", text },
});

it("tells a turn only what happened since the previous turn started", () => {
  const notices = [
    told("old", "2026-11-15T10:00:00.000Z", "Applied before turn 2"),
    told("new-b", "2026-11-15T10:05:00.000Z", "Updated after turn 2"),
    told("new-a", "2026-11-15T10:04:00.000Z", "Applied after turn 2"),
  ];
  const runs = [
    { id: RunId.make("run:2"), startedAt: at("2026-11-15T10:01:00.000Z") },
    { id: RunId.make("run:queued"), startedAt: null },
    { id: RunId.make("run:3"), startedAt: at("2026-11-15T10:06:00.000Z") },
  ];
  assert.deepStrictEqual(pendingAgentNotes({ runId: RunId.make("run:3"), runs, notices }), [
    "Applied after turn 2",
    "Updated after turn 2",
  ]);
  assert.deepStrictEqual(pendingAgentNotes({ runId: RunId.make("run:1"), runs: [], notices }), [
    "Applied before turn 2",
    "Applied after turn 2",
    "Updated after turn 2",
  ]);
});
