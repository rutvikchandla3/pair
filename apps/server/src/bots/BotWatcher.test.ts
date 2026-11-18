import { assert, it } from "@effect/vitest";
import {
  BOT_ESCALATE_AFTER_MS,
  BOT_QUIET_AFTER_MS,
  BotId,
  type BotJob,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";

import {
  classifyRunEnd,
  dueEscalations,
  isTakeoverMessage,
  mergePullRequests,
  type PendingRequest,
  quietSessions,
  type QuietCandidate,
  type TakeoverEvent,
} from "./BotWatcher.ts";

const threadId = ThreadId.make("thread:session");
const botId = BotId.make("bot:atlas");
const requestId = RuntimeRequestId.make("request:1");
const MINUTE = 60_000;

type ShellFailureFields = Pick<
  OrchestrationV2ThreadShell,
  "lastErrorClass" | "lastError" | "usageLimitResetAt"
>;
const shell = (overrides: Partial<ShellFailureFields> = {}): ShellFailureFields => ({
  lastErrorClass: overrides.lastErrorClass ?? null,
  lastError: overrides.lastError ?? null,
  usageLimitResetAt: overrides.usageLimitResetAt ?? null,
});

it("classifies a completed run", () => {
  assert.deepStrictEqual(classifyRunEnd("completed", shell()), {
    kind: "completed",
    resetAt: null,
    error: null,
  });
});

it("classifies a usage limit with its reset time", () => {
  const resetAt = "2026-11-18T14:00:00.000Z";
  assert.deepStrictEqual(
    classifyRunEnd("failed", shell({ lastErrorClass: "usage_limit", usageLimitResetAt: resetAt })),
    { kind: "usage-limit", resetAt, error: null },
  );
});

it("classifies another failure, keeping the shell's error", () => {
  assert.deepStrictEqual(
    classifyRunEnd("failed", shell({ lastErrorClass: "provider_error", lastError: "boom" })),
    { kind: "failed", resetAt: null, error: "boom" },
  );
});

it("classifies an interrupted or cancelled run as stopped, and a running one as nothing", () => {
  assert.deepStrictEqual(classifyRunEnd("interrupted", shell()), {
    kind: "stopped",
    resetAt: null,
    error: null,
  });
  assert.deepStrictEqual(classifyRunEnd("cancelled", shell()), {
    kind: "stopped",
    resetAt: null,
    error: null,
  });
  assert.strictEqual(classifyRunEnd("running", shell()), null);
});

const message = (payload: {
  readonly role?: string;
  readonly createdBy?: string;
  readonly idleCompaction?: string;
}): TakeoverEvent => ({ type: "message.updated", threadId, payload });

it("reads a user's own message as taking over", () => {
  assert.isTrue(
    isTakeoverMessage(message({ role: "user", createdBy: "user" }), {
      threadId,
      takenOver: false,
    }),
  );
});

it("never reads an agent's message, or the session's first message, as taking over", () => {
  assert.isFalse(
    isTakeoverMessage(message({ role: "user", createdBy: "agent" }), {
      threadId,
      takenOver: false,
    }),
  );
  assert.isFalse(
    isTakeoverMessage(message({ role: "assistant", createdBy: "user" }), {
      threadId,
      takenOver: false,
    }),
  );
  assert.isFalse(
    isTakeoverMessage(message({ role: "user", createdBy: "user", idleCompaction: "onReturn" }), {
      threadId,
      takenOver: false,
    }),
  );
  assert.isFalse(
    isTakeoverMessage(
      { type: "run.updated", threadId, payload: { role: "user", createdBy: "user" } },
      { threadId, takenOver: false },
    ),
  );
});

const pending = (since: number, bot = botId): PendingRequest => ({
  threadId,
  requestId,
  botId: bot,
  since,
});

it("escalates a request after ten minutes, but not before", () => {
  const now = 1_000_000_000;
  const paused = new Set<string>();
  assert.deepStrictEqual(
    dueEscalations([pending(now - BOT_ESCALATE_AFTER_MS + 1)], now, paused),
    [],
  );
  assert.strictEqual(dueEscalations([pending(now - BOT_ESCALATE_AFTER_MS)], now, paused).length, 1);
});

it("escalates a paused bot's request at once", () => {
  const now = 1_000_000_000;
  assert.strictEqual(dueEscalations([pending(now - MINUTE)], now, new Set([botId])).length, 1);
  assert.deepStrictEqual(dueEscalations([pending(now - MINUTE)], now, new Set()), []);
});

const candidate = (overrides: Partial<QuietCandidate> = {}): QuietCandidate => ({
  threadId,
  jobStatus: "working",
  active: true,
  lastOutputAt: 0,
  ...overrides,
});

it("wakes a quiet working session once per stretch, and clears the mark on new output", () => {
  const now = BOT_QUIET_AFTER_MS + 1;
  const first = quietSessions([candidate()], now, new Set());
  assert.strictEqual(first.due.length, 1);
  assert.isTrue(first.woken.has(threadId));

  // The mark holds while the stretch continues.
  const second = quietSessions([candidate()], now + MINUTE, first.woken);
  assert.deepStrictEqual(second.due, []);
  assert.isTrue(second.woken.has(threadId));

  // New output ends the stretch, so the next quiet stretch wakes again.
  const fresh = quietSessions(
    [candidate({ lastOutputAt: now + MINUTE })],
    now + MINUTE,
    second.woken,
  );
  assert.deepStrictEqual(fresh.due, []);
  assert.isFalse(fresh.woken.has(threadId));
});

it("never calls a finished, idle or still-chatty session quiet", () => {
  const now = BOT_QUIET_AFTER_MS + 1;
  assert.deepStrictEqual(
    quietSessions([candidate({ lastOutputAt: now - MINUTE })], now, new Set()).due,
    [],
  );
  assert.deepStrictEqual(quietSessions([candidate({ jobStatus: "done" })], now, new Set()).due, []);
  assert.deepStrictEqual(quietSessions([candidate({ active: false })], now, new Set()).due, []);
});

it("merges a session's pull requests into the job by number", () => {
  const existing: ReadonlyArray<BotJob["pullRequests"][number]> = [
    { number: 1, url: "https://example.test/1", state: "open" },
  ];
  const merged = mergePullRequests(existing, [
    { number: 1, url: "https://example.test/1", snapshot: { state: "merged" } },
    { number: 2, url: "https://example.test/2", snapshot: null },
  ]);
  assert.deepStrictEqual(merged, [
    { number: 1, url: "https://example.test/1", state: "merged" },
    { number: 2, url: "https://example.test/2", state: "open" },
  ]);
});
