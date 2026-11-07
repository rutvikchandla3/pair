import type {
  SandboxAsleep,
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { makeIsServerInternalPath } from "./serverInternalPaths.ts";
import * as StoppedSandboxReads from "../sandbox/mirror/StoppedSandboxReads.ts";
import type {
  WorkspaceHost,
  WorkspaceHostUnavailableError,
} from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

export const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /** Writes inside a known workspace only; a stopped machine refuses with SandboxAsleep. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
      | SandboxAsleep
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public */
export const make = Effect.gen(function* () {
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  // Absent inside the runner, where every path is local.
  const stopped = yield* Effect.serviceOption(StoppedSandboxReads.StoppedSandboxReads);

  // Only a /t3-sandbox/ path fails here: its machine is stopped or not connected.
  const hostForCwd = (cwd: string) => hosts.forPath(path.resolve(cwd));
  const unknownWorkspace = (cwd: string, cause: WorkspaceHostUnavailableError) =>
    new KnownWorkspaces.UnknownWorkspaceError({ cwd, cause });

  const readStopped = (
    input: ProjectReadFileInput,
    error: WorkspaceHostUnavailableError,
  ): Effect.Effect<
    ProjectReadFileResult,
    | WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError
  > => {
    if (Option.isNone(stopped) || error.sandboxId === undefined) {
      return Effect.fail(unknownWorkspace(input.cwd, error));
    }
    const reads = stopped.value;
    return reads.viewFor(input.cwd, error.sandboxId).pipe(
      Effect.flatMap((view) => reads.readFile(view, input)),
      // No checkpoint synced yet: an empty file the client labels, not an error.
      Effect.catchTags({
        SandboxAsleep: () =>
          Effect.succeed({
            relativePath: input.relativePath.trim(),
            contents: "",
            byteLength: 0,
            truncated: false,
            exists: false,
          }),
      }),
    );
  };

  const operationError =
    (
      input: { readonly cwd: string; readonly relativePath: string },
      resolvedPath: string,
      operationPath: string,
      operation: WorkspaceFileSystemOperationError["operation"],
    ) =>
    (cause: unknown) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath,
        operationPath,
        operation,
        cause,
      });

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    // These paths carry no cwd: `~/` is the server's home, and each path resolves its own host.
    const expandedPath = expandHomePath(requestedPath, (yield* hosts.local.info).homeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const host = yield* hosts.forPath(expandedPath).pipe(Effect.option);
    if (host._tag === "None") return null;
    const stat = yield* host.value.fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* host.value.files.readFile(expandedPath, 512).pipe(
        Effect.map((header) =>
          header.kind === "file" ? fileHeaderMimeType(header.bytes) : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
  const isInGitFolder = Effect.fnUntraced(function* (host: WorkspaceHost, absolutePath: string) {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = yield* Effect.forEach(
        ["HEAD", "commondir", "objects", "refs", ".git"],
        (name) =>
          host.files.lstat(path.join(folder, name)).pipe(
            // Any other failure leaves the folder unknown, so the write is refused.
            Effect.catchIf(
              (error) => error.code === "ENOENT" || error.code === "ENOTDIR",
              () => Effect.succeed(null),
            ),
          ),
        { concurrency: "unbounded" },
      );
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.kind === "File" || path.dirname(folder) === folder) return false;
    }
  });

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
    host: WorkspaceHost,
  ) {
    const requestedPath = input.relativePath.trim();
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, (yield* host.info).homeDirectory)
      : requestedPath;
    if (
      isNetworkPath(hostPath) &&
      !WorkspacePaths.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* host.files.realPath(absolutePath).pipe(
        Effect.catchIf(
          (error) => input.allowMissing === true && error.code === "ENOENT",
          () => Effect.succeed(null),
        ),
        Effect.mapError(operationError(input, absolutePath, absolutePath, "realpath-target")),
      );
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* host.files
      .realPath(path.resolve(input.cwd))
      .pipe(
        Effect.mapError(
          operationError(input, target.absolutePath, input.cwd, "realpath-workspace-root"),
        ),
      );
    const resolved = yield* Effect.gen(function* () {
      let candidate = target.absolutePath;
      for (;;) {
        const real = yield* Effect.result(host.files.realPath(candidate));
        if (Result.isSuccess(real)) {
          return {
            realTargetPath: path.join(real.success, path.relative(candidate, target.absolutePath)),
            exists: candidate === target.absolutePath,
          };
        }
        if (!input.allowMissing || real.failure.code !== "ENOENT") return yield* real.failure;
        // Like writes, missing reads must check the nearest existing ancestor.
        // An existing entry that cannot resolve is a dangling link, not absence.
        const exists = yield* host.files.lstat(candidate).pipe(
          Effect.as(true),
          Effect.catchIf(
            (cause) => cause.code === "ENOENT",
            () => Effect.succeed(false),
          ),
        );
        if (exists || path.dirname(candidate) === candidate) return yield* real.failure;
        candidate = path.dirname(candidate);
      }
    }).pipe(
      Effect.mapError(
        operationError(input, target.absolutePath, target.absolutePath, "realpath-target"),
      ),
    );
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(
    function* (input) {
      const host = yield* hostForCwd(input.cwd);
      const target = yield* resolveReadTarget(input, host);
      const absentResult = {
        relativePath: target.relativePath,
        contents: "",
        byteLength: 0,
        truncated: false,
        exists: false,
      };
      const realTargetPath = target.realTargetPath;
      if (realTargetPath === null) return absentResult;
      if (yield* isServerInternalPath(realTargetPath)) {
        return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }

      const file = yield* host.files.readFile(realTargetPath, PROJECT_READ_FILE_MAX_BYTES).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && error.operation === "open" && error.code === "ENOENT",
          () => Effect.succeed(null),
        ),
        Effect.mapError((cause) =>
          operationError(
            input,
            realTargetPath,
            realTargetPath,
            cause.operation === "stat" || cause.operation === "read" || cause.operation === "close"
              ? cause.operation
              : "open",
          )(cause),
        ),
      );
      if (file === null) return absentResult;
      if (file.kind === "not-file") {
        return yield* new WorkspacePathNotFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
        });
      }
      if (file.bytes.includes(0)) {
        return yield* new WorkspaceBinaryFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
        });
      }

      const truncated = file.size > PROJECT_READ_FILE_MAX_BYTES;
      return {
        relativePath: target.relativePath,
        // Streaming decode drops a character the byte limit split, instead of ending in U+FFFD.
        contents: new TextDecoder("utf-8").decode(file.bytes, { stream: truncated }),
        byteLength: file.size,
        truncated,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({ WorkspaceHostUnavailableError: (error) => readStopped(input, error) }),
      ),
  );

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: ProjectWriteFileInput,
    host: WorkspaceHost,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    // Resolve `..` in cwd the way the relative path was resolved, before following links.
    const realWorkspaceRoot = yield* host.files
      .realPath(path.resolve(input.cwd))
      .pipe(
        Effect.mapError(
          operationError(input, target.absolutePath, input.cwd, "realpath-workspace-root"),
        ),
      );

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.gen(function* () {
      for (let depth = segments.length; depth > 0; depth--) {
        const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
        const real = yield* Effect.result(host.files.realPath(candidate));
        if (Result.isSuccess(real)) return path.join(real.success, ...segments.slice(depth));
        // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
        const exists = yield* host.files.lstat(candidate).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (real.failure.code !== "ENOENT" || exists) return yield* real.failure;
      }
      return path.join(realWorkspaceRoot, ...segments);
    }).pipe(
      Effect.mapError(
        operationError(input, target.absolutePath, target.absolutePath, "realpath-target"),
      ),
    );
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      isInGitFolder(host, checkedPath).pipe(
        Effect.mapError(operationError(input, realTargetPath, checkedPath, "stat")),
      ),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(
    function* (input) {
      const host = yield* hostForCwd(input.cwd);
      yield* knownWorkspaces.assertContains(input.cwd);
      const target = yield* resolveWriteTarget(input, host);
      const realTargetPath = target.realTargetPath;
      const replacesFile = yield* host.fileSystem
        .exists(realTargetPath)
        .pipe(Effect.orElseSucceed(() => false));

      const directory = path.dirname(realTargetPath);
      yield* host.fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(operationError(input, realTargetPath, directory, "make-directory")));
      yield* host.files
        .writeNoFollow(realTargetPath, input.contents)
        .pipe(Effect.mapError(operationError(input, realTargetPath, realTargetPath, "write-file")));
      // Editor autosave overwrites existing files, which leaves the indexed paths unchanged, and
      // fff's watcher applies the new contents on its own. A forced rescan re-walks the whole
      // workspace, and the save would wait for it.
      if (!replacesFile) {
        yield* workspaceEntries.refresh(input.cwd);
      }
      return { relativePath: target.relativePath };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchTags({
          WorkspaceHostUnavailableError: (error) =>
            Option.isNone(stopped) || error.sandboxId === undefined
              ? Effect.fail<KnownWorkspaces.UnknownWorkspaceError | SandboxAsleep>(
                  unknownWorkspace(input.cwd, error),
                )
              : stopped.value.refuseWrite(error.sandboxId),
        }),
      ),
  );

  return WorkspaceFileSystem.of({ getMetadata, readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
