import {
  CommandId,
  type OrchestrationProjectShell,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectRootInput,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withCommandMetrics } from "../observability/Metrics.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  planProjectCommand,
  type ProjectCommand,
  ProjectReferencedByWorkspaceError,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface ProjectCreateInput extends ProjectCreatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends Omit<ProjectCreateInput, "workspaceRoot" | "roots"> {
  readonly workspaceRoot: string;
}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedError<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedError<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not empty.`;
  }
}

/** A workspace rule the request broke; the message is for the user. */
export class ProjectWorkspaceError extends Schema.TaggedError<ProjectWorkspaceError>()(
  "ProjectWorkspaceError",
  {
    projectId: ProjectId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const PAIR_CLOUD_WORKSPACE_MESSAGE = "On Pair Cloud, add a project by its GitHub URL.";

/** `<checkoutsDir>/<projectId>`, or null for an id that is not one plain folder name. */
export function pairCloudCheckoutPath(
  path: Path.Path,
  checkoutsDir: string,
  projectId: ProjectId,
): string | null {
  return /^\w[\w.:-]*$/.test(projectId) ? path.resolve(checkoutsDir, projectId) : null;
}

export class ProjectOperationError extends Schema.TaggedError<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "pair-cloud-workspace",
      "normalize-workspace",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "dispatch-project-command",
      "workspace-folder",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.operation === "pair-cloud-workspace") return PAIR_CLOUD_WORKSPACE_MESSAGE;
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectNotEmptyError
  | ProjectWorkspaceError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /**
     * A page of active projects in creation order, each with its repository
     * identity resolved, so a caller can match projects by repository.
     */
    readonly listPage: (input: {
      readonly cursor: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly projects: ReadonlyArray<Project>; readonly nextCursor: number | null },
      ProjectOperationError
    >;
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    /**
     * `getShell`, but the repository identity is resolved before it returns instead of peeked
     * from the cache. For a caller that decides something by the project's origin.
     */
    readonly getResolvedShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectOperationError>;
    /**
     * Each shell with its cached repository identity (always null for a workspace), plus the
     * roots whose identity is settled. Missing identities are queued, never awaited.
     */
    readonly enrichShells: (shells: ReadonlyArray<OrchestrationProjectShell>) => Effect.Effect<{
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const threadProjections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Optional so offline CLI runtimes skip it; the mirror's startup sweep catches anything missed.
  const checkpointMirror = yield* Effect.serviceOption(CheckpointMirror.CheckpointMirror);
  const projectLocks = yield* KeyedLock.make<ProjectId>();
  const workspaceLocks = yield* KeyedLock.make<string>();
  const { cloudOnly, checkoutsDir, baseDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const workspacesRoot = path.resolve(baseDir, "workspaces");
  // Root membership spans projects, so creates/edits with roots and deletes serialize on one key.
  const ROOTS_LOCK_KEY = "\u0000workspace-roots";

  /** A cloud-only server's only projects are the checkouts Pair Cloud cloned itself. */
  const refuseOutsideCheckouts = (projectId: ProjectId, workspaceRoot: string) =>
    cloudOnly &&
    path.resolve(workspaceRoot.trim()) !== pairCloudCheckoutPath(path, checkoutsDir, projectId)
      ? Effect.fail(
          new ProjectOperationError({
            operation: "pair-cloud-workspace",
            projectId,
            workspaceRoot,
            cause: PAIR_CLOUD_WORKSPACE_MESSAGE,
          }),
        )
      : Effect.void;

  const toProject = (
    row: ProjectStore.ProjectRow,
    enrichment: ProjectEnrichmentService.ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    ...(row.roots === undefined ? {} : { roots: row.roots }),
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (row: ProjectStore.ProjectRow) {
    // A workspace's folder is not a repository; its roots carry their own identities.
    if (row.roots !== undefined) return toProject(row, null);
    const enrichment =
      row.deletedAt === null
        ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
        : yield* projectEnrichment.peek(row.workspaceRoot);
    return toProject(row, enrichment);
  });

  const readRow = (projectId: ProjectId, options?: { readonly includeDeleted?: boolean }) =>
    projects
      .get(projectId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );

  const normalizeWorkspaceRoot = (input: {
    readonly projectId?: ProjectId;
    readonly workspaceRoot: string;
    readonly createIfMissing?: boolean;
  }) =>
    workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createIfMissing ?? false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "normalize-workspace",
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        ),
      );

  const listReferencingWorkspaces = (projectId: ProjectId) =>
    projects
      .list()
      .pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.roots?.some((root) => root.projectId === projectId) === true),
        ),
      );

  /** The only I/O rule for roots: each must be the top folder of a git repository. */
  const requireRepositoryRoots = Effect.fn("ProjectService.requireRepositoryRoots")(function* (
    projectId: ProjectId,
    roots: ReadonlyArray<ProjectRootInput>,
  ) {
    const rows = yield* projects
      .list({ projectIds: roots.map((root) => root.projectId) })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", projectId, cause }),
        ),
      );
    for (const row of rows) {
      if (row.roots !== undefined) continue;
      const isRepository = yield* fileSystem
        .exists(path.join(row.workspaceRoot, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!isRepository) {
        return yield* new ProjectWorkspaceError({
          projectId,
          reason: `"${row.title}" is not the top folder of a git repository, so it cannot be in a workspace.`,
        });
      }
    }
  });

  // Non-recursive mkdir claims a free name atomically.
  const claimWorkspaceFolder = Effect.fn("ProjectService.claimWorkspaceFolder")(function* (
    projectId: ProjectId,
    title: string,
  ) {
    const folderError = (cause: unknown) =>
      new ProjectOperationError({
        operation: "workspace-folder",
        projectId,
        workspaceRoot: workspacesRoot,
        cause,
      });
    yield* fileSystem
      .makeDirectory(workspacesRoot, { recursive: true })
      .pipe(Effect.mapError(folderError));
    const folderName = newProjectFolderName(title);
    for (let attempt = 1; attempt <= 100; attempt++) {
      const folder = path.join(
        workspacesRoot,
        attempt === 1 ? folderName : `${folderName}-${attempt}`,
      );
      const claimed = yield* fileSystem.makeDirectory(folder).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(folderError),
      );
      if (claimed) return folder;
    }
    return yield* folderError(`Every folder name for "${folderName}" is taken.`);
  });

  const commit = Effect.fn("ProjectService.commit")(function* (command: ProjectCommand) {
    const { projectId } = command;
    const dispatchError = (cause: unknown) =>
      new ProjectOperationError({ operation: "dispatch-project-command", projectId, cause });
    const workspaceRoot = command.type === "project.delete" ? undefined : command.workspaceRoot;
    const touchesRoots = command.type === "project.delete" || command.roots !== undefined;
    const planAndCommit = Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* readRow(projectId, { includeDeleted: true }));
      const rootProjects =
        command.type === "project.delete" || command.roots === undefined
          ? undefined
          : yield* projects
              .list({ projectIds: command.roots.map((root) => root.projectId) })
              .pipe(Effect.mapError(dispatchError));
      const referencingWorkspaces =
        command.type === "project.delete"
          ? yield* listReferencingWorkspaces(projectId).pipe(Effect.mapError(dispatchError))
          : undefined;
      const workspaceOwner =
        workspaceRoot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceRoot(workspaceRoot)
                .pipe(Effect.mapError(dispatchError)),
            );
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: {
          project,
          workspaceOwner,
          ...(rootProjects === undefined ? {} : { rootProjects }),
          ...(referencingWorkspaces === undefined ? {} : { referencingWorkspaces }),
        },
        eventId,
        now,
      });
      if (Result.isSuccess(planned)) {
        const { receipt } = yield* eventSink.commitProjectCommand({
          commandId: command.commandId,
          projectId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
        });
        return receipt;
      }
      return yield* eventSink.commitRejectedProjectCommand({
        commandId: command.commandId,
        projectId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeProjectCommandRejection(planned.failure),
      });
    });
    const lockedByWorkspace =
      workspaceRoot === undefined
        ? planAndCommit
        : workspaceLocks.withLock(workspaceRoot, planAndCommit);
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        touchesRoots
          ? workspaceLocks.withLock(ROOTS_LOCK_KEY, lockedByWorkspace)
          : lockedByWorkspace,
      )
      .pipe(Effect.mapError(dispatchError));
    if (receipt.projectId !== projectId || receipt.commandType !== command.type) {
      return yield* dispatchError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.projectId}.`,
      );
    }
    // Retries re-plan against their own effects; the first receipt determines the outcome.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeProjectCommandRejection(receipt.error));
    switch (rejection?._tag) {
      case "ProjectWorkspaceConflictError":
        return yield* new ProjectConflictError({
          projectId,
          workspaceRoot: rejection.workspaceRoot,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectCommandMissingProjectError":
        return yield* new ProjectNotFoundError({ projectId });
      case "ProjectRootsInvalidError":
      case "ProjectReferencedByWorkspaceError":
        return yield* new ProjectWorkspaceError({ projectId, reason: rejection.message });
      default:
        return yield* dispatchError(
          rejection ?? receipt.error ?? "The command was previously rejected.",
        );
    }
  }, withCommandMetrics);

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* readRow(projectId, { includeDeleted: true });
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project row.",
      });
    }
    return yield* hydrate(row.value);
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* readRow(projectId, options);
      return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* normalizeWorkspaceRoot({ workspaceRoot });
    const row = yield* (
      options?.includeDeleted === true
        ? projects
            .list({ includeDeleted: true })
            .pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(rows.find((row) => row.workspaceRoot === normalized)),
              ),
            )
        : projects.findActiveByWorkspaceRoot(normalized)
    ).pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      if (input.roots !== undefined) return yield* createWorkspace(input, input.roots);
      if (input.workspaceRoot === undefined) {
        return yield* new ProjectWorkspaceError({
          projectId: input.projectId,
          reason: "A project needs a folder or, for a workspace, its repositories.",
        });
      }
      yield* refuseOutsideCheckouts(input.projectId, input.workspaceRoot);
      const workspaceRoot = yield* normalizeWorkspaceRoot({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        createIfMissing: input.createWorkspaceRootIfMissing ?? false,
      });
      yield* commit({
        type: "project.create",
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      });
      yield* projectEnrichment.invalidate([workspaceRoot]);
      return yield* readCommitted(input.projectId);
    },
  );

  const createWorkspace = Effect.fn("ProjectService.createWorkspace")(function* (
    input: ProjectCreateInput,
    roots: ReadonlyArray<ProjectRootInput>,
  ) {
    if (input.workspaceRoot !== undefined) {
      return yield* new ProjectWorkspaceError({
        projectId: input.projectId,
        reason: "A workspace's folder is chosen by the server; leave the folder out.",
      });
    }
    // A retried command finds its committed project instead of claiming a second folder.
    const existing = yield* readRow(input.projectId, { includeDeleted: true });
    if (Option.isSome(existing) && existing.value.roots !== undefined) {
      return yield* hydrate(existing.value);
    }
    yield* requireRepositoryRoots(input.projectId, roots);
    const workspaceRoot = yield* claimWorkspaceFolder(input.projectId, input.title);
    yield* commit({
      type: "project.create",
      commandId: input.commandId,
      projectId: input.projectId,
      title: input.title,
      workspaceRoot,
      roots,
      ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
    }).pipe(
      Effect.onError(() =>
        fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore),
      ),
    );
    return yield* readCommitted(input.projectId);
  });

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* readRow(input.projectId);
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      const previousRoot = existing.value.workspaceRoot;
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? previousRoot
          : yield* normalizeWorkspaceRoot({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
            });
      if (workspaceRoot !== previousRoot) {
        yield* refuseOutsideCheckouts(input.projectId, workspaceRoot);
      }
      if (input.roots !== undefined && existing.value.roots !== undefined) {
        yield* requireRepositoryRoots(input.projectId, input.roots);
      }
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(workspaceRoot === previousRoot ? {} : { workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
        ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
        ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
        ...(input.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        ...(input.roots === undefined ? {} : { roots: input.roots }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      });
      if (workspaceRoot !== previousRoot) {
        yield* projectEnrichment.invalidate([previousRoot, workspaceRoot]);
      }
      return yield* readCommitted(input.projectId);
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteChildThread = Effect.fn("ProjectService.deleteChildThread")(function* (
    input: ProjectDeleteInput,
    threadId: ThreadId,
  ) {
    yield* legacyImporter.ensureTranscript(threadId);
    const projection = yield* threadProjections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
      "checkpoints",
    ]);
    if (projection.thread.deletedAt !== null || projection.thread.projectId !== input.projectId) {
      return;
    }
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`${input.commandId}:delete-thread:${threadId}`),
      threadId,
    };
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* threadProjections.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    const committed = yield* eventSink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
    });
    if (
      committed.receipt.threadId !== command.threadId ||
      committed.receipt.commandType !== command.type
    ) {
      return yield* Effect.fail("The thread deletion command ID belongs to a different command.");
    }
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(
        committed.receipt.error ?? "Thread deletion was previously rejected.",
      );
    }
  });

  const deleteChildThreads = Effect.fn("ProjectService.deleteChildThreads")(function* (
    input: ProjectDeleteInput,
  ) {
    const { projectId } = input;
    const snapshot = yield* threadProjections
      .getShellSnapshot({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads];
    if (projectThreads.length > 0 && input.force !== true) {
      return yield* new ProjectNotEmptyError({ projectId });
    }
    // Delete children durably before the project so a failed cascade can be retried.
    yield* Effect.forEach(
      projectThreads,
      (thread) =>
        threadCommands
          .withLock(thread.id, deleteChildThread(input, thread.id))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  // Best-effort cleanup releases disabled instances kept alive by overrides; crashes have no replay to revisit deletion.
  const clearProjectSettingsOverrides = (projectId: ProjectId) =>
    serverSettings.updateSettings({ projectSettingsOverrides: { [projectId]: null } }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to clear settings overrides for deleted project ${projectId}.`,
          cause,
        ),
      ),
    );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      // Read deleted rows so retries replay receipts and other command ids fail as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      const isFirstDelete = existing.value.deletedAt === null;
      if (isFirstDelete) {
        // Checked before the cascade too, so a refused delete keeps its threads.
        const workspace = (yield* listReferencingWorkspaces(projectId).pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "list-projects", projectId, cause }),
          ),
        )).at(0);
        if (workspace !== undefined) {
          return yield* new ProjectWorkspaceError({
            projectId,
            reason: new ProjectReferencedByWorkspaceError({
              projectId,
              workspaceId: workspace.projectId,
              workspaceTitle: workspace.title,
            }).message,
          });
        }
        yield* deleteChildThreads(input);
      }
      yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
      if (isFirstDelete) {
        yield* clearProjectSettingsOverrides(projectId);
      }
      // Every attempt: a crash after the commit must not leave the mirror until the next start.
      if (Option.isSome(checkpointMirror)) yield* checkpointMirror.value.remove(projectId);
      yield* projectEnrichment.invalidate([existing.value.workspaceRoot]);
      return yield* readCommitted(projectId);
    },
  );

  const enrichShell = (shell: OrchestrationProjectShell) =>
    shell.roots !== undefined
      ? Effect.succeed({
          project: { ...shell, repositoryIdentity: null },
          repositoryIdentityResolved: true,
        })
      : projectEnrichment.getAvailable(shell.workspaceRoot).pipe(
          Effect.map((enrichment) => ({
            project: { ...shell, repositoryIdentity: enrichment.repositoryIdentity },
            repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
          })),
        );

  const enrichShells: ProjectService["Service"]["enrichShells"] = Effect.fn(
    "ProjectService.enrichShells",
  )(function* (shells) {
    const enriched = yield* Effect.forEach(shells, enrichShell, { concurrency: 16 });
    return {
      projects: enriched.map((entry) => entry.project),
      resolvedRepositoryIdentityRoots: enriched
        .filter((entry) => entry.repositoryIdentityResolved)
        .map((entry) => entry.project.workspaceRoot),
    };
  });

  const getShell: ProjectService["Service"]["getShell"] = Effect.fn("ProjectService.getShell")(
    function* (projectId) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      return Option.isNone(shell) ? shell : Option.some((yield* enrichShell(shell.value)).project);
    },
  );

  const getResolvedShell: ProjectService["Service"]["getResolvedShell"] = Effect.fn(
    "ProjectService.getResolvedShell",
  )(function* (projectId) {
    const shell = yield* getShell(projectId);
    if (
      Option.isNone(shell) ||
      shell.value.repositoryIdentity !== null ||
      shell.value.roots !== undefined
    ) {
      return shell;
    }
    const repositoryIdentity = yield* projectEnrichment.readRepositoryIdentity(
      shell.value.workspaceRoot,
    );
    return Option.some({ ...shell.value, repositoryIdentity });
  });

  const listShells: ProjectService["Service"]["listShells"] = Effect.fn(
    "ProjectService.listShells",
  )(function* (options) {
    const shells = yield* projects
      .listShells(options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    return (yield* enrichShells(shells)).projects;
  });

  const listRows = projects
    .list()
    .pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );

  const snapshot = Effect.gen(function* () {
    const rows = yield* listRows;
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  const listPage: ProjectService["Service"]["listPage"] = Effect.fn("ProjectService.listPage")(
    function* ({ cursor, limit }) {
      const rows = (yield* listRows).filter((project) => project.deletedAt === null);
      const projects = yield* Effect.forEach(
        rows.slice(cursor, cursor + limit),
        (row) =>
          hydrate(row).pipe(
            Effect.filterOrElse(
              (project) => project.repositoryIdentity !== null || project.roots !== undefined,
              (project) =>
                projectEnrichment
                  .readRepositoryIdentity(project.workspaceRoot)
                  .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
            ),
          ),
        { concurrency: 8 },
      );
      return { projects, nextCursor: cursor + limit < rows.length ? cursor + limit : null };
    },
  );

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
    listPage,
    getShell,
    getResolvedShell,
    listShells,
    enrichShells,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
