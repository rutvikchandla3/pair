import {
  BOT_LIMIT_LABELS,
  type BotJobId,
  BotsError,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as BotSessions from "../../../bots/BotSessions.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { BotsToolkit } from "./tools.ts";

const accessDenied = new OrchestratorMcpFailure({
  code: "capability_denied",
  message: "These tools are only for a bot's home thread.",
});

/** The scope already decided whether this is a bot's home thread; the refusal is a backstop. */
const resolveBotId = Effect.fn("bots.resolveBotId")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const botId = scope.bot?.botId;
  if (botId !== undefined) return botId;
  return yield* accessDenied;
});

const botsFailure = (error: BotsError): OrchestratorMcpFailure => {
  switch (error.reason) {
    case "not-found":
      return new OrchestratorMcpFailure({ code: "task_not_found", message: error.message });
    case "invalid-request":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    case "cloud-only":
      return new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });
    default:
      return unavailable();
  }
};

const mapError = <A, R>(effect: Effect.Effect<A, BotsError, R>) =>
  effect.pipe(Effect.mapError(botsFailure));

export const layer = McpToolAccess.toLayer(BotsToolkit, {
  bot_brief: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      const projects = yield* ProjectService.ProjectService;
      const sessions = yield* BotSessions.BotSessions;
      const snapshot = yield* mapError(bots.snapshotForBot(botId));
      const bot = snapshot.bots[0];
      if (bot === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: "That bot is gone.",
        });
      }
      const shells = yield* projects.listShells().pipe(Effect.mapError(() => unavailable()));
      const homeProjects = new Set(
        (yield* mapError(bots.listAllBots()))
          .map((candidate) => candidate.homeProjectId)
          .filter((projectId): projectId is ProjectId => projectId !== null),
      );
      const openAsks = snapshot.asks.filter((ask) => ask.status === "open");
      const working = snapshot.jobs.filter((job) => job.status === "working");
      const finished = snapshot.jobs
        .filter((job) => job.status !== "working")
        .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))
        .slice(0, 5);
      const jobs = yield* Effect.forEach([...working, ...finished], (job) =>
        Effect.gen(function* () {
          const live = yield* Effect.forEach(
            snapshot.sessions.filter((session) => session.jobId === job.id),
            (session) =>
              sessions.liveState(session.threadId).pipe(
                Effect.map((state) => ({
                  threadId: session.threadId,
                  role: session.role,
                  title: session.title,
                  takenOver: session.takenOver,
                  ...state,
                })),
                Effect.orElseSucceed(() => ({
                  threadId: session.threadId,
                  role: session.role,
                  title: session.title,
                  takenOver: session.takenOver,
                  status: "stopped",
                  pendingRequest: null,
                  lastAssistantText: null,
                })),
              ),
          );
          return {
            jobId: job.id,
            number: job.number,
            title: job.title,
            request: job.request,
            projectId: job.projectId,
            status: job.status,
            headline: job.headline,
            pullRequests: job.pullRequests,
            sessions: live,
          };
        }),
      );
      return {
        bot: { name: bot.name, charter: bot.charter, paused: bot.paused },
        playbook: {
          instructions: bot.instructions,
          checkWithMeBefore: bot.limits.map((limit) => BOT_LIMIT_LABELS[limit]),
          notes: snapshot.notes.map((note) => ({
            noteId: note.id,
            text: note.text,
            source: note.source,
            citedCount: note.citedCount,
          })),
        },
        projects: shells
          .filter((shell) => shell.archivedAt == null && !homeProjects.has(shell.id))
          .map((shell) => ({
            projectId: shell.id,
            title: shell.title,
            workspaceRoot: shell.workspaceRoot,
          })),
        jobs,
        openAsks: openAsks.map((ask) => ({
          askId: ask.id,
          jobId: ask.jobId,
          question: ask.question,
          options: ask.options,
          pick: ask.pick,
        })),
      };
    }),
  ),

  bot_job_update: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      if (params.status === "done" && params.report === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Finishing a job needs a report.",
        });
      }
      const report =
        params.report === undefined
          ? undefined
          : {
              changed: params.report.changed,
              evidence: params.report.evidence,
              openQuestions: params.report.openQuestions,
              next:
                params.report.next === undefined
                  ? null
                  : {
                      text: params.report.next.text,
                      suggestedRequest: params.report.next.suggestedRequest ?? null,
                    },
            };
      return yield* mapError(
        bots.updateJob(botId, params.jobId, {
          ...(params.headline === undefined ? {} : { headline: params.headline }),
          ...(params.title === undefined ? {} : { title: params.title }),
          ...(params.status === undefined ? {} : { status: params.status }),
          ...(report === undefined ? {} : { report }),
        }),
      );
    }),
  ),

  bot_start_session: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const sessions = yield* BotSessions.BotSessions;
      const session = yield* mapError(
        sessions.start(botId, {
          jobId: params.jobId,
          projectId: params.projectId,
          role: params.role,
          title: params.title,
          task: params.task,
        }),
      );
      return { threadId: session.threadId };
    }),
  ),

  bot_session_message: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const sessions = yield* BotSessions.BotSessions;
      yield* mapError(sessions.message(botId, params.threadId, params.text));
      return { ok: true as const };
    }),
  ),

  bot_session_respond: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      const sessions = yield* BotSessions.BotSessions;
      yield* mapError(
        sessions.respond(botId, {
          threadId: params.threadId,
          requestId: params.requestId,
          ...(params.decision === undefined ? {} : { decision: params.decision }),
          ...(params.answers === undefined ? {} : { answers: params.answers }),
          ...(params.feedback === undefined ? {} : { feedback: params.feedback }),
        }),
      );
      const session = Option.getOrNull(yield* mapError(bots.sessionForThread(params.threadId)));
      if (session !== null) {
        yield* mapError(
          bots.addEvent({
            botId,
            jobId: session.jobId,
            kind: "decision",
            text: params.answer,
            sessionThreadId: params.threadId,
            decision: {
              sessionTitle: session.title,
              question: params.question,
              answer: params.answer,
              cite: params.cite,
              noteId: params.noteId ?? null,
              requestId: params.requestId,
              correction: null,
            },
          }),
        );
        if (params.noteId !== undefined) yield* mapError(bots.citeNote(params.noteId));
      }
      return { ok: true as const };
    }),
  ),

  bot_ask: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      if (params.options.length > 3) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An Ask takes at most three suggested answers.",
        });
      }
      if (params.pick !== undefined && !params.options.includes(params.pick)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "pick must be one of options.",
        });
      }
      const ask = yield* mapError(
        bots.createAsk(botId, {
          jobId: params.jobId ?? null,
          question: params.question,
          why: params.why,
          options: params.options,
          pick: params.pick ?? null,
        }),
      );
      return { askId: ask.id };
    }),
  ),

  bot_ask_resolve: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      const snapshot = yield* mapError(bots.snapshotForBot(botId));
      const resolved = yield* mapError(
        bots.resolveAsk(botId, params.askId, {
          answerKind: params.decidedByYou ? "bot-decides" : "text",
          answer: params.answer,
        }),
      );
      if (params.decidedByYou) {
        const bot = snapshot.bots[0];
        const job =
          resolved.jobId === null
            ? undefined
            : snapshot.jobs.find((candidate) => candidate.id === resolved.jobId);
        yield* mapError(
          bots.addEvent({
            botId,
            jobId: resolved.jobId,
            kind: "decision",
            text: params.answer,
            sessionThreadId: null,
            decision: {
              sessionTitle: job?.title ?? "",
              question: resolved.question,
              answer: params.answer,
              cite: `You let ${bot?.name ?? "the bot"} decide`,
              noteId: null,
              requestId: null,
              correction: null,
            },
          }),
        );
      }
      return { ok: true as const };
    }),
  ),

  bot_learn: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const botId = yield* resolveBotId();
      const bots = yield* BotService.BotService;
      const snapshot = yield* mapError(bots.snapshotForBot(botId));
      const ask =
        params.askId === undefined
          ? undefined
          : snapshot.asks.find((candidate) => candidate.id === params.askId);
      const sourceJobId: BotJobId | null = ask?.jobId ?? null;
      const job =
        sourceJobId === null
          ? undefined
          : snapshot.jobs.find((candidate) => candidate.id === sourceJobId);
      const source =
        params.source ?? (job === undefined ? "From Chat" : `From your answer on J-${job.number}`);
      const note = yield* mapError(
        bots.addNote(botId, {
          text: params.text,
          source,
          sourceJobId,
          ...(params.askId === undefined ? {} : { askId: params.askId }),
        }),
      );
      return { noteId: note.id };
    }),
  ),
});
