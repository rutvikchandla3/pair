import { assert, it } from "@effect/vitest";
import {
  MemberId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  SPACE_AGENT_INSTANCE_ID,
  SpaceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpaceAgentAdapter from "./SpaceAgentAdapter.ts";
import { SpaceAgentTools, SpaceContext, type SpaceReplyScope } from "./SpaceAgentRuntime.ts";

const NOW = "2026-11-13T10:00:00.000Z";
const threadId = ThreadId.make("room-thread");
const runId = RunId.make("run-1");
const messageId = MessageId.make("message-1");
const tagger = MemberId.make("member-ada");

type Sse = ReadonlyArray<Record<string, unknown>>;
type Reply = {
  readonly status: number;
  readonly sse?: Sse;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

const sse = (events: Sse) =>
  events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

const usage = (input: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  output_tokens: 1,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

const message = (blocks: Sse, stopReason: string, start = usage(10, 0, 0), output = 5): Sse => [
  { type: "message_start", message: { id: "msg", model: "claude-opus-5-5", usage: start } },
  ...blocks,
  { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: output } },
  { type: "message_stop" },
];

const textBlock = (index: number, ...chunks: ReadonlyArray<string>): Sse => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...chunks.map((text) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  })),
  { type: "content_block_stop", index },
];

const thinkingBlock = (index: number): Sse => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index },
];

const toolUseBlock = (index: number, id: string): Sse => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: "list_tasks", input: {} },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: '{"state":' },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: '"open"}' },
  },
  { type: "content_block_stop", index },
];

const ok = (events: Sse): Reply => ({ status: 200, sse: events });
const toolCall = (id: string) => ok(message(toolUseBlock(0, id), "tool_use"));

const appThread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("space-project"),
  title: "Room",
  providerInstanceId: SPACE_AGENT_INSTANCE_ID,
  modelSelection: { instanceId: SPACE_AGENT_INSTANCE_ID, model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  space: { kind: "room", spaceId: SpaceId.make("spc_0123456789abcdef0123") },
};

const userMessage: OrchestrationV2ConversationMessage = {
  id: messageId,
  threadId,
  runId,
  nodeId: null,
  role: "user",
  text: "@pair what's open?",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  authorId: tagger,
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
};

/** Runs one @pair reply against scripted HTTP replies and returns its events and request bodies. */
const runReply = Effect.fn("SpaceAgentAdapterTest.runReply")(function* (
  replies: ReadonlyArray<Reply>,
  options: {
    readonly afterRetryItem?: Effect.Effect<void>;
    readonly teamEnvironment?: ReadonlyArray<{ name: string; value: string; sensitive: boolean }>;
    readonly processEnv?: Record<string, string>;
  } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const urls: Array<string> = [];
  const toolCalls: Array<{
    readonly scope: SpaceReplyScope;
    readonly name: string;
    readonly input: unknown;
  }> = [];
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      const reply = replies[requests.length];
      assert.isDefined(reply, "more model calls than scripted replies");
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push(JSON.parse(raw));
      urls.push(request.url);
      assert.strictEqual(request.headers["x-api-key"], "sk-ant-team");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            reply.sse === undefined ? JSON.stringify(reply.body ?? {}) : sse(reply.sse),
            {
              status: reply.status,
              ...(reply.headers === undefined ? {} : { headers: reply.headers }),
            },
          ),
        ),
      );
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      SpaceContext,
      SpaceContext.of({
        assemble: () =>
          Effect.succeed({
            system: [{ type: "text", text: "You are @pair." }],
            tools: [],
            messages: [{ role: "user", content: "@pair what's open?" }],
          }),
      }),
    ),
    Layer.succeed(
      SpaceAgentTools,
      SpaceAgentTools.of({
        definitions: [],
        call: (scope, name, input) =>
          Effect.sync(() => {
            toolCalls.push({ scope, name, input });
            return { content: "2 open tasks", isError: false };
          }),
      }),
    ),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getMessagesById: () => Effect.succeed(new Map([[messageId, userMessage]])),
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("team")]: {
          driver: "claudeAgent",
          environment: options.teamEnvironment ?? [
            { name: "ANTHROPIC_API_KEY", value: "sk-ant-team", sensitive: true },
          ],
        },
      },
    }),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.processEnv ?? {} })),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* SpaceAgentAdapter.make;
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = appThread.modelSelection;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-1"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const isTerminal = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        event.type === "turn.terminal";
      const isRetry = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "error" &&
        event.turnItem.status === "running";
      const collected = yield* Effect.forkChild(
        Effect.gen(function* () {
          const before =
            options.afterRetryItem === undefined
              ? []
              : yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(isRetry)));
          if (options.afterRetryItem !== undefined) yield* options.afterRetryItem;
          const after = yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(isTerminal)));
          return [...before, ...after];
        }),
      );
      yield* session.startTurn({
        appThread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-1"),
        rootNodeId: NodeId.make("root-1"),
        providerThread,
        message: {
          messageId,
          text: userMessage.text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy: policy,
      });
      const events = yield* Fiber.join(collected);
      return { events, requests, toolCalls, urls };
    }),
  ).pipe(Effect.provide(layer));
});

const terminalOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const terminal = events.at(-1);
  assert(terminal?.type === "turn.terminal");
  return terminal;
};

const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "message.updated" ? [event.message] : []));

const finalUsage = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events
    .flatMap((event) => (event.type === "provider_turn.updated" ? [event.providerTurn] : []))
    .at(-1)?.turnTokenUsage;

it.effect("streams text into one assistant message and finishes completed", () =>
  Effect.gen(function* () {
    const { events, requests } = yield* runReply([
      ok(message(textBlock(0, "Two ", "tasks are open."), "end_turn")),
    ]);
    const messages = assistantMessages(events);
    assert.deepStrictEqual(
      messages.map((entry) => [entry.text, entry.streaming]),
      // Deltas inside one flush window coalesce, so only the finished text is sent.
      [["Two tasks are open.", false]],
    );
    assert.strictEqual(new Set(messages.map((entry) => entry.id)).size, 1);
    assert.strictEqual(terminalOf(events).status, "completed");
    assert.deepStrictEqual(requests[0]?.thinking, { type: "adaptive", display: "omitted" });
    assert.strictEqual(requests[0]?.max_tokens, 16_000);
    assert.strictEqual(requests[0]?.fallbacks, "default");
  }),
);

it.effect("runs a tool round trip, replays thinking and sums usage across calls", () =>
  Effect.gen(function* () {
    const { events, requests, toolCalls } = yield* runReply([
      ok(
        message(
          [...thinkingBlock(0), ...toolUseBlock(1, "toolu_1")],
          "tool_use",
          usage(100, 0, 400),
          30,
        ),
      ),
      ok(message(textBlock(0, "Two are open."), "end_turn", usage(20, 400, 50), 12)),
    ]);
    assert.deepStrictEqual(
      toolCalls.map((call) => [
        call.name,
        call.input,
        call.scope.taggerId,
        call.scope.roomMessageId,
      ]),
      [["list_tasks", { state: "open" }, tagger, messageId]],
    );
    const second = requests[1]?.messages;
    assert(Array.isArray(second));
    assert.deepStrictEqual(second.slice(1), [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "list_tasks", input: { state: "open" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "2 open tasks" }],
      },
    ]);
    const tool = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
        ? [event.turnItem]
        : [],
    );
    assert.deepStrictEqual(
      tool.map((item) => [item.status, item.output]),
      [
        ["running", undefined],
        ["completed", "2 open tasks"],
      ],
    );
    assert.deepStrictEqual(finalUsage(events), {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 100 + 400 + 20 + 400 + 50,
      cachedInputTokens: 400,
      cacheCreationTokens: 450,
      outputTokens: 42,
      models: ["claude-opus-5-5"],
    });
  }),
);

it.effect("waits out a 429 using retry-after, then answers", () =>
  Effect.gen(function* () {
    const { events, requests } = yield* runReply(
      [
        {
          status: 429,
          body: { type: "error", error: { type: "rate_limit_error" } },
          headers: { "retry-after": "7" },
        },
        ok(message(textBlock(0, "Back."), "end_turn")),
      ],
      { afterRetryItem: TestClock.adjust("7 seconds") },
    );
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(terminalOf(events).status, "completed");
    const retryItems = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem] : [],
    );
    assert.deepStrictEqual(
      retryItems.map((item) => item.status),
      ["running", "completed"],
    );
  }),
);

it.effect("maps a rejected key, an empty balance and a refusal to their failures", () =>
  Effect.gen(function* () {
    const cases = [
      [
        { status: 401, body: { error: { type: "authentication_error" } } },
        "permission_error",
        "The Team Claude key was rejected. An admin can replace it in Settings.",
      ],
      [
        { status: 402, body: { error: { type: "billing_error" } } },
        "usage_limit",
        "The Team Claude key is out of credit.",
      ],
      [
        ok(message(textBlock(0, "I can't"), "refusal")),
        "provider_error",
        "Pair couldn't answer this one.",
      ],
    ] as const;
    for (const [reply, failureClass, text] of cases) {
      const terminal = terminalOf((yield* runReply([reply])).events);
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.failure?.class, failureClass);
      assert.strictEqual(terminal.failure?.message, text);
    }
  }),
);

it.effect("pays only with the team Claude instance's key, never the server's own", () =>
  Effect.gen(function* () {
    const unpaid = yield* runReply([], {
      teamEnvironment: [],
      processEnv: { ANTHROPIC_API_KEY: "sk-ant-team" },
    });
    assert.strictEqual(terminalOf(unpaid.events).failure?.code, "missing_key");
    assert.lengthOf(unpaid.requests, 0);

    const gateway = yield* runReply([ok(message(textBlock(0, "Hi"), "end_turn"))], {
      teamEnvironment: [
        { name: "ANTHROPIC_API_KEY", value: "sk-ant-team", sensitive: true },
        { name: "ANTHROPIC_BASE_URL", value: "https://gateway.example", sensitive: false },
      ],
      processEnv: { ANTHROPIC_BASE_URL: "https://elsewhere.example" },
    });
    assert.deepStrictEqual(gateway.urls, ["https://gateway.example/v1/messages"]);
  }),
);

it.effect("stops after eight model calls and says so", () =>
  Effect.gen(function* () {
    const { events, requests, toolCalls } = yield* runReply(
      Array.from({ length: 8 }, (_, index) => toolCall(`toolu_${index}`)),
    );
    assert.strictEqual(requests.length, 8);
    assert.strictEqual(toolCalls.length, 7);
    assert.strictEqual(terminalOf(events).status, "completed");
    assert.match(assistantMessages(events).at(-1)?.text ?? "", /limit of steps/u);
  }),
);
