import * as DocumentText from "../provider/DocumentText.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChatAttachmentId,
  CloudStagingKey,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  ComputeDriverId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  GitCommandError,
  MemberId,
  MessageId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ThreadProjectionJson,
  SandboxId,
  PositiveInt,
  ScheduledTaskId,
  type ServerProvider,
  type TeamImageBuild,
  TeamImageBuildId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextExports from "./ContextExports.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as CloudPreparation from "../sandbox/lifecycle/CloudPreparation.ts";
import * as ServerDrain from "../drain/ServerDrain.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as StagedCloudImports from "../cloudMove/StagedCloudImports.ts";
import { NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FakeComputeDriver from "../sandbox/compute/ComputeDriverTesting.ts";
import * as SandboxBootstrapSource from "../sandbox/lifecycle/SandboxBootstrapSource.ts";
import * as SandboxEffects from "../sandbox/lifecycle/SandboxEffects.ts";
import * as SandboxCredentialRevocation from "../sandbox/credentials/SandboxCredentialRevocation.ts";
import * as RunnerGrants from "../sandbox/runnerHub/RunnerGrants.ts";
import * as RunnerHub from "../sandbox/runnerHub/RunnerHub.ts";
import * as RunnerHubTesting from "../sandbox/runnerHub/RunnerHubTesting.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as TeamImageStore from "../sandbox/image/TeamImageStore.ts";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as const;
const claudeAdapter = {
  instanceId: claudeModelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly cloudOnly?: boolean;
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly remoteHasBranch?: GitWorkflow.GitWorkflowService["Service"]["remoteHasBranch"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly mirrorRestore?: MirrorSync.MirrorSync["Service"]["restore"];
  readonly stagedImports?: Partial<StagedCloudImports.StagedCloudImports["Service"]>;
  /** The team's active image build; none by default. */
  readonly activeImageBuild?: TeamImageBuild;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false, cloudOnly: options.cloudOnly ?? false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const deleteLocalBranch = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      getResolvedShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      remoteHasBranch: options.remoteHasBranch ?? (() => Effect.succeed(true)),
      removeWorktree,
      deleteLocalBranch,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
  const active = options.activeImageBuild;
  const layerTeamImages =
    active === undefined
      ? TeamImageStore.layer.pipe(Layer.provide(layerDatabase))
      : Layer.mock(TeamImageStore.TeamImageStore)({
          state: Effect.succeed({ activeBuildId: active.id, nextBuildNumber: active.number + 1 }),
          build: (id) =>
            Effect.succeed(
              id === active.id
                ? Option.some({ build: active, machine: {} as never })
                : Option.none(),
            ),
        });
  const layerContextExports = ContextExports.layer.pipe(
    Layer.provide(layerThreadManagement),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("environment:launch-test"),
          label: "Launch test",
        } as never),
      }),
    ),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerContextExports,
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        layerProjections,
        layerTeamImages,
        IdAllocator.layer,
        Layer.succeed(ServerConfig.ServerConfig, {
          cloudOnly: options.cloudOnly ?? false,
        } as ServerConfig.ServerConfig["Service"]),
        options.mirrorRestore === undefined
          ? Layer.empty
          : Layer.mock(MirrorSync.MirrorSync)({ restore: options.mirrorRestore }),
        options.stagedImports === undefined
          ? Layer.empty
          : Layer.mock(StagedCloudImports.StagedCloudImports)(options.stagedImports),
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              pinnedAt: null,
              archivedAt: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        layerExternalServices,
        WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerContextExports,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
      layerProjections,
      layerTeamImages,
    ),
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
          ManagedPolicy.layerTest(),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "succeeded");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      assert.equal(result.threadId, thread!.id);
      const projection = yield* threads.getThreadProjection(thread!.id);
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find(
        (item): item is Extract<typeof item, { type: "user_message" }> =>
          item.type === "user_message",
      );
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect(
  "returns no dispatched thread when sending an automation to a missing thread fails",
  () => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
          ManagedPolicy.layerTest(),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const threadId = ThreadId.make("thread:missing");
      const { task } = yield* tasks.upsert({
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "failed");
      assert.isNull(result.threadId);
      assert.equal(result.task.threadId, threadId);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect("runs a thread-bound automation on the provider the thread uses now", () => {
  const harness = makeHarness({ adapters: [adapter, claudeAdapter] });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
        ManagedPolicy.layerTest(),
      ),
    ),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({ command: "command:switched", thread: "thread:switched" }),
    );
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make("scheduled-task:switched"),
      title: "Hourly check",
      prompt: "Check on the delegated workers.",
      enabled: false,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: launched.threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:switch-selection"),
      threadId: launched.threadId,
      modelSelection: claudeModelSelection,
    });

    const result = yield* tasks.runNow({ id: task.id });
    assert.equal(result.task.lastRunStatus, "succeeded");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.scheduledTaskId === task.id);
    const run = projection.runs.find((item) => item.id === message?.runId);
    assert.deepStrictEqual(run?.modelSelection, claudeModelSelection);
    assert.deepStrictEqual(projection.thread.modelSelection, claudeModelSelection);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
});

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("provisions independent launches concurrently instead of behind a global semaphore", () =>
  Effect.gen(function* () {
    const setupCount = yield* Ref.make(0);
    const bothEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
          ),
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const results = yield* Effect.all(
        [
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-a",
              thread: "thread:launch:concurrent-a",
              message: "First",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-b",
              thread: "thread:launch:concurrent-b",
              message: "Second",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result.projection.runs[0]?.status),
        ["preparing", "preparing"],
      );
      yield* Deferred.await(bothEntered);
      assert.equal(yield* Ref.get(setupCount), 2);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([" /COMPACT "])(
  "uses the first conversation message for a title after %s",
  (nativeCommand) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "compact-title",
            thread: "compact-title-thread",
            message: nativeCommand,
          }),
          generateTitle: true,
        });
        assert.isUndefined(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration,
        );
        assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.lastVisitedAt);
        assert.isFalse(
          (yield* outbox.listByCommandId(CommandId.make("compact-title:initial-message"))).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        const commandId = CommandId.make("compact-title-conversation");
        const messageId = MessageId.make("compact-title-conversation-message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId,
          createdBy: "user",
          creationSource: "web",
          text: "Fix the failing parser",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        assert.equal(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration
            ?.requestId,
          commandId,
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(commandId))
            .filter((effect) => effect.request.type === "thread-title.generate")
            .map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "initial", messageId } }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps native maintenance commands out of steering and restart messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const scenario of [
        {
          name: "compact-steer",
          first: "Fix the parser",
          next: " /COMPACT ",
          mode: "steer_active",
        },
        {
          name: "compact-restart",
          first: "Fix the parser",
          next: "/compact",
          mode: "restart_active",
        },
        {
          name: "logout-steer",
          first: "Fix the parser",
          next: "/logout",
          mode: "steer_active",
        },
        {
          name: "logout-restart",
          first: "Fix the parser",
          next: "/logout",
          mode: "restart_active",
        },
        {
          name: "steer-logout",
          first: "/logout",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "steer-compaction",
          first: "/compact",
          next: "Continue with the parser",
          mode: "steer_active",
        },
      ] as const) {
        const launched = yield* launches.launch(
          launchInput({
            command: `${scenario.name}:launch`,
            thread: scenario.name,
            message: scenario.first,
          }),
        );
        const before = yield* threads.getThreadProjection(launched.threadId);
        const targetRun = before.runs[0];
        if (targetRun === undefined) return yield* Effect.die("Launch must create a run");
        const commandId = CommandId.make(`${scenario.name}:message`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId: MessageId.make(`${scenario.name}:message`),
          createdBy: "user",
          creationSource: "web",
          text: scenario.next,
          attachments: [],
          dispatchMode: { type: scenario.mode, targetRunId: targetRun.id },
        });
        if (scenario.name.startsWith("steer-")) {
          yield* dispatch;
          const queued = (yield* threads.getThreadProjection(launched.threadId)).runs[1];
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.userMessageId, MessageId.make(`${scenario.name}:message`));
          continue;
        }
        const failure = yield* dispatch.pipe(Effect.flip);
        assert.include(
          String(failure.cause).toLowerCase(),
          scenario.name.includes("logout") ? "sign" : "context compaction",
        );
        const after = yield* threads.getThreadProjection(launched.threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.thread.titleRegeneration, before.thread.titleRegeneration);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("arms durable title generation after accepting the first message", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      generateTitle: (input) =>
        Effect.succeed({
          title: input.previousTitle === undefined ? "Generated title" : "Regenerated title",
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const input = {
        ...launchInput({
          command: "command:launch:title-generation",
          thread: "thread:launch:title-generation",
          message: "Generate my title",
        }),
        title: "Generate my title",
        generateTitle: true,
      };
      const launched = yield* launches.launch(input);
      const generationCommandId = CommandId.make("command:launch:title-generation:initial-message");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.title, "Generate my title");
      assert.equal(projection.thread.titleRegeneration?.requestId, generationCommandId);
      assert.deepEqual(
        (yield* outbox.listByCommandId(generationCommandId)).map((effect) => effect.request),
        [
          {
            type: "thread-title.generate",
            kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
          },
        ],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: generationCommandId,
        kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
      });
      const generated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(generated.thread.title, "Generated title");
      assert.deepEqual(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );

      const manualRequestId = CommandId.make("command:title-generation:manual");
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: manualRequestId,
        threadId: launched.threadId,
        regenerateTitle: true,
      });
      assert.deepEqual(
        (yield* outbox.listByCommandId(manualRequestId)).map((effect) => effect.request),
        [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: manualRequestId,
        kind: { type: "regenerate" },
      });
      const regenerated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(regenerated.thread.title, "Regenerated title");
      assert.equal(
        harness.generateThreadTitle.mock.calls[1]?.[0]?.previousTitle,
        "Generated title",
      );

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:title-generation:user-rename"),
        threadId: launched.threadId,
        title: "Keep my title",
      });
      const renamed = yield* threads.getThreadProjection(launched.threadId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* threads.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("command:title-generation:stale-completion"),
        threadId: launched.threadId,
        requestId: generationCommandId,
        title: "Stale generated title",
      });
      const afterStaleCompletion = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(afterStaleCompletion.thread.title, "Keep my title");
      assert.equal(
        DateTime.toEpochMillis(afterStaleCompletion.thread.updatedAt),
        DateTime.toEpochMillis(renamed.thread.updatedAt),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not update a reused thread title when the initial message is rejected", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

// Stands `projectId` in for the Scratch project: a plain folder, not a Git
// repository, so Git fails there with the error a real one raises.
function scratchHarness() {
  const claimed: Array<ThreadId> = [];
  const scratchRoot = project.workspaceRoot;
  const notARepository = (operation: string, cwd: string) =>
    new GitCommandError({
      operation,
      command: "vcs-route",
      cwd,
      detail: "Failed to resolve the VCS driver for this Git command.",
    });
  const harness = makeHarness({
    managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (id) => Effect.succeed(id === projectId),
      folderForThread: (input) =>
        Effect.sync(() => {
          if (input.projectId !== projectId) return Option.none();
          claimed.push(input.threadId);
          return Option.some(`/scratch/folder-${claimed.length}`);
        }),
    }),
    remoteExists: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.remoteExists", input.cwd))
        : Effect.succeed(true),
    createWorktree: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.createWorktree", input.cwd))
        : Effect.succeed({
            worktree: {
              path: "/other-repo-worktrees/feature",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
  });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
        ManagedPolicy.layerTest(),
      ),
    ),
  );
  return {
    ...harness,
    claimed,
    layer: Layer.mergeAll(harness.layer, layerScheduledTasks),
  };
}

const worktreeStrategy = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

function scheduledTaskInput(id: string, targetProjectId: ProjectId) {
  return {
    id: ScheduledTaskId.make(id),
    title: "Daily summary",
    prompt: "Summarize the day.",
    enabled: false,
    schedule: { type: "interval" as const, everyMs: 60_000 },
    projectId: targetProjectId,
    threadId: null,
    workspaceStrategy: worktreeStrategy,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
}

it.effect("launches a worktree request for Scratch at the root, in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:scratch-worktree",
        thread: "thread:launch:scratch-worktree",
        message: "Tidy my notes",
        workspace: worktreeStrategy,
      }),
    );
    const scratch = yield* preparationSettled(launched.threadId);
    assert.equal(scratch.thread.worktreePath, "/scratch/folder-1");
    // Released past preparation; provider execution is disabled here.
    assert.equal(scratch.runs[0]?.status, "starting");
    assert.deepEqual(scratch.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    // A Git project still gets the worktree it asked for.
    const other = yield* launches.launch({
      ...launchInput({
        command: "command:launch:git-worktree",
        thread: "thread:launch:git-worktree",
        message: "Build the feature",
        workspace: worktreeStrategy,
      }),
      projectId: otherProjectId,
    });
    const git = yield* preparationSettled(other.threadId);
    assert.equal(git.runs[0]?.status, "starting");
    assert.equal(git.runs[0]?.workspacePreparation?.type, "worktree");
    assert.equal(git.thread.worktreePath, "/other-repo-worktrees/feature");
    assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.cwd, "/other-repo");
    assert.deepEqual(harness.claimed, [launched.threadId]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stores a Scratch scheduled task at the root and keeps worktrees elsewhere", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const scratch = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-upsert", projectId),
    );
    assert.deepEqual(scratch.task.workspaceStrategy, { type: "root" });
    const git = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:git-upsert", otherProjectId),
    );
    assert.deepEqual(git.task.workspaceStrategy, worktreeStrategy);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("runs a Scratch scheduled task saved with a worktree in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const { task } = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-stored", projectId),
    );
    // Tasks saved before Scratch was coerced still hold a worktree strategy.
    yield* sql`
      UPDATE scheduled_tasks
      SET workspace_strategy_json = ${JSON.stringify(worktreeStrategy)}
      WHERE task_id = ${task.id}
    `;
    const ran = yield* tasks.runNow({ id: task.id });
    assert.equal(ran.task.lastRunStatus, "succeeded");
    const [thread] = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
    assert.isDefined(thread);
    const projection = yield* preparationSettled(thread!.id);
    assert.equal(projection.runs[0]?.status, "starting");
    assert.equal(projection.thread.worktreePath, "/scratch/folder-1");
    assert.deepEqual(projection.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["stable", "upstream/release"])(
  "launches from %s with the fetched commit and remote PR base",
  (baseRef) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "launch-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      const localHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote advance"]);
      yield* command(cwd, ["push", "upstream", "stable:release"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["reset", "--hard", localHead]);
      yield* command(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);

      const setupStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        hasCommit: ({ refName }) =>
          command(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          hasRefNamed: () => Effect.succeed(false),
        },
        fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
        createWorktree: (input, options) =>
          git.createWorktree({ ...input, cwd, path: worktreePath }, options),
        runSetup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const workspace = {
          type: "worktree" as const,
          baseRef,
          branch: "feature",
          startFromOrigin: true,
        };
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:remote-base",
            thread: "thread:launch:remote-base",
            workspace,
          }),
        );
        yield* Deferred.await(setupStarted);
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.thread.worktreePath, worktreePath);
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          remoteHead,
        );
        const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
          remoteHead,
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-remote-git-" })),
          Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect("fetches the origin base from the remote it already resolved", () => {
  let fetchInput: Deferred.Deferred<unknown> | null = null;
  const harness = makeHarness({
    fetchWorktreeBaseCommit: (input) => Deferred.succeed(fetchInput!, input).pipe(Effect.as(null)),
  });
  return Effect.gen(function* () {
    fetchInput = yield* Deferred.make<unknown>();
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    yield* launches.launch(
      launchInput({
        command: "command:launch:resolved-remote",
        thread: "thread:launch:resolved-remote",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    assert.deepEqual(yield* Deferred.await(fetchInput), {
      cwd: project.workspaceRoot,
      refName: "main",
      remote: { remoteName: "origin", branchName: "main" },
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shows the fetch diagnosis when preparing a worktree from origin fails", () => {
  const detail =
    "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.fetchRemote",
          command: "git",
          cwd: project.workspaceRoot,
          detail,
          exitCode: 128,
        }),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:fetch-failure",
        thread: "thread:launch:fetch-failure",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.messages[0]?.text, "Start from origin");
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(
      projection.turnItems.find((item) => item.type === "command_execution")?.status,
      "failed",
    );
    assert.include(
      projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
      detail,
    );
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(harness.runSetup.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a preparation retry after the project disables its provider", () => {
  let fetchAttempts = 0;
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      fetchAttempts++ === 0
        ? Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git",
              cwd: project.workspaceRoot,
              detail: "Git could not reach the remote.",
              exitCode: 128,
            }),
          )
        : Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:disabled-preparation-retry",
        thread: "thread:launch:disabled-preparation-retry",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* preparationSettled(launched.threadId);
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const error = yield* launches
      .retryPreparation({
        commandId: CommandId.make("command:launch:disabled-preparation-retry:retry"),
        threadId: launched.threadId,
        runId: launched.projection.runs[0]!.id,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "ThreadManagementProviderInstanceDisabledError");
    assert.equal((yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status, "failed");
    assert.equal(fetchAttempts, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not release a prepared run after the project disables its provider", () => {
  return Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:disable-during-preparation",
          thread: "thread:launch:disable-during-preparation",
          message: "Prepare a worktree",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* Deferred.await(setupEntered);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
        },
      });
      yield* Deferred.succeed(allowSetup, undefined);
      const projection = yield* preparationSettled(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make("command:launch:disable-during-preparation:release"),
      );
      assert.isFalse(
        effects.some(
          (effect) =>
            effect.request.type === "provider-turn.start" &&
            effect.request.runId === launched.projection.runs[0]?.id,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

it.effect.each(["fails", "is interrupted"] as const)(
  "holds a message queued during setup when the workspace preparation %s",
  (ending) =>
    Effect.gen(function* () {
      const fetchEntered = yield* Deferred.make<void>();
      const allowFetch = yield* Deferred.make<void>();
      let fetchFailures = 1;
      const harness = makeHarness({
        fetchWorktreeBaseCommit: () =>
          fetchFailures-- <= 0
            ? Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })
            : Deferred.succeed(fetchEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowFetch)),
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.fetchRemote",
                      command: "git",
                      cwd: project.workspaceRoot,
                      detail: "Git could not reach the remote.",
                      exitCode: 128,
                    }),
                  ),
                ),
              ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: `command:launch:queued-setup-${ending}`,
            thread: `thread:launch:queued-setup-${ending}`,
            message: "First message",
            workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
          }),
        );
        yield* Deferred.await(fetchEntered);
        const queued = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make(`command:launch:queued-setup-${ending}:follow-up`),
          threadId: launched.threadId,
          messageId: MessageId.make(`message:launch:queued-setup-${ending}:follow-up`),
          text: "Sent during setup",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(queued.delivery, "queued");
        if (ending === "fails") {
          yield* Deferred.succeed(allowFetch, undefined);
        } else {
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:launch:queued-setup-interrupt"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
        }

        yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.runs.at(-1)?.status, "queued");
        assert.equal(projection.thread.worktreePath, null);

        if (ending === "fails") {
          yield* launches.retryPreparation({
            commandId: CommandId.make("command:launch:queued-setup-retry"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
          const retried = yield* threads.getThreadProjection(launched.threadId);
          assert.equal(retried.runs.at(-1)?.queueHeld, false);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["failed", "interrupted"] as const)(
  "holds a message queued during setup that arrives after the setup %s",
  (ending) => {
    let fetchEntered: Deferred.Deferred<void> | null = null;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        ending === "interrupted"
          ? Deferred.succeed(fetchEntered!, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
    });
    return Effect.gen(function* () {
      fetchEntered = yield* Deferred.make<void>();
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:late-queued-follow-up-${ending}`,
          thread: `thread:launch:late-queued-follow-up-${ending}`,
          message: "First message",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      if (ending === "interrupted") {
        yield* Deferred.await(fetchEntered);
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:launch:late-queued-follow-up:interrupt"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.updated" && stored.event.payload.status === ending,
        ),
        Stream.runHead,
      );

      const queued = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:send`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:send`),
        text: "Sent during setup",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.delivery, "queued");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      const held = projection.runs.at(-1)!;
      assert.equal(held.status, "queued");
      assert.equal(held.queueHeld, true);

      // A message the user starts does not release it: the held message would
      // run after it in the project checkout.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:start`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:start`),
        text: "Sent after setup",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:wake`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:wake`),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      const wake = (yield* threads.getThreadProjection(launched.threadId)).runs.at(-1)!;
      assert.equal(wake.status, "queued");
      assert.isTrue(wake.queueHeld);

      // Nor does the next one, though the run that message started is now the
      // latest and carries no workspace preparation.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:again`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:again`),
        text: "Sent after that",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(launched.threadId);
      assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const first = yield* launches.launch(rest);
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      // Clients drop their pending copy once the thread reaches the message's commit.
      assert.isNumber(first.sequence);
      assert.equal(retry.sequence, first.sequence);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted launch after the project disables the instance", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const input = launchInput({
      command: "command:launch:retry-after-disable",
      thread: "thread:launch:retry-after-disable",
      message: "Hello",
    });
    const first = yield* launches.launch(input);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* launches.launch(input);
    assert.equal(retry.threadId, first.threadId);
    assert.isTrue(retry.resumed);

    const fresh = yield* launches
      .launch(
        launchInput({
          command: "command:launch:fresh-after-disable",
          thread: "thread:launch:fresh-after-disable",
          message: "Hello",
        }),
      )
      .pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("an agent's launch never starts work above the modes it asks for", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    // The first launch, at full access, creates the thread without a message.
    const created = yield* launches.launch(
      launchInput({ command: "command:launch:narrowed-retry", thread: "thread:narrowed" }),
    );
    // The same key comes back from a narrower agent, now carrying a message,
    // as a retry or a concurrent launch that lost the create would.
    const failed = yield* launches
      .launch({
        ...launchInput({
          command: "command:launch:narrowed-retry",
          thread: "thread:narrowed",
          message: "Run this",
        }),
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "dispatch-message");
    const projection = yield* threads.getThreadProjection(created.threadId);
    assert.equal(projection.runs.length, 0);
    assert.equal(projection.messages.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        if (error._tag !== "ThreadLaunchError") {
          assert.fail(`expected ThreadLaunchError, got ${error._tag}`);
        }
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
                workspace: { type: "worktree", baseRef: "main" },
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("reports one concurrent same-command launch as new and the rest as resumed", () =>
  Effect.gen(function* () {
    // Both launches read no receipt before either one claims the thread.
    const arrived = yield* Ref.make(0);
    const bothRead = yield* Deferred.make<void>();
    const harness = makeHarness({
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () =>
          Ref.updateAndGet(arrived, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothRead, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(bothRead)),
            Effect.as(Option.none()),
          ),
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({
        command: "command:launch:concurrent-resumed",
        thread: "thread:launch:concurrent-resumed",
      });
      const results = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(results.map((result) => result.resumed).sort(), [false, true]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "does not report a retry as resumed when the earlier attempt only claimed the thread",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const input = launchInput({
          command: "command:launch:claimed-only",
          thread: "thread:launch:claimed-only",
          message: "Counted once",
        });
        yield* threads.dispatch({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        const retried = yield* launches.launch(input);
        assert.isFalse(retried.resumed);
        assert.isTrue((yield* launches.launch(input)).resumed);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("schedules an accepted preparing message exactly once across concurrent retries", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:accepted-before-fork",
        thread: "thread:launch:accepted-before-fork",
        message: "Resume preparation",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const messageId = MessageId.make("message:launch:accepted-before-fork");

      yield* threads.dispatch({
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:initial-message`),
        threadId: input.threadId,
        messageId,
        text: "Resume preparation",
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const preparing = yield* threads.getThreadProjection(input.threadId);
      assert.equal(preparing.runs[0]?.status, "preparing");

      const [first, second] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.isTrue(first.resumed);
      assert.isTrue(second.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("creates a strong provider-thread mapping for an imported native session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:imported-native-session",
        thread: "thread:launch:imported-native-session",
      }),
      importedNativeThread: {
        ref: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-session-42",
          strength: "strong" as const,
        },
        metadata: {
          title: "Native session",
          updatedAt: "2026-08-23T00:00:00Z",
        },
      },
    };

    const launched = yield* launches.launch(input);

    assert.deepInclude(launched.projection.providerThreads[0], {
      id: IdAllocator.deriveProviderThread({
        driver: input.importedNativeThread.ref.driver,
        providerInstanceId: modelSelection.instanceId,
        nativeThreadId: input.importedNativeThread.ref.nativeId,
      }),
      driver: input.importedNativeThread.ref.driver,
      providerInstanceId: modelSelection.instanceId,
      appThreadId: input.threadId,
      nativeThreadRef: input.importedNativeThread.ref,
      status: "not_loaded",
      nativeMetadata: input.importedNativeThread.metadata,
    });
    assert.equal(
      launched.projection.thread.activeProviderThreadId,
      launched.projection.providerThreads[0]?.id,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-intake-" }).pipe(
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](t3-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
        checkWorktreeBase: launches.checkWorktreeBase,
        checkCloudLaunch: launches.checkCloudLaunch,
        retryPreparation: launches.retryPreparation,
        prepareRun: launches.prepareRun,
        restoreCheckout: launches.restoreCheckout,
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    const record = stored.context?.records[0];
    assert.isDefined(record);
    assert.equal((record as { attachmentId: string }).attachmentId, stored.attachments[0]?.id);
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const replayed = yield* ThreadMessageIntake.launchThread(input);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const duplicate = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-duplicate-create"),
      initialMessage: { ...input.initialMessage, messageId: MessageId.make("intake-duplicate") },
    }).pipe(Effect.result);
    assert.ok(Result.isFailure(duplicate));
    assert.ok(duplicate.failure._tag === "ThreadLaunchError");
    assert.equal(duplicate.failure.operation, "create-thread");
    assert.propertyVal(duplicate.failure.cause, "_tag", "OrchestratorThreadAlreadyExistsError");
    assert.equal((yield* claimedFiles).length, 1);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    const dispatch = ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch;
    yield* dispatch;
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles, TeamState.layerTest())));
});

it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const renamed = yield* Deferred.make<void>();
    const harness = makeHarness({
      renameBranch: (input) =>
        Deferred.succeed(renamed, undefined).pipe(Effect.as({ branch: input.newBranch })),
      runSetup: () =>
        Deferred.await(renamed).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.deepEqual(harness.deleteLocalBranch.mock.calls[0]?.[0], {
        cwd: "/repo",
        refName: "generated-branch",
        force: true,
      });
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "deletes a claimed worktree's branch when setup is cancelled before checkout returns",
  () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      const harness = makeHarness({
        createWorktree: (_input, options) =>
          (options?.progress?.onWorktreeClaimed?.("/repo-worktrees/feature") ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(claimed, undefined)),
            Effect.andThen(Effect.never),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const launched = yield* launches.launch(
          launchInput({
            command: "launch:cancel-claimed",
            thread: "thread:cancel-claimed",
            message: "Start",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        yield* Deferred.await(claimed);
        assert.isTrue(yield* tracker.cancel(launched.threadId));
        assert.equal(harness.removeWorktree.mock.calls[0]?.[0].path, "/repo-worktrees/feature");
        assert.equal(
          harness.deleteLocalBranch.mock.calls[0]?.[0].refName,
          harness.createWorktree.mock.calls[0]?.[0].newRefName,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("stops an in-flight branch rename when tracked setup is cancelled", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const branchNameStarted = yield* Deferred.make<void>();
    const allowBranchName = yield* Deferred.make<void>();
    const branchNameInterrupted = yield* Deferred.make<void>();
    const renameAttempted = yield* Deferred.make<void>();
    const harness = makeHarness({
      renameBranch: (input) =>
        Deferred.succeed(renameAttempted, undefined).pipe(Effect.as({ branch: input.newBranch })),
      runSetup: () => Deferred.succeed(setupEntered, undefined).pipe(Effect.andThen(Effect.never)),
      generateBranchName: () =>
        Deferred.succeed(branchNameStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
          Effect.onInterrupt(() => Deferred.succeed(branchNameInterrupted, undefined)),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:cancel-renaming",
          thread: "thread:cancel-renaming",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* Deferred.await(setupEntered);
      yield* Deferred.await(branchNameStarted);
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      yield* Deferred.succeed(allowBranchName, undefined);
      yield* Effect.raceFirst(
        Deferred.await(branchNameInterrupted),
        Deferred.await(renameAttempted),
      );
      assert.isTrue(
        yield* Deferred.isDone(branchNameInterrupted),
        "the cancelled setup's branch rename kept running",
      );
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath);
      assert.equal(
        harness.deleteLocalBranch.mock.calls[0]?.[0].refName,
        harness.createWorktree.mock.calls[0]?.[0].newRefName,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([0, 1])("releases an async setup before its completion with exit %s", (exitCode) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
    const harness = makeHarness({
      runSetup: () =>
        Effect.succeed({
          status: "started" as const,
          async: true,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup",
          cwd: "/repo-worktrees/feature",
          completion: Deferred.await(completion),
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:async-${exitCode}`,
          thread: `thread:launch:async-${exitCode}`,
          message: "Start during setup",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
            true,
        ),
        Stream.runHead,
      );
      const running = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(running.runs[0]?.status, "starting");
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.equal(
        settled?.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "is missing", baseRef: "t3/renamed", startFromOrigin: false, origin: true },
  {
    name: "has no origin to come from",
    baseRef: "t3/renamed",
    startFromOrigin: true,
    origin: false,
  },
  {
    name: "is a previous checkout there never was",
    baseRef: "-",
    startFromOrigin: false,
    origin: true,
  },
])("refuses a new worktree whose base ref $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD"),
      git: {
        resolveWorktreeBaseRemote: () =>
          Effect.succeed(testCase.origin ? { remoteName: "origin", branchName: "main" } : null),
        hasRefNamed: () => Effect.succeed(false),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: testCase.baseRef,
            startFromOrigin: testCase.startFromOrigin,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBaseRefError",
        projectId,
        baseRef: testCase.baseRef,
      });
      assert.equal(
        error.message,
        `Base ref "${testCase.baseRef}" does not resolve to a commit in project "Project" (/repo).`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted send after the project disables the instance", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-send-retry-" }).pipe(
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const created = yield* launches.launch(
      launchInput({
        command: "command:send:retry-setup",
        thread: "thread:send:retry-after-disable",
      }),
    );

    const sendInput = {
      commandId: CommandId.make("command:send:retry-after-disable"),
      projectId,
      threadId: created.threadId,
      messageId: MessageId.make("message:send:retry-after-disable"),
      text: "Hello again",
      attachments: [],
      mode: "auto" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* ThreadMessageIntake.sendToThread(sendInput);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* ThreadMessageIntake.sendToThread(sendInput);
    assert.equal(retry.message.id, first.message.id);

    const fresh = yield* ThreadMessageIntake.sendToThread({
      ...sendInput,
      commandId: CommandId.make("command:send:fresh-after-disable"),
      messageId: MessageId.make("message:send:fresh-after-disable"),
    }).pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

const cloudSettings = {
  sandbox: {
    drivers: [{ kind: "docker" as const, id: ComputeDriverId.make("docker"), label: "Docker" }],
  },
  // A managed Codex account signs in on a machine; one that signs in locally cannot.
  providerInstances: {
    [modelSelection.instanceId]: {
      driver: ProviderDriverKind.make("codex"),
      config: { setupMode: "managed" },
    },
  },
};
const cloudRemote = "https://github.com/acme/app.git";
const imageBuild = (driverId = "docker"): TeamImageBuild => ({
  id: TeamImageBuildId.make("tib_00000000000000000004"),
  number: PositiveInt.make(4),
  status: "succeeded",
  phase: null,
  recipeRevision: PositiveInt.make(1),
  driverId: ComputeDriverId.make(driverId),
  requestedBy: { kind: "member", memberId: MemberId.make("member:admin") },
  activateOnSuccess: true,
  imageRef: "sha256:team-image-4",
  requestedAt: DateTime.makeUnsafe("2026-11-09T09:00:00.000Z"),
  startedAt: DateTime.makeUnsafe("2026-11-09T09:00:00.000Z"),
  finishedAt: DateTime.makeUnsafe("2026-11-09T09:10:00.000Z"),
  imageDeletedAt: null,
});

/** A cloud launch's git: the project has an origin, the sandbox has no clone yet, `main` is pushed. */
function cloudHarness(
  git: Partial<GitWorkflow.GitWorkflowService["Service"]> = {},
  options: Pick<
    HarnessOptions,
    "mirrorRestore" | "runSetup" | "stagedImports" | "activeImageBuild" | "serverSettings"
  > = {},
) {
  const cloneRepository = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["cloneRepository"]>[0]) =>
      Effect.void,
  );
  const harness = makeHarness({
    serverSettings: cloudSettings,
    ...options,
    cloudOnly: true,
    createWorktree: (input) =>
      Effect.succeed({
        worktree: { path: input.path!, refName: input.newRefName!, headSha: "abc" },
      } as never),
    git: {
      readRemoteUrl: () => Effect.succeed(cloudRemote),
      isRepository: () => Effect.succeed(false),
      cloneRepository,
      hasCommit: ({ refName }) => Effect.succeed(refName === "refs/remotes/origin/main"),
      ...git,
    },
  });
  return { ...harness, cloneRepository };
}

const runReaching = (threadId: ThreadId, status: "starting" | "failed") =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.streamStoredEventsFrom({ threadId, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === status,
      ),
      Stream.runHead,
    ),
  );

const cloudWorkspace = { type: "cloud" as const, baseRef: "main" };
const seedRef = CloudStagingKey.make(`mv_${"0".repeat(32)}`);
const seedMember = MemberId.make("member:seed");
const seedWorkspace = {
  ...cloudWorkspace,
  branch: "feature/login",
  seedRef,
  existingBranch: true as const,
};
const existingBranchWorkspace = {
  ...cloudWorkspace,
  branch: "feature/login",
  existingBranch: true as const,
};

it.effect("refuses a worktree launch on a cloud-only server before creating a thread", () => {
  const harness = makeHarness({ cloudOnly: true });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const workspace of [worktreeStrategy, { type: "root" as const }]) {
      const input = launchInput({
        command: `command:launch:cloud-only:${workspace.type}`,
        thread: `thread:launch:cloud-only:${workspace.type}`,
        message: "Fix the build",
        workspace,
      });
      const error = yield* Effect.flip(launches.launch(input));
      assert.equal(error._tag, "ThreadLaunchError");
      const cause = error._tag === "ThreadLaunchError" ? error.cause : undefined;
      assert.include(cause ?? {}, { _tag: "CloudLaunchError", reason: "local-launch" });
      assert.isNull(yield* threads.getThreadShell(input.threadId));
    }
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("places a scheduled worktree launch in the cloud on a cloud-only server", () => {
  const harness = cloudHarness({ currentBranch: () => Effect.succeed("main") });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // MCP stores the remote's base (`origin/main`); the editor stores a branch.
    for (const workspace of [
      { type: "worktree" as const, baseRef: "origin/main", startFromOrigin: true },
      { type: "root" as const },
    ]) {
      const commandId = CommandId.make(`command:launch:scheduled-cloud:${workspace.type}`);
      const launched = yield* launches.launch({
        ...launchInput({
          command: commandId,
          thread: `thread:launch:scheduled-cloud:${workspace.type}`,
          message: "Run the suite",
          workspace,
        }),
        cloudPlacement: true,
        discardOnSettle: workspace.type === "worktree",
      });
      const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
      assert.equal(launched.projection.thread.sandboxId, sandboxId);
      assert.deepInclude(launched.projection.runs[0] ?? {}, {
        workspacePreparation: { type: "worktree", baseRef: "main" },
      });
      const sandbox = yield* projections.getSandbox(sandboxId);
      assert.equal(sandbox?.state, "provisioning");
      assert.equal(sandbox?.discardOnSettle, workspace.type === "worktree" ? true : undefined);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("launches a cloud thread and releases it on runner hello", () => {
  const harness = cloudHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const commandId = CommandId.make("command:launch:cloud");
    const launched = yield* launches.launch(
      launchInput({
        command: commandId,
        thread: "thread:launch:cloud",
        message: "Fix the build",
        workspace: cloudWorkspace,
      }),
    );
    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    assert.equal(launched.projection.thread.sandboxId, sandboxId);
    // Old clients decode the run: it records a worktree, and the thread holds the placement.
    assert.deepInclude(launched.projection.runs[0] ?? {}, {
      status: "preparing",
      workspacePreparation: { type: "worktree", baseRef: "main" },
    });
    assert.deepInclude(
      yield* ProjectionStore.ProjectionStoreV2.use((projections) =>
        projections.getSandbox(sandboxId),
      ),
      { state: "provisioning", generation: 1, ownerThreadId: launched.threadId },
    );
    assert.equal(harness.cloneRepository.mock.calls.length, 0);

    // What the runner hub sends on the runner's hello.
    yield* threads.dispatch({
      type: "sandbox.runner.attached",
      commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
      threadId: launched.threadId,
      sandboxId,
      generation: 1,
      runnerBootId: "boot",
    });
    yield* runReaching(launched.threadId, "starting");

    const root = `/t3-sandbox/${sandboxId}`;
    const clonePath = `${root}/repos/github.com/acme/app`;
    assert.deepEqual(harness.cloneRepository.mock.calls[0]?.[0], {
      cwd: root,
      url: cloudRemote,
      path: clonePath,
    });
    const worktree = harness.createWorktree.mock.calls[0]?.[0];
    assert.equal(worktree?.cwd, clonePath);
    assert.equal(worktree?.refName, "origin/main");
    assert.isTrue(worktree?.path?.startsWith(`${root}/worktrees/`));
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.thread.worktreePath, worktree?.path);
    // Branch names are generated by a local CLI, never in the sandbox.
    assert.equal(harness.generateBranchName.mock.calls[0]?.[0].cwd, project.workspaceRoot);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  { name: "on its driver boots it", driverId: "docker", boots: true },
  { name: "on another driver is skipped", driverId: "fly", boots: false },
])("the team's active build $name", ({ driverId, boots }) => {
  const harness = cloudHarness({}, { activeImageBuild: imageBuild(driverId) });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const commandId = CommandId.make(`command:launch:cloud-image-${driverId}`);
    const launched = yield* launches.launch(
      launchInput({
        command: commandId,
        thread: `thread:launch:cloud-image-${driverId}`,
        message: "Fix the build",
        workspace: cloudWorkspace,
      }),
    );
    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    const sandbox = yield* ProjectionStore.ProjectionStoreV2.use((projections) =>
      projections.getSandbox(sandboxId),
    );
    assert.deepEqual(
      sandbox?.imageBuild,
      boots ? { id: imageBuild().id, number: imageBuild().number } : undefined,
    );

    // The image has no clone of this project, so the checkout clones it and says so once.
    yield* threads.dispatch({
      type: "sandbox.runner.attached",
      commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
      threadId: launched.threadId,
      sandboxId,
      generation: 1,
      runnerBootId: "boot",
    });
    yield* runReaching(launched.threadId, "starting");
    assert.equal(harness.cloneRepository.mock.calls.length, 1);
    const notices = (yield* threads.getThreadProjection(launched.threadId)).visibleTurnItems
      .map(({ item }) => item)
      .filter((item) => item.type === "system_notice")
      .map((item) => item.message);
    assert.deepEqual(
      notices,
      boots
        ? [
            "Not in the team image. Project was cloned when this session started; an admin can add it to the team image so sessions start faster.",
          ]
        : [],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("launches a seeded cloud thread from its claimed seed and never asks origin", () => {
  const restored = Deferred.makeUnsafe<{ worktreePath: string; branch: string }>();
  const setupRan = Deferred.makeUnsafe<string>();
  const check = vi.fn(
    (_input: Parameters<StagedCloudImports.StagedCloudImports["Service"]["check"]>[0]) =>
      Effect.void,
  );
  const claim = vi.fn(
    (_input: Parameters<StagedCloudImports.StagedCloudImports["Service"]["claim"]>[0]) =>
      Effect.void,
  );
  const mirrorRestore = vi.fn<MirrorSync.MirrorSync["Service"]["restore"]>((input) =>
    Deferred.succeed(restored, { worktreePath: input.worktreePath, branch: input.branch }).pipe(
      Effect.as({ snapshotAt: null }),
    ),
  );
  const harness = cloudHarness(
    {
      currentBranch: () => Effect.succeed("main"),
      remoteHasBranch: () => Effect.die("a seeded launch never asks origin for its branch"),
    },
    {
      mirrorRestore,
      stagedImports: { check, claim },
      runSetup: ({ worktreePath }) =>
        Deferred.succeed(setupRan, worktreePath).pipe(Effect.as({ status: "no-script" as const })),
    },
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const commandId = CommandId.make("command:launch:cloud-seed");
    const input = {
      ...launchInput({
        command: commandId,
        thread: "thread:launch:cloud-seed",
        message: "Keep going",
        workspace: seedWorkspace,
      }),
      actorId: seedMember,
    };
    const launched = yield* launches.launch(input);
    const staged = { key: seedRef, kind: "seed", projectId, memberId: seedMember };
    assert.deepEqual(check.mock.calls, [[staged]]);
    assert.deepEqual(claim.mock.calls, [[{ ...staged, threadId: launched.threadId }]]);
    assert.isBelow(check.mock.invocationCallOrder[0]!, claim.mock.invocationCallOrder[0]!);

    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    yield* threads.dispatch({
      type: "sandbox.runner.attached",
      commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
      threadId: launched.threadId,
      sandboxId,
      generation: 1,
      runnerBootId: "boot",
    });
    yield* runReaching(launched.threadId, "starting");
    const worktreePath = `/t3-sandbox/${sandboxId}/worktrees/feature-login`;
    assert.deepEqual(yield* Deferred.await(restored), { worktreePath, branch: "feature/login" });
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(yield* Deferred.await(setupRan), worktreePath);
    assert.equal(
      (yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath,
      worktreePath,
    );

    // A replay has the launch's receipt: it does not check again, and claims for the same thread.
    yield* launches.launch(input);
    assert.equal(check.mock.calls.length, 1);
    assert.equal(claim.mock.calls.length, 2);
    assert.equal(claim.mock.calls[1]?.[0].threadId, launched.threadId);
  }).pipe(Effect.provide(harness.layer));
});

const laptopExport = {
  version: 1,
  source: {
    environmentId: EnvironmentId.make("environment:laptop"),
    threadId: ThreadId.make("thread:laptop"),
    title: "Fix the flaky test",
    environmentLabel: "Kim's MacBook Pro",
  },
  exportedAt: DateTime.makeUnsafe("2026-11-09T10:05:00.000Z"),
  messages: [
    {
      role: "user",
      text: "Why does it flake?",
      createdAt: DateTime.makeUnsafe("2026-11-09T10:00:00.000Z"),
    },
    {
      role: "assistant",
      text: "A race in the setup.",
      createdAt: DateTime.makeUnsafe("2026-11-09T10:01:00.000Z"),
    },
  ],
  omittedMessageCount: 0,
} as const;

/** The conversation and move rows as `type: text`, in timeline order, marked when on a run. */
const timelineOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projection = yield* threads.getThreadProjection(threadId);
    return projection.visibleTurnItems.flatMap(({ item }) => {
      const text =
        item.type === "user_message" || item.type === "assistant_message"
          ? item.text
          : item.type === "move"
            ? item.message
            : null;
      return text === null ? [] : [`${item.runId === null ? "" : "run "}${item.type}: ${text}`];
    });
  });

it.effect("imports a staged context export before the first message, once", () => {
  const exportRef = CloudStagingKey.make(`mv_${"1".repeat(32)}`);
  const claim = vi.fn(
    (_input: Parameters<StagedCloudImports.StagedCloudImports["Service"]["claim"]>[0]) =>
      Effect.void,
  );
  const readContextExport = vi.fn(() => Effect.succeed(laptopExport));
  const dropContextExport = vi.fn(() => Effect.void);
  const harness = cloudHarness(
    { currentBranch: () => Effect.succeed("main") },
    {
      stagedImports: {
        check: () => Effect.void,
        claim,
        readContextExport,
        dropContextExport,
      },
    },
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:cloud-export",
        thread: "thread:launch:cloud-export",
        message: "Keep going",
        workspace: cloudWorkspace,
      }),
      actorId: seedMember,
      contextExportRef: exportRef,
    };
    const launched = yield* launches.launch(input);
    const expected = [
      "user_message: Why does it flake?",
      "assistant_message: A race in the setup.",
      "move: Continued from “Fix the flaky test” on Kim's MacBook Pro",
      "run user_message: Keep going",
    ];
    assert.deepEqual(yield* timelineOf(launched.threadId), expected);
    assert.deepEqual(claim.mock.calls, [
      [
        {
          key: exportRef,
          kind: "context-export",
          projectId,
          memberId: seedMember,
          threadId: launched.threadId,
        },
      ],
    ]);
    assert.deepEqual(dropContextExport.mock.calls, [[{ key: exportRef }]] as never);

    // A replay claims again for the same thread but finds the history already there.
    yield* launches.launch(input);
    assert.equal(claim.mock.calls.length, 2);
    assert.equal(readContextExport.mock.calls.length, 1);
    assert.deepEqual(yield* timelineOf(launched.threadId), expected);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("imports an export in hand on a local launch, as a copy", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch({
      ...launchInput({
        command: "command:launch:local-copy",
        thread: "thread:launch:local-copy",
        message: "Keep going",
      }),
      contextExport: { value: laptopExport, copy: true },
    });
    assert.deepEqual((yield* timelineOf(launched.threadId)).slice(-2), [
      "move: Copy of “Fix the flaky test” from Kim's MacBook Pro",
      "run user_message: Keep going",
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  { name: "a kept disk", kept: true, mirrored: true, restoredFrom: "disk" },
  {
    name: "a new disk the mirror has the branch for",
    kept: false,
    mirrored: true,
    restoredFrom: "mirror",
  },
  { name: "a new disk the mirror never saw", kept: false, mirrored: false, restoredFrom: "origin" },
  {
    // The retry and re-arm case too: the seed lives in the thread's refs, so no `seeded` is passed.
    name: "a new thread whose mirror holds its seed",
    recorded: false,
    kept: false,
    mirrored: true,
    restoredFrom: "seed",
  },
  {
    name: "a seeded launch the mirror has no copy of",
    recorded: false,
    seeded: true,
    kept: false,
    mirrored: false,
    restoredFrom: "seed-unavailable",
  },
] as const)(
  "checks a cloud thread out again from $name",
  ({ kept, mirrored, restoredFrom, ...row }) =>
    Effect.gen(function* () {
      const recorded = "recorded" in row ? row.recorded : true;
      const seeded = "seeded" in row ? row.seeded : false;
      const sandboxId = SandboxId.make("sbx_00000000000000000213");
      const root = `/t3-sandbox/${sandboxId}`;
      const recordedPath = `${root}/worktrees/feature-login`;
      const fetchRemote = vi.fn(() => Effect.void);
      const cloneRepository = vi.fn(() => Effect.void);
      const createWorktree = vi.fn((input: { readonly path: string | null }) =>
        Effect.succeed({
          worktree: { path: input.path!, refName: "feature/login", headSha: "abc" },
        }),
      );
      const restore = vi.fn((_input: Parameters<MirrorSync.MirrorSync["Service"]["restore"]>[0]) =>
        Effect.succeed(mirrored ? { snapshotAt: null } : null),
      );
      const checkingOut = CloudPreparation.checkoutInSandbox({
        sandboxId,
        threadId: ThreadId.make("thread:checkout-again"),
        projectId,
        projectRoot: project.workspaceRoot,
        baseRef: "main",
        branch: "feature/login",
        existingBranch: false,
        existingWorktreePath: recorded ? recordedPath : null,
        seeded,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitWorkflow.GitWorkflowService)({
              readRemoteUrl: () => Effect.succeed(cloudRemote),
              isRepository: (cwd) => Effect.succeed(kept && cwd === recordedPath),
              fetchRemote,
              cloneRepository,
              hasCommit: ({ refName }) => Effect.succeed(refName === "refs/remotes/origin/main"),
              createWorktree: createWorktree as never,
            }),
            Layer.mock(MirrorSync.MirrorSync)({ restore }),
          ),
        ),
      );
      if (restoredFrom === "seed-unavailable") {
        const error = yield* Effect.flip(checkingOut);
        assert.include(error, { _tag: "CloudLaunchError", reason: "seed-unavailable" });
        assert.equal(createWorktree.mock.calls.length, 0);
        return;
      }
      const checkout = yield* checkingOut;
      assert.deepInclude(checkout, { worktreePath: recordedPath, restoredFrom });
      // A kept disk does no fetch and no bundle; a rebuild never deletes its work on cancel.
      assert.equal(cloneRepository.mock.calls.length, kept ? 0 : 1);
      assert.equal(fetchRemote.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, kept ? 0 : 1);
      assert.equal(createWorktree.mock.calls.length, restoredFrom === "origin" ? 1 : 0);
      assert.equal(checkout.created, restoredFrom === "origin" || restoredFrom === "seed");
      if (restoredFrom === "seed") {
        assert.equal(restore.mock.calls[0]?.[0].worktreePath, recordedPath);
      }
    }),
);

it.effect.each([
  { name: "a thread with a run", message: "Fix the build" },
  // No run records a base, so the rebuild falls back to the thread's branch.
  { name: "a thread launched without a message", message: undefined },
] as const)(
  "rebuilds a cloud thread's lost checkout when its machine comes back, and says so: $name",
  ({ message }) => {
    const restored = Deferred.makeUnsafe<string>();
    const setupRan = Deferred.makeUnsafe<string>();
    const mirrorRestore = vi.fn<MirrorSync.MirrorSync["Service"]["restore"]>(({ worktreePath }) =>
      Deferred.succeed(restored, worktreePath).pipe(
        Effect.as({ snapshotAt: DateTime.makeUnsafe("2026-11-09T14:02:30.000Z") }),
      ),
    );
    // The launch's own checkout of a new thread asks the mirror first and finds nothing.
    mirrorRestore.mockImplementationOnce(() => Effect.succeed(null));
    const harness = cloudHarness(
      {},
      {
        mirrorRestore,
        runSetup: ({ worktreePath }) =>
          Deferred.succeed(setupRan, worktreePath).pipe(
            Effect.as({ status: "no-script" as const }),
          ),
      },
    );
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const commandId = CommandId.make("command:launch:cloud-rebuild");
      const launched = yield* launches.launch(
        launchInput({
          command: commandId,
          thread: "thread:launch:cloud-rebuild",
          ...(message === undefined ? {} : { message }),
          workspace: { ...cloudWorkspace, branch: "feature/login" },
        }),
      );
      const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
      yield* threads.dispatch({
        type: "sandbox.runner.attached",
        commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
        threadId: launched.threadId,
        sandboxId,
        generation: 1,
        runnerBootId: "boot",
      });
      yield* Deferred.await(setupRan);
      const recorded = (yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath;
      const setupRuns = harness.runSetup.mock.calls.length;

      // The fake's disk never holds the checkout, as a machine on a new disk does not.
      const notice = threads
        .streamStoredEventsFrom({ threadId: launched.threadId, eventType: "turn-item.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "system_notice",
          ),
          Stream.runHead,
        );
      yield* launches.restoreCheckout({
        commandId: CommandId.make(`sandbox-restore:${launched.threadId}:2`),
        threadId: launched.threadId,
      });
      assert.equal(yield* Deferred.await(restored), recorded);
      const event = Option.getOrThrow(yield* notice).event;
      assert.include(
        event.type === "turn-item.updated" && event.payload.type === "system_notice"
          ? event.payload.message
          : "",
        "Rebuilt from the snapshot of 2026-11-09 14:02 UTC",
      );
      assert.equal(harness.runSetup.mock.calls.length, setupRuns + 1);
      assert.equal(harness.runSetup.mock.calls.at(-1)?.[0].worktreePath, recorded);
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath,
        recorded,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("refuses to retry a run onto a new machine on a server that is not cloud-only", () => {
  const harness = cloudHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const commandId = CommandId.make("command:launch:cloud-retry-gate");
    const launched = yield* launches.launch(
      launchInput({
        command: commandId,
        thread: "thread:launch:cloud-retry-gate",
        message: "Fix the build",
        workspace: cloudWorkspace,
      }),
    );
    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    // The create never answered, so the failed machine has no disk to keep.
    yield* threads.dispatch({
      type: "sandbox.failed",
      commandId: CommandId.make(`sandbox-failed:${sandboxId}:1:sandbox.create`),
      threadId: launched.threadId,
      sandboxId,
      generation: 1,
      failure: { code: "create-failed", message: "capacity", retryable: true },
    });
    yield* runReaching(launched.threadId, "failed");
    const runId = launched.projection.runs[0]!.id;

    // The same records, read by a server restarted without cloud-only.
    const offCloud = Context.get(
      yield* Layer.build(
        Layer.fresh(ThreadLaunch.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              CommandReceiptStore.layer,
              IdAllocator.layer,
              Layer.succeed(ServerConfig.ServerConfig, {
                cloudOnly: false,
              } as ServerConfig.ServerConfig["Service"]),
            ),
          ),
        ),
      ),
      ThreadLaunch.ThreadLaunchService,
    );
    const error = yield* offCloud
      .retryPreparation({
        commandId: CommandId.make("command:retry:cloud-retry-gate"),
        threadId: launched.threadId,
        runId,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestratorDispatchError");
    assert.equal(
      error._tag === "OrchestratorDispatchError" ? error.cause : "",
      NOT_CLOUD_ONLY_MESSAGE,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.runs.find((run) => run.id === runId)?.status, "failed");
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect.each([
  {
    name: "its machine fails to start",
    git: {},
    machineFails: true,
    reason: "Compute driver docker failed to create: capacity.",
  },
  {
    name: "the project has no origin",
    git: { readRemoteUrl: () => Effect.succeed(null) },
    machineFails: false,
    reason: "This project has no origin remote to clone in the cloud.",
  },
  {
    name: "the base branch was never pushed",
    git: { hasCommit: () => Effect.succeed(false) },
    machineFails: false,
    reason: "main is not on origin. Push main first.",
  },
  {
    // Origin said it had the branch at launch; it was deleted before the machine checked.
    name: "an existing branch was never pushed",
    git: {
      hasCommit: ({ refName }) => Effect.succeed(refName === "refs/remotes/origin/main"),
    } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>,
    workspace: existingBranchWorkspace,
    machineFails: false,
    reason: "feature/login is not on github.com/acme/app. Push feature/login first.",
  },
  {
    name: "origin could not be asked about an existing branch that was never pushed",
    git: {
      hasCommit: ({ refName }) => Effect.succeed(refName === "refs/remotes/origin/main"),
      remoteHasBranch: ({ cwd }) =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.remoteHasBranch",
            command: "git ls-remote",
            cwd,
            detail: "Could not reach the remote.",
          }),
        ),
    } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>,
    workspace: existingBranchWorkspace,
    machineFails: false,
    reason: "feature/login is not on github.com/acme/app. Push feature/login first.",
  },
  {
    name: "the repo is private and nobody can read it",
    git: {
      cloneRepository: ({ cwd }) =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.cloneRepository",
            command: "git clone",
            cwd,
            reason: "authentication_failed",
            detail: "git clone failed",
          }),
        ),
    } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>,
    machineFails: false,
    reason:
      "Pair Cloud can't read github.com/acme/app. Connect GitHub to clone private repos, in Settings → Team.",
  },
  {
    name: "the clone fails for another reason",
    git: {
      cloneRepository: () =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.cloneRepository",
            command: "git clone",
            cwd: "/sandbox",
            reason: "path_already_exists",
            detail: "git clone failed",
          }),
        ),
    } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>,
    machineFails: false,
    reason: "Pair Cloud couldn't clone github.com/acme/app: git clone failed",
  },
  {
    name: "the machine can't resolve the remote's host",
    git: {
      cloneRepository: () =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.cloneRepository",
            command: "git clone",
            cwd: "/sandbox",
            detail: "Could not resolve host: github.com",
          }),
        ),
    } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>,
    machineFails: false,
    reason:
      "Pair Cloud couldn't clone github.com/acme/app: Could not resolve host: github.com. Run Test in Settings → Cloud to check the machine's network.",
  },
])("fails a cloud launch's run when $name", ({ git, workspace, machineFails, reason }) => {
  const harness = cloudHarness(git);
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const commandId = CommandId.make("command:launch:cloud-fails");
    const launched = yield* launches.launch(
      launchInput({
        command: commandId,
        thread: "thread:launch:cloud-fails",
        message: "Fix the build",
        workspace: workspace ?? cloudWorkspace,
      }),
    );
    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    const fields = { threadId: launched.threadId, sandboxId, generation: 1 };
    yield* threads.dispatch(
      machineFails
        ? {
            // What the create effect reports once its last attempt failed.
            type: "sandbox.failed",
            commandId: CommandId.make(`sandbox-failed:${sandboxId}:1:sandbox.create`),
            ...fields,
            failure: { code: "create-failed", message: reason, retryable: false },
          }
        : {
            type: "sandbox.runner.attached",
            commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
            ...fields,
            runnerBootId: "boot",
          },
    );
    yield* runReaching(launched.threadId, "failed");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const failure = projection.turnItems.find((item) => item.type === "error")?.failure;
    assert.equal(failure?.code, ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE);
    assert.equal(failure?.message, reason);
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  {
    name: "a server without Cloud set up",
    settings: { providerInstances: cloudSettings.providerInstances },
    refusal: { _tag: "CloudLaunchError", reason: "no-driver" },
  },
  {
    name: "a project that turned cloud off",
    settings: {
      ...cloudSettings,
      projectSettingsOverrides: { [projectId]: { sandboxAllowed: false } },
    },
    refusal: { _tag: "CloudLaunchError", reason: "project-disallowed" },
  },
  {
    name: "an account that signs in only on this server",
    settings: { sandbox: cloudSettings.sandbox },
    refusal: { _tag: "ProviderCloudLocalOnlyError", instanceId: modelSelection.instanceId },
  },
  {
    name: "a branch that isn't on origin",
    settings: cloudSettings,
    git: {
      readRemoteUrl: () => Effect.succeed(cloudRemote),
      remoteHasBranch: () => Effect.succeed(false),
    },
    workspace: existingBranchWorkspace,
    refusal: {
      _tag: "CloudLaunchError",
      reason: "branch-not-pushed",
      branch: "feature/login",
      remote: "github.com/acme/app",
    },
  },
  {
    name: "an existing branch with no name",
    settings: cloudSettings,
    workspace: { ...cloudWorkspace, existingBranch: true as const },
    refusal: { _tag: "CloudLaunchError", reason: "no-branch" },
  },
  {
    name: "a server that is not cloud-only",
    settings: cloudSettings,
    cloudOnly: false,
    refusal: { _tag: "CloudLaunchError", reason: "not-cloud-only" },
  },
  {
    name: "a seed with no branch",
    settings: cloudSettings,
    workspace: { ...cloudWorkspace, seedRef },
    refusal: { _tag: "CloudLaunchError", reason: "no-branch" },
  },
  {
    name: "a seed on its base branch",
    settings: cloudSettings,
    workspace: { ...seedWorkspace, branch: "main" },
    refusal: { _tag: "CloudLaunchError", reason: "seed-on-base", branch: "main" },
  },
  {
    name: "a seed on the checkout's default branch",
    settings: cloudSettings,
    workspace: { ...seedWorkspace, baseRef: "develop", branch: "main" },
    refusal: { _tag: "CloudLaunchError", reason: "seed-on-base", branch: "main" },
  },
  {
    name: "a seed staged by someone else",
    settings: cloudSettings,
    workspace: seedWorkspace,
    check: () =>
      Effect.fail(
        new StagedCloudImports.StagedCloudImportError({ key: seedRef, reason: "key-in-use" }),
      ),
    refusal: { _tag: "CloudLaunchError", reason: "seed-unavailable" },
  },
  {
    name: "a context export staged by someone else",
    settings: cloudSettings,
    contextExportRef: seedRef,
    check: () =>
      Effect.fail(
        new StagedCloudImports.StagedCloudImportError({ key: seedRef, reason: "key-in-use" }),
      ),
    refusal: { _tag: "CloudLaunchError", reason: "export-unavailable" },
  },
])(
  "refuses a cloud launch for $name before any thread or machine",
  ({ settings, git, workspace, cloudOnly = true, refusal, ...row }) => {
    const claim = vi.fn(() => Effect.void);
    const harness = makeHarness({
      cloudOnly,
      serverSettings: settings,
      git: { currentBranch: () => Effect.succeed("main"), ...git },
      stagedImports: { check: "check" in row ? row.check : () => Effect.void, claim },
    });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:cloud-off",
        thread: "thread:launch:cloud-off",
        message: "Fix the build",
        workspace: workspace ?? cloudWorkspace,
      });
      const error = yield* Effect.flip(
        launches.launch({
          ...input,
          actorId: seedMember,
          ...("contextExportRef" in row ? { contextExportRef: row.contextExportRef } : {}),
        }),
      );
      assert.equal(error._tag, "ThreadLaunchError");
      const cause = error._tag === "ThreadLaunchError" ? error.cause : undefined;
      assert.include(cause ?? {}, refusal);
      assert.isNull(yield* threads.getThreadShell(input.threadId));
      assert.equal(claim.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps a cloud run parked when the server stops before its machine is ready", () => {
  const harness = cloudHarness();
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    // A second instance, so closing its scope stands in for a server shutdown.
    const scope = yield* Scope.make();
    const launches = Context.get(
      yield* Layer.buildWithScope(
        Layer.fresh(ThreadLaunch.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              CommandReceiptStore.layer,
              IdAllocator.layer,
              Layer.succeed(ServerConfig.ServerConfig, {
                cloudOnly: true,
              } as ServerConfig.ServerConfig["Service"]),
            ),
          ),
        ),
        scope,
      ),
      ThreadLaunch.ThreadLaunchService,
    );
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:cloud-shutdown",
        thread: "thread:launch:cloud-shutdown",
        message: "Fix the build",
        workspace: cloudWorkspace,
      }),
    );
    // Its preparation is waiting on the machine, as a run parked across a restart is.
    yield* threads
      .streamStoredEventsFrom({ threadId: launched.threadId, eventType: "turn-item.updated" })
      .pipe(Stream.runHead);
    yield* Scope.close(scope, Exit.void);
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.runs[0]?.status, "preparing");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reuses the sandbox when a cloud launch is replayed", () => {
  const harness = cloudHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({
      command: "command:launch:cloud-replay",
      thread: "thread:launch:cloud-replay",
      message: "Fix the build",
      workspace: cloudWorkspace,
    });
    const first = yield* launches.launch(input);
    const replayed = yield* launches.launch(input);
    assert.isTrue(replayed.resumed);
    assert.equal(replayed.projection.thread.sandboxId, first.projection.thread.sandboxId);
    const creates = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
      outbox.listByCommandId(CommandId.make("command:launch:cloud-replay:sandbox")),
    );
    assert.deepEqual(
      creates.map((effect) => effect.request.type),
      ["sandbox.create"],
    );
  }).pipe(Effect.provide(harness.layer));
});

// Subprocess fixture: an in-process runner over the hub clones and checks out with real git.
it.live.each([
  { source: "a clone of origin", fromImage: false },
  { source: "a copy of the team image's clone", fromImage: true },
])("launches a cloud thread end to end: machine, runner hello, $source, release", ({ fromImage }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const hub = yield* RunnerHub.RunnerHub;
    const hosts = yield* WorkspaceHosts.WorkspaceHosts;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-cloud-e2e-" });
    const seed = `${directory}/seed`;
    const origin = `${directory}/origin.git`;
    // The loopback runner serves the local disk, so the sandbox root is a folder of ours.
    const root = `${directory}/sandbox`;
    yield* fs.makeDirectory(seed);
    yield* fs.makeDirectory(root);
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "launch-cloud-e2e", cwd, args });
    yield* run(seed, ["init", "-b", "main"]);
    yield* run(seed, [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    yield* run(seed, ["init", "--bare", origin]);
    yield* run(seed, ["push", origin, "main"]);
    // The build cloned `main` before this commit, so only a fetch after the copy reaches it.
    const imageRoot = `${directory}/image`;
    if (fromImage) {
      yield* run(seed, [
        "clone",
        origin,
        CloudPreparation.clonePathFor(imageRoot, origin, projectId),
      ]);
    }
    yield* run(seed, [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-m",
      "after the build",
    ]);
    yield* run(seed, ["push", origin, "main"]);
    const head = (yield* run(seed, ["rev-parse", "HEAD"])).stdout.trim();
    const succeeds = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "launch-cloud-e2e", cwd, args, allowNonZeroExit: true }).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );

    const fake = yield* FakeComputeDriver.make(ComputeDriverId.make("docker"));
    const cloneRepository = vi.fn(git.cloneRepository);
    const harness = makeHarness({
      cloudOnly: true,
      serverSettings: cloudSettings,
      ...(fromImage ? { activeImageBuild: imageBuild() } : {}),
      createWorktree: (input, options) => git.createWorktree(input, options),
      git: {
        readRemoteUrl: () => Effect.succeed(origin),
        isRepository: (cwd) => succeeds(cwd, ["rev-parse", "--git-dir"]),
        cloneRepository,
        fetchRemote: git.fetchRemote,
        hasCommit: ({ cwd, refName }) =>
          succeeds(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]),
      },
    });
    const layerSandboxEffects = SandboxEffects.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FakeComputeDriver.layerRegistry(fake.driver),
          ServerDrain.layerTest,
          // Only stop and destroy revoke credentials.
          Layer.mock(SandboxCredentialRevocation.SandboxCredentialRevocation)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(
              EnvironmentId.make("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"),
            ),
          }),
          // Enrolls with the real hub, as the server's bootstrap source does.
          Layer.succeed(SandboxBootstrapSource.SandboxBootstrapSource, {
            forGeneration: (input) =>
              hub.mintEnrollment(input.sandboxId, input.generation).pipe(
                Effect.map((enrollmentSecret) => ({
                  ...input,
                  runnerBuildId: "build",
                  serverUrl: "unix:/run/pair-host/runner.sock",
                  enrollmentSecret,
                })),
                Effect.orDie,
              ),
          }),
        ),
      ),
      Layer.provide(harness.layer),
    );

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const commandId = CommandId.make("command:launch:cloud-e2e");
      const launched = yield* launches.launch(
        launchInput({
          command: commandId,
          thread: "thread:launch:cloud-e2e",
          message: "Fix the build",
          workspace: cloudWorkspace,
        }),
      );
      const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);

      // The provision's create effect, as the effect worker runs it, answered by the driver.
      const create = yield* (yield* SandboxEffects.SandboxEffects)
        .execute({ type: "sandbox.create", sandboxId, generation: 1 })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(fake.calls);
      if (call._tag !== "create") return yield* Effect.die(`Expected create, got ${call._tag}`);
      assert.deepEqual(
        call.input.image,
        fromImage ? { type: "build", imageRef: "sha256:team-image-4" } : { type: "base" },
      );
      yield* Deferred.succeed(call.reply, { driverRef: call.input.name, baseImage: null });
      yield* Fiber.join(create);

      // The machine boots: its runner enrolls with the bootstrap's secret and says hello.
      const runner = yield* RunnerHubTesting.makeRunner(call.input.bootstrap.enrollmentSecret);
      yield* runner.connect();
      yield* hub.connection(sandboxId);
      const host = yield* hosts.forPath(`/t3-sandbox/${sandboxId}`);
      yield* hosts.register(root, host);
      yield* threads.dispatch({
        type: "sandbox.runner.attached",
        commandId: CommandId.make(`sandbox-attached:${sandboxId}:1:boot`),
        threadId: launched.threadId,
        sandboxId,
        generation: 1,
        runnerBootId: "boot",
      });
      yield* runReaching(launched.threadId, "starting");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      const worktreePath = projection.thread.worktreePath ?? "";
      assert.isTrue(worktreePath.startsWith(`${root}/worktrees/`));
      assert.equal((yield* hosts.forPath(worktreePath)).id, host.id);
      assert.equal((yield* run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(), head);
      assert.equal(cloneRepository.mock.calls.length, fromImage ? 0 : 1);
      assert.equal(projection.runs[0]?.status, "starting");
      // The released run's turn is queued for the provider, which runs in the worktree there.
      const released = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
        outbox.listByCommandId(CommandId.make(`${commandId}:release`)),
      );
      assert.include(
        released.map((effect) => effect.request.type),
        "provider-turn.start",
      );
    }).pipe(
      Effect.provideService(CloudPreparation.SandboxCheckoutRoot, () => root),
      Effect.provideService(CloudPreparation.TeamImageCloneRoot, imageRoot),
      Effect.provide(Layer.merge(harness.layer, layerSandboxEffects)),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-cloud-git-" })),
        Layer.provideMerge(RunnerHub.layer),
        Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
        Layer.provide(RunnerGrants.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
