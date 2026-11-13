import {
  type MemberId,
  type ProjectId,
  SPACE_MAX_REPOSITORIES,
  SpaceError,
  type SpaceWorkspacePreview,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";

export interface SpaceWorkspaceInput {
  readonly repositoryIds: ReadonlyArray<ProjectId>;
  readonly spaceName: string;
  readonly workspaceName?: string | undefined;
}

/**
 * Where a space's threads run (spaces.md "Repositories"): its one repository, a workspace with
 * exactly its repositories, or a new workspace. A workspace it reuses is never edited.
 */
export class SpaceWorkspaces extends Context.Service<
  SpaceWorkspaces,
  {
    readonly preview: (
      input: SpaceWorkspaceInput,
    ) => Effect.Effect<SpaceWorkspacePreview, SpaceError>;
    /** Re-runs the rule at write time, creating the workspace when none matches. */
    readonly resolve: (
      input: SpaceWorkspaceInput & { readonly actorId: MemberId },
    ) => Effect.Effect<{ readonly projectId: ProjectId; readonly created: boolean }, SpaceError>;
  }
>()("t3/space/SpaceWorkspaces") {}

const failed = (cause: unknown) =>
  new SpaceError({
    reason: "failed",
    message: cause instanceof Error ? cause.message : String(cause),
  });

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((id) => b.has(id));
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;

  const lastUsed = (projectId: ProjectId) =>
    sql<{ readonly at: string | null }>`
      SELECT MAX(updated_at) AS at FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((rows) => rows[0]?.at ?? null),
      Effect.mapError(failed),
    );

  const plan = Effect.fn("SpaceWorkspaces.plan")(function* (input: SpaceWorkspaceInput) {
    const repositoryIds = [...new Set(input.repositoryIds)];
    if (repositoryIds.length === 0) {
      return yield* new SpaceError({ reason: "not-allowed", message: "Pick a repository." });
    }
    if (repositoryIds.length > SPACE_MAX_REPOSITORIES) {
      return yield* new SpaceError({
        reason: "too-many-repositories",
        message: `A space has at most ${SPACE_MAX_REPOSITORIES} repositories.`,
      });
    }
    for (const id of repositoryIds) {
      const project = Option.getOrNull(yield* projects.getById(id).pipe(Effect.mapError(failed)));
      if (project === null || project.deletedAt !== null) {
        return yield* new SpaceError({ reason: "not-found", message: `No repository ${id}.` });
      }
      if (project.roots !== undefined) {
        return yield* new SpaceError({
          reason: "not-allowed",
          message: `${project.title} is a workspace; pick its repositories instead.`,
        });
      }
    }
    if (repositoryIds.length === 1) {
      const project = Option.getOrThrow(
        yield* projects.getById(repositoryIds[0]!).pipe(Effect.mapError(failed)),
      );
      return { type: "project" as const, projectId: project.id, title: project.title };
    }
    const shells = yield* projects.listShells().pipe(Effect.mapError(failed));
    const candidates = shells.filter(
      (shell) =>
        shell.roots !== undefined &&
        shell.archivedAt == null &&
        sameSet(
          shell.roots.map((root) => root.projectId),
          repositoryIds,
        ),
    );
    const named = candidates.find(
      (shell) => shell.title.toLowerCase() === input.spaceName.trim().toLowerCase(),
    );
    if (named !== undefined) {
      return { type: "reuse" as const, projectId: named.id, title: named.title };
    }
    if (candidates.length > 0) {
      const ranked = yield* Effect.forEach(candidates, (shell) =>
        Effect.map(lastUsed(shell.id), (at) => ({ shell, at: at ?? shell.updatedAt })),
      );
      const best = ranked.toSorted((left, right) => (left.at < right.at ? 1 : -1))[0]!.shell;
      return { type: "reuse" as const, projectId: best.id, title: best.title };
    }
    const wanted = (input.workspaceName ?? input.spaceName).trim();
    const titles = new Set(shells.map((shell) => shell.title.toLowerCase()));
    let title = wanted;
    for (let suffix = 2; titles.has(title.toLowerCase()); suffix++) title = `${wanted} ${suffix}`;
    return { type: "create" as const, title, repositoryIds };
  });

  const preview: SpaceWorkspaces["Service"]["preview"] = Effect.fn("SpaceWorkspaces.preview")(
    function* (input) {
      const planned = yield* plan(input);
      return planned.type === "create"
        ? { type: "create" as const, title: planned.title }
        : planned;
    },
  );

  const resolve: SpaceWorkspaces["Service"]["resolve"] = Effect.fn("SpaceWorkspaces.resolve")(
    function* (input) {
      const planned = yield* plan(input);
      if (planned.type !== "create") return { projectId: planned.projectId, created: false };
      const projectId = yield* ids.allocate
        .project({ fixtureName: "space-workspace" })
        .pipe(Effect.mapError(failed));
      const commandId = yield* ids.allocate
        .command({ fixtureName: "space", commandName: "workspace.create" })
        .pipe(Effect.mapError(failed));
      const project = yield* projects
        .create({
          commandId,
          projectId,
          title: planned.title,
          roots: planned.repositoryIds.map((id) => ({ projectId: id })),
        })
        .pipe(Effect.mapError(failed));
      return { projectId: project.id, created: true };
    },
  );

  return SpaceWorkspaces.of({ preview, resolve });
});

export const layer = Layer.effect(SpaceWorkspaces, make);
