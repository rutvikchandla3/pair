import { trackedFoldersRefusal, type TrackedFoldersHostKind } from "@t3tools/contracts";

import { sandboxOfPath } from "../workspaceHost/WorkspaceHosts.ts";

/** Where a request about a path's tracked folders lands. Only "local" can read what they name. */
export const trackedFoldersHostKind = (cloudOnly: boolean, path: string): TrackedFoldersHostKind =>
  cloudOnly ? "cloud-only" : sandboxOfPath(path) === "local" ? "local" : "sandbox";

/** Why tracked folders are refused for `path` on this server, or undefined. */
export const trackedFoldersRefusalAt = (
  cloudOnly: boolean,
  path: string,
  project: { readonly roots?: ReadonlyArray<unknown> | undefined } = {},
): string | undefined => trackedFoldersRefusal(project, trackedFoldersHostKind(cloudOnly, path));
