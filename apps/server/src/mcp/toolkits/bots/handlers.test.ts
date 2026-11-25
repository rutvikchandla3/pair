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
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotSessions } from "../../../bots/BotSessions.ts";
import { BotService } from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
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

const haOpus = {
  instanceId: ProviderInstanceId.make("claudeAgent-rutvik-916a"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};

const cloudSession = (state: NonNullable<BotSession["cloud"]>["state"]): BotSession => ({
  ...session(false),
  cloud: {
    environmentId: EnvironmentId.make("environment:cloud"),
    label: "Pair Cloud",
    state,
    pendingRequest: null,
    lastOutputAt: "2026-01-01T00:00:00.000Z",
    reportedRunId: null,
    reportedRequestIds: [],
    position: 0,
  },
});

interface Harness {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly bot?: Partial<BotService["Service"]>;
  readonly sessions?: Partial<BotSessions["Service"]>;
  readonly projects?: Partial<ProjectService.ProjectService["Service"]>;
  readonly search?: Partial<ThreadSearch.ThreadSearch["Service"]>;
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
      Layer.mock(ProjectService.ProjectService)(harness.projects ?? {}),
      Layer.mock(ThreadSearch.ThreadSearch)(harness.search ?? {}),
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

  it.effect("tells the bot why a session could not start", () =>
    Effect.gen(function* () {
      const message =
        "Could not start the session on Pair Cloud: The linked environment stopped answering.";
      const result = yield* callTool(
        "bot_start_session",
        { jobId, role: "worker", title: "Upgrade server", task: "Do it", cloud: {} },
        {
          sessions: {
            start: () => Effect.fail(new BotsError({ reason: "unavailable", message })),
          },
        },
      );
      expect(result).toMatchObject({ code: "orchestration_error", message });
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

  it.effect("creates a job for the bot, with the title and request it gave", () =>
    Effect.gen(function* () {
      const calls: Array<{ botId: BotId; input: unknown }> = [];
      const projectId = ProjectId.make("project:one");
      const result = yield* callTool(
        "bot_job_create",
        { title: "Sidebar drag flicker", request: "Fix the flicker", projectId },
        {
          bot: {
            createJobForBot: (id, input) => {
              calls.push({ botId: id, input });
              return Effect.succeed({ id: jobId, title: input.title } as never);
            },
          },
          projects: {
            getById: () => Effect.succeedSome({ id: projectId } as never),
          },
        },
      );
      expect(result).toMatchObject({ jobId, title: "Sidebar drag flicker" });
      expect(calls).toEqual([
        {
          botId,
          input: { title: "Sidebar drag flicker", request: "Fix the flicker", projectId },
        },
      ]);
    }),
  );

  it.effect("lets the bot reopen a finished job with status working", () =>
    Effect.gen(function* () {
      const patches: Array<unknown> = [];
      yield* callTool(
        "bot_job_update",
        { jobId, status: "working" },
        {
          bot: {
            updateJob: (_id, _jobId, patch) => {
              patches.push(patch);
              return Effect.succeed({
                id: jobId,
                botId,
                number: 1,
                title: "Upgrade server",
                request: "Upgrade it",
                projectId: null,
                status: "working",
                headline: "",
                headlineAt: null,
                pullRequests: [],
                report: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                finishedAt: null,
                archivedAt: null,
              });
            },
          },
        },
      );
      expect(patches).toEqual([{ status: "working" }]);
    }),
  );

  it.effect("refuses a project that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "bot_job_create",
        { title: "t", request: "r", projectId: ProjectId.make("project:gone") },
        { projects: { getById: () => Effect.succeedNone } },
      );
      expect(result).toMatchObject({ code: "invalid_request" });
    }),
  );

  it.effect("forgets the bot's own note and returns its text", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "bot_forget",
        { noteId },
        {
          bot: {
            forgetNote: () =>
              Effect.succeed({ id: noteId, text: "Rate limits are per member" } as never),
          },
        },
      );
      expect(result).toMatchObject({ forgotten: true, text: "Rate limits are per member" });
    }),
  );

  it.effect("refuses a note that is not the bot's", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "bot_forget",
        { noteId },
        {
          bot: {
            forgetNote: () =>
              Effect.fail(new BotsError({ reason: "not-found", message: "That note is gone." })),
          },
        },
      );
      expect(result).toMatchObject({ code: "task_not_found" });
    }),
  );

  it.effect(
    "returns a labelled thread link from bot_start_session, in the cloud's environment",
    () =>
      Effect.gen(function* () {
        const asked: Array<unknown> = [];
        const start = (started: BotSession) =>
          callTool(
            "bot_start_session",
            {
              jobId,
              projectId: ProjectId.make("project:one"),
              role: "worker",
              title: "Upgrade server",
              task: "Do it",
              modelSelection: haOpus,
            },
            {
              sessions: {
                start: (_botId, input) => {
                  asked.push(input.modelSelection);
                  return Effect.succeed({ ...started, modelSelection: haOpus });
                },
              },
            },
          );
        expect(yield* start(session(false))).toMatchObject({
          threadId: sessionThreadId,
          link: "[Upgrade server](t3-thread://v2/environment:bots/thread:session)",
          where: "this machine",
        });
        expect(yield* start(cloudSession("working"))).toMatchObject({
          link: "[Upgrade server](t3-thread://v2/environment:cloud/thread:session)",
          where: "Pair Cloud",
          environmentId: "environment:cloud",
          modelSelection: haOpus,
        });
        expect(asked).toEqual([haOpus, haOpus]);
      }),
  );

  it.effect("briefs a cloud session from its last-read state, and says where it runs", () =>
    Effect.gen(function* () {
      const bot = {
        id: botId,
        name: "Atlas",
        charter: "",
        voice: "crisp",
        paused: false,
        instructions: "",
        limits: [],
        homeProjectId: null,
        models: { brain: haOpus, worker: haOpus, reviewer: haOpus },
      };
      const job = {
        id: jobId,
        number: 1,
        title: "Upgrade server",
        request: "",
        projectId: null,
        status: "working",
        headline: "",
        pullRequests: [],
        finishedAt: null,
      };
      const result = yield* callTool(
        "bot_brief",
        {},
        {
          bot: {
            snapshotForBot: () =>
              Effect.succeed({
                bots: [bot],
                jobs: [job],
                sessions: [{ ...cloudSession("unreachable"), modelSelection: haOpus }],
                asks: [],
                notes: [],
                events: [],
                revision: 0,
              } as never),
            listAllBots: () => Effect.succeed([bot] as never),
          },
          sessions: {
            liveState: () => Effect.die("a cloud session is never read live"),
            cloudTarget: () => Effect.succeed(null),
          },
          projects: { listShells: () => Effect.succeed([]) },
        },
      );
      expect(result).toMatchObject({
        bot: { models: { worker: haOpus, reviewer: haOpus } },
        jobs: [
          {
            sessions: [
              {
                modelSelection: haOpus,
                where: "Pair Cloud",
                environmentId: "environment:cloud",
                reachable: false,
                status: "unreachable",
              },
            ],
          },
        ],
      });
    }),
  );

  it.effect("stores the home thread's active run on an Ask", () =>
    Effect.gen(function* () {
      const asks: Array<unknown> = [];
      const result = yield* callTool(
        "bot_ask",
        { question: "q", why: "w", options: [] },
        {
          bot: {
            createAsk: (_id, input) => {
              asks.push(input);
              return Effect.succeed({ id: "ask:1" } as never);
            },
          },
        },
      );
      expect(result).toMatchObject({ askId: "ask:1" });
      expect(asks).toEqual([
        {
          jobId: null,
          question: "q",
          why: "w",
          options: [],
          pick: null,
          homeRunId: RunId.make("run:mcp-test"),
        },
      ]);
    }),
  );
  it.effect("recalls the chat, job reports, answered Asks and notes, best match first", () =>
    Effect.gen(function* () {
      const searched: Array<unknown> = [];
      const result = yield* callTool(
        "bot_recall",
        { query: "rate limit" },
        {
          bot: {
            snapshotForBot: () =>
              Effect.succeed({
                bots: [{ id: botId, homeThreadId: threadId }],
                jobs: [
                  {
                    id: jobId,
                    title: "Rate limit",
                    request: "Add a rate limit to the API",
                    headline: "",
                    pullRequests: [],
                    report: {
                      changed: "Per-member rate limit, 60 a minute.",
                      evidence: [],
                      openQuestions: [],
                      next: null,
                    },
                    updatedAt: "2026-11-02T00:00:00.000Z",
                    finishedAt: "2026-11-03T00:00:00.000Z",
                  },
                ],
                asks: [
                  {
                    id: "ask:1",
                    jobId,
                    question: "Per member or per token?",
                    answer: "Per member, the rate limit is per member.",
                    status: "answered",
                    answeredAt: "2026-11-01T00:00:00.000Z",
                  },
                  { id: "ask:2", question: "rate limit again?", status: "open", answer: null },
                ],
                notes: [
                  {
                    id: noteId,
                    text: "Unrelated: fix the cause.",
                    updatedAt: "2026-11-01T00:00:00.000Z",
                  },
                ],
              } as never),
          },
          search: {
            searchThreadMessages: (input) => {
              searched.push(input);
              return Effect.succeed([
                {
                  messageId: "message:1" as never,
                  source: "user",
                  snippet: "make the rate limit 60 a minute",
                  messageCreatedAt: "2026-11-04T00:00:00.000Z",
                  // A whole-phrase match, as the index grades it: equal hits rank newest first.
                  quality: 1.25,
                },
              ]);
            },
          },
        },
      );
      expect(searched).toEqual([{ threadId, query: "rate limit", limit: 8 }]);
      expect(result).toEqual({
        results: [
          {
            source: "chat",
            from: "user",
            at: "2026-11-04T00:00:00.000Z",
            text: "make the rate limit 60 a minute",
          },
          {
            source: "job",
            jobId,
            title: "Rate limit",
            at: "2026-11-03T00:00:00.000Z",
            text: expect.stringContaining("rate limit"),
          },
          {
            source: "answer",
            askId: "ask:1",
            jobId,
            at: "2026-11-01T00:00:00.000Z",
            text: "Q: Per member or per token?\nA: Per member, the rate limit is per member.",
          },
        ],
      });
    }),
  );
});
