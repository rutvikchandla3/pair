import { assert, it } from "@effect/vitest";
import {
  MemberId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as SandboxAttachments from "../sandbox/attachments/SandboxAttachments.ts";
import * as TeamState from "../team/TeamState.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

function layerProjectionStore(
  getProviderControlContext: ProjectionStore.ProjectionStoreV2["Service"]["getProviderControlContext"],
  overrides: Partial<ProjectionStore.ProjectionStoreV2["Service"]> = {},
) {
  return Layer.mock(ProjectionStore.ProjectionStoreV2)({
    apply: () => Effect.void,
    getProviderControlContext,
    ...overrides,
  });
}

function layerSessions(
  liveSessionId: ProviderSessionId,
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  return Layer.succeed(
    ProviderSessionManager.ProviderSessionManagerV2,
    ProviderSessionManager.ProviderSessionManagerV2.of({
      shutdown: Effect.void,
      open: () => Effect.die("unused open"),
      get: (providerSessionId) =>
        Effect.succeed(providerSessionId === liveSessionId ? Option.some(runtime) : Option.none()),
      isLive: (providerSessionId) => Effect.succeed(providerSessionId === liveSessionId),
      close: () => Effect.void,
      closeInstance: () => Effect.void,
      release: () => Effect.void,
      detach: () => Effect.void,
      otherWorkingThreads: () => Effect.succeed([]),
      releaseUnlessBusy: () => Effect.succeed(true),
      forgetLoadedProviderThread: () => Effect.void,
      subscribePromptSuggestion: () => Stream.empty,
    }),
  );
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const steered = yield* Ref.make<ReadonlyArray<string>>([]);
      const steerCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const attachment = {
        type: "image",
        id: "thread-restart-session-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      } as const;
      const steeringMessage: OrchestrationV2ConversationMessage = {
        id: MessageId.make("message:steer"),
        threadId,
        runId: RunId.make("run:restart-session"),
        nodeId: null,
        role: "user",
        text: "Ship it",
        attachments: [attachment],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        authorId: MemberId.make("member-alice"),
        senderLabel: "name_with_note",
        createdAt: now,
        updatedAt: now,
      };
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = layerProjectionStore(
        (_threadId, target) =>
          Ref.get(projection).pipe(
            Effect.map((current) => ({
              providerThread: current.providerThreads.find(
                (thread) => thread.id === target.providerThreadId,
              ),
              providerTurn: current.providerTurns.find((turn) => turn.id === target.providerTurnId),
              attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
              message: target.messageId === undefined ? undefined : steeringMessage,
              run:
                target.messageId === undefined
                  ? undefined
                  : ({ id: RunId.make("run:restart-session") } as never),
            })),
          ),
        { getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)) },
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId
                ? Option.some(runtime)
                : providerSessionId === replacementSessionId
                  ? Option.some({
                      ...runtime,
                      steerTurn: ({ message }) =>
                        Ref.update(steered, (texts) => [...texts, message.text]).pipe(
                          Effect.andThen(Ref.update(steerCalls, (calls) => [...calls, "steer"])),
                        ),
                    })
                  : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
          otherWorkingThreads: () => Effect.succeed([]),
          releaseUnlessBusy: () => Effect.succeed(true),
          subscribePromptSuggestion: () => Stream.empty,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerProjection,
            layerSessionManager,
            Layer.mock(SandboxAttachments.SandboxAttachmentStaging)({
              stage: ({ cwd, attachments }) =>
                Ref.update(steerCalls, (calls) => [
                  ...calls,
                  `stage ${cwd}: ${attachments.map((candidate) => candidate.id).join(",")}`,
                ]),
            }),
            TeamState.layerTest([
              {
                id: MemberId.make("member-alice"),
                name: "Alice",
                role: "member",
                gitName: null,
                gitEmail: null,
                isOwner: false,
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: null,
                removedAt: null,
              },
            ]),
            Layer.mock(EventSink.EventSinkV2)({}),
            McpAppModelContext.layerEmpty,
          ),
        ),
      );

      // A steer to the live replacement session names its sender.
      yield* ProviderTurnControlService.ProviderTurnControlServiceV2.pipe(
        Effect.flatMap((control) =>
          control.steer({
            threadId,
            providerSessionId: replacementSessionId,
            providerThreadId,
            providerTurnId,
            messageId: steeringMessage.id,
          }),
        ),
        Effect.provide(layerControl),
      );
      assert.deepEqual(yield* Ref.get(steered), [
        "Several people are prompting this thread; each message names its sender.\n\nMessage from Alice:\n\nShip it",
      ]);

      // The machine gets the files, on the session's cwd, before the provider hears of the message.
      assert.deepEqual(yield* Ref.get(steerCalls), ["stage /workspace: " + attachment.id, "steer"]);

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect("steers a running turn with its sender and the thread's MCP app model context", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:steer-app-context");
    const sessionId = ProviderSessionId.make("provider-session:steer-app-context");
    const providerTurnId = ProviderTurnId.make("provider-turn:steer-app-context");
    const attemptId = RunAttemptId.make("run-attempt:steer-app-context");
    const providerThread = {
      id: ProviderThreadId.make("provider-thread:steer-app-context"),
      driver,
      providerInstanceId,
      providerSessionId: sessionId,
    } as OrchestrationV2ProviderThread;
    const projection = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
    const steered: Array<ProviderAdapter.ProviderAdapterV2SteerInput> = [];
    const runtime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId: sessionId,
      steerTurn: (input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
        Effect.sync(() => void steered.push(input)),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const layerControl = ProviderTurnControlService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerProjectionStore(() =>
            Effect.succeed({
              providerThread,
              providerTurn: projection.providerTurns[0],
              attempt: projection.attempts[0],
              message: {
                id: MessageId.make("message:steer-app-context"),
                text: "What did the app report?",
                attachments: [],
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("thread:steer-sender"),
              } as unknown as NonNullable<
                ProjectionStore.ProjectionProviderControlContext["message"]
              >,
              run: {
                id: RunId.make("run:steer-app-context"),
                status: "running",
                activeAttemptId: attemptId,
              } as OrchestrationV2Run,
            }),
          ),
          layerSessions(sessionId, runtime),
          Layer.mock(EventSink.EventSinkV2)({}),
          Layer.mock(SandboxAttachments.SandboxAttachmentStaging)({}),
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () =>
              Effect.succeed([
                {
                  itemId: "turn-item:call-1",
                  server: "tools",
                  tool: "picker",
                  text: "Pressed: blue",
                },
              ]),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      yield* control.steer({
        threadId,
        providerSessionId: sessionId,
        providerThreadId: providerThread.id,
        providerTurnId,
        messageId: MessageId.make("message:steer-app-context"),
      });
    }).pipe(Effect.provide(layerControl));

    assert.equal(steered.length, 1);
    assert.equal(
      steered[0]!.message.text,
      '[T3 Code: the agent in T3 thread "thread:steer-sender" sent this message, not the user.]\n\nWhat did the app report?',
    );
    assert.deepEqual("appContext" in steered[0]! ? steered[0].appContext : undefined, [
      { key: "mcp_app_turn-item_call-1", text: "Pressed: blue" },
    ]);
  }),
);
