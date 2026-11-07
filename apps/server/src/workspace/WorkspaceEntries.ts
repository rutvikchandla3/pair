import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  ProjectEntriesFailure,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as StoppedSandboxReads from "../sandbox/mirror/StoppedSandboxReads.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type {
  CoarseOperationError,
  CoarseOperations,
  WorkspaceHost,
  WorkspaceHostFileError,
  WorkspaceHostUnavailableError,
} from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get pathMissing(): boolean {
    return (this.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }

  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

/** The failure category a client sees for each error; the runner maps its errors with it too. */
export function entriesFailureContext(error: WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      throw new Error(`Unhandled workspace entries error: ${String(error satisfies never)}`);
  }
}

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** Children classified at once when listing a folder; each symlink costs a realpath and a stat. */
const SYMLINK_RESOLVE_BATCH_SIZE = 64;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
  host: WorkspaceHost,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const { platform, homeDirectory } = yield* host.info;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, homeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, homeDirectory), input.partialPath);
});

/** A coarse operation's failure as the error the local path would give, so clients see one category. */
const coarseEntriesError = (
  cwd: string,
  error: CoarseOperationError,
  query?: { readonly length: number; readonly limit: number },
): WorkspaceEntriesError => {
  const root = { workspaceRoot: cwd, normalizedWorkspaceRoot: cwd };
  switch (error._tag === "RunnerOpsError" ? error.failure : "failed") {
    case "workspace_root_not_found":
      return new WorkspacePaths.WorkspaceRootNotExistsError(root);
    case "workspace_root_create_failed":
      return new WorkspacePaths.WorkspaceRootCreateFailedError({ ...root, cause: error });
    case "workspace_root_stat_failed":
      return new WorkspacePaths.WorkspaceRootStatFailedError({
        ...root,
        phase: "validate-existing",
        cause: error,
      });
    case "workspace_root_not_directory":
      return new WorkspacePaths.WorkspaceRootNotDirectoryError(root);
    case "search_index_create_failed":
      return new WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "in the sandbox",
        cause: error,
      });
    case "search_index_scan_timed_out":
      return new WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut({
        cwd,
        timeout: "in the sandbox",
      });
    case "search_index_search_failed":
      if (query !== undefined) {
        return new WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize: query.limit,
          reason: "in the sandbox",
          cause: error,
        });
      }
  }
  return new WorkspaceEntriesReadDirectoryError({
    cwd,
    partialPath: cwd,
    parentPath: cwd,
    cause: error,
  });
};

/** @public */
export const make = Effect.gen(function* () {
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  // Absent inside the runner, where every path is local.
  const stopped = yield* Effect.serviceOption(StoppedSandboxReads.StoppedSandboxReads);

  /**
   * Only a /t3-sandbox/ path fails `forPath`: its machine is stopped (or not connected), so the read
   * comes from the mirror's latest checkpoint. With none synced yet it is empty, never an error.
   */
  const readStopped = <A, E>(
    cwd: string,
    error: WorkspaceHostUnavailableError,
    empty: A,
    unavailable: () => E,
    read: (
      reads: StoppedSandboxReads.StoppedSandboxReads["Service"],
      view: StoppedSandboxReads.StoppedView,
    ) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Option.isNone(stopped) || error.sandboxId === undefined
      ? Effect.fail(unavailable())
      : stopped.value.viewFor(cwd, error.sandboxId).pipe(
          Effect.flatMap((view) => read(stopped.value, view)),
          Effect.catchTags({ SandboxAsleep: () => Effect.succeed(empty) }),
        );

  const unavailableEntriesError = (cwd: string, cause: unknown) => () =>
    new WorkspaceEntriesReadDirectoryError({ cwd, partialPath: cwd, parentPath: cwd, cause });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  // Fails closed before the native search index scans a folder on the wrong machine.
  const hostForRoot = (cwd: string, normalizedCwd: string) =>
    hosts.forPath(normalizedCwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: cwd,
            parentPath: normalizedCwd,
            cause,
          }),
      ),
    );

  // A sandbox host runs the whole call on its own disk (02 §5).
  const coarseFor = (cwd: string) =>
    hosts
      .forPath(path.resolve(cwd))
      .pipe(Effect.map((host): CoarseOperations | undefined => host.invoke));

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      // A stopped machine's files can't change, and its checkpoint has no index to refresh.
      const coarse = yield* coarseFor(cwd).pipe(Effect.orElseSucceed(() => null));
      if (coarse === null) return;
      if (coarse !== undefined) return yield* coarse.refreshSearch(cwd);
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
          function* (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          },
        );
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      // Without a project, browsing picks a project root, and those live on the server.
      const host =
        input.cwd === undefined ? hosts.local : yield* hosts.forPath(path.resolve(input.cwd));
      const resolvedInputPath = yield* resolveBrowseTarget(input, path, host);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* host.files.readDirectory(parentPath).pipe(
        Effect.catchIf(
          (error) => error.code === "EACCES" || error.code === "EPERM",
          () => Effect.succeed([]),
        ),
        Effect.mapError(
          (cause) =>
            new WorkspaceEntriesReadDirectoryError({
              cwd: input.cwd,
              partialPath: input.partialPath,
              parentPath,
              cause,
            }),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.kind === "Directory" &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({
          WorkspaceHostUnavailableError: (error) =>
            readStopped(
              input.cwd ?? input.partialPath,
              error,
              { parentPath: input.partialPath, entries: [] },
              () =>
                new WorkspaceEntriesReadDirectoryError({
                  cwd: input.cwd,
                  partialPath: input.partialPath,
                  parentPath: input.partialPath,
                  cause: error,
                }),
              (reads, view) => reads.browse(view, input),
            ),
        }),
      ),
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const coarse = yield* coarseFor(input.cwd);
      if (coarse !== undefined) {
        return yield* coarse.searchEntries(input).pipe(
          Effect.mapError((error) =>
            coarseEntriesError(input.cwd, error, {
              length: input.query.length,
              limit: input.limit,
            }),
          ),
        );
      }
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      yield* hostForRoot(input.cwd, normalizedCwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({
          WorkspaceHostUnavailableError: (error) =>
            readStopped(
              input.cwd,
              error,
              { entries: [], truncated: false },
              unavailableEntriesError(input.cwd, error),
              (reads, view) => reads.search(view, input),
            ),
        }),
      ),
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(
    function* (input) {
      const coarse = yield* coarseFor(input.cwd);
      if (coarse !== undefined) {
        return yield* coarse.searchContents(input).pipe(
          Effect.mapError((error) =>
            coarseEntriesError(input.cwd, error, {
              length: input.query.length,
              limit: input.limit,
            }),
          ),
        );
      }
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      yield* hostForRoot(input.cwd, normalizedCwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.searchContents(input);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
          ),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({
          WorkspaceHostUnavailableError: (error) =>
            readStopped(
              input.cwd,
              error,
              { matches: [], truncated: false },
              unavailableEntriesError(input.cwd, error),
              (reads, view) => reads.searchContents(view, input),
            ),
        }),
      ),
  );

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const coarse = yield* coarseFor(input.cwd);
      if (coarse !== undefined) {
        return yield* coarse
          .listEntries(input)
          .pipe(Effect.mapError((error) => coarseEntriesError(input.cwd, error)));
      }
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const host = yield* hostForRoot(input.cwd, normalizedCwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink, nestedGitRoots } = yield* Effect.gen(function* () {
          const root = yield* host.files.realPath(normalizedCwd);
          const directory = yield* host.files.realPath(target.absolutePath);
          const relative = path.relative(root, directory);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative) ||
            relative.split(path.sep).includes(".git") ||
            target.relativePath.split("/").includes(".git")
          ) {
            return yield* toError(
              new Error("Directory must be inside the workspace and outside .git."),
            );
          }
          const children = yield* host.files.readDirectory(directory);
          const isSameOrInside = (parent: string, child: string) => {
            const relativeChild = path.relative(parent, child);
            return (
              relativeChild !== ".." &&
              !relativeChild.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relativeChild)
            );
          };
          // Reject canonical ancestors so "Expand all folders" cannot follow a cycle.
          const loadVisitedFolders = yield* Effect.cached(
            Effect.gen(function* () {
              const folders = [root];
              let current = normalizedCwd;
              for (const segment of target.relativePath.split("/").filter(Boolean)) {
                current = path.join(current, segment);
                folders.push(yield* host.files.realPath(current));
              }
              return folders;
            }),
          );
          const resolveSymlinkKind = Effect.fnUntraced(function* (name: string) {
            const resolved = yield* host.files
              .realPath(path.join(directory, name))
              .pipe(Effect.orElseSucceed(() => undefined));
            if (
              resolved === undefined ||
              !isSameOrInside(root, resolved) ||
              path.relative(root, resolved).split(path.sep).includes(".git")
            ) {
              return undefined;
            }
            const stat = yield* host.fileSystem
              .stat(resolved)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (stat?.type === "File") return "file" as const;
            if (stat?.type !== "Directory") return undefined;
            const folders = yield* loadVisitedFolders;
            return folders.some((folder) => isSameOrInside(resolved, folder))
              ? undefined
              : ("directory" as const);
          });
          // Bound filesystem work for directories such as pnpm node_modules.
          const kinds = yield* Effect.forEach(
            children,
            (child): Effect.Effect<ProjectEntry["kind"] | undefined, WorkspaceHostFileError> => {
              if (child.name === ".git") return Effect.undefined;
              if (child.kind === "Directory") return Effect.succeed("directory");
              if (child.kind === "File") return Effect.succeed("file");
              return child.kind === "SymbolicLink"
                ? resolveSymlinkKind(child.name)
                : Effect.undefined;
            },
            { concurrency: SYMLINK_RESOLVE_BATCH_SIZE },
          );
          const nestedGitRoots: Array<string> = [];
          const segments = target.relativePath.split("/").filter(Boolean);
          for (let index = 1; index <= segments.length; index += 1) {
            const candidate = segments.slice(0, index).join("/");
            const dotGit = yield* Effect.result(
              host.files.lstat(path.join(normalizedCwd, candidate, ".git")),
            );
            if (Result.isSuccess(dotGit)) nestedGitRoots.push(candidate);
          }
          return {
            nestedGitRoots,
            entries: children.flatMap((child, index): ProjectEntry[] => {
              const kind = kinds[index];
              if (kind === undefined) return [];
              return [
                {
                  path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                  kind,
                },
              ];
            }),
            // Git refuses to classify paths beyond a symbolic link.
            throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
          };
        }).pipe(
          Effect.catchTags({ WorkspaceHostFileError: (cause) => Effect.fail(toError(cause)) }),
        );
        let gitRoot = "";
        let gitPrefix = "";
        // stdin avoids argument limits; ignore classification is optional without git/repositories.
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: path.join(normalizedCwd, gitRoot),
              stdin: `${paths.map((entryPath) => entryPath.slice(gitPrefix.length)).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Git refuses paths inside a submodule (128) but still answers for nested clones.
        for (const nestedGitRoot of nestedGitRoots) {
          if ((yield* checkIgnore([`${nestedGitRoot}/.git`]))?.exitCode !== 128) continue;
          gitRoot = nestedGitRoot;
          gitPrefix = `${gitRoot}/`;
        }
        const directoryGitPath = target.relativePath.slice(gitPrefix.length);
        // Check ignored folders once to avoid child index lookups; exit 0 guarantees no tracked descendants.
        // Symlinks and pathspec magic still need per-child checks.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          directoryGitPath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(directoryGitPath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(gitPrefix + ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({
          WorkspaceHostUnavailableError: (error) =>
            readStopped(
              input.cwd,
              error,
              { entries: [], truncated: false },
              unavailableEntriesError(input.cwd, error),
              (reads, view) => reads.list(view, input),
            ),
        }),
      ),
  );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    // A stopped machine's checkpoint follows .gitignore, so it holds no ignored files.
    const reachable = yield* hosts.forPath(path.resolve(input.cwd)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!reachable) return { files: [], truncated: false };
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    const host = yield* hostForRoot(input.cwd, normalizedCwd);
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    const paths = result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .toSorted();
    const files = yield* Effect.forEach(
      paths.slice(0, IGNORED_FILES_LIMIT),
      (relativePath) =>
        // lstat: a symlink usually points outside the workspace, where reads refuse to go.
        host.fileSystem.lstat(path.join(normalizedCwd, relativePath)).pipe(
          Effect.map((stat) =>
            stat.type === "File" ? { path: relativePath, byteLength: Number(stat.size) } : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: "unbounded" },
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({ browse, list, listIgnoredFiles, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
