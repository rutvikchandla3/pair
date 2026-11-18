import { describe, expect, it } from "@effect/vitest";
import {
  type BotId,
  BotId as BotIdValue,
  BotJobId as BotJobIdValue,
  type BotSession,
  BotNoteId,
  BotsError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotSessions } from "../../../bots/BotSessions.ts";
import { BotService } from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const botId = BotIdValue.make("bot:atlas") as BotId;
const threadId = ThreadId.make("thread:atlas-home");
const sessionThreadId = ThreadId.make("thread:session");
const jobId = BotJobIdValue.make("job:1");
const requestId = RuntimeRequestId.make("request:1");
const noteId = BotNoteId.make("note:1");

const scope = (
  bot: { readonly botId: BotId } | undefined,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:bots"),
  requestNamespace: "provider:bots",
  thread: {
    threadId,
    providerSessionId: "provider:bots",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  ...(bot === undefined ? {} : { bot }),
});

const session = (takenOver: boolean): BotSession => ({
  threadId: sessionThreadId,
  botId,
  jobId,
  role: "worker",
  title: "Upgrade server",
  projectId: ProjectId.make("project:one"),
  takenOver,
  createdAt: "2026-01-01T00:00:00.000Z",
});

interface Harness {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly bot?: Partial<BotService["Service"]>;
  readonly sessions?: Partial<BotSessions["Service"]>;
}

const callTool = (
  name: keyof typeof BotsToolkit.tools,
  params: Record<string, unknown>,
  harness: Harness = {},
) =>
  Effect.gen(function* () {
    const layer = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, harness.scope ?? scope({ botId })),
      Layer.mock(BotService)(harness.bot ?? {}),
      Layer.mock(BotSessions)(harness.sessions ?? {}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    return yield* Effect.gen(function* () {
      const toolkit = yield* BotsToolkit;
      const events = yield* toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return events.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BotsHandlers.layer).pipe(Layer.provideMerge(layer)),
      ),
    );
  });

describe("bots tools", () => {
  it.effect("refuses an Ask pick that is not one of its options", () =>
    Effect.gen(function* () {
      const result = yield* callTool("bot_ask", {
        question: "Per member or per token?",
        why: "The rate limit can be scoped either way.",
        options: ["Per member", "Per token"],
        pick: "Per workspace",
      });
      expect(result).toMatchObject({ code: "invalid_request" });
      expect((result as { message: string }).message).toContain("pick must be one of options");
    }),
  );

  it.effect("records a decision and cites the note when answering a session", () =>
    Effect.gen(function* () {
      const events: Array<Parameters<BotService["Service"]["addEvent"]>[0]> = [];
      const cited: Array<string> = [];
      const result = yield* callTool(
        "bot_session_respond",
        {
          threadId: sessionThreadId,
          requestId,
          decision: "accept",
          question: "Use a Map here?",
          answer: "Yes, use a Map.",
          cite: 'Note: "Fix the cause, not the symptom"',
          noteId,
        },
        {
          bot: {
            sessionForThread: () => Effect.succeedSome(session(false)),
            addEvent: (input) => {
              events.push(input);
              return Effect.succeed({} as never);
            },
            citeNote: (id) => {
              cited.push(id);
              return Effect.succeed({} as never);
            },
          },
          sessions: {
            respond: () => Effect.void,
          },
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "decision",
        text: "Yes, use a Map.",
        sessionThreadId,
        decision: {
          sessionTitle: "Upgrade server",
          question: "Use a Map here?",
          answer: "Yes, use a Map.",
          cite: 'Note: "Fix the cause, not the symptom"',
          noteId,
          requestId,
          correction: null,
        },
      });
      expect(cited).toEqual([noteId]);
    }),
  );

  it.effect("refuses a message to a session the user took over", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "bot_session_message",
        { threadId: sessionThreadId, text: "Try again" },
        {
          sessions: {
            message: () =>
              Effect.fail(
                new BotsError({
                  reason: "invalid-request",
                  message: "The user took over this session; leave it until they hand it back.",
                }),
              ),
          },
        },
      );
      expect(result).toMatchObject({
        code: "invalid_request",
        message: "The user took over this session; leave it until they hand it back.",
      });
    }),
  );

  it.effect("refuses a caller that is not a bot's home thread", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "bot_ask",
        { question: "q", why: "w", options: [] },
        { scope: scope(undefined) },
      );
      expect(result).toMatchObject({ code: "capability_denied" });
    }),
  );
});
