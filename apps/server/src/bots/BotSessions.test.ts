import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type BotJob,
  BotJobId,
  type BotSession,
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

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BotService } from "./BotService.ts";
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

/** Starts one session and returns the launch request it made. */
const startSession = (input: {
  readonly jobProjectId: ProjectId | null;
  readonly projectId?: ProjectId;
}) =>
  Effect.gen(function* () {
    const launches: Array<ThreadLaunch.ThreadLaunchRequest> = [];
    const layer = BotSessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(BotService)({
            getBot: () => Effect.succeedSome(bot),
            snapshotForBot: () =>
              Effect.succeed({
                bots: [bot],
                jobs: [job(input.jobProjectId)],
                sessions: [],
                asks: [],
                notes: [],
                events: [],
                revision: 0,
              }),
            addSession: (session: BotSession) => Effect.succeed(session),
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
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            isRepository: (cwd) => Effect.succeed(cwd === "/home/user/acme/app"),
            defaultBranch: () => Effect.succeed("main"),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/home/user/projects",
            ensureScratchProject: Effect.succeed({ projectId: scratchId }),
          }),
          SecureRandom.layerWebCrypto,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sessions = yield* BotSessions.BotSessions;
      yield* sessions.start(bot.id, {
        jobId: BotJobId.make("job:1"),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        role: "worker",
        title: "Add pgAdmin login to .zshrc",
        task: "Add the login.",
      });
    }).pipe(Effect.provide(layer));
    const launch = launches[0];
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
