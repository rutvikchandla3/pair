import {
  type CommandId,
  CONTEXT_EXPORT_MAX_BYTES,
  CONTEXT_EXPORT_MAX_MESSAGE_CHARS,
  CONTEXT_EXPORT_MAX_MESSAGES,
  isCompactionCommandMessage,
  type MemberId,
  OrchestrationV2ContextExport,
  type OrchestrationV2ContextExportMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ContextExportError extends Schema.TaggedError<ContextExportError>()(
  "ContextExportError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["not-found", "too-large", "not-empty", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Context export for thread ${this.threadId} failed: ${this.reason}.`;
  }
}

/**
 * A thread's conversation as it leaves this server (`build`) and as it lands on a new thread
 * here (`import`), as read-only history its first run hands off.
 */
export class ContextExports extends Context.Service<
  ContextExports,
  {
    readonly build: (
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ContextExport, ContextExportError>;
    /** Refuses a thread with any message or run; a replay of the same command id writes nothing. */
    readonly import: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly contextExport: OrchestrationV2ContextExport;
      readonly copy?: true;
      readonly actorId?: MemberId;
    }) => Effect.Effect<void, ContextExportError>;
  }
>()("t3/orchestration-v2/ContextExports") {}

const SHORTENED_MARKER = "\n\n[Message shortened; the rest is on the original thread.]";
/** Room left for `source`, `exportedAt` and the export's own keys. */
const ENVELOPE_BYTES = 16 * 1024;

const encodeContextExport = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextExport),
);

function shorten(text: string): string {
  if (text.length <= CONTEXT_EXPORT_MAX_MESSAGE_CHARS) return text;
  const end = CONTEXT_EXPORT_MAX_MESSAGE_CHARS - SHORTENED_MARKER.length;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}${SHORTENED_MARKER}`;
}

const messageBytes = (message: OrchestrationV2ContextExportMessage) =>
  Buffer.byteLength(
    JSON.stringify({ ...message, createdAt: DateTime.formatIso(message.createdAt) }),
    "utf8",
  ) + 1;

/**
 * Fits a conversation under the export's caps: the first user message, then the newest that fit,
 * so the one gap is right after the first user message.
 */
export function capContextExport(messages: ReadonlyArray<OrchestrationV2ContextExportMessage>): {
  readonly messages: ReadonlyArray<OrchestrationV2ContextExportMessage>;
  readonly omittedMessageCount: number;
} {
  const shortened = messages.map((message) => ({ ...message, text: shorten(message.text) }));
  const bytes = shortened.map(messageBytes);
  let budget = CONTEXT_EXPORT_MAX_BYTES - ENVELOPE_BYTES;
  if (
    shortened.length <= CONTEXT_EXPORT_MAX_MESSAGES &&
    bytes.reduce((total, size) => total + size, 0) <= budget
  ) {
    return { messages: shortened, omittedMessageCount: 0 };
  }
  const first = shortened.findIndex((message) => message.role === "user");
  const head = first === -1 ? [] : [shortened[first]!];
  budget -= first === -1 ? 0 : bytes[first]!;
  let room = CONTEXT_EXPORT_MAX_MESSAGES - head.length;
  let start = shortened.length;
  while (start - 1 > first && room > 0 && bytes[start - 1]! <= budget) {
    start -= 1;
    budget -= bytes[start]!;
    room -= 1;
  }
  const tail = shortened.slice(start);
  return {
    messages: [...head, ...tail],
    omittedMessageCount: shortened.length - head.length - tail.length,
  };
}

const fromMessage = (source: OrchestrationV2ContextExport["source"], copy: boolean) =>
  copy
    ? `Copy of “${source.title}” from ${source.environmentLabel}`
    : `Continued from “${source.title}” on ${source.environmentLabel}`;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const failWith =
    (threadId: ThreadId, reason: ContextExportError["reason"]) => (cause?: unknown) =>
      new ContextExportError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const encodedBytes = (threadId: ThreadId, contextExport: OrchestrationV2ContextExport) =>
    encodeContextExport(contextExport).pipe(
      Effect.map((text) => Buffer.byteLength(text, "utf8")),
      Effect.mapError(failWith(threadId, "failed")),
    );

  const build: ContextExports["Service"]["build"] = Effect.fn("ContextExports.build")(
    function* (threadId) {
      const failed = failWith(threadId, "failed");
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failed));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failWith(threadId, "not-found")();
      }
      const { projection } = yield* threads
        .getThreadSnapshot(threadId)
        .pipe(Effect.mapError(failed));
      const conversation = projection.visibleTurnItems.flatMap(
        ({ item }): ReadonlyArray<OrchestrationV2ContextExportMessage> => {
          const createdAt = item.startedAt ?? item.updatedAt;
          if (item.type === "user_message") {
            return item.text.trim() === "" || isCompactionCommandMessage({ role: "user", ...item })
              ? []
              : [{ role: "user", text: item.text, createdAt }];
          }
          if (item.type === "assistant_message") {
            return item.streaming || item.text.trim() === ""
              ? []
              : [{ role: "assistant", text: item.text, createdAt }];
          }
          return [];
        },
      );
      const descriptor = yield* environment.getDescriptor;
      const capped = capContextExport(conversation);
      const contextExport: OrchestrationV2ContextExport = {
        version: 1,
        source: {
          environmentId: descriptor.environmentId,
          threadId,
          title: projection.thread.title,
          environmentLabel: descriptor.label,
        },
        exportedAt: yield* DateTime.now,
        messages: capped.messages,
        omittedMessageCount: capped.omittedMessageCount,
      };
      if ((yield* encodedBytes(threadId, contextExport)) > CONTEXT_EXPORT_MAX_BYTES) {
        return yield* failWith(threadId, "too-large")();
      }
      return contextExport;
    },
  );

  const importExport: ContextExports["Service"]["import"] = Effect.fn("ContextExports.import")(
    function* (input) {
      const { threadId, contextExport } = input;
      if ((yield* encodedBytes(threadId, contextExport)) > CONTEXT_EXPORT_MAX_BYTES) {
        return yield* failWith(threadId, "too-large")();
      }
      yield* threads
        .dispatch({
          type: "thread.history.import",
          commandId: input.commandId,
          threadId,
          contextExport,
          fromMessage: fromMessage(contextExport.source, input.copy === true),
          ...(input.copy === undefined ? {} : { copy: input.copy }),
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              // The decider refuses only a missing or used thread; say which.
              const shell = yield* threads
                .getThreadShell(threadId)
                .pipe(Effect.orElseSucceed(() => null));
              const reason =
                shell === null || shell.deletedAt !== null
                  ? "not-found"
                  : (cause._tag === "OrchestratorDispatchError" ||
                        cause._tag === "OrchestratorCommandPreviouslyRejectedError") &&
                      (shell.latestRunId !== null || shell.itemCount > 0)
                    ? "not-empty"
                    : "failed";
              return yield* failWith(threadId, reason)(cause);
            }),
          ),
        );
    },
  );

  return ContextExports.of({ build, import: importExport });
});

export const layer = Layer.effect(ContextExports, make);
