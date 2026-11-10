// @effect-diagnostics nodeBuiltinImport:off -- sandbox paths are POSIX on every server.
import * as NodePath from "node:path";

import type { SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as LocalWorkspaceHost from "./LocalWorkspaceHost.ts";
import {
  SANDBOX_ROOT,
  sandboxIdFromPath,
  type WorkspaceHost,
  WorkspaceHostUnavailableError,
} from "./WorkspaceHost.ts";

export class WorkspaceHosts extends Context.Service<
  WorkspaceHosts,
  {
    readonly local: WorkspaceHost;
    /** Takes an absolute path from a cwd, worktree or project root; `..` collapses first. */
    readonly forPath: (path: string) => Effect.Effect<WorkspaceHost, WorkspaceHostUnavailableError>;
    /**
     * Routes `root` and everything under it to `host` until the scope closes. `RunnerHub`
     * registers `/t3-sandbox/<id>` per runner boot; tests register any absolute root.
     */
    readonly register: (
      root: string,
      host: WorkspaceHost,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/workspaceHost/WorkspaceHosts") {}

const isUnder = (path: string, root: string) =>
  path === root || (path.startsWith(root) && path[root.length] === "/");

// Only a path with `.` or empty segments can resolve somewhere its prefix does not say.
const normalize = (path: string) =>
  path.startsWith("/") && (path.includes("/.") || path.includes("//"))
    ? NodePath.posix.resolve(path)
    : path;

/**
 * The machine `forPath` sends a path to: "local" off the sandbox root, else its sandbox, or
 * undefined when the path names none (which `forPath` refuses).
 */
export const sandboxOfPath = (raw: string): SandboxId | "local" | undefined => {
  const path = normalize(raw);
  return isUnder(path, SANDBOX_ROOT) ? sandboxIdFromPath(path) : "local";
};

export const make = Effect.gen(function* () {
  const local = yield* LocalWorkspaceHost.make;
  const succeedLocal = Effect.succeed(local);
  const roots = new Map<string, WorkspaceHost>();
  // Roots outside the reserved root exist only in tests; without them local paths skip the map.
  let outsideRoots = 0;

  // Untraced and allocation-free on the local path: every workspace operation resolves here.
  // @effect-diagnostics-next-line effectFnOpportunity:off
  const forPath = (raw: string) => {
    const path = normalize(raw);
    const reserved = isUnder(path, SANDBOX_ROOT);
    if (!reserved && outsideRoots === 0) return succeedLocal;
    let match: string | undefined;
    for (const root of roots.keys()) {
      if (isUnder(path, root) && (match === undefined || root.length > match.length)) match = root;
    }
    if (match !== undefined) return Effect.succeed(roots.get(match)!);
    // Fail closed: a path under the reserved root never falls back to local disk.
    if (!reserved) return succeedLocal;
    const sandboxId = sandboxIdFromPath(path);
    return Effect.fail(
      new WorkspaceHostUnavailableError(sandboxId === undefined ? {} : { sandboxId }),
    );
  };

  const register: WorkspaceHosts["Service"]["register"] = (root, host) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const key = NodePath.posix.resolve(root);
        if (!roots.has(key) && !isUnder(key, SANDBOX_ROOT)) outsideRoots += 1;
        roots.set(key, host);
        return key;
      }),
      // A newer registration of the same root (the next runner boot) stays.
      (key) =>
        Effect.sync(() => {
          if (roots.get(key) !== host) return;
          roots.delete(key);
          if (!isUnder(key, SANDBOX_ROOT)) outsideRoots -= 1;
        }),
    ).pipe(Effect.asVoid);

  return WorkspaceHosts.of({ local, forPath, register });
});

export const layer = Layer.effect(WorkspaceHosts, make);

/**
 * Every path is local, the reserved root included. Only for the runner: inside a sandbox its
 * `/t3-sandbox/<id>/` is local disk, and nothing registers there.
 */
export const layerLocalOnly = Layer.effect(
  WorkspaceHosts,
  Effect.gen(function* () {
    const local = yield* LocalWorkspaceHost.make;
    // Untraced, as in `make`: every workspace operation resolves here.
    return WorkspaceHosts.of({
      local,
      forPath: Effect.fnUntraced(function* () {
        return local;
      }),
      // @effect-diagnostics-next-line effectFnOpportunity:off
      register: () => Effect.void,
    });
  }),
);
