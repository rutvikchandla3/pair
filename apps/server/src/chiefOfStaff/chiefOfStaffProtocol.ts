import {
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  ChiefOfStaffError,
  type ChiefOfStaffEvent,
  type ChiefOfStaffState,
  DEFAULT_TEXT_GENERATION_MODEL,
  type MemberId,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ChiefOfStaffCaller {
  readonly memberId: MemberId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

/** Highest access first, so the first level a caller fully holds is the widest it can lend. */
const ACCESS_LEVELS: ReadonlyArray<AuthMcpClientAccess> = [
  "full-access",
  "auto",
  "auto-accept-edits",
  "approval-required",
  "read-only",
];

/**
 * A caller lends the MCP credential the highest access whose scopes it all holds itself, never
 * above the configured level.
 */
export const effectiveToolAccess = (
  configured: AuthMcpClientAccess,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): AuthMcpClientAccess =>
  ACCESS_LEVELS.slice(ACCESS_LEVELS.indexOf(configured)).find((access) =>
    mcpClientScopes(access).every((scope) => scopes.includes(scope)),
  ) ?? "read-only";

/**
 * The realtime requests are missing from `effect-codex-app-server`'s generated metadata (Codex CLI
 * 0.167), so they go out through the raw client. Only the WebRTC, audio-out, v3 combination works
 * on a ChatGPT subscription; websocket transport and text output need an API key.
 */
interface RealtimeStartParams {
  readonly threadId: string;
  readonly outputModality: "audio";
  readonly version: "v3";
  readonly transport: { readonly type: "webrtc"; readonly sdp: string };
  readonly voice?: string;
  readonly initialItems: ReadonlyArray<{ readonly role: "developer"; readonly text: string }>;
}

const CHIEF_OF_STAFF_MCP_SERVER = "t3-code";

/**
 * The home thread's persona, written to its `AGENTS.md`. It is an owner-level operator with a
 * thread credential, so every t3_* tool works and it can hand real work to agents.
 */
export const homeInstructions = (): string =>
  [
    "You are the user's Chief of staff inside T3 Code (Pair), an owner-level operator across their threads, projects and workspaces.",
    '"Threads", "projects" and "workspaces" always mean the user\'s T3 Code threads, projects and workspaces.',
    `Prefer the t3_* tools from the ${CHIEF_OF_STAFF_MCP_SERVER} MCP server; never guess about T3 state. Start real work with delegate_task or create_threads instead of doing it all inline.`,
    "You may also use your shell, edit files, and run the `t3` CLI (for example `t3 thread start|send|list|show|fork`, `t3 project`, `t3 environment`).",
    "Never claim you cannot do something without trying it first, and finish multi-step work instead of stopping early.",
    "Before you delete, force-push, merge, or interrupt or stop someone's work, say exactly what you will do and confirm it in chat or out loud first.",
    "Your long-term memory is in MEMORY.md in this folder. Read it at the start of each turn when it exists, and keep it current with the `cos_memory_*` tools.",
    "End every reply with a one- or two-sentence spoken-style summary on its own last line, prefixed `Summary:`.",
  ].join("\n");

/**
 * The voice's backing thread only relays: it sends the user's words to the home thread with the
 * t3-code MCP tools and speaks back the home thread's `Summary:` line.
 */
export const relayInstructions = (homeThreadId: string): string =>
  [
    "You are only the voice of the user's Chief of staff. The Chief of staff's real thread does the work; you relay it.",
    `For anything beyond small talk, call t3_thread_send with threadId ${homeThreadId} and message set to exactly what the user asked.`,
    "Then call t3_thread_wait for that thread with a timeout of 90000 ms. When it finishes, call t3_thread_read and speak its final `Summary:` line.",
    "If the wait times out, tell the user the work is under way and you will report back, then keep waiting.",
    "When the home thread asks a question or asks for confirmation, relay it to the user and send the user's answer back with t3_thread_send.",
    `If the home thread ${homeThreadId} has a pending approval, read the request out in full and answer it with t3_pending_request only after the user answers out loud.`,
    "Never do the work yourself. Speak in one or two short sentences.",
  ].join("\n");

/** The voice's backing thread: read-only with no approval UI, since it only needs its MCP tools. */
export const backingThreadParams = (input: {
  readonly cwd: string;
  readonly model: string;
  readonly homeThreadId: string;
  readonly mcpEndpoint: string;
  readonly mcpAuthorizationHeader: string;
}) => ({
  approvalPolicy: "never" as const,
  sandbox: "read-only" as const,
  cwd: input.cwd,
  model: input.model || DEFAULT_TEXT_GENERATION_MODEL,
  developerInstructions: relayInstructions(input.homeThreadId),
  config: {
    model_reasoning_effort: "low",
    [`mcp_servers.${CHIEF_OF_STAFF_MCP_SERVER}`]: {
      url: input.mcpEndpoint,
      http_headers: { Authorization: input.mcpAuthorizationHeader },
      // With approval policy never, an MCP call that would ask for approval fails instead.
      default_tools_approval_mode: "approve",
    },
  },
});

export const realtimeStartParams = (input: {
  readonly threadId: string;
  readonly sdpOffer: string;
  readonly voice: string;
  readonly status: string;
  readonly homeThreadId: string;
}): RealtimeStartParams => ({
  threadId: input.threadId,
  outputModality: "audio",
  version: "v3",
  transport: { type: "webrtc", sdp: input.sdpOffer },
  ...(input.voice ? { voice: input.voice } : {}),
  initialItems: [
    {
      role: "developer",
      text: `${relayInstructions(input.homeThreadId)}\n\n${input.status}`,
    },
  ],
});

/** A realtime refusal, as the user can act on it. */
export const realtimeFailure = (message: string): ChiefOfStaffError => {
  if (/requires API key auth|API key/i.test(message)) {
    return new ChiefOfStaffError({
      reason: "requires-api-key",
      message:
        "Codex refused voice for this sign-in. Update Codex and sign it in with ChatGPT, then try again.",
    });
  }
  if (/404 Not Found/i.test(message) && /\/v1\/live|realtime/i.test(message)) {
    return new ChiefOfStaffError({
      reason: "realtime-endpoint-not-found",
      message:
        "Codex could not reach the voice endpoint, usually because it is configured with a proxy base URL. Set Chief of staff's realtime base URL to https://chatgpt.com/backend-api/codex in Settings.",
    });
  }
  return new ChiefOfStaffError({
    reason: "start-failed",
    message: `Chief of staff could not start voice: ${message}`,
  });
};

export interface StatusThread {
  readonly title: string;
  readonly project: string | undefined;
  readonly status: string;
  readonly needs: "approval" | "answer" | undefined;
  /** Epoch milliseconds; newest first. */
  readonly updatedAt: number;
}

export const STATUS_THREAD_CAP = 25;

export const formatStatus = (threads: ReadonlyArray<StatusThread>): string => {
  const shown = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, STATUS_THREAD_CAP);
  const lines = shown.map((thread) => {
    const state =
      thread.needs === "approval"
        ? "needs approval"
        : thread.needs === "answer"
          ? "waiting for the user's answer"
          : thread.status;
    const project =
      thread.project === undefined ? "" : ` (project ${JSON.stringify(thread.project)})`;
    return `- ${JSON.stringify(thread.title)}${project}: ${state}`;
  });
  const hidden = threads.length - shown.length;
  return [
    "Current T3 Code threads that are not settled (authoritative, refreshed just now):",
    ...(lines.length === 0 ? ["- none"] : lines),
    ...(hidden > 0 ? [`- and ${hidden} older threads not listed`] : []),
    "Answer thread status questions from this list directly; use the tools for anything else.",
  ].join("\n");
};

const ThreadScoped = Schema.Struct({ threadId: Schema.optional(Schema.String) });
const TranscriptDelta = Schema.Struct({ role: Schema.String, delta: Schema.String });
const TranscriptDone = Schema.Struct({ role: Schema.String, text: Schema.String });
const ItemAdded = Schema.Struct({ item: Schema.Struct({ type: Schema.String }) });
const ToolItem = Schema.Struct({
  item: Schema.Struct({
    type: Schema.String,
    id: Schema.String,
    tool: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }),
});
const decodeThreadScoped = Schema.decodeUnknownOption(ThreadScoped);
const decodeTranscriptDelta = Schema.decodeUnknownOption(TranscriptDelta);
const decodeTranscriptDone = Schema.decodeUnknownOption(TranscriptDone);
const decodeItemAdded = Schema.decodeUnknownOption(ItemAdded);
const decodeToolItem = Schema.decodeUnknownOption(ToolItem);

const TOOL_LABELS: Record<string, string> = {
  t3_thread_list: "Checking your threads",
  t3_thread_read: "Reading a thread",
  t3_thread_send: "Messaging a thread",
  t3_thread_wait: "Waiting on a thread",
  t3_thread_update: "Updating a thread",
  t3_thread_interrupt: "Interrupting a thread",
  t3_workflow_stop: "Stopping a workflow",
};

const toolLabel = (tool: string): string =>
  TOOL_LABELS[tool] ?? `Using ${tool.replace(/^t3_/, "").replaceAll("_", " ")}`;

const speaker = (role: string) =>
  role === "user" || role === "assistant" ? (role as "user" | "assistant") : undefined;

/** False for a notification about another native thread. */
export const isForThread = (params: unknown, threadId: string): boolean =>
  Option.match(decodeThreadScoped(params), {
    onNone: () => true,
    onSome: (scoped) => scoped.threadId === undefined || scoped.threadId === threadId,
  });

/**
 * WebRTC carries the audio, so the app-server never says when the model speaks: an assistant
 * transcript means speaking, a user one or a finished reply means listening, a handoff means thinking.
 */
export const mapNotification = (
  state: ChiefOfStaffState,
  method: string,
  params: unknown,
): { readonly state: ChiefOfStaffState; readonly events: ReadonlyArray<ChiefOfStaffEvent> } => {
  const moveTo = (next: ChiefOfStaffState, events: ReadonlyArray<ChiefOfStaffEvent> = []) => ({
    state: next,
    events: next === state ? events : [{ _tag: "state" as const, state: next }, ...events],
  });
  const unchanged = { state, events: [] };
  switch (method) {
    case "thread/realtime/started":
      return state === "connecting" ? moveTo("listening") : unchanged;
    case "thread/realtime/transcript/delta":
      return Option.match(decodeTranscriptDelta(params), {
        onNone: () => unchanged,
        onSome: ({ role, delta }) => {
          const who = speaker(role);
          if (who === undefined) return unchanged;
          const event: ChiefOfStaffEvent = {
            _tag: "transcript",
            role: who,
            text: delta,
            final: false,
          };
          return who === "assistant"
            ? moveTo("speaking", [event])
            : moveTo(state === "thinking" ? "thinking" : "listening", [event]);
        },
      });
    case "thread/realtime/transcript/done":
      return Option.match(decodeTranscriptDone(params), {
        onNone: () => unchanged,
        onSome: ({ role, text }) => {
          const who = speaker(role);
          if (who === undefined) return unchanged;
          const event: ChiefOfStaffEvent = { _tag: "transcript", role: who, text, final: true };
          return who === "assistant" ? moveTo("listening", [event]) : moveTo(state, [event]);
        },
      });
    case "thread/realtime/itemAdded":
      return Option.match(decodeItemAdded(params), {
        onNone: () => unchanged,
        onSome: ({ item }) => (item.type === "handoff_request" ? moveTo("thinking") : unchanged),
      });
    case "turn/started":
      return moveTo("thinking");
    case "turn/completed":
      return state === "thinking" ? moveTo("listening") : unchanged;
    case "item/started":
    case "item/completed":
      return Option.match(decodeToolItem(params), {
        onNone: () => unchanged,
        onSome: ({ item }) => {
          if (item.type !== "mcpToolCall" || item.tool === undefined) return unchanged;
          const status =
            method === "item/started"
              ? "started"
              : item.status === "failed"
                ? "failed"
                : "completed";
          return {
            state,
            events: [
              {
                _tag: "working",
                id: item.id,
                tool: item.tool,
                label: toolLabel(item.tool),
                status,
              },
            ],
          };
        },
      });
    default:
      return unchanged;
  }
};
