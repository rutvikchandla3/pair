import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LocalWorkspaceHost from "./LocalWorkspaceHost.ts";
import {
  SANDBOX_ROOT,
  type WorkspaceHost,
  WorkspaceHostUnavailableError,
} from "./WorkspaceHost.ts";

export class WorkspaceHosts extends Context.Service<
  WorkspaceHosts,
  {
    readonly local: WorkspaceHost;
    /** Takes an absolute path from a cwd, worktree or project root; it is not normalized. */
    readonly forPath: (path: string) => Effect.Effect<WorkspaceHost, WorkspaceHostUnavailableError>;
  }
>()("t3/workspaceHost/WorkspaceHosts") {}

export const make = Effect.gen(function* () {
  const local = yield* LocalWorkspaceHost.make;
  const succeedLocal = Effect.succeed(local);
  // Untraced and allocation-free on the local path: every workspace operation resolves here.
  const forPath = (path: string) => {
    // Fail closed: a path under the reserved root never falls back to local disk.
    if (path !== SANDBOX_ROOT && !path.startsWith(`${SANDBOX_ROOT}/`)) return succeedLocal;
    return Effect.fail(new WorkspaceHostUnavailableError({ sandboxId: path.split("/")[2] ?? "" }));
  };
  return WorkspaceHosts.of({ local, forPath });
});

export const layer = Layer.effect(WorkspaceHosts, make);
