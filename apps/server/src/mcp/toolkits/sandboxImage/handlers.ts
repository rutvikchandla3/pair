import { TeamImageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as TeamImageAuthority from "../../../sandbox/image/TeamImageAuthority.ts";
import * as TeamImageService from "../../../sandbox/image/TeamImageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { SandboxImageToolkit } from "./tools.ts";

const RECENT_BUILDS = 10;
const DEFAULT_LOG_LINES = 100;

/** Who this call changes the image as; checked at each call, after the mode checks. */
const requester = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const authority = yield* TeamImageAuthority.TeamImageAuthority;
  return yield* authority.forCaller(scope);
});

export const layer = McpToolAccess.toLayer(SandboxImageToolkit, {
  t3_team_image_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* TeamImageService.TeamImageService).snapshot;
      const saved = snapshot.recipe;
      const shells =
        saved === null || saved.recipe.projectIds.length === 0
          ? []
          : yield* (yield* ProjectService.ProjectService)
              .listShells({ projectIds: saved.recipe.projectIds })
              .pipe(Effect.mapError(unavailable));
      return {
        recipe:
          saved === null
            ? null
            : {
                revision: saved.revision,
                projects: saved.recipe.projectIds.map((id) => ({
                  id,
                  name: shells.find((shell) => shell.id === id)?.title ?? "(removed project)",
                })),
                buildEnv: saved.recipe.buildEnv,
                buildSecretNames: Object.keys(saved.recipe.buildSecrets),
                install: saved.recipe.install,
                savedBy: saved.savedBy,
              },
        activeBuild:
          snapshot.builds.find((build) => build.id === snapshot.activeBuildId)?.number ?? null,
        builds: snapshot.builds.slice(0, RECENT_BUILDS).map((build) => ({
          build: build.number,
          status: build.status,
          phase: build.phase,
          recipeRevision: build.recipeRevision,
          requestedBy: build.requestedBy,
          ...(build.failure === undefined ? {} : { failure: build.failure }),
          ...(build.manifest === undefined ? {} : { manifest: build.manifest }),
        })),
      };
    }),
  ),
  t3_team_image_build_log: McpToolAccess.reads(({ build, tail, from }) =>
    Effect.gen(function* () {
      const log = yield* (yield* TeamImageService.TeamImageService).readBuildLog(build);
      const lines = log.text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const count = tail ?? DEFAULT_LOG_LINES;
      const start =
        from === undefined ? Math.max(0, lines.length - count) : Math.min(from - 1, lines.length);
      return {
        build,
        status: log.build.status,
        totalLines: lines.length,
        from: start + 1,
        text: lines.slice(start, start + count).join("\n"),
      };
    }),
  ),
  t3_team_image_recipe_update: McpToolAccess.writesEnvironment(({ install, baseRevision }) =>
    Effect.gen(function* () {
      const by = yield* requester;
      const saved = yield* (yield* TeamImageService.TeamImageService).saveInstall({
        by,
        baseRevision,
        install,
      });
      return { revision: saved.revision };
    }),
  ),
  t3_team_image_build_start: McpToolAccess.writesEnvironment(({ recipeRevision }) =>
    Effect.gen(function* () {
      const by = yield* requester;
      const build = yield* (yield* TeamImageService.TeamImageService).startBuild({
        by,
        input: { recipeRevision },
        activateOnSuccess: false,
      });
      return {
        build: build.number,
        note: "It will wait for an admin to activate it on the Team image page.",
      };
    }),
  ),
  t3_team_image_build_cancel: McpToolAccess.writesEnvironment(({ build }) =>
    Effect.gen(function* () {
      const by = yield* requester;
      const service = yield* TeamImageService.TeamImageService;
      // The running build is always among the snapshot's newest.
      const found = (yield* service.snapshot).builds.find(({ number }) => number === build);
      if (found === undefined) {
        return yield* new TeamImageError({
          reason: "not-found",
          message: `Build ${build} is not running.`,
        });
      }
      yield* service.cancelBuild({ by, imageBuildId: found.id });
      return { build, status: "cancelled" as const };
    }),
  ),
  // Anyone's run may propose; an admin reviews it, so no authority is checked.
  t3_team_image_propose: McpToolAccess.actsAsCaller(({ install, reason }) =>
    Effect.gen(function* () {
      const { caller } = yield* loadCaller();
      if (caller?.sandboxId === undefined) {
        return yield* new TeamImageError({
          reason: "not-available",
          message: "Only a cloud session can propose a team image change.",
        });
      }
      yield* (yield* TeamImageService.TeamImageService).fileProposal({
        threadId: caller.id,
        projectId: caller.projectId,
        install,
        reason,
      });
      return { note: "Proposed. An admin will see it in Team image." };
    }),
  ),
});
