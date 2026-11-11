import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

// Pure path rules for managed worktree folders. Kept apart from the settings-reading check in
// worktreesDirectory.ts, so git code that the runner bundles reaches no server settings.

/** Null for filesystem roots or settings not absolute on this host, including synced foreign-platform paths. */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}

/** The folder a branch's worktree gets under `<worktrees dir>/<repo>/`. */
export const worktreeDirectoryName = Effect.fn("worktreeDirectoryName")(function* (branch: string) {
  const directoryName = branch.replace(/\//g, "-");
  // Leave room for files beneath the worktree on Windows, regardless of branch length.
  if (directoryName.length <= 40) return directoryName;
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(branch));
  // Avoid splitting a surrogate pair, which Git would list back as a different path.
  const prefix = directoryName.slice(0, 23).replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}-${Hex.encode(hash).slice(0, 16)}`;
});
