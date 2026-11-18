import {
  type BotId,
  type BotJobId,
  type BotSession,
  type BotSessionRole,
  BotsError,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationV2TurnItem,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BotService } from "./BotService.ts";
import { sessionTaskFooter } from "./botPersona.ts";

const notFound = (message: string) => new BotsError({ reason: "not-found", message });
const invalidRequest = (message: string) => new BotsError({ reason: "invalid-request", message });
const unavailable = (message: string) => new BotsError({ reason: "unavailable", message });

const isProviderDisabled = Schema.is(
  ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
);

/** What the bot is told when a session can't start, so it can tell the user what to change. */
const launchFailure = (error: unknown, projectTitle: string, role: BotSessionRole): string => {
  if (!isProviderDisabled(error)) {
    return "Could not start the session.";
  }
  if (error.reason !== undefined) {
    return `Could not start the session: the ${error.instanceId} provider belongs to someone else (${error.reason}).`;
  }
  return `Could not start the session: the ${error.instanceId} provider is turned off for ${projectTitle}. Tell the user to turn it on in Settings, or to pick another ${role} model under Models… in your menu.`;
};

export interface BotSessionStartInput {
  readonly jobId: BotJobId;
  readonly projectId: BotSession["projectId"];
  readonly role: BotSessionRole;
  readonly title: BotSession["title"];
  readonly task: string;
}

export interface BotRespondInput {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision?: import("@t3tools/contracts").ProviderApprovalDecision | undefined;
  readonly answers?: import("@t3tools/contracts").ProviderUserInputAnswers | undefined;
  readonly feedback?: string | undefined;
}

export interface BotSessionLiveState {
  readonly status: string;
  readonly pendingRequest: {
    readonly requestId: RuntimeRequestId;
    readonly kind: string;
    readonly text: string;
  } | null;
  readonly lastAssistantText: string | null;
}

/** A short, client-friendly name for a shell's run state. */
const summarizeThreadStatus = (shell: {
  readonly status: string;
  readonly activityRunStatus?: string | null | undefined;
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}): string => {
  if (shell.archivedAt !== null) return "archived";
  if (shell.deletedAt !== null) return "stopped";
  const status = shell.activityRunStatus ?? shell.status;
  switch (status) {
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "working";
    case "completed":
      return "idle";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      return "idle";
  }
};

export class BotSessions extends Context.Service<
  BotSessions,
  {
    readonly start: (
      botId: BotId,
      input: BotSessionStartInput,
    ) => Effect.Effect<BotSession, BotsError>;
    readonly message: (
      botId: BotId,
      threadId: ThreadId,
      text: string,
    ) => Effect.Effect<void, BotsError>;
    readonly respond: (botId: BotId, input: BotRespondInput) => Effect.Effect<void, BotsError>;
    readonly liveState: (threadId: ThreadId) => Effect.Effect<BotSessionLiveState, BotsError>;
  }
>()("t3/bots/BotSessions") {}

const make = Effect.gen(function* () {
  const botService = yield* BotService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const random = yield* SecureRandom.SecureRandom;

  const loadBot = Effect.fn("BotSessions.loadBot")(function* (botId: BotId) {
    const bot = Option.getOrNull(yield* botService.getBot(botId));
    if (bot === null) return yield* notFound("That bot is gone.");
    return bot;
  });

  const requireSession = Effect.fn("BotSessions.requireSession")(function* (
    botId: BotId,
    threadId: ThreadId,
  ) {
    const session = Option.getOrNull(yield* botService.sessionForThread(threadId));
    if (session === null || session.botId !== botId) {
      return yield* notFound("That session does not belong to this bot.");
    }
    if (session.takenOver) {
      return yield* invalidRequest(
        "The user took over this session; leave it until they hand it back.",
      );
    }
    return session;
  });

  const start: BotSessions["Service"]["start"] = Effect.fn("BotSessions.start")(
    function* (botId, input) {
      const bot = yield* loadBot(botId);
      const job = (yield* botService.snapshotForBot(botId)).jobs.find(
        (candidate) => candidate.id === input.jobId,
      );
      if (job === undefined) return yield* notFound("That job is gone.");
      if (job.status !== "working") {
        return yield* invalidRequest(
          "This job is not working; reopen it before starting sessions.",
        );
      }
      const project = Option.getOrNull(
        yield* projects
          .getById(input.projectId)
          .pipe(Effect.mapError(() => unavailable("Could not read the project."))),
      );
      if (project === null) return yield* invalidRequest("That project was not found.");
      const root = project.workspaceRoot;
      const baseRef =
        (yield* git.defaultBranch(root).pipe(Effect.orElseSucceed(() => null))) ??
        (yield* git.currentBranch(root).pipe(Effect.orElseSucceed(() => null))) ??
        "main";
      const launched = yield* launches
        .launch({
          commandId: CommandId.make(`server:bot-session:${yield* random.uuidV4()}`),
          projectId: project.id,
          title: input.title,
          modelSelection: input.role === "worker" ? bot.models.worker : bot.models.reviewer,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
          initialMessage: {
            text: `${input.task}${sessionTaskFooter({ bot, job })}`,
            attachments: [],
          },
          createdBy: "agent",
          creationSource: "server",
          ownerId: bot.ownerId,
        })
        .pipe(
          Effect.tapError((error) => Effect.logWarning("bot session launch failed", { error })),
          Effect.mapError((error) => unavailable(launchFailure(error, project.title, input.role))),
        );
      const session: BotSession = {
        threadId: launched.threadId,
        botId,
        jobId: input.jobId,
        role: input.role,
        title: input.title,
        projectId: project.id,
        takenOver: false,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      return yield* botService.addSession(session);
    },
  );

  const message: BotSessions["Service"]["message"] = Effect.fn("BotSessions.message")(
    function* (botId, threadId, text) {
      const session = yield* requireSession(botId, threadId);
      yield* threads
        .sendToThread({
          projectId: session.projectId,
          commandId: CommandId.make(`server:bot-session:${yield* random.uuidV4()}`),
          threadId,
          messageId: MessageId.make(`message:bot-session:${yield* random.uuidV4()}`),
          text,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(() => unavailable("Could not send the message to the session.")),
          Effect.asVoid,
        );
    },
  );

  const respond: BotSessions["Service"]["respond"] = Effect.fn("BotSessions.respond")(
    function* (botId, input) {
      yield* requireSession(botId, input.threadId);
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`server:bot-session:${yield* random.uuidV4()}`),
          threadId: input.threadId,
          requestId: input.requestId,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
          ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
        })
        .pipe(Effect.mapError(() => unavailable("Could not answer the session's request.")));
    },
  );

  const liveState: BotSessions["Service"]["liveState"] = Effect.fn("BotSessions.liveState")(
    function* (threadId) {
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => unavailable("Could not read the session thread.")));
      if (shell === null) return yield* notFound("That session thread is gone.");
      const records = yield* threads
        .getThreadRecords(threadId, ["messages", "runtimeRequests", "turnItems"], {
          messageRoles: ["assistant"],
        })
        .pipe(Effect.mapError(() => unavailable("Could not read the session thread.")));
      const request = records.runtimeRequests.find((candidate) => candidate.status === "pending");
      const lastAssistant = records.messages.at(-1);
      return {
        status: summarizeThreadStatus(shell),
        pendingRequest:
          request === undefined
            ? null
            : {
                requestId: request.id,
                kind: request.kind,
                text: pendingRequestText(request.id, request.kind, records.turnItems),
              },
        lastAssistantText:
          lastAssistant === undefined
            ? null
            : Array.from(lastAssistant.text).slice(0, 800).join(""),
      };
    },
  );

  return { start, message, respond, liveState } satisfies BotSessions["Service"];
});

/** What the bot should read about a pending request: the question, or the command it waits on. */
const pendingRequestText = (
  requestId: RuntimeRequestId,
  kind: string,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): string => {
  const item = turnItems.find(
    (candidate) =>
      (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
      candidate.requestId === requestId,
  );
  if (item === undefined) return kind;
  if (item.type === "user_input_request") {
    return item.questions[0]?.question ?? kind;
  }
  const approval = item as { readonly prompt?: string; readonly reason?: string };
  return approval.prompt ?? approval.reason ?? kind;
};

export const layer = Layer.effect(BotSessions, make);
