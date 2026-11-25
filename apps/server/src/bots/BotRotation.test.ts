import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SessionRotation from "../orchestration-v2/SessionRotation.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { composeBrief, estimateTokens } from "./botBrief.ts";
import { at, heavyBriefInput } from "./botFixtures.testkit.ts";
import {
  BotRotation,
  composeSeed,
  effectiveBudget,
  FLUSH_MESSAGE_PREFIX,
  flushBlocked,
  flushPlan,
  layer as botRotationLayer,
  rotationDue,
  rotationWaitsForFlush,
} from "./BotRotation.ts";
import { BotSessions } from "./BotSessions.ts";
import { BotService } from "./BotService.ts";
import { BotThreads } from "./botThreads.ts";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const usage = (
  usedTokens: number,
  expiresInMs?: number,
  window?: { readonly maxTokens?: number; readonly autoCompactThreshold?: number },
) => ({
  usedTokens,
  promptCacheExpiresAt:
    expiresInMs === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(NOW + expiresInMs)),
  ...window,
});

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  options: { readonly flush?: boolean; readonly started?: boolean } = {},
) => ({
  ordinal,
  status,
  // Cancelled runs default to never started: a removed queued message.
  startedAt:
    (options.started ?? !["queued", "preparing", "starting", "cancelled"].includes(status))
      ? DateTime.makeUnsafe(at(ordinal))
      : null,
  userMessageId: MessageId.make(
    options.flush === true ? `${FLUSH_MESSAGE_PREFIX}run:${ordinal}` : `message:${ordinal}`,
  ),
});

describe("rotation rules", () => {
  it("starts fresh past the budget, at budget 0, or once a big session went cold", () => {
    const due = (input: Partial<Parameters<typeof rotationDue>[0]>) =>
      rotationDue({ budget: 150_000, usage: null, nowMs: NOW, flush: false, ...input });
    assert.deepStrictEqual(
      [
        due({ usage: usage(150_000) }),
        due({ usage: usage(149_999) }),
        due({ budget: 0 }),
        due({ usage: usage(80_000, -1) }),
        due({ usage: usage(80_000, 60_000) }),
        // Small cold sessions are cheaper to re-read than to replace.
        due({ usage: usage(20_000, -1) }),
        // No usage reported: nothing to measure, so it resumes.
        due({}),
        // The flush runs on the session it saves.
        due({ usage: usage(200_000), flush: true }),
        due({ budget: 0, flush: true }),
        // Claude set to a 150k window compacts at 117k, so the budget drops to 70% of that.
        due({ usage: usage(82_000, undefined, { autoCompactThreshold: 117_000 }) }),
        due({ usage: usage(81_000, undefined, { autoCompactThreshold: 117_000 }) }),
      ],
      [true, false, true, true, false, false, false, false, false, true, false],
    );
  });

  it("rotates below where the provider would compact, never above the configured budget", () => {
    const budget = (window?: Parameters<typeof usage>[2]) =>
      effectiveBudget(150_000, window === undefined ? null : usage(0, undefined, window));
    assert.deepStrictEqual(
      [
        budget({ maxTokens: 200_000 }),
        // A big window keeps the configured budget: a bigger session re-reads more every turn.
        budget({ maxTokens: 1_000_000 }),
        budget({ maxTokens: 1_000_000, autoCompactThreshold: 117_000 }),
        // A window too small to hold a seed and a few turns is left to the provider's compaction.
        budget({ maxTokens: 32_000 }),
        budget({}),
        budget(),
        effectiveBudget(0, usage(0, undefined, { maxTokens: 200_000 })),
      ],
      [140_000, 150_000, 81_900, 150_000, 150_000, 150_000, 0],
    );
  });

  it("waits a turn for the flush only after a completed run that was not one", () => {
    const waits = (runs: ReadonlyArray<ReturnType<typeof run>>) => rotationWaitsForFlush(runs, 9);
    assert.deepStrictEqual(
      [
        waits([run(7, "completed"), run(8, "completed")]),
        waits([run(8, "completed", { flush: true })]),
        waits([run(8, "failed", { flush: true })]),
        waits([run(8, "cancelled", { flush: true, started: true })]),
        // A flush cancelled before it started never ran, so the run before it decides.
        waits([run(7, "completed"), run(8, "cancelled", { flush: true })]),
        // So does a queued message the user removed.
        waits([run(7, "completed", { flush: true }), run(8, "cancelled")]),
        // A failed or interrupted turn sends no flush: rotate rather than wait for nothing.
        waits([run(8, "failed")]),
        waits([run(8, "interrupted")]),
        // Queued runs and the turn itself don't count; later ordinals are still queued.
        waits([run(7, "completed", { flush: true }), run(8, "queued"), run(9, "starting")]),
        waits([run(8, "completed", { flush: true }), run(10, "completed")]),
        waits([]),
      ],
      [true, false, false, false, true, false, false, false, false, false, false],
    );
  });

  it("sends a budget flush behind waiting turns, but never a second flush or an idle one they'd waste", () => {
    const now = { atMs: "now" } as const;
    const idle = { atMs: NOW } as const;
    const blocked = (
      runs: ReadonlyArray<ReturnType<typeof run>>,
      plan: { readonly atMs: number | "now" },
    ) => flushBlocked([run(5, "completed"), ...runs], { ordinal: 5 }, plan);
    assert.deepStrictEqual(
      [
        blocked([], now),
        blocked([], idle),
        blocked([run(6, "queued"), run(7, "queued")], now),
        blocked([run(6, "queued")], idle),
        blocked([run(6, "starting")], now),
        blocked([run(6, "running")], now),
        blocked([run(6, "completed")], now),
        blocked([run(6, "queued", { flush: true })], now),
        blocked([run(4, "running", { flush: true })], now),
        // A removed queued message is not waiting.
        blocked([run(6, "cancelled")], idle),
      ],
      [false, false, false, true, false, true, true, true, true, false],
    );
  });

  it("reads a session's context from its latest turn, else from its provider thread", () => {
    assert.deepStrictEqual(
      [
        SessionRotation.currentSessionUsage(
          { usage: { usedTokens: 90_000 }, promptCacheExpiresAt: "2026-11-22T13:00:00.000Z" },
          { contextUsage: { usedTokens: 10 } },
        ),
        // ACP agents report usage per session, on the provider thread.
        SessionRotation.currentSessionUsage(undefined, { contextUsage: { usedTokens: 70_000 } }),
        SessionRotation.currentSessionUsage(undefined, { contextUsage: null }),
        SessionRotation.currentSessionUsage(
          { usage: { usedTokens: 90_000, maxTokens: 200_000 }, autoCompactThreshold: 117_000 },
          { contextUsage: null },
        ),
        SessionRotation.currentSessionUsage(
          { usage: { usedTokens: 90_000, maxTokens: null } },
          { contextUsage: null },
        ),
      ],
      [
        { usedTokens: 90_000, promptCacheExpiresAt: "2026-11-22T13:00:00.000Z" },
        { usedTokens: 70_000, promptCacheExpiresAt: null },
        null,
        {
          usedTokens: 90_000,
          promptCacheExpiresAt: null,
          maxTokens: 200_000,
          autoCompactThreshold: 117_000,
        },
        { usedTokens: 90_000, promptCacheExpiresAt: null },
      ],
    );
  });

  it("flushes now past the budget, just before a big session goes cold, and never twice", () => {
    const plan = (input: Partial<Parameters<typeof flushPlan>[0]>) =>
      flushPlan({ budget: 150_000, usage: null, afterFlush: false, ...input });
    assert.deepStrictEqual(
      [
        plan({ usage: usage(160_000) }),
        plan({ usage: usage(80_000, 3_600_000) }),
        plan({ usage: usage(20_000, 3_600_000) }),
        plan({ usage: usage(80_000) }),
        plan({ usage: usage(160_000), afterFlush: true }),
        plan({ usage: usage(160_000), budget: 0 }),
        plan({ usage: usage(90_000, undefined, { autoCompactThreshold: 117_000 }) }),
      ],
      [
        { atMs: "now" },
        { atMs: NOW + 3_600_000 - 120_000 },
        null,
        null,
        null,
        null,
        { atMs: "now" },
      ],
    );
  });
});

const homeMessage = (index: number): OrchestrationV2ConversationMessage => {
  const role = index % 3 === 2 ? "assistant" : "user";
  return {
    id: MessageId.make(`message:${index}`),
    threadId: ThreadId.make("thread:heavy-home"),
    runId: null,
    nodeId: null,
    role,
    text: `message ${index} ${"lorem ipsum ".repeat(150)}`,
    attachments: [],
    streaming: false,
    createdBy: role === "assistant" ? "agent" : index % 3 === 0 ? "user" : "agent",
    creationSource: "server",
    createdAt: DateTime.makeUnsafe(at(index)),
    updatedAt: DateTime.makeUnsafe(at(index)),
  };
};

describe("composeSeed", () => {
  it("keeps a heavy bot's seed under 40k tokens with 10k messages, 50 open jobs and 200 notes", () => {
    const input = heavyBriefInput();
    const messages = Array.from({ length: 10_000 }, (_, index) => homeMessage(index));
    const seed = composeSeed({ brief: composeBrief(input), messages });

    assert.isBelow(estimateTokens(seed), 40_000);
    assert.include(seed, `Your brief as of ${input.now}`);
    assert.include(seed, "message 9999 ");
    assert.notInclude(seed, "message 0 ");
    assert.include(seed, "User (");
    assert.include(seed, "Pair (");
    assert.include(seed, "You (");
  });
});

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const botId = BotId.make("bot:rotation");
const threadId = ThreadId.make("thread:bot-rotation-home");

interface CapturedTurn {
  readonly runOrdinal: number;
  readonly nativeThreadId: string | null;
  readonly text: string;
}

/** A provider whose every turn reports `usedTokens` of context and answers "ok". */
const makeAdapter = (input: {
  readonly cwd: string;
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  /** Per run ordinal when a function; undefined reports no usage for that turn. */
  readonly usedTokens: number | ((runOrdinal: number) => number | undefined);
  /** When set, reported usage keeps the prompt cache warm this long. */
  readonly promptCacheTtlMs?: number;
}): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const generation = yield* Ref.make(0);
      return {
        instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession: {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: input.cwd,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromPubSub(events),
        ensureThread: ({ threadId: appThreadId }) =>
          Effect.gen(function* () {
            const nativeId = `native:${yield* Ref.updateAndGet(generation, (value) => value + 1)}`;
            return {
              id: ProviderThreadId.make(`provider-thread:${nativeId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            };
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            yield* Ref.update(input.captured, (turns) => [
              ...turns,
              {
                runOrdinal: turn.runOrdinal,
                nativeThreadId: turn.providerThread.nativeThreadRef?.nativeId ?? null,
                text: turn.message.text,
              },
            ]);
            const eventTime = yield* DateTime.now;
            const usedTokens =
              typeof input.usedTokens === "number"
                ? input.usedTokens
                : input.usedTokens(turn.runOrdinal);
            const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.runOrdinal}`);
            const providerTurn = {
              id: providerTurnId,
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: { driver, nativeId: `turn:${turn.runOrdinal}`, strength: "strong" },
              ordinal: turn.providerTurnOrdinal,
              startedAt: eventTime,
            } as const;
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                ...providerTurn,
                status: "running",
                completedAt: null,
                ...(usedTokens === undefined
                  ? {}
                  : {
                      tokenUsage: {
                        usedTokens,
                        updatedAt: DateTime.formatIso(eventTime),
                        ...(input.promptCacheTtlMs === undefined
                          ? {}
                          : {
                              promptCacheExpiresAt: DateTime.formatIso(
                                DateTime.add(eventTime, { milliseconds: input.promptCacheTtlMs }),
                              ),
                            }),
                      },
                    }),
              },
            });
            yield* PubSub.publish(events, {
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: TurnItemId.make(`turn-item:${turn.runOrdinal}:assistant`),
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: turn.runOrdinal * 100 + 1,
                status: "completed",
                title: null,
                startedAt: eventTime,
                completedAt: eventTime,
                updatedAt: eventTime,
                type: "assistant_message",
                messageId: MessageId.make(`message:assistant:${turn.runOrdinal}`),
                text: "ok",
                streaming: false,
              },
            });
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...providerTurn, status: "completed", completedAt: eventTime },
            });
            yield* PubSub.publish(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
});

/** The orchestrator harness and a started-able BotRotation for one home thread. */
const rotationLayers = (input: {
  readonly cwd: string;
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly usedTokens: number | ((runOrdinal: number) => number | undefined);
  readonly promptCacheTtlMs?: number;
  readonly brief: "loads" | "dies";
  readonly paused?: boolean;
}) => {
  const bot = {
    id: botId,
    name: "Atlas",
    charter: "",
    voice: "crisp",
    paused: input.paused ?? false,
    instructions: "Keep diffs boring.",
    limits: [],
    homeProjectId: null,
    models: { brain: modelSelection, worker: modelSelection, reviewer: modelSelection },
    updatedAt: at(0),
  };
  const database = SqlitePersistence.layerMemory;
  const projections = ProjectionStore.layer.pipe(Layer.provide(database));
  const harness = ProviderReplayHarness.layerWithRegistry(
    { name: "bot-rotation" },
    ProviderAdapterRegistry.layerSingle(makeAdapter(input)),
    { runEffectWorker: false, databaseLayer: database },
  );
  const rotation = botRotationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness,
        projections,
        Layer.mock(BotService)({
          getBot: () => Effect.succeedSome(bot as never),
          snapshotForBot: () =>
            input.brief === "dies"
              ? Effect.die(new TypeError("Cannot read properties of undefined"))
              : Effect.succeed({
                  bots: [bot],
                  jobs: [],
                  sessions: [],
                  asks: [],
                  notes: [],
                  events: [],
                  revision: 0,
                } as never),
          listAllBots: () => Effect.succeed([bot] as never),
        }),
        Layer.mock(BotSessions)({ cloudTarget: () => Effect.succeed(null) }),
        Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([]) }),
      ),
    ),
  );
  return { harness, rotation, projections };
};

/**
 * The first `runs` runs done. Each event may queue effects (finalizing a run, starting the next),
 * so the worker is drained before the thread is read again.
 */
const settled = Effect.fn("BotRotationTest.settled")(function* (runs: number) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const done = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.length >= runs &&
    projection.runs
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .slice(0, runs)
      .every((run) => run.status === "completed");
  const afterSequence = yield* eventSink.latestSequence();
  yield* worker.drain();
  const current = yield* orchestrator.getThreadProjection(threadId);
  if (done(current)) return current;
  const [projection] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() =>
      worker.drain().pipe(Effect.andThen(orchestrator.getThreadProjection(threadId))),
    ),
    Stream.filter(done),
    Stream.take(1),
    Stream.runCollect,
  );
  return projection!;
});

// A brief that dies still rotates: resuming would flush again after every turn. A paused bot still
// answers its user, so it flushes the same way.
it.effect.each([
  { brief: "loads", paused: false },
  { brief: "dies", paused: false },
  { brief: "loads", paused: true },
] as const)(
  "after the session passes the budget, flushes on it, then starts the next turn fresh from stored state (brief $brief, paused $paused)",
  ({ brief, paused }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("bot-rotation");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const { harness, rotation } = rotationLayers({
          cwd,
          captured,
          usedTokens: 160_000,
          brief,
          paused,
        });
        BotThreads.setHome(threadId, botId);
        yield* Effect.addFinalizer(() => Effect.sync(() => BotThreads.clearHome(threadId)));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const bots = yield* BotRotation;
          yield* bots.start();
          const send = (id: string, text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:bot-rotation"),
            title: "Atlas",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "system",
            creationSource: "server",
          });

          // The first turn reports 160k of context, past the 150k budget, so the bot saves notes
          // on that session before anything else runs.
          yield* send("first", "Fix the login bug");
          const afterFlush = yield* settled(2);
          assert.isTrue(
            afterFlush.messages
              .find((message) => message.runId === afterFlush.runs[1]!.id)!
              .id.startsWith(FLUSH_MESSAGE_PREFIX),
          );

          // Queued together: the third turn's seed must not show the fourth message early.
          yield* send("third", "What's the status?");
          yield* send("fourth", "Also check the sidebar");
          yield* settled(5);
          yield* send("sixth", "Ship it");
          const final = yield* settled(7);
          const turns = yield* Ref.get(captured);

          assert.deepStrictEqual(
            turns.map((turn) => [turn.runOrdinal, turn.nativeThreadId]),
            [
              [1, "native:1"],
              [2, "native:1"],
              [3, "native:2"],
              // Still past the budget with a message waiting: the session flushes before the
              // waiting turn starts fresh, instead of dropping what it knew unsaved.
              [5, "native:2"],
              [6, "native:3"],
              [7, "native:3"],
              [8, "native:4"],
            ],
          );
          assert.deepStrictEqual(
            final.runs
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((run) => run.userMessageId.startsWith(FLUSH_MESSAGE_PREFIX)),
            [false, true, false, true, false, true, false],
          );
          assert.notInclude(turns[2]!.text, "Also check the sidebar");
          assert.isTrue(turns[3]!.text.startsWith("[Pair] After this turn"));
          assert.isTrue(turns[4]!.text.startsWith("[Pair] This chat now runs on a fresh session"));
          assert.isTrue(turns[4]!.text.endsWith("User message:\nAlso check the sidebar"));
          assert.include(turns[6]!.text, "Also check the sidebar");
          assert.isTrue(turns[1]!.text.startsWith("[Pair] After this turn"));
          const fresh = turns[2]!.text;
          assert.isTrue(fresh.startsWith("[Pair] This chat now runs on a fresh session"));
          assert.include(
            fresh,
            brief === "dies"
              ? "Your brief could not be loaded"
              : '"instructions":"Keep diffs boring."',
          );
          assert.include(fresh, "User (");
          assert.include(fresh, "Fix the login bug");
          assert.notInclude(fresh, "[Pair] After this turn");
          assert.isTrue(fresh.endsWith("User message:\nWhat's the status?"));
          // Same provider thread row, new native session.
          assert.strictEqual(new Set(final.runs.map((run) => run.providerThreadId)).size, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(harness, rotation).pipe(Layer.provide(SessionRotation.layerSlot)),
          ),
        );
      }),
    ),
);

it.effect(
  "on a long home thread, flushes from usage reported many turns ago before its cache goes cold, as a full read decides",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("bot-rotation-long");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        // Turn 1 reports 60k, under the budget but worth an idle flush, on a 3-hour cache; the
        // next 60 report no usage. Only flush checks that still find turn 1 flush before it goes cold.
        const runs = 61;
        const { harness, rotation, projections } = rotationLayers({
          cwd,
          captured,
          usedTokens: (ordinal) => (ordinal === 1 ? 60_000 : undefined),
          promptCacheTtlMs: 3 * 60 * 60_000,
          brief: "loads",
        });
        BotThreads.setHome(threadId, botId);
        yield* Effect.addFinalizer(() => Effect.sync(() => BotThreads.clearHome(threadId)));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          yield* (yield* BotRotation).start();
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:bot-rotation"),
            title: "Atlas",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "system",
            creationSource: "server",
          });
          // The bounded lookup BotRotation runs, replayed here, must pick the full read's turn.
          let memo: ReturnType<typeof ProjectionStore.nextProviderTurnsSince> | undefined;
          for (let ordinal = 1; ordinal <= runs; ordinal++) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`message-${ordinal}`),
              threadId,
              messageId: MessageId.make(`message:${ordinal}`),
              text: `Status ${ordinal}?`,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* settled(ordinal);
            // Later usage must carry a later time, or the store's tie rule keeps the older turn.
            yield* TestClock.adjust("1 minute");
            const providerThreadId = (yield* store.getThread(threadId)).activeProviderThreadId!;
            const full = yield* store.getThreadRecords(threadId, ["providerTurns"], {
              providerTurnThreadIds: [providerThreadId],
              latestProviderTurnUsageOnly: true,
            });
            const bounded = yield* store.getThreadRecords(threadId, ["providerTurns"], {
              providerTurnThreadIds: [providerThreadId],
              providerTurnsSince: memo ?? { providerThreadId, through: null, bestId: null },
            });
            assert.strictEqual(
              bounded.providerTurns.find((turn) => turn.tokenUsage !== undefined)?.id,
              full.providerTurns[0]?.id,
            );
            memo = ProjectionStore.nextProviderTurnsSince(providerThreadId, bounded.providerTurns);
          }

          assert.strictEqual((yield* orchestrator.getThreadProjection(threadId)).runs.length, runs);
          yield* TestClock.adjust("3 hours");
          const final = yield* settled(runs + 1);
          const flushRuns = final.runs.filter((run) =>
            run.userMessageId.startsWith(FLUSH_MESSAGE_PREFIX),
          );
          assert.deepStrictEqual(
            flushRuns.map((run) => run.ordinal),
            [runs + 1],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(harness, rotation, projections).pipe(
              Layer.provide(SessionRotation.layerSlot),
            ),
          ),
        );
      }),
    ),
);
