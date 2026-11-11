import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectRoot,
  type ProjectRootInput,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly roots?: ReadonlyArray<ProjectRootInput>;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly roots?: ReadonlyArray<ProjectRootInput>;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export class ProjectRootsInvalidError extends Schema.TaggedError<ProjectRootsInvalidError>()(
  "ProjectRootsInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ProjectReferencedByWorkspaceError extends Schema.TaggedError<ProjectReferencedByWorkspaceError>()(
  "ProjectReferencedByWorkspaceError",
  {
    projectId: ProjectId,
    workspaceId: ProjectId,
    workspaceTitle: Schema.String,
  },
) {
  override get message(): string {
    return `This project is a repository in workspace "${this.workspaceTitle}". Remove it from that workspace first.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
  ProjectRootsInvalidError,
  ProjectReferencedByWorkspaceError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  readonly workspaceOwner: ProjectRow | undefined;
  /** Active rows for the projects a create or update names as roots. */
  readonly rootProjects?: ReadonlyArray<ProjectRow>;
  /** Active workspaces with the deleted project among their roots. */
  readonly referencingWorkspaces?: ReadonlyArray<ProjectRow>;
}

const MIN_WORKSPACE_ROOTS = 2;
const MAX_WORKSPACE_ROOTS = 8;
const ROOT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const FALLBACK_ROOT_NAME = "repository";

// Mirrored by defaultWorkspaceRepositoryName in client-runtime, which previews it.
const defaultRootName = (workspaceRoot: string) => {
  const name = (workspaceRoot.split(/[\\/]+/).findLast((segment) => segment.length > 0) ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" || name === "." || name === ".." ? FALLBACK_ROOT_NAME : name;
};

/** Resolves default names and checks the v1 workspace rules; I/O checks stay in ProjectService. */
function resolveProjectRoots(input: {
  readonly workspaceId: ProjectId;
  readonly roots: ReadonlyArray<ProjectRootInput>;
  readonly rootProjects: ReadonlyArray<ProjectRow>;
}): Result.Result<ReadonlyArray<ProjectRoot>, ProjectRootsInvalidError> {
  const invalid = (detail: string) => Result.fail(new ProjectRootsInvalidError({ detail }));
  if (input.roots.length < MIN_WORKSPACE_ROOTS || input.roots.length > MAX_WORKSPACE_ROOTS) {
    return invalid(
      `A workspace needs ${MIN_WORKSPACE_ROOTS} to ${MAX_WORKSPACE_ROOTS} repositories (got ${input.roots.length}).`,
    );
  }
  const rows = new Map(
    input.rootProjects
      .filter((row) => row.deletedAt === null)
      .map((row) => [row.projectId, row] as const),
  );
  const projectIds = new Set<ProjectId>();
  const names = new Set<string>();
  const resolved: Array<ProjectRoot> = [];
  for (const root of input.roots) {
    if (root.projectId === input.workspaceId) return invalid("A workspace cannot contain itself.");
    if (projectIds.has(root.projectId)) {
      return invalid("Each project can appear only once in a workspace.");
    }
    projectIds.add(root.projectId);
    const row = rows.get(root.projectId);
    if (row === undefined) return invalid(`Project ${root.projectId} was not found.`);
    if (row.roots !== undefined) {
      return invalid(`"${row.title}" is a workspace, so it cannot be a repository in another.`);
    }
    const name = root.name ?? defaultRootName(row.workspaceRoot);
    if (!ROOT_NAME_PATTERN.test(name) || name === "." || name === "..") {
      return invalid(
        `Folder name "${name}" for "${row.title}" may use only letters, digits, ".", "_" and "-".`,
      );
    }
    const key = name.toLowerCase();
    if (names.has(key)) return invalid(`Two repositories use the folder name "${name}".`);
    names.add(key);
    resolved.push({ projectId: root.projectId, name });
  }
  return Result.succeed(resolved);
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/** Read state and commit the planned event under the project lock. */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      let roots: ReadonlyArray<ProjectRoot> | undefined;
      if (command.roots !== undefined) {
        const resolved = resolveProjectRoots({
          workspaceId: command.projectId,
          roots: command.roots,
          rootProjects: state.rootProjects ?? [],
        });
        if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
        roots = resolved.success;
      }
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          ...(roots === undefined ? {} : { roots }),
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Allow editing or removing persisted invalid script ids, while rejecting new invalid ids.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        if (project.roots !== undefined) {
          return Result.fail(
            new ProjectRootsInvalidError({ detail: "A workspace's folder cannot be moved." }),
          );
        }
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      let roots: ReadonlyArray<ProjectRoot> | undefined;
      if (command.roots !== undefined) {
        if (project.roots === undefined) {
          return Result.fail(
            new ProjectRootsInvalidError({
              detail: "Only a workspace's repositories can be changed.",
            }),
          );
        }
        const resolved = resolveProjectRoots({
          workspaceId: command.projectId,
          roots: command.roots,
          rootProjects: state.rootProjects ?? [],
        });
        if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
        roots = resolved.success;
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          ...(roots === undefined ? {} : { roots }),
          // Repeating a pin or archive keeps the original time.
          ...(command.pinned === undefined
            ? {}
            : { pinnedAt: command.pinned ? (project.pinnedAt ?? occurredAt) : null }),
          ...(command.archived === undefined
            ? {}
            : { archivedAt: command.archived ? (project.archivedAt ?? occurredAt) : null }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      const workspace = state.referencingWorkspaces?.find(
        (row) =>
          row.deletedAt === null && row.roots?.some((root) => root.projectId === command.projectId),
      );
      if (workspace !== undefined) {
        return Result.fail(
          new ProjectReferencedByWorkspaceError({
            projectId: command.projectId,
            workspaceId: workspace.projectId,
            workspaceTitle: workspace.title,
          }),
        );
      }
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
