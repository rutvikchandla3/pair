import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type BotJob,
  BotJobId,
  type BotSession,
  type ChatAttachment,
  ChatAttachmentId,
  EnvironmentId,
  MemberId,
  type Project,
  ProjectId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { ProviderCloudUnsupportedError } from "../provider/Errors.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { modelSelectionProblem } from "../provider/modelSelectionCheck.ts";
import { readyProvider } from "../provider/ProviderRegistry.testkit.ts";
import { BotService } from "./BotService.ts";
import { NO_CLOUD_MESSAGE } from "./botCloud.ts";
import * as BotSessions from "./BotSessions.ts";

const at = "2026-11-19T00:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const claude = readyProvider(model.instanceId, {
  models: [
    { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isCustom: false, capabilities: null },
  ],
});

const bot: Bot = {
  id: BotId.make("bot:atlas"),
  ownerId: MemberId.make("member:owner"),
  name: "Atlas",
  color: "#6366f1",
  shape: "round",
  voice: "crisp",
  picture: null,
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

interface Forwarded {
  readonly tool: string;
  readonly environmentId: EnvironmentId;
  readonly params: Record<string, unknown>;
  readonly attachmentsStaged: boolean;
}

/** What the cloud received as pending uploads, with the bytes that went. */
interface Staged {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly bytes: ReadonlyArray<number>;
}

const sessionThreadId = ThreadId.make("thread:live-session");

const homeRecords = (chat: ReadonlyArray<ChatAttachment> | undefined) => ({
  messages: [
    { role: "user", createdBy: "user", text: "See the screenshots.", attachments: chat ?? [] },
    { role: "user", createdBy: "agent", text: "From a session.", attachments: [sentByAgent] },
  ],
});

const sessionRecords = {
  messages: [{ role: "assistant", text: "Fixed the login bug." }],
  turnItems: [
    {
      type: "user_input_request",
      requestId: "request:1",
      questions: [{ question: "Which branch?" }],
    },
  ],
};

/** BotSessions over fakes; `forwarded` records every call made through a link. */
const sessionsHarness = (input: {
  readonly jobProjectId: ProjectId | null;
  readonly cloudOnly?: boolean;
  readonly clouds?: ReadonlyArray<EnvironmentId>;
  readonly sessions?: ReadonlyArray<BotSession>;
  /** This server's providers; default: the bot's own Claude. */
  readonly providers?: ReadonlyArray<ServerProvider>;
  /** What a re-probe finds; default: the same providers. */
  readonly refreshedProviders?: ReadonlyArray<ServerProvider>;
  /** The local launch fails with this. */
  readonly launchFails?: ThreadManagementService.ThreadManagementProviderInstanceDisabledError;
  /** The cloud's t3_thread_launch fails with this. */
  readonly cloudRefuses?: OrchestratorMcpFailure;
  /** This server's attachments directory, and what the user attached in the bot's chat. */
  readonly attachmentsDir?: string;
  readonly chat?: ReadonlyArray<ChatAttachment>;
  /** The request `sessionThreadId` waits on, if any. */
  readonly sessionPending?: { readonly id: string; readonly kind: string } | null;
  /** The session's job status; default: working. */
  readonly jobStatus?: BotJob["status"];
}) => {
  const updates: Array<BotJob["status"] | undefined> = [];
  const handedBack: Array<ThreadId> = [];
  const launches: Array<ThreadLaunch.ThreadLaunchRequest> = [];
  const forwarded: Array<Forwarded> = [];
  const staged: Array<Staged> = [];
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
          getJob: () =>
            Effect.succeedSome({
              ...job(input.jobProjectId),
              status: input.jobStatus ?? "working",
            }),
          setSessionTakenOver: (threadId) => {
            handedBack.push(threadId);
            return Effect.succeed(cloudSession);
          },
          updateJob: (_botId, _jobId, patch) => {
            updates.push(patch.status);
            return Effect.succeed(job(input.jobProjectId));
          },
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
            if (input.launchFails !== undefined) return Effect.fail(input.launchFails);
            launches.push(request);
            return Effect.succeed({
              threadId: request.threadId ?? ThreadId.make("thread:session"),
              projection: {
                messages: [{ attachments: request.initialMessage?.attachments ?? [] }],
              } as unknown as ThreadLaunch.ThreadLaunchResult["projection"],
              resumed: false,
            });
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              (threadId === sessionThreadId
                ? {
                    id: sessionThreadId,
                    status: "completed",
                    archivedAt: null,
                    deletedAt: null,
                    latestRunId: "run:2",
                    pendingRuntimeRequest: input.sessionPending ?? null,
                    updatedAt: DateTime.makeUnsafe(at),
                  }
                : {
                    id: homeThreadId,
                    providerInstanceId: model.instanceId,
                    activeRunId: null,
                  }) as never,
            ),
          // Like the projection store, only the fields asked for.
          getThreadRecords: (threadId, fields) =>
            Effect.succeed(
              Object.fromEntries(
                Object.entries(
                  threadId === sessionThreadId
                    ? sessionRecords
                    : threadId === homeThreadId
                      ? homeRecords(input.chat)
                      : { messages: [] },
                ).filter(([field]) => (fields as ReadonlyArray<string>).includes(field)),
              ) as never,
            ),
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
          attachmentsDir: input.attachmentsDir ?? "/home/user/.t3/userdata/attachments",
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(DocumentText.DocumentText)({ ensure: () => Effect.undefined }),
        NodeServices.layer,
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
          stageAttachments: (_scope, environmentId, files) =>
            Effect.sync(() =>
              files.map(({ attachment, bytes }, index) => {
                staged.push({ environmentId, name: attachment.name, bytes: Array.from(bytes) });
                return { ...attachment, id: ChatAttachmentId.make(`pending-cloud-${index}`) };
              }),
            ),
          call: (_scope, tool, environmentId, params, options) => {
            forwarded.push({
              tool: tool.name,
              environmentId,
              params: params as Record<string, unknown>,
              attachmentsStaged: options?.attachmentsStaged === true,
            });
            if (input.cloudRefuses !== undefined) return Effect.fail(input.cloudRefuses);
            // The cloud answers with what the thread runs on.
            return Effect.succeed({
              threadId: cloudThreadId,
              modelSelection: (params as { modelSelection: unknown }).modelSelection,
            } as never);
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(input.providers ?? [claude]),
          refreshInstance: () =>
            Effect.succeed(input.refreshedProviders ?? input.providers ?? [claude]),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed((input.providers ?? [claude]).map((p) => p.instanceId)),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
  );
  return { launches, forwarded, staged, updates, handedBack, layer };
};

const startInput = (input: {
  readonly projectId?: ProjectId;
  readonly cloud?: BotSessions.BotSessionStartInput["cloud"];
  readonly modelSelection?: BotSessions.BotSessionStartInput["modelSelection"];
  readonly attachments?: ReadonlyArray<string>;
}): BotSessions.BotSessionStartInput => ({
  jobId: BotJobId.make("job:1"),
  ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  role: "worker",
  title: "Add pgAdmin login to .zshrc",
  task: "Add the login.",
  ...(input.cloud === undefined ? {} : { cloud: input.cloud }),
  ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
  ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
});

const screenshotBytes = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
const screenshot: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("thread-home-00000000-0000-4000-8000-000000000001"),
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: screenshotBytes.length,
};

/** On a message an agent sent to the bot's chat, not the user. */
const sentByAgent: ChatAttachment = {
  ...screenshot,
  id: ChatAttachmentId.make("thread-home-00000000-0000-4000-8000-000000000003"),
};

/** A temporary attachments directory holding the screenshot the user sent the bot. */
const attachmentsWithScreenshot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bot-sessions-" });
  const stored = resolveAttachmentPath({ attachmentsDir, attachment: screenshot })!;
  yield* fileSystem.writeFile(stored, Uint8Array.from(screenshotBytes));
  return { attachmentsDir, stored };
}).pipe(Effect.provide(NodeServices.layer));

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

/** Starts one cloud session whose launch fails there with `failure`, and returns the error. */
const startRefused = (
  failure: OrchestratorMcpFailure,
  modelSelection: BotSessions.BotSessionStartInput["modelSelection"],
) =>
  Effect.gen(function* () {
    const sessions = yield* BotSessions.BotSessions;
    return yield* sessions.start(bot.id, startInput({ cloud: {}, modelSelection }));
  }).pipe(
    Effect.provide(
      sessionsHarness({ jobProjectId: repoId, clouds: [cloudId], cloudRefuses: failure }).layer,
    ),
    Effect.flip,
  );

describe("BotSessions.start", () => {
  it.effect("runs work outside any project in the scratch project, in place", () =>
    Effect.gen(function* () {
      const launch = yield* startSession({ jobProjectId: null });
      assert.strictEqual(launch.projectId, scratchId);
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });
      assert.include(launch.initialMessage?.text ?? "", "You are not in a worktree");
      assert.deepStrictEqual(launch.modelSelection, bot.models.worker);
    }),
  );

  it.effect("runs on the model the bot chose and records it, refusing one that can't run", () =>
    Effect.gen(function* () {
      const chosen = { ...model, options: [{ id: "effort", value: "high" }] };
      const start = (
        modelSelection: BotSessions.BotSessionStartInput["modelSelection"],
        providers?: ReadonlyArray<ServerProvider>,
        fakes: Pick<
          Parameters<typeof sessionsHarness>[0],
          "refreshedProviders" | "launchFails"
        > = {},
      ) => {
        const harness = sessionsHarness({
          jobProjectId: repoId,
          ...(providers === undefined ? {} : { providers }),
          ...fakes,
        });
        return Effect.gen(function* () {
          const sessions = yield* BotSessions.BotSessions;
          return yield* sessions.start(bot.id, startInput({ modelSelection }));
        }).pipe(
          Effect.provide(harness.layer),
          Effect.map((session) => ({ session, launches: harness.launches })),
          Effect.mapError((error) => ({ error, launches: harness.launches })),
        );
      };
      const started = yield* start(chosen);
      assert.deepStrictEqual(started.launches[0]?.modelSelection, chosen);
      assert.deepStrictEqual(started.session.modelSelection, chosen);

      const refused = yield* start({
        instanceId: ProviderInstanceId.make("claudeAgent-ha"),
        model: "claude-opus-5-5",
      }).pipe(Effect.flip);
      assert.strictEqual(refused.error.reason, "invalid-request");
      assert.include(refused.error.message, 'No provider instance "claudeAgent-ha" here.');
      assert.notInclude(refused.error.message, "That is your worker model");
      assert.lengthOf(refused.launches, 0);

      // The bot's own choice may not carry an option its model doesn't declare.
      const codex = readyProvider("codex", {
        models: [
          {
            slug: "gpt-5.5",
            name: "GPT-5.5",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  options: [{ id: "xhigh", label: "Extra high" }],
                },
              ],
            },
          },
        ],
      });
      const undeclared = yield* start(
        {
          instanceId: codex.instanceId,
          model: "gpt-5.5",
          options: [{ id: "effort", value: "xhigh" }],
        },
        [claude, codex],
      ).pipe(Effect.flip);
      assert.include(
        undeclared.error.message,
        "Unknown option effort; supported options: reasoningEffort.",
      );
      assert.lengthOf(undeclared.launches, 0);

      // The role default is checked too, and the bot is told it was its default.
      const roleDefault = yield* start(undefined, []).pipe(Effect.flip);
      assert.include(roleDefault.error.message, "That is your worker model");
      assert.lengthOf(roleDefault.launches, 0);

      // A stale snapshot, as before the first probe, is re-probed instead of refused.
      const stale = { ...claude, installed: false, status: "warning" as const };
      const reprobed = yield* start(chosen, [stale], { refreshedProviders: [claude] });
      assert.lengthOf(reprobed.launches, 1);

      const turnedOff = yield* start(chosen, undefined, {
        launchFails: new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
          projectId: repoId,
          instanceId: model.instanceId,
        }),
      }).pipe(Effect.flip);
      assert.strictEqual(turnedOff.error.reason, "invalid-request");
      assert.include(turnedOff.error.message, "turned off for");
      assert.include(turnedOff.error.message, "or pass another modelSelection");
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

  it.effect("gives the session the user's chat attachments, by id or saved path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { attachmentsDir, stored } = yield* attachmentsWithScreenshot;
        const fileSystem = yield* FileSystem.FileSystem;
        for (const reference of [screenshot.id, stored]) {
          const harness = sessionsHarness({
            jobProjectId: repoId,
            attachmentsDir,
            chat: [screenshot],
          });
          yield* Effect.gen(function* () {
            const sessions = yield* BotSessions.BotSessions;
            yield* sessions.start(bot.id, startInput({ attachments: [reference] }));
          }).pipe(Effect.provide(harness.layer));
          const launch = harness.launches[0];
          const [sent] = launch?.initialMessage?.attachments ?? [];
          assert.isDefined(launch?.threadId);
          assert.isDefined(sent);
          // The thread's own copy, as if the user had attached it there.
          assert.notStrictEqual(sent.id, screenshot.id);
          assert.deepInclude(sent, {
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
          });
          const copy = resolveAttachmentPath({ attachmentsDir, attachment: sent })!;
          assert.deepStrictEqual(Array.from(yield* fileSystem.readFile(copy)), screenshotBytes);
        }
        // Only the chat's file and the sessions' copies remain: no pending uploads linger.
        const files = yield* fileSystem.readDirectory(attachmentsDir);
        assert.lengthOf(files, 3);
        assert.isFalse(files.some((file) => file.startsWith("pending-")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses any reference that is not an attachment in the bot's chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { attachmentsDir } = yield* attachmentsWithScreenshot;
        const fileSystem = yield* FileSystem.FileSystem;
        // Another thread's attachment, stored in the same directory.
        const elsewhere = {
          ...screenshot,
          id: ChatAttachmentId.make("thread-other-00000000-0000-4000-8000-000000000002"),
        };
        const elsewherePath = resolveAttachmentPath({ attachmentsDir, attachment: elsewhere })!;
        yield* fileSystem.writeFile(elsewherePath, Uint8Array.from(screenshotBytes));
        yield* fileSystem.writeFile(
          resolveAttachmentPath({ attachmentsDir, attachment: sentByAgent })!,
          Uint8Array.from(screenshotBytes),
        );
        for (const reference of [
          "/etc/passwd",
          `${attachmentsDir}/../secret.png`,
          elsewhere.id,
          elsewherePath,
          sentByAgent.id,
          "thread-home-00000000-0000-4000-8000-000000000009",
        ]) {
          for (const cloud of [undefined, {}]) {
            const harness = sessionsHarness({
              jobProjectId: repoId,
              attachmentsDir,
              chat: [screenshot],
              clouds: [cloudId],
            });
            const error = yield* Effect.gen(function* () {
              const sessions = yield* BotSessions.BotSessions;
              return yield* sessions.start(
                bot.id,
                startInput({ attachments: [reference], ...(cloud === undefined ? {} : { cloud }) }),
              );
            }).pipe(Effect.provide(harness.layer), Effect.flip);
            assert.strictEqual(error.reason, "invalid-request");
            assert.include(error.message, `${reference} is not an attachment the user sent`);
            assert.lengthOf(harness.launches, 0);
            assert.lengthOf(harness.forwarded, 0);
            assert.lengthOf(harness.staged, 0);
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("BotSessions cloud sessions", () => {
  it.effect("starts on the linked Pair Cloud, in the project there, and records where", () =>
    Effect.gen(function* () {
      // An instance only the cloud has: the cloud checks it, not this server.
      const onCloud = {
        instanceId: ProviderInstanceId.make("claudeAgent-ha"),
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      };
      const harness = sessionsHarness({ jobProjectId: repoId, clouds: [cloudId] });
      const session = yield* Effect.gen(function* () {
        const sessions = yield* BotSessions.BotSessions;
        return yield* sessions.start(bot.id, startInput({ cloud: {}, modelSelection: onCloud }));
      }).pipe(Effect.provide(harness.layer));
      assert.lengthOf(harness.launches, 0);
      const [launch] = harness.forwarded;
      assert.strictEqual(launch?.tool, "t3_thread_launch");
      assert.strictEqual(launch?.environmentId, cloudId);
      assert.strictEqual(launch?.params.projectId, projectThere);
      assert.deepStrictEqual(launch?.params.workspaceStrategy, { type: "cloud", baseRef: "main" });
      assert.strictEqual(session.threadId, cloudThreadId);
      assert.strictEqual(session.projectId, projectThere);
      assert.deepStrictEqual(launch?.params.modelSelection, onCloud);
      assert.deepStrictEqual(session.modelSelection, onCloud);
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

      // The cloud's own refusal reaches the bot with its words, plus whose model it was.
      const refusals = [
        // What a cloud without this instance answers, worded by the shared check.
        `${modelSelectionProblem({
          providers: [],
          adapterInstanceIds: new Set(),
          selection: model,
        })} No thread was created.`,
        // What Pair Cloud 0.1.7-pair.36 answered a bot whose worker default is pi (19 Nov).
        `${new ProviderCloudUnsupportedError({ threadId: "", driver: "pi" }).message} No thread was created.`,
      ];
      for (const refusal of refusals) {
        for (const modelSelection of [undefined, model]) {
          const error = yield* startRefused(
            new OrchestratorMcpFailure({ code: "invalid_request", message: refusal }),
            modelSelection,
          );
          assert.strictEqual(error.reason, "invalid-request");
          assert.include(error.message, `on Cloud ${cloudId}: ${refusal}`);
          assert.strictEqual(
            error.message.includes(
              `That is your worker model, from this machine: pass modelSelection with one that runs there (orchestrator_capabilities with environmentId ${cloudId} lists them).`,
            ),
            modelSelection === undefined,
          );
          assert.notInclude(error.message, "Models…");
        }
      }
      // Only a failure to answer may pass with time; any other code is a refusal to act on.
      for (const [code, reason] of [
        ["runtime_mode_escalation_denied", "invalid-request"],
        ["orchestration_error", "unavailable"],
      ] as const) {
        const error = yield* startRefused(
          new OrchestratorMcpFailure({ code, message: "The cloud says why." }),
          model,
        );
        assert.strictEqual(error.reason, reason);
        assert.include(error.message, "The cloud says why.");
      }
    }),
  );

  it.effect("uploads the chat's attachments to the cloud for its session's messages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { attachmentsDir } = yield* attachmentsWithScreenshot;
        const harness = sessionsHarness({
          jobProjectId: repoId,
          clouds: [cloudId],
          sessions: [cloudSession],
          attachmentsDir,
          chat: [screenshot],
        });
        yield* Effect.gen(function* () {
          const sessions = yield* BotSessions.BotSessions;
          yield* sessions.start(bot.id, startInput({ cloud: {}, attachments: [screenshot.id] }));
          yield* sessions.message(bot.id, cloudThreadId, "Here it is.", [screenshot.id]);
        }).pipe(Effect.provide(harness.layer));
        const upload = { environmentId: cloudId, name: "screenshot.png", bytes: screenshotBytes };
        assert.deepStrictEqual(harness.staged, [upload, upload]);
        const sentThere = [{ ...screenshot, id: "pending-cloud-0" }];
        assert.deepStrictEqual(
          harness.forwarded.map((call) => [
            call.tool,
            call.params.attachments,
            call.attachmentsStaged,
          ]),
          [
            ["t3_thread_launch", sentThere, true],
            ["t3_thread_send_attachments", sentThere, true],
          ],
        );
        assert.strictEqual(harness.forwarded[1]?.params.message, "Here it is.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

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
      assert.deepStrictEqual(harness.updates, []);
    }),
  );

  it.effect("reopens a done job before a follow-up goes out, and only a done one", () =>
    Effect.gen(function* () {
      const reopened = (jobStatus: BotJob["status"]) =>
        Effect.gen(function* () {
          const harness = sessionsHarness({
            jobProjectId: repoId,
            clouds: [cloudId],
            sessions: [cloudSession],
            jobStatus,
          });
          yield* Effect.gen(function* () {
            const sessions = yield* BotSessions.BotSessions;
            yield* sessions.message(bot.id, cloudThreadId, "Also check the other repo.");
          }).pipe(Effect.provide(harness.layer));
          assert.strictEqual(harness.forwarded.length, 1);
          return harness.updates;
        });
      assert.deepStrictEqual(yield* reopened("done"), ["working"]);
      assert.deepStrictEqual(yield* reopened("working"), []);
      assert.deepStrictEqual(yield* reopened("stopped"), []);
    }),
  );
});

describe("BotSessions.reclaim", () => {
  it.effect("takes back a taken-over session, and only the bot's own", () =>
    Effect.gen(function* () {
      const reclaim = (session: BotSession, botId = bot.id) => {
        const harness = sessionsHarness({ jobProjectId: repoId, sessions: [session] });
        return Effect.gen(function* () {
          const sessions = yield* BotSessions.BotSessions;
          return yield* sessions.reclaim(botId, session.threadId).pipe(Effect.flip, Effect.option);
        }).pipe(
          Effect.provide(harness.layer),
          Effect.map((failure) => ({ failure, handedBack: harness.handedBack })),
        );
      };
      const taken = { ...cloudSession, takenOver: true };
      assert.deepStrictEqual((yield* reclaim(taken)).handedBack, [cloudThreadId]);
      assert.deepStrictEqual((yield* reclaim(cloudSession)).handedBack, []);
      const other = yield* reclaim(taken, BotId.make("bot:other"));
      assert.deepStrictEqual(other.handedBack, []);
      assert.strictEqual(Option.getOrThrow(other.failure).reason, "not-found");
    }),
  );
});

describe("BotSessions.liveState", () => {
  it.effect("reads a session thread with or without a pending request", () =>
    Effect.gen(function* () {
      const live = (sessionPending: { readonly id: string; readonly kind: string } | null) =>
        Effect.gen(function* () {
          const sessions = yield* BotSessions.BotSessions;
          return yield* sessions.liveState(sessionThreadId);
        }).pipe(Effect.provide(sessionsHarness({ jobProjectId: repoId, sessionPending }).layer));

      assert.deepStrictEqual(yield* live(null), {
        status: "idle",
        pendingRequest: null,
        lastAssistantText: "Fixed the login bug.",
        changedAt: at,
      });
      assert.deepStrictEqual(
        (yield* live({ id: "request:1", kind: "user_input" })).pendingRequest,
        {
          requestId: "request:1",
          kind: "user_input",
          text: "Which branch?",
        } as never,
      );
    }),
  );
});
