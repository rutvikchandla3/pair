import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";
import {
  CommandId,
  type ChatAttachment,
  type MemberId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ThreadProjection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type SandboxId,
  type ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as PairCloudProjects from "../project/PairCloudProjects.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as CloudPreparation from "../sandbox/lifecycle/CloudPreparation.ts";
import { hasNoDisk } from "../sandbox/lifecycle/SandboxDecisions.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as RunnerHub from "../sandbox/runnerHub/RunnerHub.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    }
  /** A checkout in a new sandbox; the run records `worktree` and the thread holds the sandbox. */
  | {
      readonly type: "cloud";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly existingBranch?: true | undefined;
    };

type RunWorkspaceStrategy = Exclude<ThreadLaunchWorkspaceStrategy, { readonly type: "cloud" }>;

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** The member who launched it by hand; agent and scheduled launches leave it unset. */
  readonly actorId?: MemberId;
  /** Who the thread belongs to when no human launched it, e.g. a scheduled task's creator. */
  readonly ownerId?: MemberId;
  /** The linked environment this launch is for, if one asked for it. */
  readonly linkOrigin?: OrchestrationV2LinkOrigin;
  /** The parent there, when that environment's agent delegated this as a task. */
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom;
  /** A scheduled or webhook run: on a cloud-only server its workspace becomes a cloud checkout. */
  readonly cloudPlacement?: true;
  /** The cloud launch's machine is discarded once its threads settle. */
  readonly discardOnSettle?: boolean;
}

type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "initialMessage" | "actorId" | "ownerId"
> & {
  readonly workspaceStrategy: RunWorkspaceStrategy;
  readonly reusedWorktree?: { readonly baseRef: string };
  /** A cloud thread's `worktree` is made in this sandbox, from the project's remote. */
  readonly sandboxId?: SandboxId | undefined;
  /** A cloud thread's recorded checkout, kept when the sandbox's disk still has it. */
  readonly existingWorktreePath?: string | null;
  /** A cloud `branch` that must already be on origin. */
  readonly existingBranch?: true;
};

type CloudPlacement = Effect.Success<ReturnType<typeof CloudPreparation.resolveCloudLaunch>>;

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  /** The launch's last write (the initial message, else the thread claim) was accepted before this call. */
  readonly resumed: boolean;
  readonly sequence?: number;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /** Check before creation for early errors; launch otherwise accepts and reports base failures inside the thread. */
    readonly checkWorktreeBase: (
      input: Pick<ThreadLaunchInput, "projectId" | "workspaceStrategy">,
    ) => Effect.Effect<void, ThreadLaunchBaseRefError>;
    /** Refuses a cloud launch before anything exists; `launch` runs the same check. */
    readonly checkCloudLaunch: (input: {
      readonly projectId: ProjectId;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<
      CloudPlacement,
      Effect.Error<ReturnType<typeof CloudPreparation.resolveCloudLaunch>>
    >;
    readonly retryPreparation: (
      input: ThreadLaunchPreparationInput,
    ) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    readonly prepareRun: (input: ThreadLaunchPreparationInput) => Effect.Effect<void>;
    /**
     * Brings back a cloud thread's checkout when its machine came up without it, at the same
     * path, then reruns setup and records what was rebuilt. Runs in the background; never fails.
     */
    readonly restoreCheckout: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

type SandboxCheckout = Effect.Success<ReturnType<typeof CloudPreparation.checkoutInSandbox>>;

/** The timeline row that tells a rebuilt checkout from a kept disk (07 §9). */
const rebuildNotice = (checkout: SandboxCheckout) => {
  if (checkout.restoredFrom === "mirror" && checkout.snapshotAt !== null) {
    const at = DateTime.formatIso(checkout.snapshotAt).slice(0, 16).replace("T", " ");
    return `Rebuilt from the snapshot of ${at} UTC: the machine's disk was lost. Ignored files and caches were not kept.`;
  }
  if (checkout.restoredFrom === "mirror") {
    return `Rebuilt from the last saved commit on ${checkout.branch}: the machine's disk was lost. Uncommitted changes, ignored files and caches were not kept.`;
  }
  return `Checked out again from the remote: the machine's disk was lost and no copy of ${checkout.branch} was saved. Unpushed commits and uncommitted changes were not kept.`;
};

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  const refusal = isThreadLaunchError(error) ? error.cause : error;
  if (CloudPreparation.isCloudLaunchRefusal(refusal)) return refusal.message;
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const { cloudOnly } = serverConfig;
  const preparationScope = yield* Scope.make("sequential");
  // Keyed by run when there is one, so a re-arm never prepares a run a launch already prepares.
  const scheduledLaunches = yield* Ref.make<ReadonlySet<string>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));
  // The server provides the hub; a cloud checkout then waits for the machine's runner to dial in.
  const runnerHub = yield* Effect.serviceOption(RunnerHub.RunnerHub);
  const mirrorSync = yield* Effect.serviceOption(MirrorSync.MirrorSync);
  // One checkout at a time per machine: threads on it share a clone.
  const sandboxCheckouts = yield* KeyedLock.make<SandboxId>();
  // The server provides it; on a cloud-only server it fetches and authenticates the checkout.
  const pairCloudProjects = yield* Effect.serviceOption(PairCloudProjects.PairCloudProjects);
  const cloudServices = Context.make(GitWorkflow.GitWorkflowService, git).pipe(
    Context.add(ProjectionStore.ProjectionStoreV2, projections),
    Context.add(ServerSettings.ServerSettingsService, serverSettings),
    Context.add(ServerConfig.ServerConfig, serverConfig),
    Context.add(ThreadManagement.ThreadManagementService, threads),
    (context) =>
      Option.isSome(runnerHub)
        ? Context.add(context, RunnerHub.RunnerHub, runnerHub.value)
        : context,
    (context) =>
      Option.isSome(mirrorSync)
        ? Context.add(context, MirrorSync.MirrorSync, mirrorSync.value)
        : context,
  );
  const checkoutInSandbox = (input: Parameters<typeof CloudPreparation.checkoutInSandbox>[0]) =>
    sandboxCheckouts.withLock(
      input.sandboxId,
      CloudPreparation.checkoutInSandbox(input).pipe(Effect.provide(cloudServices)),
    );
  const recordRebuild = (commandId: CommandId, threadId: ThreadId, checkout: SandboxCheckout) =>
    threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`${commandId}:rebuilt`),
        threadId,
        message: rebuildNotice(checkout),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a rebuilt checkout", { threadId, cause }),
        ),
      );

  const mapError =
    (
      input: Pick<PreparationInput, "commandId" | "projectId">,
      operation: ThreadLaunchError["operation"],
      threadId?: ThreadId,
    ) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const checkCloudLaunch: ThreadLaunchService["Service"]["checkCloudLaunch"] = (input) =>
    CloudPreparation.resolveCloudLaunch(input.projectId, input.instanceId).pipe(
      Effect.provide(cloudServices),
    );

  /** Refuses a branch origin lacks; when git cannot ask, the checkout in the sandbox decides. */
  const checkExistingBranch = Effect.fn("ThreadLaunchService.checkExistingBranch")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly branch: string;
      readonly memberId: MemberId | undefined;
    }) {
      const origin = { cwd: input.workspaceRoot, remoteName: "origin" };
      const url = yield* git.readRemoteUrl(origin);
      if (url === null) return;
      const repository = PairCloudProjects.parsePairCloudRemote(url);
      const env =
        Option.isSome(pairCloudProjects) && repository !== null
          ? yield* pairCloudProjects.value.gitEnvFor({ repository, memberId: input.memberId })
          : undefined;
      if (
        yield* git.remoteHasBranch({
          ...origin,
          refName: input.branch,
          ...(env === undefined ? {} : { env }),
        })
      ) {
        return;
      }
      return yield* new CloudPreparation.CloudLaunchError({
        projectId: input.projectId,
        reason: "branch-not-pushed",
        branch: input.branch,
        remote: normalizeGitRemoteUrl(url),
      });
    },
    Effect.catchTags({
      GitCommandError: (cause) =>
        Effect.logWarning("Could not ask origin for a cloud launch's branch", { cause }),
    }),
  );

  /** The machine derives from `commandId`, so a replayed launch provisions the same one. */
  const provisionCloud = Effect.fn("ThreadLaunchService.provisionCloud")(function* (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly placement: CloudPlacement;
    readonly discardOnSettle: boolean;
  }) {
    yield* threads.dispatch({
      type: "sandbox.provision",
      commandId: CommandId.make(`${input.commandId}:sandbox`),
      threadId: input.threadId,
      sandboxId: CloudPreparation.sandboxIdForLaunch(input.commandId),
      projectId: input.projectId,
      driverId: input.placement.driverId,
      size: input.placement.size,
      ...(input.discardOnSettle ? { discardOnSettle: true } : {}),
    });
  });

  /**
   * A task stores a local strategy; on a cloud-only server each run checks out from origin. A
   * worktree keeps its base, and any other strategy starts from the project checkout's branch.
   */
  const placeInCloud = Effect.fn("ThreadLaunchService.placeInCloud")(function* (
    request: ThreadLaunchInput,
  ) {
    const strategy = request.workspaceStrategy;
    if (!cloudOnly || request.cloudPlacement !== true || strategy.type === "cloud") return request;
    const baseRef =
      strategy.type === "worktree"
        ? strategy.baseRef.replace(/^origin\//, "")
        : (strategy.branch ??
          (yield* projects.getById(request.projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(null),
                onSome: (project) => git.currentBranch(project.workspaceRoot),
              }),
            ),
            Effect.orElseSucceed(() => null),
          )) ??
          "main");
    const workspaceStrategy: ThreadLaunchWorkspaceStrategy = {
      type: "cloud",
      baseRef,
      ...(strategy.type === "worktree" && strategy.branch !== undefined
        ? { branch: strategy.branch }
        : {}),
    };
    return { ...request, workspaceStrategy };
  });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.type !== "worktree" || strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = project.workspaceRoot;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      if (
        strategy.startFromOrigin === true &&
        (yield* git.resolveWorktreeBaseRemote({ cwd, refName: baseRef })) !== null
      )
        return undefined;
      // git worktree add accepts remote-tracking branches; let Git decide when any matching ref exists.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" })) ? project : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const reused = input.reusedWorktree;
    const tracked = input.workspaceStrategy.type === "worktree" || reused !== undefined;
    const sandboxId = input.sandboxId;
    // A cloud checkout is a worktree of the sandbox's clone, not of the project root.
    let worktreeRepository = project.workspaceRoot;
    let createdWorktreePath: string | null = null;
    let createdBranch: string | null = null;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    let runReleased = false;
    // Stop background renames before forgetting worktrees; completed renames record them again.
    let branchRename: Fiber.Fiber<unknown> | null = null;
    if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = Effect.fn("ThreadLaunchService.generateBranchNameFor")(
        function* (cwd: string, message: ThreadLaunchInitialMessage) {
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                  input.projectId,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              message: message.text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
            })
            .pipe(
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        },
      );

      const requestedBranch = input.workspaceStrategy.branch;
      let branch: string | null;
      if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
        const uuid = yield* randomUuidV4;
        branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
      } else {
        branch = requestedBranch ?? null;
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      const progress = (phase: "sandbox-admission" | "sandbox-start" | "clone") =>
        runId === null
          ? Effect.void
          : threads
              .dispatch({
                type: "prepared-run.progress",
                commandId: CommandId.make(`${input.commandId}:progress:${phase}`),
                threadId,
                runId,
                phase,
              })
              .pipe(Effect.asVoid, Effect.mapError(mapError(input, "update-thread", threadId)));
      if (input.workspaceStrategy.type === "worktree" && sandboxId !== undefined) {
        const fetchCheckout = Option.isSome(pairCloudProjects)
          ? pairCloudProjects.value.fetchCheckout({
              projectId: input.projectId,
              workspaceRoot: project.workspaceRoot,
              memberId: input.actorId ?? input.ownerId,
            })
          : Effect.void;
        // The machine starts while the checkout fetches; the mirror reads it after both.
        yield* Effect.all(
          [
            fetchCheckout,
            CloudPreparation.awaitSandboxReady({ sandboxId, onWaiting: progress }).pipe(
              Effect.provide(cloudServices),
              Effect.mapError(mapError(input, "provision-worktree", threadId)),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
        yield* progress("clone");
        yield* setupTracker.stageStatus(threadId, "fetch", "running");
        const existingWorktreePath = input.existingWorktreePath ?? null;
        const checkout = yield* checkoutInSandbox({
          sandboxId,
          threadId,
          projectId: input.projectId,
          projectRoot: project.workspaceRoot,
          baseRef: input.workspaceStrategy.baseRef,
          branch: branch!,
          existingBranch: input.existingBranch === true,
          existingWorktreePath,
        }).pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        yield* Effect.logInfo("Prepared a cloud checkout", {
          threadId,
          restoredFrom: checkout.restoredFrom,
        });
        if (existingWorktreePath !== null && checkout.restoredFrom !== "disk") {
          yield* recordRebuild(input.commandId, threadId, checkout);
        }
        yield* setupTracker.stageStatus(threadId, "fetch", "done");
        worktreeRepository = checkout.clonePath;
        worktreePath = checkout.worktreePath;
        branch = checkout.branch;
        if (checkout.created) {
          createdWorktreePath = worktreePath;
          createdBranch = branch;
        }
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      } else if (input.workspaceStrategy.type === "worktree") {
        if (runId !== null) {
          yield* threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:worktree`),
              threadId,
              runId,
              phase: "worktree",
            })
            .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
        }
        let startRef = input.workspaceStrategy.baseRef;
        let baseRefName = input.workspaceStrategy.baseRef;
        const remote =
          input.workspaceStrategy.startFromOrigin === true
            ? yield* git
                .resolveWorktreeBaseRemote({
                  cwd: project.workspaceRoot,
                  refName: input.workspaceStrategy.baseRef,
                })
                .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)))
            : null;
        const shouldFetch = remote !== null;
        yield* setupTracker.stageStatus(threadId, "fetch", shouldFetch ? "running" : "skipped");
        if (remote !== null) {
          const remoteBase = yield* git
            .fetchWorktreeBaseCommit({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
              remote,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBase !== null) {
            startRef = remoteBase.commitSha;
            baseRefName = `refs/remotes/${remoteBase.remoteRefName}`;
          }
        }
        if (shouldFetch) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        if (
          branch !== null &&
          isTemporaryWorktreeBranch(branch) &&
          (yield* git
            .hasCommit({
              cwd: project.workspaceRoot,
              refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          branch = flattenTemporaryWorktreeBranchName(branch);
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        const worktree = yield* git
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: startRef,
              newRefName: branch!,
              baseRefName,
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    createdWorktreePath = path;
                    createdBranch = branch;
                  }),
                onCheckoutProgress: (progress) =>
                  setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
              },
            },
          )
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        worktreePath = worktree.worktree.path;
        branch = worktree.worktree.refName;
        createdWorktreePath = worktreePath;
        createdBranch = branch;
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      }

      // Do not rewrite reused worktrees; that could undo the original branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      workspaceRecorded = true;

      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        isTemporaryWorktreeBranch(branch)
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        // Text generation runs a local CLI that reads only the message, never a sandbox path.
        branchRename = yield* generateBranchNameFor(
          sandboxId === undefined ? worktreeCwd : project.workspaceRoot,
          initialMessage,
        ).pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            git
              .renameBranch({
                cwd: worktreeCwd,
                oldBranch,
                newBranch,
                ...(exactName ? { exactName: true } : {}),
              })
              .pipe(
                // A cancel must see the renamed branch, or its cleanup deletes the old name.
                Effect.tap((renamed) =>
                  Effect.sync(() => {
                    createdBranch = renamed.branch;
                  }),
                ),
                Effect.uninterruptible,
              ),
          ),
          Effect.flatMap((renamed) =>
            Effect.gen(function* () {
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:branch-rename`),
                  threadId,
                  branch: renamed.branch,
                  worktreePath: worktreeCwd,
                  expectedBranch: oldBranch,
                  expectedWorktreePath: worktreeCwd,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Parent thread worktree branch update failed", {
                      threadId,
                      cause,
                    }),
                  ),
                );
              // Update parents first so children inherit names; reread each pass for newly updated descendants.
              const visited = new Set([threadId]);
              while (true) {
                const snapshot = yield* threads.getShellSnapshot({ worktreePath: worktreeCwd });
                const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
                  (thread) => !visited.has(thread.id) && thread.branch === oldBranch,
                );
                if (sharing.length === 0) break;
                for (const thread of sharing) {
                  visited.add(thread.id);
                  yield* threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:branch-rename:${thread.id}`),
                      threadId: thread.id,
                      branch: renamed.branch,
                      expectedBranch: oldBranch,
                      expectedWorktreePath: worktreeCwd,
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Shared thread worktree branch update failed", {
                          threadId: thread.id,
                          cause,
                        }),
                      ),
                    );
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }),
          ),
          Effect.forkIn(preparationScope),
        );
      }

      if (runId !== null && worktreePath !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      const setup =
        worktreePath === null
          ? ({ status: "no-script" } as const)
          : yield* setupScripts
              .runForThread({
                threadId,
                projectId: input.projectId,
                projectCwd: project.workspaceRoot,
                worktreePath,
                ...(tracked
                  ? {
                      observeCompletion: {
                        onOutputLine: (line: string) =>
                          setupTracker.appendTail(threadId, "setup-script", line),
                      },
                    }
                  : {}),
                project: {
                  id: project.id,
                  workspaceRoot: project.workspaceRoot,
                  scripts: project.scripts,
                },
              })
              .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

      let awaitAsyncSetup = Effect.void;
      if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: completion.exitCode === 0 ? "done" : "failed",
              detail: `exited with ${completion.exitCode ?? "no exit code"}`,
            });
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            awaitAsyncSetup = awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stage(threadId, "setup-script", {
                  status: "failed",
                  detail: failureDetail(Cause.squash(cause)),
                }),
              ),
            );
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(threadId, "setup-script", "skipped");
      }
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
          })
          .pipe(
            Effect.mapError(mapError(input, "release-run", threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                runReleased = true;
              }),
            ),
            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const cancelled = Cause.hasInterruptsOnly(cause);
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          if (cancelled && setupTerminalId)
            yield* terminals
              .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
              .pipe(Effect.ignore);
          if (
            tracked &&
            createdWorktreePath &&
            ((cancelled && !runReleased) || !workspaceRecorded)
          ) {
            if (branchRename !== null) yield* Fiber.interrupt(branchRename);
            const removedPath = createdWorktreePath;
            const removedBranch = createdBranch;
            // Forget worktrees only after removal succeeds; failed removals must not reuse partially written checkouts.
            yield* git
              .removeWorktree({ cwd: worktreeRepository, path: removedPath, force: true })
              .pipe(
                Effect.andThen(
                  removedBranch === null
                    ? Effect.void
                    : git
                        .deleteLocalBranch({
                          cwd: worktreeRepository,
                          refName: removedBranch,
                          force: true,
                        })
                        .pipe(Effect.ignoreCause({ log: true })),
                ),
                Effect.andThen(
                  threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                      threadId,
                      worktreePath: null,
                      branch: null,
                    })
                    .pipe(Effect.ignore),
                ),
                Effect.catchCause((removeCause) =>
                  Effect.logWarning("Failed to remove an abandoned thread worktree", {
                    commandId: input.commandId,
                    threadId,
                    path: removedPath,
                    cause: removeCause,
                  }),
                ),
              );
          }
        }),
      ),
    );
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (key: CommandId | RunId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(key)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(key);
      return [true, next] as const;
    });

  const releasePreparation = (key: CommandId | RunId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(key);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const preparation = Effect.gen(function* () {
      const prepare = prepareInBackground(input, threadId, runId);
      if (
        runId === null ||
        (input.workspaceStrategy.type !== "worktree" && input.reusedWorktree === undefined)
      ) {
        return yield* prepare;
      }
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const projection = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (projection.runs.find((run) => run.id === runId)?.status !== "preparing") return;
      const interruption = threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              (stored.event.payload.status === "interrupted" ||
                stored.event.payload.status === "cancelled"),
          ),
          Stream.runHead,
          Effect.flatMap((event) => (Option.isSome(event) ? Effect.interrupt : Effect.never)),
        );
      yield* Effect.raceFirst(prepare, interruption);
    });
    const key = runId ?? input.commandId;
    yield* preparation.pipe(
      Effect.onError((cause) =>
        // A cloud run interrupted here was cancelled already, or the server is stopping and
        // startup recovery re-arms it on its machine.
        input.sandboxId !== undefined && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : // Free the run first: a retry accepted once the failure lands must find it unreserved.
            releasePreparation(key).pipe(
              Effect.andThen(
                failPreparedRun(
                  input,
                  threadId,
                  runId,
                  Cause.hasInterruptsOnly(cause)
                    ? "Worktree setup cancelled."
                    : Cause.squash(cause),
                ),
              ),
            ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(key)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (requested) {
      const request = yield* placeInCloud(requested);
      if (cloudOnly && request.workspaceStrategy.type !== "cloud") {
        return yield* mapError(
          request,
          "resolve-project",
        )(
          new CloudPreparation.CloudLaunchError({
            projectId: request.projectId,
            reason: "local-launch",
          }),
        );
      }
      // Scratch has no Git repository. Normalize before folder allocation so
      // durable preparation and retries use the thread's own Scratch folder.
      const input: ThreadLaunchInput =
        request.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(request.projectId))
          ? { ...request, workspaceStrategy: { type: "root" } }
          : request;
      const cloud =
        input.workspaceStrategy.type === "cloud"
          ? yield* checkCloudLaunch({
              projectId: input.projectId,
              instanceId: input.modelSelection.instanceId,
            }).pipe(Effect.mapError(mapError(input, "resolve-project")))
          : null;
      yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
        type: "thread.create",
        projectId: input.projectId,
      }).pipe(Effect.mapError(mapError(input, "resolve-project")));
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      const strategy = input.workspaceStrategy;
      const existingBranch = strategy.type === "cloud" && strategy.existingBranch === true;
      if (existingBranch) {
        if (strategy.branch === undefined) {
          return yield* mapError(
            input,
            "resolve-project",
          )(
            new CloudPreparation.CloudLaunchError({
              projectId: input.projectId,
              reason: "no-branch",
            }),
          );
        }
        // Only a new launch asks: a replay never re-asks origin.
        if (Option.isNone(launchReceipt)) {
          yield* checkExistingBranch({
            projectId: input.projectId,
            workspaceRoot: project.workspaceRoot,
            branch: strategy.branch,
            memberId: input.actorId ?? input.ownerId,
          }).pipe(Effect.mapError(mapError(input, "resolve-project")));
        }
      }
      yield* threads.assertProviderInstanceEnabled({
        projectId: input.projectId,
        commandId: input.commandId,
        instanceId: input.modelSelection.instanceId,
      });
      if (input.reuseExistingThread !== true) {
        yield* threads.assertNewThreadProviderInstanceSelectable({
          commandId: input.commandId,
          projectId: input.projectId,
          instanceId: input.modelSelection.instanceId,
          actorId: input.actorId,
          ownerId: input.ownerId,
        });
      }
      return yield* Effect.gen(function* () {
        // Recover ids from accepted launch receipts before allocating; retries have no client id and new ids collide with receipts.
        const reusableLaunchReceipt =
          input.threadId === undefined &&
          Option.isSome(launchReceipt) &&
          launchReceipt.value.status === "accepted" &&
          launchReceipt.value.commandType === "thread.create"
            ? launchReceipt.value
            : undefined;
        const candidateThreadId =
          input.threadId ??
          reusableLaunchReceipt?.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (reusableLaunchReceipt !== undefined) {
          const shell = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (shell === null) {
            return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
          }
          if (shell.projectId !== input.projectId) {
            return yield* mapError(
              input,
              "resolve-project",
              candidateThreadId,
            )("Project identity changed.");
          }
        }

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        const requestedStrategy: RunWorkspaceStrategy =
          input.workspaceStrategy.type === "cloud"
            ? {
                type: "worktree",
                baseRef: input.workspaceStrategy.baseRef,
                ...(input.workspaceStrategy.branch === undefined
                  ? {}
                  : { branch: input.workspaceStrategy.branch }),
              }
            : input.workspaceStrategy;
        const workspaceStrategy: RunWorkspaceStrategy =
          requestedStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => requestedStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : requestedStrategy;
        const initialBranch = workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
                expectedEmpty: true,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                ...(input.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: input.importedNativeThread }),
                ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
                ...(input.delegatedFrom === undefined
                  ? {}
                  : { delegatedFrom: input.delegatedFrom }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
                ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
                ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }
        const sandboxId =
          cloud === null ? undefined : CloudPreparation.sandboxIdForLaunch(input.commandId);
        if (cloud !== null) {
          yield* provisionCloud({
            commandId: input.commandId,
            threadId,
            projectId: input.projectId,
            placement: cloud,
            discardOnSettle: input.discardOnSettle === true,
          }).pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        }
        let runId: RunId | null = null;
        let messageSequence: number | undefined;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              ...(input.initialMessage.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
              ...(input.initialMessage.senderThreadId === undefined
                ? {}
                : { senderThreadId: input.initialMessage.senderThreadId }),
              attachments: input.initialMessage.attachments,
              ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start", workspaceStrategy },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
              ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
            })
            .pipe(
              // An agent's launch can land on a thread that a replay, or a concurrent
              // launch with the same key, created with broader modes. The orchestrator
              // refuses the message under the thread's lock; the user's own clients
              // launch into their own drafts, whatever modes those hold.
              input.createdBy === "agent"
                ? Effect.provideService(DispatchModeLimit, {
                    runtimeMode: input.runtimeMode,
                    interactionMode: input.interactionMode,
                  })
                : (effect) => effect,
              Effect.mapError(mapError(input, "dispatch-message", threadId)),
            );
          // A concurrent retry can read no receipt and still replay the dispatch.
          messageWasAlreadyAccepted ||= dispatched.replayed === true;
          messageSequence = dispatched.sequence;
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        const boundWorktreePath = projection.thread.worktreePath;
        const preparationStrategy: RunWorkspaceStrategy =
          Option.isSome(launchReceipt) &&
          workspaceStrategy.type === "root" &&
          boundWorktreePath !== null
            ? {
                type: "existing_worktree",
                worktreePath: boundWorktreePath,
                branch: workspaceStrategy.branch,
              }
            : workspaceStrategy;
        if (shouldSchedule) {
          const preparationKey = runId ?? input.commandId;
          const ownsPreparation = yield* reservePreparation(preparationKey);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(
                  {
                    ...input,
                    workspaceStrategy: preparationStrategy,
                    sandboxId,
                    ...(existingBranch ? { existingBranch: true as const } : {}),
                  },
                  threadId,
                  runId,
                );
              } else {
                yield* releasePreparation(preparationKey);
              }
            }).pipe(Effect.onError(() => releasePreparation(preparationKey)));
          }
        }

        return {
          threadId,
          projection,
          // An attempt that failed after claiming the thread recorded nothing, so
          // only a repeat of the final write counts as resumed.
          resumed:
            input.initialMessage === undefined
              ? Option.isSome(launchReceipt) || claimed.replayed === true
              : messageWasAlreadyAccepted,
          ...(messageSequence === undefined ? {} : { sequence: messageSequence }),
        };
      });
    },
  );

  const prepareRun: ThreadLaunchService["Service"]["prepareRun"] = Effect.fn(
    "ThreadLaunchService.prepareRun",
  )(function* (input) {
    const scheduled = yield* Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [input.runId],
      });
      const run = runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.runId))) return;
      yield* scheduleRunPreparation(input, thread, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.runId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(input, input.threadId, input.runId, Cause.squash(scheduled.cause));
    }
  });

  const restoreInBackground = Effect.fn("ThreadLaunchService.restoreInBackground")(
    function* (input: { readonly commandId: CommandId; readonly threadId: ThreadId }) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (
        shell === null ||
        shell.deletedAt !== null ||
        shell.sandboxId === undefined ||
        shell.worktreePath === null ||
        shell.branch === null
      ) {
        return;
      }
      const { sandboxId, worktreePath, branch } = shell;
      const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      const firstCheckout = runs
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .find((run) => run.workspacePreparation?.type === "worktree")?.workspacePreparation;
      if (firstCheckout?.type !== "worktree") return;
      const project = yield* projects.getById(shell.projectId);
      if (Option.isNone(project)) return;
      const { workspaceRoot } = project.value;
      yield* CloudPreparation.awaitSandboxReady({ sandboxId, onWaiting: () => Effect.void }).pipe(
        Effect.provide(cloudServices),
      );
      const checkout = yield* checkoutInSandbox({
        sandboxId,
        threadId: input.threadId,
        projectId: shell.projectId,
        projectRoot: workspaceRoot,
        baseRef: firstCheckout.baseRef,
        branch,
        existingBranch: false,
        existingWorktreePath: worktreePath,
      });
      yield* Effect.logInfo("Restored a cloud checkout", {
        threadId: input.threadId,
        restoredFrom: checkout.restoredFrom,
      });
      if (checkout.restoredFrom === "disk") return;
      if (checkout.worktreePath !== worktreePath || checkout.branch !== branch) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:workspace`),
          threadId: input.threadId,
          branch: checkout.branch,
          worktreePath: checkout.worktreePath,
        });
      }
      yield* setupScripts
        .runForThread({
          threadId: input.threadId,
          projectId: shell.projectId,
          projectCwd: workspaceRoot,
          worktreePath: checkout.worktreePath,
          project: { id: project.value.id, workspaceRoot, scripts: project.value.scripts },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A rebuilt checkout's setup script failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      yield* recordRebuild(input.commandId, input.threadId, checkout);
    },
  );

  const restoreCheckout: ThreadLaunchService["Service"]["restoreCheckout"] = Effect.fn(
    "ThreadLaunchService.restoreCheckout",
  )(function* (input) {
    const key = input.commandId;
    if (!(yield* reservePreparation(key))) return;
    yield* restoreInBackground(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not restore a cloud thread's checkout", {
          threadId: input.threadId,
          cause,
        }),
      ),
      Effect.ensuring(releasePreparation(key)),
      Effect.forkIn(preparationScope),
    );
  });

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const before = yield* threads.getThreadShell(input.threadId);
    // Retrying a machine with no disk makes a new one: 2.23's launch gate, before the run moves.
    if (!cloudOnly && before?.sandboxId !== undefined && before.sandbox?.state === "failed") {
      const record = yield* projections
        .getSandbox(before.sandboxId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new Orchestrator.OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        );
      if (record !== null && hasNoDisk(record)) {
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: input.commandId,
          commandType: "prepared-run.retry",
          cause: NOT_CLOUD_ONLY_MESSAGE,
        });
      }
    }
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    // A cloud run failed by its machine needs the machine back before the checkout.
    const shell = yield* threads.getThreadShell(input.threadId);
    if (shell?.sandbox?.state === "failed" && shell.sandboxId !== undefined) {
      yield* threads.dispatch({
        type: "sandbox.retry",
        commandId: CommandId.make(`${input.commandId}:sandbox-retry`),
        threadId: shell.sandbox.ownerThreadId,
        sandboxId: shell.sandboxId,
      });
    }
    yield* prepareRun(input);
    return dispatched;
  });

  const scheduleRunPreparation = Effect.fn("ThreadLaunchService.scheduleRunPreparation")(function* (
    input: ThreadLaunchPreparationInput,
    thread: OrchestrationV2ThreadProjection["thread"],
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: RunWorkspaceStrategy,
  ) {
    const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    // Placement lives on the thread: a cloud worktree is (re)made in its sandbox, never locally.
    const cloud =
      thread.sandboxId !== undefined && workspacePreparation.type === "worktree"
        ? {
            sandboxId: thread.sandboxId,
            existingWorktreePath: thread.worktreePath,
            workspaceStrategy: {
              ...workspacePreparation,
              ...(thread.branch === null ? {} : { branch: thread.branch }),
            },
          }
        : null;
    const reuse =
      cloud === null &&
      workspacePreparation.type === "worktree" &&
      thread.worktreePath !== null &&
      thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return yield* schedulePreparation(
      {
        commandId: input.commandId,
        projectId: thread.projectId,
        ...(thread.ownerId === undefined || thread.ownerId === null
          ? {}
          : { ownerId: thread.ownerId }),
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...cloud,
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  });

  return ThreadLaunchService.of({
    launch,
    checkWorktreeBase,
    checkCloudLaunch,
    retryPreparation,
    prepareRun,
    restoreCheckout,
  });
});

export const layer = Layer.effect(ThreadLaunchService, make);
