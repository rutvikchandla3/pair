import {
  MemberId,
  SPACE_AGENT_DRIVER,
  SPACE_AGENT_INSTANCE_ID,
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderTurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderTextDeltaCoalescer } from "../orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SpaceAgentAdapterSlot } from "./SpaceAgentAdapterSlot.ts";
import { spaceReplyTrigger } from "./SpaceAgentDecisions.ts";
import {
  SpaceAgentTools,
  SpaceContext,
  type SpaceContentBlock,
  type SpaceMessageParam,
  type SpaceReplyScope,
} from "./SpaceAgentRuntime.ts";

const driver = SPACE_AGENT_DRIVER;
const MAX_MODEL_CALLS = 8;
const TEXT_FLUSH_INTERVAL_MS = 50;
const MAX_OUTPUT_TOKENS = 16_000;
const RETRY_WINDOW_MS = 120_000;
const MAX_RETRY_DELAY_MS = 30_000;
const ANTHROPIC_VERSION = "2023-06-01";
/** Every reply request's settings; `evals/space-agent` sends the same. */
export const SPACE_AGENT_REQUEST_OPTIONS = {
  max_tokens: MAX_OUTPUT_TOKENS,
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "medium" },
  tool_choice: { type: "auto" },
  cache_control: { type: "ephemeral" },
  fallbacks: "default",
} as const;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ERROR_BODY_LIMIT = 4_096;

const SpaceAgentCapabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
};

// ── Messages API over HTTP ─────────────────────────────────────────────

export const SpaceAgentCallErrorKind = Schema.Literals([
  "retryable",
  "transport",
  "rejected",
  "out_of_credit",
  "invalid",
]);

export class SpaceAgentCallError extends Schema.TaggedError<SpaceAgentCallError>()(
  "SpaceAgentCallError",
  {
    kind: SpaceAgentCallErrorKind,
    status: Schema.NullOr(Schema.Number),
    retryAfterMs: Schema.NullOr(Schema.Number),
    errorType: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Claude API call failed (${this.kind}${this.status === null ? "" : ` ${this.status}`}).`;
  }
}

const isRetryable = (error: SpaceAgentCallError) =>
  error.kind === "retryable" || error.kind === "transport";

interface ApiUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly iterations?: ReadonlyArray<ApiUsage> | null;
}

type ApiBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: string; readonly [key: string]: unknown };

type ApiDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: string };

/** The Messages API stream events Pair reads; others are skipped. */
export type SpaceAgentStreamEvent =
  | {
      readonly type: "message_start";
      readonly message: { readonly model?: string; readonly usage?: ApiUsage };
    }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly content_block: ApiBlock;
    }
  | { readonly type: "content_block_delta"; readonly index: number; readonly delta: ApiDelta }
  | { readonly type: "content_block_stop"; readonly index: number }
  | {
      readonly type: "message_delta";
      readonly delta: { readonly stop_reason?: string | null };
      readonly usage?: ApiUsage;
    }
  | { readonly type: "message_stop" }
  | { readonly type: "error"; readonly error?: { readonly type?: string } }
  | { readonly type: "ping" };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const retryAfterMs = (headers: Readonly<Record<string, string | undefined>>, now: number) => {
  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers["retry-after"];
  if (raw === undefined) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
};

/** 429, 529 and 5xx wait and retry; 402 or a billing error is out of credit; 401/403 rejected. */
const classifyHttpStatus = (status: number, errorType: string | null) => {
  if (status === 402 || errorType === "billing_error") return "out_of_credit" as const;
  if (status === 401 || status === 403) return "rejected" as const;
  if (status === 429 || status === 529 || status >= 500) return "retryable" as const;
  return "invalid" as const;
};

export interface SpaceAgentEndpoint {
  readonly apiKey: Redacted.Redacted<string>;
  readonly baseUrl: string;
}

const streamMessages = (
  http: HttpClient.HttpClient,
  endpoint: SpaceAgentEndpoint,
  body: unknown,
): Stream.Stream<SpaceAgentStreamEvent, SpaceAgentCallError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const request = HttpClientRequest.post(
        `${endpoint.baseUrl.replace(/\/+$/u, "")}/v1/messages`,
      ).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": Redacted.value(endpoint.apiKey),
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": FALLBACK_BETA,
          accept: "text/event-stream",
        }),
        HttpClientRequest.bodyJsonUnsafe(body),
      );
      const transport = () =>
        new SpaceAgentCallError({
          kind: "transport",
          status: null,
          retryAfterMs: null,
          errorType: null,
        });
      const response = yield* http.execute(request).pipe(Effect.mapError(transport));
      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const parsed = parseJson(text.slice(0, ERROR_BODY_LIMIT));
        const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
        const errorType = typeof error?.type === "string" ? error.type : null;
        return yield* new SpaceAgentCallError({
          kind: classifyHttpStatus(response.status, errorType),
          status: response.status,
          retryAfterMs: retryAfterMs(response.headers, yield* Clock.currentTimeMillis),
          errorType,
        });
      }
      return response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapError(transport),
        Stream.map((frame) => {
          const event = parseJson(frame.data);
          return isRecord(event) && typeof event.type === "string"
            ? (event as SpaceAgentStreamEvent)
            : undefined;
        }),
        Stream.filter((event) => event !== undefined),
        Stream.mapEffect((event) => {
          if (event.type !== "error") return Effect.succeed(event);
          const errorType = event.error?.type ?? null;
          return Effect.fail(
            new SpaceAgentCallError({
              kind:
                errorType === "overloaded_error" ||
                errorType === "api_error" ||
                errorType === "rate_limit_error"
                  ? "retryable"
                  : "invalid",
              status: null,
              retryAfterMs: null,
              errorType,
            }),
          );
        }),
      );
    }),
  );

// ── The Team Claude key ────────────────────────────────────────────────

export class SpaceAgentKeyMissingError extends Schema.TaggedError<SpaceAgentKeyMissingError>()(
  "SpaceAgentKeyMissingError",
  {},
) {}

/**
 * The first enabled server-owned `claudeAgent` instance (no `ownerMemberId`) with an
 * `ANTHROPIC_API_KEY` in its environment, and its `ANTHROPIC_BASE_URL` if set. Never the process
 * environment: replies are the team's, not whoever started the server.
 */
const readTeamClaudeEndpoint = Effect.fn("SpaceAgentAdapter.readTeamClaudeEndpoint")(function* (
  settingsService: ServerSettings.ServerSettingsService["Service"],
  resolver: Option.Option<SecretResolver.SecretResolver["Service"]>,
) {
  const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const instances = Object.entries(settings?.providerInstances ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, instance] of instances) {
    if (instance.driver !== "claudeAgent") continue;
    if (instance.ownerMemberId !== undefined || instance.enabled === false) continue;
    const variable = instance.environment?.find((entry) => entry.name === "ANTHROPIC_API_KEY");
    if (variable === undefined) continue;
    let apiKey: string | undefined;
    if (typeof variable.value === "string") {
      apiKey = variable.value;
    } else if (Option.isSome(resolver)) {
      [apiKey] = yield* resolver.value.read([variable.value]);
    }
    if (apiKey === undefined || apiKey.trim().length === 0) continue;
    const baseUrl = instance.environment?.find((entry) => entry.name === "ANTHROPIC_BASE_URL");
    return {
      apiKey: Redacted.make(apiKey.trim()),
      baseUrl:
        typeof baseUrl?.value === "string" && baseUrl.value.trim().length > 0
          ? baseUrl.value.trim()
          : DEFAULT_BASE_URL,
    } satisfies SpaceAgentEndpoint;
  }
  return yield* new SpaceAgentKeyMissingError();
});

// ── Failures (spaces-agent §8) ─────────────────────────────────────────

const failureFor = (error: SpaceAgentCallError): OrchestrationV2ProviderFailure => {
  switch (error.kind) {
    case "out_of_credit":
      return makeProviderFailure({
        class: "usage_limit",
        message: "The Team Claude key is out of credit.",
        code: error.errorType ?? `http_${error.status ?? 402}`,
        retryable: true,
      });
    case "rejected":
      return makeProviderFailure({
        class: "permission_error",
        message: "The Team Claude key was rejected. An admin can replace it in Settings.",
        code: `http_${error.status ?? 401}`,
        retryable: false,
      });
    case "retryable":
      return makeProviderFailure({
        class: "provider_error",
        message: "The Claude API is unavailable. Pair stopped waiting after two minutes.",
        code: error.status === null ? error.errorType : `http_${error.status}`,
        retryable: true,
      });
    case "transport":
      return makeProviderFailure({
        class: "transport_error",
        message: "Pair couldn't reach the Claude API.",
        code: "network",
        retryable: true,
      });
    case "invalid":
      return makeProviderFailure({
        class: "validation_error",
        message: "The Claude API refused Pair's request.",
        code: error.status === null ? error.errorType : `http_${error.status}`,
        retryable: true,
      });
  }
};

const MISSING_KEY_FAILURE = makeProviderFailure({
  class: "permission_error",
  message: "@pair needs a Team Claude key. An admin can add one in Settings.",
  code: "missing_key",
  retryable: false,
});

const REFUSAL_FAILURE = makeProviderFailure({
  class: "provider_error",
  message: "Pair couldn't answer this one.",
  code: "refusal",
  retryable: true,
});

const UNREADABLE_ROOM_FAILURE = makeProviderFailure({
  class: "provider_error",
  message: "Pair couldn't read this room. Retry the reply.",
  code: "context",
  retryable: true,
});

const WAITING_FAILURE = makeProviderFailure({
  class: "provider_error",
  message: "Pair is waiting on the Claude API.",
  code: "waiting",
  retryable: true,
});

const STOPPED_EARLY_NOTE = {
  cap: "I stopped before finishing: this reply reached its limit of steps.",
  length: "I stopped before finishing: this reply reached its length limit.",
} as const;

// ── Usage ──────────────────────────────────────────────────────────────

interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const count = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** `iterations` lists every attempt (a server-side fallback adds one); top-level is the last. */
const addUsage = (totals: UsageTotals, usage: ApiUsage) => {
  const attempts =
    usage.iterations !== undefined && usage.iterations !== null && usage.iterations.length > 0
      ? usage.iterations
      : [usage];
  for (const attempt of attempts) {
    totals.input += count(attempt.input_tokens);
    totals.cacheRead += count(attempt.cache_read_input_tokens);
    totals.cacheWrite += count(attempt.cache_creation_input_tokens);
    totals.output += count(attempt.output_tokens);
  }
};

const mergeUsage = (start: ApiUsage | undefined, end: ApiUsage | undefined): ApiUsage => {
  const merged: Record<string, unknown> = { ...start };
  for (const [key, value] of Object.entries(end ?? {})) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged as ApiUsage;
};

const turnTokenUsage = (totals: UsageTotals, models: ReadonlyArray<string>): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  inputTokens: totals.input + totals.cacheRead + totals.cacheWrite,
  cachedInputTokens: totals.cacheRead,
  cacheCreationTokens: totals.cacheWrite,
  outputTokens: totals.output,
  ...(models.length === 0 ? {} : { models }),
});

// ── The adapter ────────────────────────────────────────────────────────

type ReplayBlock = SpaceContentBlock | { readonly type: string; readonly [key: string]: unknown };

interface CallResult {
  readonly stopReason: string | null;
  readonly blocks: ReadonlyArray<ApiBlock>;
  readonly usage: ApiUsage;
  readonly model: string | undefined;
}

/** After a mid-output fallback, only blocks from the last boundary on are replayed as-is. */
const replayContent = (blocks: ReadonlyArray<ApiBlock>): ReadonlyArray<ReplayBlock> => {
  const boundary = blocks.findLastIndex((block) => block.type === "fallback");
  return blocks.filter(
    (block, index) =>
      index >= boundary ||
      !(
        block.type === "thinking" ||
        block.type === "redacted_thinking" ||
        block.type === "tool_use"
      ),
  );
};

const toolUsesToRun = (blocks: ReadonlyArray<ApiBlock>) => {
  const boundary = blocks.findLastIndex((block) => block.type === "fallback");
  return blocks.flatMap((block, index) =>
    index > boundary && block.type === "tool_use" && "id" in block && "name" in block
      ? [block as Extract<ApiBlock, { readonly type: "tool_use"; readonly id: string }>]
      : [],
  );
};

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const context = yield* SpaceContext;
  const tools = yield* SpaceAgentTools;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const readEndpoint = Effect.suspend(() => readTeamClaudeEndpoint(settings, secrets));

  const openSession = Effect.fn("SpaceAgentAdapter.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const sessionScope = yield* Effect.scope;
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(events, event).pipe(Effect.asVoid);
    const active = new Map<ProviderTurnId, Fiber.Fiber<void>>();
    const createdAt = yield* DateTime.now;
    const providerSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: SPACE_AGENT_INSTANCE_ID,
      status: "ready" as const,
      // Rooms have no folder; nothing here reads it.
      cwd: input.runtimePolicy.cwd ?? ".",
      model: input.modelSelection.model,
      capabilities: SpaceAgentCapabilities,
      createdAt,
      updatedAt: createdAt,
      lastError: null,
    };

    const ensureThread = Effect.fn("SpaceAgentAdapter.ensureThread")(function* (
      threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
    ) {
      if (threadInput.existingProviderThread !== undefined) {
        return threadInput.existingProviderThread;
      }
      const now = yield* DateTime.now;
      return {
        id: IdAllocator.derive.providerThread({
          driver,
          nativeThreadId: threadInput.threadId,
          providerInstanceId: SPACE_AGENT_INSTANCE_ID,
        }),
        driver,
        providerInstanceId: SPACE_AGENT_INSTANCE_ID,
        providerSessionId: input.providerSessionId,
        appThreadId: threadInput.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
    });

    const startTurn = Effect.fn("SpaceAgentAdapter.startTurn")(function* (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      const startedAt = yield* DateTime.now;
      const providerTurnId = IdAllocator.derive.providerTurn({
        driver,
        nativeTurnId: turn.attemptId,
      });
      let providerTurn: OrchestrationV2ProviderTurn = {
        id: providerTurnId,
        providerThreadId: turn.providerThread.id,
        nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: null,
        ordinal: turn.providerTurnOrdinal,
        status: "running",
        startedAt,
        completedAt: null,
      };
      yield* emit({
        type: "provider_turn.updated",
        driver,
        threadId: turn.threadId,
        providerTurn,
      });

      const ordinals = new Map<string, number>();
      const ordinalOf = (nativeItemId: string) => {
        const existing = ordinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const next = ordinals.size + 1;
        ordinals.set(nativeItemId, next);
        return next;
      };
      const nativeId = (suffix: string) => `${turn.attemptId}:${suffix}`;
      const nodeOf = (nativeItemId: string): NodeId =>
        IdAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
      const itemBase = (nativeItemId: string, itemStartedAt: DateTime.Utc) => ({
        id: IdAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId: nodeOf(nativeItemId),
        providerThreadId: turn.providerThread.id,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinalOf(nativeItemId),
        startedAt: itemStartedAt,
      });
      const emitNode = (
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        nodeStartedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver,
          node: {
            id: nodeOf(nativeItemId),
            threadId: turn.threadId,
            runId: turn.runId,
            parentNodeId: turn.rootNodeId,
            rootNodeId: turn.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: nodeStartedAt,
            completedAt,
          },
        });

      const emitAssistant = Effect.fnUntraced(function* (
        nativeItemId: string,
        text: string,
        streaming: boolean,
        messageStartedAt: DateTime.Utc,
      ) {
        const now = yield* DateTime.now;
        const messageId = IdAllocator.derive.messageFromProviderItem({ driver, nativeItemId });
        yield* emitNode(
          nativeItemId,
          "assistant_message",
          streaming ? "running" : "completed",
          messageStartedAt,
          streaming ? null : now,
        );
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...itemBase(nativeItemId, messageStartedAt),
            status: streaming ? "running" : "completed",
            title: null,
            completedAt: streaming ? null : now,
            updatedAt: now,
            type: "assistant_message",
            messageId,
            text,
            streaming,
          },
        });
        yield* emit({
          type: "message.updated",
          driver,
          message: {
            id: messageId,
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId: nodeOf(nativeItemId),
            role: "assistant",
            text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: messageStartedAt,
            updatedAt: now,
          },
        });
      });

      const emitTool = Effect.fnUntraced(function* (
        nativeItemId: string,
        name: string,
        toolInput: unknown,
        status: "running" | "completed" | "failed",
        toolStartedAt: DateTime.Utc,
        output?: string,
      ) {
        const now = yield* DateTime.now;
        const done = status !== "running";
        yield* emitNode(nativeItemId, "tool_call", status, toolStartedAt, done ? now : null);
        const item: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> = {
          ...itemBase(nativeItemId, toolStartedAt),
          status,
          title: name,
          completedAt: done ? now : null,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: name,
          input: toolInput,
          ...(output === undefined ? {} : { output }),
        };
        yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      });

      const totals: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      const models = new Set<string>();
      let usageSeen = false;
      let retry: { attempt: number; startedAt: DateTime.Utc; delayMs: number } | null = null;
      const retryNativeId = `terminal-failure:${providerTurnId}`;
      const retryInfo = (current: NonNullable<typeof retry>): OrchestrationV2ProviderRetry => ({
        attempt: current.attempt,
        maxAttempts: null,
        retryDelayMs: Math.round(current.delayMs),
      });
      const retryOrdinal = () => ordinalOf(retryNativeId);

      const finish = Effect.fnUntraced(function* (
        outcome:
          | { readonly status: "completed" | "interrupted" }
          | { readonly status: "failed"; readonly failure: OrchestrationV2ProviderFailure },
      ) {
        const completedAt = yield* DateTime.now;
        if (retry !== null && outcome.status !== "failed") {
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: makeProviderRetryTurnItem({
              driver,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              itemOrdinal: retryOrdinal(),
              failure: WAITING_FAILURE,
              retry: retryInfo(retry),
              status: outcome.status,
              startedAt: retry.startedAt,
              updatedAt: completedAt,
            }),
          });
        }
        providerTurn = {
          ...providerTurn,
          status: outcome.status,
          completedAt,
          ...(usageSeen ? { turnTokenUsage: turnTokenUsage(totals, [...models]) } : {}),
        };
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turn.threadId,
          providerTurn,
        });
        if (outcome.status !== "failed") {
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            runOrdinal: turn.runOrdinal,
            status: outcome.status,
            failure: null,
            threadDisposition: "reusable",
          });
          return;
        }
        const failureItemOrdinal = retryOrdinal();
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: makeProviderFailureTurnItem({
            driver,
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            itemOrdinal: failureItemOrdinal,
            failure: outcome.failure,
            ...(retry === null ? {} : { retry: retryInfo(retry), retryStartedAt: retry.startedAt }),
            occurredAt: completedAt,
          }),
        });
        yield* emit({
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThread.id,
          providerTurnId,
          runOrdinal: turn.runOrdinal,
          failureItemOrdinal,
          status: "failed",
          failure: outcome.failure,
          ...(retry === null ? {} : { retry: retryInfo(retry), retryStartedAt: retry.startedAt }),
          threadDisposition: "reusable",
        });
      });

      // Each model call gets its own two-minute window; `retry-after` wins over backoff.
      const withRetry = <A>(call: Effect.Effect<A, SpaceAgentCallError>) =>
        Effect.suspend(() => {
          let attempt = 0;
          let windowStart: number | null = null;
          const gate = Effect.fnUntraced(function* (error: SpaceAgentCallError) {
            if (!isRetryable(error)) return false;
            const nowMs = yield* Clock.currentTimeMillis;
            windowStart ??= nowMs;
            attempt += 1;
            const nextDelayMs = Math.min(
              error.retryAfterMs ?? 1000 * 2 ** (attempt - 1),
              MAX_RETRY_DELAY_MS,
            );
            if (nowMs - windowStart + nextDelayMs > RETRY_WINDOW_MS) return false;
            const now = yield* DateTime.now;
            retry = {
              attempt: (retry?.attempt ?? 0) + 1,
              startedAt: retry?.startedAt ?? now,
              delayMs: nextDelayMs,
            };
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: makeProviderRetryTurnItem({
                driver,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                itemOrdinal: retryOrdinal(),
                failure: WAITING_FAILURE,
                retry: retryInfo(retry),
                status: "running",
                startedAt: retry.startedAt,
                updatedAt: now,
              }),
            });
            // Sleeping inside the gate keeps the wait registered before anyone sees the item.
            yield* Effect.sleep(Duration.millis(nextDelayMs));
            return true;
          });
          return call.pipe(Effect.retry({ while: gate }));
        });

      const callModel = Effect.fnUntraced(function* (
        endpoint: SpaceAgentEndpoint,
        body: unknown,
        callIndex: number,
      ) {
        const blocks: Array<ApiBlock> = [];
        const partialJson = new Map<number, string>();
        let startUsage: ApiUsage | undefined;
        let endUsage: ApiUsage | undefined;
        let stopReason: string | null = null;
        let model: string | undefined;
        let finished = false;
        const textId = nativeId(`call:${callIndex}:text`);
        const turnKey = String(turn.runId);
        let textStartedAt: DateTime.Utc | null = null;
        const textDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: TEXT_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.flatMap(DateTime.now, (now) =>
              emitAssistant(textId, update.text, !update.completed, textStartedAt ?? now),
            ),
        });
        yield* streamMessages(http, endpoint, body).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              switch (event.type) {
                case "message_start":
                  startUsage = event.message.usage;
                  model = event.message.model;
                  return;
                case "content_block_start":
                  blocks[event.index] = event.content_block;
                  return;
                case "content_block_delta": {
                  const block = blocks[event.index];
                  if (block === undefined) return;
                  const delta = event.delta;
                  if (delta.type === "text_delta" && "text" in delta && block.type === "text") {
                    blocks[event.index] = { ...block, text: `${block.text}${delta.text}` };
                    textStartedAt ??= yield* DateTime.now;
                    yield* textDeltas.append({
                      turnId: turnKey,
                      itemId: textId,
                      delta: delta.text,
                    });
                  } else if (
                    delta.type === "thinking_delta" &&
                    "thinking" in delta &&
                    block.type === "thinking"
                  ) {
                    blocks[event.index] = {
                      ...block,
                      thinking: `${String(block.thinking)}${delta.thinking}`,
                    };
                  } else if (
                    delta.type === "signature_delta" &&
                    "signature" in delta &&
                    block.type === "thinking"
                  ) {
                    blocks[event.index] = {
                      ...block,
                      signature: `${String(block.signature ?? "")}${delta.signature}`,
                    };
                  } else if (delta.type === "input_json_delta" && "partial_json" in delta) {
                    partialJson.set(
                      event.index,
                      `${partialJson.get(event.index) ?? ""}${delta.partial_json}`,
                    );
                  }
                  return;
                }
                case "content_block_stop": {
                  const block = blocks[event.index];
                  const json = partialJson.get(event.index);
                  if (block?.type === "tool_use" && json !== undefined) {
                    const parsed = json.trim().length === 0 ? {} : parseJson(json);
                    blocks[event.index] = { ...block, input: parsed ?? { invalid_json: json } };
                  }
                  return;
                }
                case "message_delta":
                  stopReason = event.delta.stop_reason ?? stopReason;
                  endUsage = mergeUsage(endUsage, event.usage);
                  return;
                case "message_stop":
                  finished = true;
                  return;
                default:
                  return;
              }
            }),
          ),
        );
        if (!finished) {
          return yield* new SpaceAgentCallError({
            kind: "retryable",
            status: null,
            retryAfterMs: null,
            errorType: "incomplete_stream",
          });
        }
        if (textStartedAt !== null) {
          yield* textDeltas.complete({ turnId: turnKey, itemId: textId });
        }
        const result: CallResult = {
          stopReason,
          blocks: blocks.filter((block) => block !== undefined),
          usage: mergeUsage(startUsage, endUsage),
          model,
        };
        return result;
      }, Effect.scoped);

      const reply = Effect.gen(function* () {
        const roomSpace = turn.appThread.space;
        const [message] = (yield* projections
          .getMessagesById(turn.threadId, [turn.message.messageId])
          .pipe(Effect.orElseSucceed(() => new Map()))).values();
        const authorId = message?.authorId;
        if (roomSpace?.kind !== "room" || authorId === undefined) {
          return yield* finish({ status: "failed", failure: UNREADABLE_ROOM_FAILURE });
        }
        const scope: SpaceReplyScope = {
          spaceId: roomSpace.spaceId,
          roomThreadId: turn.threadId,
          runId: turn.runId,
          taggerId: MemberId.make(authorId),
          roomMessageId: spaceReplyTrigger(turn.message.messageId),
        };
        const teamEndpoint = yield* readEndpoint.pipe(Effect.option);
        if (Option.isNone(teamEndpoint)) {
          return yield* finish({ status: "failed", failure: MISSING_KEY_FAILURE });
        }
        const assembled = yield* context.assemble(scope).pipe(Effect.option);
        if (Option.isNone(assembled)) {
          return yield* finish({ status: "failed", failure: UNREADABLE_ROOM_FAILURE });
        }
        const endpoint = teamEndpoint.value;
        const model = turn.modelSelection.model;
        const messages: Array<SpaceMessageParam | { role: "assistant"; content: unknown }> = [
          ...assembled.value.messages,
        ];
        let stoppedEarly: keyof typeof STOPPED_EARLY_NOTE | null = null;
        for (let callIndex = 1; callIndex <= MAX_MODEL_CALLS; callIndex++) {
          const body = {
            model,
            stream: true,
            system: assembled.value.system,
            tools: assembled.value.tools,
            messages,
            ...SPACE_AGENT_REQUEST_OPTIONS,
          };
          const result = yield* withRetry(callModel(endpoint, body, callIndex));
          usageSeen = true;
          addUsage(totals, result.usage);
          if (result.model !== undefined) models.add(result.model);
          if (result.stopReason === "refusal") {
            return yield* finish({ status: "failed", failure: REFUSAL_FAILURE });
          }
          messages.push({ role: "assistant", content: replayContent(result.blocks) });
          if (result.stopReason === "max_tokens") {
            stoppedEarly = "length";
            break;
          }
          if (result.stopReason === "pause_turn") continue;
          const toolUses = result.stopReason === "tool_use" ? toolUsesToRun(result.blocks) : [];
          if (toolUses.length === 0) break;
          if (callIndex === MAX_MODEL_CALLS) {
            stoppedEarly = "cap";
            break;
          }
          const results: Array<SpaceContentBlock> = [];
          for (const toolUse of toolUses) {
            const toolId = nativeId(`tool:${toolUse.id}`);
            const toolStartedAt = yield* DateTime.now;
            yield* emitTool(toolId, toolUse.name, toolUse.input, "running", toolStartedAt);
            const outcome =
              isRecord(toolUse.input) && "invalid_json" in toolUse.input
                ? { content: "INVALID_JSON: the tool input was not valid JSON.", isError: true }
                : yield* tools.call(scope, toolUse.name, toolUse.input);
            yield* emitTool(
              toolId,
              toolUse.name,
              toolUse.input,
              outcome.isError ? "failed" : "completed",
              toolStartedAt,
              outcome.content,
            );
            results.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: outcome.content,
              ...(outcome.isError ? { is_error: true } : {}),
            });
          }
          messages.push({ role: "user", content: results });
        }
        if (stoppedEarly !== null) {
          const noteStartedAt = yield* DateTime.now;
          yield* emitAssistant(
            nativeId("stopped-early"),
            STOPPED_EARLY_NOTE[stoppedEarly],
            false,
            noteStartedAt,
          );
        }
        yield* finish({ status: "completed" });
      }).pipe(
        Effect.catchTags({
          SpaceAgentCallError: (error) => finish({ status: "failed", failure: failureFor(error) }),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("@pair reply failed", cause).pipe(
            Effect.andThen(
              finish({
                status: "failed",
                failure: makeProviderFailure({ class: "unknown", retryable: true }),
              }),
            ),
          ),
        ),
        Effect.onInterrupt(() => finish({ status: "interrupted" })),
        Effect.ensuring(Effect.sync(() => active.delete(providerTurnId))),
      );
      const fiber = yield* Effect.forkIn(reply, sessionScope, { startImmediately: true });
      active.set(providerTurnId, fiber);
    });

    const emptySnapshot = (
      providerThread: ProviderAdapter.ProviderAdapterV2ThreadSnapshot["providerThread"],
    ): ProviderAdapter.ProviderAdapterV2ThreadSnapshot => ({
      providerThread,
      providerTurns: [],
      messages: [],
      runtimeRequests: [],
    });

    yield* Scope.addFinalizer(
      sessionScope,
      Effect.forEach([...active.values()], Fiber.interrupt, { discard: true }),
    );

    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: SPACE_AGENT_INSTANCE_ID,
      driver,
      providerSessionId: input.providerSessionId,
      providerSession,
      events: Stream.fromQueue(events),
      ensureThread,
      resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
      startTurn,
      steerTurn: ({ providerThread }) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
            driver,
            providerThreadId: providerThread.id,
          }),
        ),
      interruptTurn: ({ providerTurnId }) => {
        const fiber = active.get(providerTurnId);
        return fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
      },
      respondToRuntimeRequest: ({ requestId }) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
            driver,
            requestId,
            cause: "@pair never asks for approval.",
          }),
        ),
      readThreadSnapshot: ({ providerThread }) => Effect.succeed(emptySnapshot(providerThread)),
      rollbackThread: ({ providerThread }) => Effect.succeed(emptySnapshot(providerThread)),
      forkThread: ({ sourceProviderThread }) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterForkThreadError({
            driver,
            providerThreadId: sourceProviderThread.id,
            cause: "A room can't be forked.",
          }),
        ),
    };
    return runtime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: SPACE_AGENT_INSTANCE_ID,
    driver,
    getCapabilities: Effect.fn("SpaceAgentAdapter.getCapabilities")(function () {
      return Effect.succeed(SpaceAgentCapabilities);
    }),
    planSelectionTransition: Effect.fn("SpaceAgentAdapter.planSelectionTransition")(function () {
      return Effect.succeed({ type: "apply_on_next_turn" as const });
    }),
    openSession,
  });
});

export const layerRegister = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* SpaceAgentAdapterSlot;
    if (slot === undefined) return;
    const adapter = yield* make;
    slot.current = adapter;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (slot.current === adapter) slot.current = undefined;
      }),
    );
  }),
);
