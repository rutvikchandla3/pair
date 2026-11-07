import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";

import type { WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";

const GIT_DIR_SUFFIX = "/.git";

/**
 * Points a script's `T3CODE_*` paths into the sandbox. Clients build `T3CODE_PROJECT_ROOT` from the
 * server's project root, which no sandbox has; the clone is the parent of the worktree's git
 * common dir, asked of git on the host.
 */
export const sandboxScriptEnvironment = Effect.fn("sandboxScriptEnvironment")(function* (
  host: Pick<WorkspaceHost, "spawner">,
  cwd: string,
  runtimeEnv: Readonly<Record<string, string>> | null | undefined,
): Effect.fn.Return<Record<string, string>> {
  const env: Record<string, string> = { ...runtimeEnv, T3CODE_SANDBOX: "1" };
  // A plain terminal, not a script.
  if (env.T3CODE_PROJECT_ROOT === undefined) return env;
  const commonDir = yield* host.spawner
    .string(
      ChildProcess.make("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd,
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ""),
    );
  const root = commonDir.endsWith(GIT_DIR_SUFFIX)
    ? commonDir.slice(0, -GIT_DIR_SUFFIX.length) || "/"
    : (env.T3CODE_WORKTREE_PATH ?? cwd);
  return { ...env, T3CODE_PROJECT_ROOT: root };
});
