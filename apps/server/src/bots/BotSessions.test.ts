import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type BotJob,
  BotJobId,
  type BotSession,
  EnvironmentId,
  MemberId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { BotService } from "./BotService.ts";
import { NO_CLOUD_MESSAGE } from "./botCloud.ts";
import * as BotSessions from "./BotSessions.ts";

const at = "2026-11-19T00:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const bot: Bot = {
  id: BotId.make("bot:atlas"),
  ownerId: MemberId.make("member:owner"),
  name: "Atlas",
  color: "#6366f1",
  shape: "round",
  voice: "crisp",
  charter: "",
  instructions: "",
  limits: [],
  models: { brain: model, worker: model, reviewer: model },
  homeThreadId: null,
  homeProjectId: null,
  paused: false,
  lastSeenAt: null,
  nextJobNumber: 2,
  createdAt: at,
  updatedAt: at,
};

const job = (projectId: ProjectId | null): BotJob => ({
  id: BotJobId.make("job:1"),
  botId: bot.id,
  number: 1,
  title: "Add pgAdmin login to .zshrc",
  request: "add my pgAdmin login to my zshrc",
  projectId,
  status: "working",
  headline: "",
  headlineAt: null,
  pullRequests: [],
  report: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  archivedAt: null,
});

const project = (id: ProjectId, workspaceRoot: string) =>
  ({ id, title: "pair", workspaceRoot }) as Project;

const scratchId = ProjectId.make("project:scratch");
const repoId = ProjectId.make("project:repo");
const folderId = ProjectId.make("project:folder");
const projects = new Map([
  [scratchId, project(scratchId, "/home/user/.t3/scratch")],
  [repoId, project(repoId, "/home/user/acme/app")],
  [folderId, project(folderId, "/home/user/notes")],
]);

const homeThreadId = ThreadId.make("thread:home");
const cloudId = EnvironmentId.make("env:cloud");
const cloudThreadId = ThreadId.make("thread:cloud-session");
const projectThere = ProjectId.make("project:there");

interface Forwarded {
  readonly tool: string;
  readonly environmentId: EnvironmentId;
  readonly params: Record<string, unknown>;
}

/** BotSessions over fakes; `forwarded` records every call made through a link. */
const sessionsHarness = (input: {
  readonly jobProjectId: ProjectId | null;
  readonly cloudOnly?: boolean;
  readonly clouds?: ReadonlyArray<EnvironmentId>;
  readonly sessions?: ReadonlyArray<BotSession>;
}) => {
  const launches: Array<ThreadLaunch.ThreadLaunchRequest> = [];
  const forwarded: Array<Forwarded> = [];
  const clouds = input.clouds ?? [];
  const homeBot: Bot = { ...bot, homeThreadId };
  const layer = BotSessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BotService)({
          getBot: () => Effect.succeedSome(homeBot),
          snapshotForBot: () =>
            Effect.succeed({
              bots: [homeBot],
              jobs: [job(input.jobProjectId)],
              sessions: [],
              asks: [],
              notes: [],
              events: [],
              revision: 0,
            }),
          addSession: (session: BotSession) => Effect.succeed(session),
          sessionForThread: (threadId) =>
            Effect.succeed(
              Option.fromNullishOr(
                input.sessions?.find((session) => session.threadId === threadId),
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (request) => {
            launches.push(request);
            return Effect.succeed({
              threadId: ThreadId.make("thread:session"),
              projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
              resumed: false,
            });
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: homeThreadId,
              providerInstanceId: model.instanceId,
              activeRunId: null,
            } as never),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          isRepository: (cwd) => Effect.succeed(cwd === "/home/user/acme/app"),
          defaultBranch: () => Effect.succeed("main"),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/home/user/projects",
          ensureScratchProject: Effect.succeed({ projectId: scratchId }),
        }),
        Layer.succeed(ServerConfig.ServerConfig, {
          cloudOnly: input.cloudOnly ?? false,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env:here")),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          agentLinks: Effect.succeed(new Set(clouds)),
          get: (environmentId) =>
            Effect.succeed(
              clouds.includes(environmentId)
                ? Option.some({ label: `Cloud ${environmentId}` } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({
          resolveProject: () => Effect.succeed(projectThere),
          call: (_scope, tool, environmentId, params) => {
            forwarded.push({
              tool: tool.name,
              environmentId,
              params: params as Record<string, unknown>,
            });
            return Effect.succeed({ threadId: cloudThreadId } as never);
          },
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
  );
  return { launches, forwarded, layer };
};

const startInput = (input: {
  readonly projectId?: ProjectId;
  readonly cloud?: BotSessions.BotSessionStartInput["cloud"];
}): BotSessions.BotSessionStartInput => ({
  jobId: BotJobId.make("job:1"),
  ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  role: "worker",
  title: "Add pgAdmin login to .zshrc",
  task: "Add the login.",
  ...(input.cloud === undefined ? {} : { cloud: input.cloud }),
});

/** Starts one session and returns the launch request it made. */
const startSession = (input: {
  readonly jobProjectId: ProjectId | null;
  readonly projectId?: ProjectId;
}) =>
  Effect.gen(function* () {
    const harness = sessionsHarness(input);
    yield* Effect.gen(function* () {
      const sessions = yield* BotSessions.BotSessions;
      yield* sessions.start(bot.id, startInput(input));
    }).pipe(Effect.provide(harness.layer));
    const launch = harness.launches[0];
    assert.isDefined(launch);
    return launch;
  });

describe("BotSessions.start", () => {
  it.effect("runs work outside any project in the scratch project, in place", () =>
    Effect.gen(function* () {
      const launch = yield* startSession({ jobProjectId: null });
      assert.strictEqual(launch.projectId, scratchId);
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });
      assert.include(launch.initialMessage?.text ?? "", "You are not in a worktree");
    }),
  );

  it.effect("runs a project that is not a git repository in place", () =>
    Effect.gen(function* () {
      const launch = yield* startSession({ jobProjectId: folderId });
      assert.strictEqual(launch.projectId, folderId);
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });
    }),
  );

  it.effect("gives a git project's session its own worktree off the default branch", () =>
    Effect.gen(function* () {
      const launch = yield* startSession({ jobProjectId: null, projectId: repoId });
      assert.strictEqual(launch.projectId, repoId);
      assert.deepStrictEqual(launch.workspaceStrategy, {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: false,
      });
      assert.include(launch.initialMessage?.text ?? "", "Work in your own worktree.");
    }),
  );
});

describe("BotSessions cloud sessions", () => {
  it.effect("starts on the linked Pair Cloud, in the project there, and records where", () =>
    Effect.gen(function* () {
      const harness = sessionsHarness({ jobProjectId: repoId, clouds: [cloudId] });
      const session = yield* Effect.gen(function* () {
        const sessions = yield* BotSessions.BotSessions;
        return yield* sessions.start(bot.id, startInput({ cloud: {} }));
      }).pipe(Effect.provide(harness.layer));
      assert.lengthOf(harness.launches, 0);
      const [launch] = harness.forwarded;
      assert.strictEqual(launch?.tool, "t3_thread_launch");
      assert.strictEqual(launch?.environmentId, cloudId);
      assert.strictEqual(launch?.params.projectId, projectThere);
      assert.deepStrictEqual(launch?.params.workspaceStrategy, { type: "cloud", baseRef: "main" });
      assert.strictEqual(session.threadId, cloudThreadId);
      assert.strictEqual(session.projectId, projectThere);
      assert.strictEqual(session.cloud?.environmentId, cloudId);
      assert.strictEqual(session.cloud?.state, "working");
    }),
  );

  it.effect("runs on this server's own machines when it runs cloud machines itself", () =>
    Effect.gen(function* () {
      const harness = sessionsHarness({ jobProjectId: repoId, cloudOnly: true });
      const session = yield* Effect.gen(function* () {
        const sessions = yield* BotSessions.BotSessions;
        return yield* sessions.start(
          bot.id,
          startInput({ cloud: { baseRef: "release", branch: "fix" } }),
        );
      }).pipe(Effect.provide(harness.layer));
      assert.lengthOf(harness.forwarded, 0);
      assert.deepStrictEqual(harness.launches[0]?.workspaceStrategy, {
        type: "cloud",
        baseRef: "release",
        branch: "fix",
      });
      assert.isUndefined(session.cloud);
    }),
  );

  it.effect("refuses what can't run in the cloud, saying what to do", () =>
    Effect.gen(function* () {
      const cases = [
        { jobProjectId: null, clouds: [cloudId], expected: "A job with no project" },
        { jobProjectId: folderId, clouds: [cloudId], expected: "is not a git repository" },
        { jobProjectId: repoId, clouds: [], expected: NO_CLOUD_MESSAGE },
        {
          jobProjectId: repoId,
          clouds: [cloudId, EnvironmentId.make("env:other")],
          expected: "Pass cloud.environmentId",
        },
      ];
      for (const { expected, ...input } of cases) {
        const harness = sessionsHarness(input);
        const error = yield* Effect.gen(function* () {
          const sessions = yield* BotSessions.BotSessions;
          return yield* sessions.start(bot.id, startInput({ cloud: {} }));
        }).pipe(Effect.provide(harness.layer), Effect.flip);
        assert.include(error.message, expected);
        assert.lengthOf(harness.forwarded, 0);
        assert.lengthOf(harness.launches, 0);
      }
    }),
  );

  const cloudSession: BotSession = {
    threadId: cloudThreadId,
    botId: bot.id,
    jobId: BotJobId.make("job:1"),
    role: "worker",
    title: "Rate limit",
    projectId: projectThere,
    takenOver: false,
    createdAt: at,
    cloud: {
      environmentId: cloudId,
      label: "Pair Cloud",
      state: "waiting",
      pendingRequest: null,
      lastOutputAt: at,
      reportedRunId: null,
      reportedRequestIds: [],
      position: 0,
    },
  };

  it.effect("messages and answers a cloud session through the link, never approvals", () =>
    Effect.gen(function* () {
      const harness = sessionsHarness({
        jobProjectId: repoId,
        clouds: [cloudId],
        sessions: [cloudSession],
      });
      const refusal = yield* Effect.gen(function* () {
        const sessions = yield* BotSessions.BotSessions;
        yield* sessions.message(bot.id, cloudThreadId, "Status?");
        yield* sessions.respond(bot.id, {
          threadId: cloudThreadId,
          requestId: "request:1" as never,
          answers: { scope: "per member" },
        });
        return yield* sessions
          .respond(bot.id, {
            threadId: cloudThreadId,
            requestId: "request:2" as never,
            decision: "accept",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(
        harness.forwarded.map((call) => [call.tool, call.environmentId, call.params.threadId]),
        [
          ["t3_thread_send", cloudId, cloudThreadId],
          ["t3_pending_request", cloudId, cloudThreadId],
        ],
      );
      assert.strictEqual(harness.forwarded[1]?.params.action, "respond");
      assert.include(refusal.message, "can't be approved from here");
    }),
  );
});
