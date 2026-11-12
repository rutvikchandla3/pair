import {
  ChiefOfStaffError,
  type ChiefOfStaffEvent,
  type ChiefOfStaffState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
const CHIEF_OF_STAFF_DEFAULT_MODEL = "gpt-6-luna";

const CHIEF_OF_STAFF_INSTRUCTIONS = [
  "You are the user's Chief of staff inside T3 Code, the app where they run coding agents.",
  '"Threads", "projects" and "workspaces" always mean the user\'s T3 Code threads, projects and workspaces.',
  `Look them up and act on them with the t3_* tools from the ${CHIEF_OF_STAFF_MCP_SERVER} MCP server; never guess.`,
  "After you start a lookup, wait for its result; never guess or say you cannot see something meanwhile.",
  "Answer in one or two short spoken sentences.",
  "Before you delete, interrupt or stop anything, say what you will do and wait for the user to confirm out loud.",
].join("\n");

/** The backing thread's settings: it reads and calls T3 tools, never edits files or asks approval. */
export const backingThreadParams = (input: {
  readonly cwd: string;
  readonly model: string;
  readonly mcpEndpoint: string;
  readonly mcpAuthorizationHeader: string;
}) => ({
  approvalPolicy: "never" as const,
  sandbox: "read-only" as const,
  cwd: input.cwd,
  model: input.model || CHIEF_OF_STAFF_DEFAULT_MODEL,
  developerInstructions: CHIEF_OF_STAFF_INSTRUCTIONS,
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
}): RealtimeStartParams => ({
  threadId: input.threadId,
  outputModality: "audio",
  version: "v3",
  transport: { type: "webrtc", sdp: input.sdpOffer },
  ...(input.voice ? { voice: input.voice } : {}),
  initialItems: [{ role: "developer", text: `${CHIEF_OF_STAFF_INSTRUCTIONS}\n\n${input.status}` }],
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
