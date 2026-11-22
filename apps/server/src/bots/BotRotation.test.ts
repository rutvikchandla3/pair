import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
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
  FLUSH_MESSAGE_PREFIX,
  flushPlan,
  layer as botRotationLayer,
  rotationDue,
} from "./BotRotation.ts";
import { BotSessions } from "./BotSessions.ts";
import { BotService } from "./BotService.ts";
import { BotThreads } from "./botThreads.ts";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const usage = (usedTokens: number, expiresInMs?: number) => ({
  usedTokens,
  promptCacheExpiresAt:
    expiresInMs === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(NOW + expiresInMs)),
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
      ],
      [true, false, true, true, false, false, false, false, false],
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
      ],
      [
        { usedTokens: 90_000, promptCacheExpiresAt: "2026-11-22T13:00:00.000Z" },
        { usedTokens: 70_000, promptCacheExpiresAt: null },
        null,
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
      ],
      [{ atMs: "now" }, { atMs: NOW + 3_600_000 - 120_000 }, null, null, null, null],
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
  readonly usedTokens: number;
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
                tokenUsage: {
                  usedTokens: input.usedTokens,
                  updatedAt: DateTime.formatIso(eventTime),
                },
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

it.effect(
  "after the session passes the budget, flushes on it, then starts the next turn fresh from stored state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("bot-rotation");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const bot = {
          id: botId,
          name: "Atlas",
          charter: "",
          voice: "crisp",
          paused: false,
          instructions: "Keep diffs boring.",
          limits: [],
          homeProjectId: null,
          models: { brain: modelSelection, worker: modelSelection, reviewer: modelSelection },
          updatedAt: at(0),
        };
        const database = SqlitePersistence.layerMemory;
        const harness = ProviderReplayHarness.layerWithRegistry(
          { name: "bot-rotation" },
          ProviderAdapterRegistry.layerSingle(makeAdapter({ cwd, captured, usedTokens: 160_000 })),
          { runEffectWorker: false, databaseLayer: database },
        );
        const rotation = botRotationLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              harness,
              ProjectionStore.layer.pipe(Layer.provide(database)),
              Layer.mock(BotService)({
                getBot: () => Effect.succeedSome(bot as never),
                snapshotForBot: () =>
                  Effect.succeed({
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
          const final = yield* settled(4);
          const turns = yield* Ref.get(captured);

          assert.deepStrictEqual(
            turns.slice(0, 4).map((turn) => [turn.runOrdinal, turn.nativeThreadId]),
            [
              [1, "native:1"],
              [2, "native:1"],
              [3, "native:2"],
              // Still past the budget, but a message was waiting: no flush, a fresh session.
              [4, "native:3"],
            ],
          );
          assert.notInclude(turns[2]!.text, "Also check the sidebar");
          assert.include(turns[3]!.text, "What's the status?");
          assert.isTrue(turns[1]!.text.startsWith("[Pair] After this turn"));
          const fresh = turns[2]!.text;
          assert.isTrue(fresh.startsWith("[Pair] This chat now runs on a fresh session"));
          assert.include(fresh, '"instructions":"Keep diffs boring."');
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
