import {
  type Bot,
  type BotId,
  type BotJob,
  type BotJobId,
  type BotSession,
  type BotSessionRole,
  BotsError,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpFailure,
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

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { checkModelSelection, isModelSelectionRefusal } from "../provider/modelSelectionCheck.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { BotService } from "./BotService.ts";
import { type BotCloudTarget, loadBotLinkScope, resolveCloudTarget } from "./botCloud.ts";
import { sessionTaskFooter } from "./botPersona.ts";

const notFound = (message: string) => new BotsError({ reason: "not-found", message });
const invalidRequest = (message: string) => new BotsError({ reason: "invalid-request", message });
const unavailable = (message: string) => new BotsError({ reason: "unavailable", message });

const isProviderDisabled = Schema.is(
  ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
);

/** What the bot is told when a session can't start, so it can tell the user what to change. */
const launchFailure = (
  error: unknown,
  projectTitle: string,
  role: BotSessionRole,
  chosen: boolean,
): BotsError => {
  if (!isProviderDisabled(error)) {
    return unavailable("Could not start the session.");
  }
  if (error.reason !== undefined) {
    return invalidRequest(
      `Could not start the session: the ${error.instanceId} provider belongs to someone else (${error.reason}).`,
    );
  }
  const instead = chosen
    ? "or pass another modelSelection"
    : `or to pick another ${role} model under Models… in your menu`;
  return invalidRequest(
    `Could not start the session: the ${error.instanceId} provider is turned off for ${projectTitle}. Tell the user to turn it on in Settings, ${instead}.`,
  );
};

export interface BotSessionStartInput {
  readonly jobId: BotJobId;
  /** Defaults to the job's project; a job without one runs in a scratch folder ("No project"). */
  readonly projectId?: BotSession["projectId"] | undefined;
  readonly role: BotSessionRole;
  readonly title: BotSession["title"];
  readonly task: string;
  /** Run on a Pair Cloud machine, checked out from `baseRef` on the remote. */
  readonly cloud?:
    | {
        readonly environmentId?: EnvironmentId | undefined;
        /** Default: the project's default branch. */
        readonly baseRef?: string | undefined;
        readonly branch?: string | undefined;
      }
    | undefined;
  /** Replaces the role's model for this session; checked where the session runs. */
  readonly modelSelection?: ModelSelection | undefined;
}

const roleModel = (bot: Bot, role: BotSessionRole): ModelSelection =>
  role === "worker" ? bot.models.worker : bot.models.reviewer;

const roleDefaultHint = (role: BotSessionRole): string =>
  `That is your ${role} model: pass modelSelection (orchestrator_capabilities lists what can), or ask the user to pick another under Models… in your menu.`;

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
    /**
     * Where `cloud` sessions would run now, from the stored links, or why they can't. Null on a
     * server that runs cloud machines itself.
     */
    readonly cloudTarget: (
      environmentId?: EnvironmentId,
    ) => Effect.Effect<BotCloudTarget | null, BotsError>;
  }
>()("t3/bots/BotSessions") {}

const make = Effect.gen(function* () {
  const botService = yield* BotService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const random = yield* SecureRandom.SecureRandom;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  const linkScope = (bot: Bot) => loadBotLinkScope(threads, hereId, bot);

  const cloudTarget: BotSessions["Service"]["cloudTarget"] = (environmentId) =>
    cloudOnly ? Effect.succeed(null) : resolveCloudTarget(links, environmentId);

  /** The cloud's own message, prefixed with where it came from, for the bot to relay. */
  const cloudFailure = (target: BotCloudTarget, what: string) => (error: OrchestratorMcpFailure) =>
    error.code === "capability_denied"
      ? new BotsError({ reason: "cloud-only", message: `${target.label}: ${error.message}` })
      : error.code === "orchestration_error"
        ? unavailable(`${what} on ${target.label}: ${error.message}`)
        : invalidRequest(`${what} on ${target.label}: ${error.message}`);

  const startInCloud = Effect.fn("BotSessions.startInCloud")(function* (
    bot: Bot,
    job: BotJob,
    project: { readonly id: BotSession["projectId"]; readonly title: string },
    baseRef: string,
    input: BotSessionStartInput & { readonly cloud: NonNullable<BotSessionStartInput["cloud"]> },
  ) {
    const target = yield* resolveCloudTarget(links, input.cloud.environmentId);
    const { scope, activeRunId } = yield* linkScope(bot);
    // The project there is the one with this project's repository, as delegate_task finds it.
    const projectThere = yield* forwarding
      .resolveProject(scope, target.environmentId, {
        parentProjectId: project.id,
        requested: undefined,
        argument: "projectId",
      })
      .pipe(
        Effect.mapError((error) =>
          invalidRequest(
            `${target.label} has no single project for ${project.title}'s repository: ${error.message} Run the session here instead, or ask the user to add the project on ${target.label}.`,
          ),
        ),
      );
    const launched = yield* forwarding
      .call(scope, ProjectToolkit.tools.t3_thread_launch, target.environmentId, {
        projectId: projectThere,
        title: input.title,
        modelSelection: input.modelSelection ?? roleModel(bot, input.role),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: {
          type: "cloud",
          baseRef,
          ...(input.cloud.branch === undefined ? {} : { branch: input.cloud.branch }),
        },
        message: `${input.task}${sessionTaskFooter({ bot, job, inWorktree: true })}`,
        // A retry in the same bot turn finds the machine it started; a later turn gets a new one.
        clientRequestId: `bot-session:${activeRunId ?? "idle"}:${input.title}`.slice(0, 256),
      })
      .pipe(
        Effect.tapError((error) => Effect.logWarning("bot cloud session launch failed", { error })),
        Effect.mapError((error) => {
          const failure = cloudFailure(target, "Could not start the session")(error);
          // Its role default holds this machine's ids, which the cloud may not have.
          return input.modelSelection === undefined &&
            error.code === "invalid_request" &&
            isModelSelectionRefusal(error.message)
            ? invalidRequest(`${failure.message} ${roleDefaultHint(input.role)}`)
            : failure;
        }),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const session: BotSession = {
      threadId: launched.threadId,
      botId: bot.id,
      jobId: job.id,
      role: input.role,
      title: input.title,
      projectId: projectThere,
      takenOver: false,
      createdAt: now,
      modelSelection: launched.modelSelection,
      cloud: {
        environmentId: target.environmentId,
        label: target.label,
        state: "working",
        pendingRequest: null,
        lastOutputAt: now,
        reportedRunId: null,
        reportedRequestIds: [],
        position: 0,
      },
    };
    return yield* botService.addSession(session);
  });

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
      if (input.cloud !== undefined && input.projectId === undefined && job.projectId === null) {
        return yield* invalidRequest(
          "A job with no project runs on this machine. Leave out cloud, or give the job a project.",
        );
      }
      const projectId =
        input.projectId ??
        job.projectId ??
        (yield* folders.ensureScratchProject.pipe(
          Effect.mapError((error) => unavailable(`Could not start the session: ${error.message}`)),
        )).projectId;
      const project = Option.getOrNull(
        yield* projects
          .getById(projectId)
          .pipe(Effect.mapError(() => unavailable("Could not read the project."))),
      );
      if (project === null) return yield* invalidRequest("That project was not found.");
      const root = project.workspaceRoot;
      // Only a git project can give a session its own worktree. Anything else, the scratch
      // project included, runs in place; the scratch project gives each thread its own folder.
      const inWorktree = yield* git.isRepository(root).pipe(Effect.orElseSucceed(() => false));
      const baseRef = inWorktree
        ? ((yield* git.defaultBranch(root).pipe(Effect.orElseSucceed(() => null))) ??
          (yield* git.currentBranch(root).pipe(Effect.orElseSucceed(() => null))) ??
          "main")
        : null;
      const cloud = input.cloud;
      if (cloud !== undefined) {
        if (baseRef === null) {
          return yield* invalidRequest(
            `${project.title} is not a git repository, so it can't run on a cloud machine. Leave out cloud.`,
          );
        }
        const cloudBase = cloud.baseRef ?? baseRef;
        // This server runs cloud machines itself: an ordinary session here, on its own machine.
        if (!cloudOnly)
          return yield* startInCloud(bot, job, project, cloudBase, { ...input, cloud });
      }
      const workspaceStrategy =
        cloud !== undefined
          ? {
              type: "cloud" as const,
              baseRef: cloud.baseRef ?? baseRef ?? "main",
              ...(cloud.branch === undefined ? {} : { branch: cloud.branch }),
            }
          : baseRef === null
            ? { type: "root" as const }
            : { type: "worktree" as const, baseRef, startFromOrigin: false };
      const modelSelection = input.modelSelection ?? roleModel(bot, input.role);
      // ThreadLaunchService doesn't check a selection; t3_thread_launch does, for cloud sessions.
      const { problem } = yield* checkModelSelection({
        providers,
        adapterInstanceIds: new Set(yield* adapters.list()),
        selection: modelSelection,
        // The bot built it from this server's capabilities, so an undeclared id is a mistake
        // (Claude's effort sent to Codex) that would otherwise be silently ignored.
        declaredOptionsOnly: input.modelSelection !== undefined,
      });
      if (problem !== null) {
        return yield* invalidRequest(
          input.modelSelection === undefined
            ? `${problem} ${roleDefaultHint(input.role)}`
            : problem,
        );
      }
      const launched = yield* launches
        .launch({
          commandId: CommandId.make(`server:bot-session:${yield* random.uuidV4()}`),
          projectId: project.id,
          title: input.title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy,
          initialMessage: {
            text: `${input.task}${sessionTaskFooter({ bot, job, inWorktree })}`,
            attachments: [],
          },
          createdBy: "agent",
          creationSource: "server",
          ownerId: bot.ownerId,
        })
        .pipe(
          Effect.tapError((error) => Effect.logWarning("bot session launch failed", { error })),
          Effect.mapError((error) =>
            launchFailure(error, project.title, input.role, input.modelSelection !== undefined),
          ),
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
        modelSelection,
      };
      return yield* botService.addSession(session);
    },
  );

  const message: BotSessions["Service"]["message"] = Effect.fn("BotSessions.message")(
    function* (botId, threadId, text) {
      const session = yield* requireSession(botId, threadId);
      if (session.cloud !== undefined) {
        const target = session.cloud;
        const { scope } = yield* linkScope(yield* loadBot(botId));
        yield* forwarding
          .call(scope, OrchestratorToolkit.tools.t3_thread_send, target.environmentId, {
            threadId,
            message: text,
            mode: "auto",
          })
          .pipe(Effect.mapError(cloudFailure(target, "Could not send the message")));
        return;
      }
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
      const session = yield* requireSession(botId, input.threadId);
      if (session.cloud !== undefined) {
        const target = session.cloud;
        if (input.answers === undefined) {
          return yield* invalidRequest(
            `A session on ${target.label} can't be approved from here. Ask the user with bot_ask to open the session and approve it there.`,
          );
        }
        const { scope } = yield* linkScope(yield* loadBot(botId));
        yield* forwarding
          .call(scope, ThreadToolkit.tools.t3_pending_request, target.environmentId, {
            action: "respond",
            threadId: input.threadId,
            requestId: input.requestId,
            answers: input.answers,
          })
          .pipe(Effect.mapError(cloudFailure(target, "Could not answer the session")));
        return;
      }
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

  return { start, message, respond, liveState, cloudTarget } satisfies BotSessions["Service"];
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
