import { assert, it } from "@effect/vitest";
import {
  BOT_ESCALATE_AFTER_MS,
  BOT_QUIET_AFTER_MS,
  BotId,
  type BotJob,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BotPictures from "./BotPictures.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import {
  BotWatcher,
  layer as botWatcherLayer,
  classifyRunEnd,
  dueEscalations,
  isTakeoverMessage,
  mergePullRequests,
  type PendingRequest,
  quietSessions,
  type QuietCandidate,
  REPORT_LIMIT,
  reportRunEnd,
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

it.effect(
  "records a local session's archived thread state, refreshes it when the run ends, and clears it",
  () => {
    const sessionThreadId = ThreadId.make("thread:local-session");
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const now = DateTime.makeUnsafe("2026-11-19T00:00:00.000Z");
    let current: OrchestrationV2ThreadShell = {
      id: sessionThreadId,
      projectId: ProjectId.make("project:bots"),
      title: "Fix the login bug",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "claude-haiku-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: sessionThreadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "agent",
      creationSource: "web",
      activeRunId: RunId.make("run:1"),
      latestRunId: RunId.make("run:1"),
      activityRunStatus: "running",
      status: "running",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const event = (type: "thread.archived" | "thread.unarchived") => ({
      id: EventId.make(`event:${type}`),
      type,
      threadId: sessionThreadId,
      occurredAt: now,
      payload: { ...current, lastVisitedAt: null },
    });
    const bots = BotService.layer({ cloudOnly: false }).pipe(
      Layer.provide(BotStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
      Layer.provide(SecureRandom.layerWebCrypto),
      Layer.provide(Layer.mock(BotPictures.BotPictures)({})),
    );
    const layer = botWatcherLayer.pipe(
      Layer.provideMerge(bots),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.sync(() => current),
          getThreadRecords: () => Effect.succeed({ messages: [] } as never),
        }),
      ),
      Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
    );
    return Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const watcher = yield* BotWatcher;
      const caller = { memberId: MemberId.make("member:rutvik") };
      const bot = yield* service.create(caller, {
        name: "Atlas",
        charter: "Ship it",
        starter: "default",
      });
      const job = yield* service.createJob(caller, { botId: bot.id, request: "Fix the login bug" });
      yield* service.addSession({
        threadId: sessionThreadId,
        botId: bot.id,
        jobId: job.id,
        role: "worker",
        title: "Fix the login bug",
        projectId: current.projectId,
        takenOver: false,
        createdAt: "2026-11-19T00:00:00.000Z",
      });
      const archived = () =>
        service
          .sessionForThread(sessionThreadId)
          .pipe(Effect.map((s) => Option.getOrThrow(s).archived));

      yield* watcher.handle(event("thread.archived"));
      assert.strictEqual(yield* archived(), "working");
      assert.strictEqual(Option.getOrThrow(yield* service.getJob(job.id)).status, "working");

      current = { ...current, activeRunId: null, activityRunStatus: null, status: "completed" };
      yield* watcher.handle({
        id: EventId.make("event:run.updated"),
        type: "run.updated",
        threadId: sessionThreadId,
        occurredAt: now,
        payload: {
          id: RunId.make("run:1"),
          threadId: sessionThreadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: current.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:1"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      assert.strictEqual(yield* archived(), "done");

      current = { ...current, archivedAt: null };
      yield* watcher.handle(event("thread.unarchived"));
      assert.strictEqual(yield* archived(), undefined);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("hands a finished session's report to the bot, cut at its limit", () =>
  Effect.gen(function* () {
    const wakes: Array<BotService.BotWake> = [];
    const bots = {
      addEvent: () => Effect.succeed({} as never),
      publishWake: (wake: BotService.BotWake) => Effect.sync(() => void wakes.push(wake)),
    } as unknown as BotService.BotService["Service"];
    const session = {
      threadId,
      botId,
      jobId: "job:1",
      role: "worker",
      title: "Fix the login bug",
      projectId: ProjectId.make("project:bots"),
      takenOver: false,
      createdAt: "2026-11-19T00:00:00.000Z",
    } as const;
    const job = { status: "working" } as BotJob;
    const completed = { kind: "completed", resetAt: null, error: null } as const;

    yield* reportRunEnd(bots, session as never, job, completed, "Fixed it. Tests pass.");
    yield* reportRunEnd(bots, session as never, job, completed, null);
    yield* reportRunEnd(bots, session as never, job, completed, "x".repeat(REPORT_LIMIT + 50));

    assert.deepStrictEqual(
      wakes.map((wake) => [wake.text, wake.report]),
      [
        [
          'Session "Fix the login bug" (thread thread:session) finished. Its report is below; continue the job or finish it.',
          'Report from "Fix the login bug":\nFixed it. Tests pass.',
        ],
        [
          'Session "Fix the login bug" (thread thread:session) finished. Read its report with t3_thread_read, then continue the job or finish it.',
          undefined,
        ],
        [
          'Session "Fix the login bug" (thread thread:session) finished. Its report is below; continue the job or finish it.',
          `Report from "Fix the login bug" (cut short; t3_thread_read has the rest):\n${"x".repeat(REPORT_LIMIT - 1)}…`,
        ],
      ],
    );
  }),
);
