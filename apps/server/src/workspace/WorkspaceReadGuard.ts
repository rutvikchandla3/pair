import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CloudOnlyRefusedError } from "@t3tools/contracts";

// Only the tag and the no-op layer: the runner builds WorkspaceEntries, and the server layer
// (KnownWorkspaces.layerReadGuard) pulls in the database, which its bundle must never carry.

export class WorkspaceReadGuard extends Context.Service<
  WorkspaceReadGuard,
  {
    /**
     * On a cloud-only server, fails unless `path` on the server's own disk resolves, symlinks
     * included, inside a known workspace. Sandbox paths pass: they read inside the machine or
     * from its mirror.
     */
    readonly confine: (
      operation: string,
      path: string,
    ) => Effect.Effect<void, CloudOnlyRefusedError>;
  }
>()("t3/workspace/WorkspaceReadGuard") {}

/** Inside the runner every path is the machine's own disk. */
export const layerUnconfined = Layer.succeed(
  WorkspaceReadGuard,
  WorkspaceReadGuard.of({ confine: Effect.fnUntraced(function* () {}) }),
);
