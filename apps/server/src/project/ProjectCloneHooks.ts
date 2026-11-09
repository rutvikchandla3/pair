import { CommandId, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { ProjectCloneHooks } from "./ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

/** Registers a tracked clone's project before git runs and refreshes it once git is done. */
export const makeProjectCloneHooks = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
  return {
    createProject: (project) =>
      projectService
        .create({
          commandId: CommandId.make(`project-clone-create:${project.projectId}`),
          projectId: project.projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          createWorkspaceRootIfMissing: true,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to create clone project.",
                cause,
              }),
          ),
        ),
    onCloned: (project) =>
      repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
        Effect.andThen(
          projectService.update({
            commandId: CommandId.make(`project-clone-done:${project.projectId}`),
            projectId: project.projectId,
          }),
        ),
        Effect.andThen(refreshGitStatus(project.workspaceRoot)),
        // The folder was empty when the project was created, so the cached
        // enrichment says "no repository" and clients cannot group it yet.
        Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
        Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
        Effect.ignoreCause({ log: true }),
      ),
  } satisfies ProjectCloneHooks;
});
