import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChiefOfStaffCleanup from "./ChiefOfStaffCleanup.ts";
import * as ProjectService from "./ProjectService.ts";

const shell = (id: string, workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const runWith = (
  shells: (stateDir: string) => ReadonlyArray<OrchestrationProjectShell>,
  options: { readonly failDelete?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const deleted: Array<ProjectService.ProjectDeleteInput> = [];
    let listed = false;
    const exit = yield* ChiefOfStaffCleanup.run().pipe(
      Effect.provide(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () =>
            Effect.sync(() => {
              listed = true;
              return shells(stateDir);
            }),
          delete: (input) =>
            options.failDelete
              ? Effect.fail(new ProjectService.ProjectNotFoundError({ projectId: input.projectId }))
              : Effect.sync(() => {
                  deleted.push(input);
                  return {
                    ...shell(input.projectId, "/deleted"),
                    repositoryIdentity: null,
                    faviconPath: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    projectIcon: null,
                    deletedAt: "2026-11-02T00:00:00.000Z",
                  };
                }),
        }),
      ),
      Effect.exit,
    );
    return { deleted: deleted.map(({ projectId, force }) => [projectId, force]), listed, exit };
  });

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "chief-of-staff-cleanup-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("ChiefOfStaffCleanup", (it) => {
  it.effect("keeps the folder when a delete fails, so the next start retries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const home = path.join(stateDir, "chief-of-staff", "home", "member-1");
      yield* fileSystem.makeDirectory(home, { recursive: true });

      const { exit } = yield* runWith(() => [shell("home", home)], { failDelete: true });

      expect(exit._tag).toBe("Failure");
      expect(yield* fileSystem.exists(home)).toBe(true);
    }),
  );

  it.effect("deletes only projects rooted in the old folder, then the folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const root = path.join(stateDir, "chief-of-staff");
      yield* fileSystem.makeDirectory(path.join(root, "home", "member-1"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(stateDir, "bots", "atlas"), { recursive: true });

      const { deleted } = yield* runWith((dir) => [
        shell("home", path.join(dir, "chief-of-staff", "home", "member-1")),
        shell("bot", path.join(dir, "bots", "atlas")),
        shell("sibling", path.join(dir, "chief-of-staff-notes")),
        shell("repo", "/work/repo"),
      ]);

      expect(deleted).toEqual([["home", true]]);
      expect(yield* fileSystem.exists(root)).toBe(false);
      expect(yield* fileSystem.exists(path.join(stateDir, "bots", "atlas"))).toBe(true);
    }),
  );

  it.effect("reads no projects when the folder is gone", () =>
    Effect.gen(function* () {
      const { deleted, listed } = yield* runWith(() => []);
      expect(listed).toBe(false);
      expect(deleted).toEqual([]);
    }),
  );
});
