import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * Chief of staff is gone, but installs that used it keep its project, home thread and state
 * folder. Delete the projects rooted in that folder, then the folder; nothing recreates it.
 */
export const run = Effect.fn("ChiefOfStaffCleanup.run")(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, "chief-of-staff");
  if (!(yield* fileSystem.exists(root))) return;

  const projects = yield* ProjectService.ProjectService;
  const shells = yield* projects.listShells();
  // A failed delete stops here, so the folder stays and the next start retries.
  yield* Effect.forEach(
    shells.filter((shell) => shell.workspaceRoot.startsWith(root + path.sep)),
    (shell) =>
      projects.delete({
        commandId: CommandId.make(`server:chief-of-staff-cleanup:${shell.id}`),
        projectId: shell.id,
        force: true,
      }),
    { discard: true },
  );
  yield* fileSystem.remove(root, { recursive: true });
});
