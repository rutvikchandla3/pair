import { describe, expect, it } from "@effect/vitest";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { buildSessionsSnapshot, type SnapshotThread } from "./SessionsSnapshot.ts";
import { threadShell } from "./PairBuilder.testkit.ts";

const SENT_AT = DateTime.makeUnsafe("2026-11-01T01:00:00.000Z");
const session = (thread: Omit<SnapshotThread, "createdBy"> & Partial<SnapshotThread>) =>
  buildSessionsSnapshot({
    sandboxId: "sandbox-1",
    sentAt: SENT_AT,
    connections: 3,
    threads: [{ createdBy: null, ...thread }],
  }).sessions[0];

describe("buildSessionsSnapshot", () => {
  it("describes the sandbox and each thread in the Builder's shape", () => {
    const ada = { id: "u-1", name: "Ada" };
    expect(
      buildSessionsSnapshot({
        sandboxId: undefined,
        sentAt: SENT_AT,
        connections: 3,
        threads: [{ shell: threadShell("t-1"), firstMessage: "Fix it", createdBy: ada }],
      }),
    ).toEqual({
      type: "sessions.snapshot",
      sandbox_id: null,
      sent_at: "2026-11-01T01:00:00.000Z",
      connections: 3,
      sessions: [
        {
          id: "t-1",
          runtime_session_id: null,
          name: "Fix the login bug",
          first_message: "Fix it",
          title: "Fix the login bug",
          created_at: Date.parse("2026-11-01T00:00:00.000Z"),
          updated_at: Date.parse("2026-11-01T00:05:00.000Z"),
          is_streaming: false,
          archived: false,
          created_by: ada,
        },
      ],
    });
  });

  it.each([
    ["a renamed thread keeps its title", "Ship it", "do things", "Ship it"],
    ["an unnamed thread shows its first message", "New thread", "  Fix\nthe bug  ", "Fix the bug"],
    ["an empty title falls back too", " ", "Fix the bug", "Fix the bug"],
    [
      "a long first message is cut to 80 characters",
      "New thread",
      "a".repeat(100),
      `${"a".repeat(79)}…`,
    ],
    ["nothing to show is a new session", "New thread", "", "New session"],
  ])("titles: %s", (_case, title, firstMessage, expected) => {
    expect(session({ shell: threadShell("t", { title }), firstMessage })?.title).toBe(expected);
  });

  it("caps the first message so a pasted log cannot outgrow the Builder's body limit", () => {
    const pasted = `  Fix this:\n${"x".repeat(120_000)}`;
    const sent = session({ shell: threadShell("t"), firstMessage: pasted })?.first_message ?? "";
    expect(Array.from(sent)).toHaveLength(500);
    expect(sent.startsWith("Fix this:\nxxx")).toBe(true);
    expect(sent.endsWith("…")).toBe(true);
  });

  it.each([
    ["an idle thread", {}, false],
    ["a running run", { status: "running" as const }, true],
    ["a preparing activity", { activityRunStatus: "preparing" as const }, true],
    ["a finished run", { status: "completed" as const }, false],
    [
      "a run waiting on an approval",
      {
        status: "waiting" as const,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("r"),
          kind: "command" as const,
          createdAt: SENT_AT,
        },
      },
      false,
    ],
    [
      "a run past an async question",
      {
        status: "running" as const,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("r"),
          kind: "user_input" as const,
          createdAt: SENT_AT,
          blocking: false,
        },
      },
      true,
    ],
  ])("streaming: %s", (_case, overrides, expected) => {
    expect(session({ shell: threadShell("t", overrides), firstMessage: "" })?.is_streaming).toBe(
      expected,
    );
  });

  it("marks archived and deleted threads archived", () => {
    expect(
      session({ shell: threadShell("t", { archivedAt: SENT_AT }), firstMessage: "" })?.archived,
    ).toBe(true);
    expect(
      session({ shell: threadShell("t", { deletedAt: SENT_AT }), firstMessage: "" })?.archived,
    ).toBe(true);
  });
});
