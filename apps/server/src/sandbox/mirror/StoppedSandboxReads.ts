// @effect-diagnostics nodeBuiltinImport:off -- sandbox paths and git tree paths are POSIX on every server.
import * as NodePath from "node:path";

import {
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
  type ProjectEntry,
  type ProjectListEntriesInput,
  type ProjectListEntriesResult,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectSearchContentsInput,
  type ProjectSearchContentsResult,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
  SandboxAsleep,
  type SandboxId,
  type ThreadId,
} from "@t3tools/contracts";
import { isExplicitRelativePath } from "@t3tools/shared/path";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type RankedSearchResult,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "../../workspace/WorkspaceSearchIndex.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";

const posix = NodePath.posix;

/** Same caps as the live index and editor reads. */
const MAX_LIST_ENTRIES = 25_000;
const CONTENT_SEARCH_TIME_BUDGET = "250 millis";
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
const CONTENT_SEARCH_MAX_LINE_LENGTH = 512;
const TREE_LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface StoppedView {
  readonly sandboxId: SandboxId;
  /** Whose checkpoint backs the view. */
  readonly threadId: ThreadId;
  /** The checkpoint's appRunOrdinal, for "As of turn N" (0 when it has none). */
  readonly turn: number;
  /** The checkpoint's oid in the mirror. */
  readonly commit: string;
  /** The mirror. */
  readonly gitDir: string;
  /** cwd relative to the checkpoint's tree root ("" for the root). */
  readonly prefix: string;
  /** The cwd the client asked about. */
  readonly cwd: string;
}

export class StoppedSandboxReads extends Context.Service<
  StoppedSandboxReads,
  {
    /** The view for a cwd under /t3-sandbox/<id>/; fails with SandboxAsleep when none exists. */
    readonly viewFor: (
      cwd: string,
      sandboxId: SandboxId,
    ) => Effect.Effect<StoppedView, SandboxAsleep>;
    /** The refusal a write to a stopped machine gets; nothing is queued. */
    readonly refuseWrite: (sandboxId: SandboxId) => Effect.Effect<never, SandboxAsleep>;
    readonly list: (
      view: StoppedView,
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly search: (
      view: StoppedView,
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly searchContents: (
      view: StoppedView,
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly browse: (
      view: StoppedView,
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntries.WorkspaceEntriesBrowseError>;
    readonly readFile: (
      view: StoppedView,
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystem.WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/sandbox/mirror/StoppedSandboxReads") {}

const isInside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);

/** A client path inside `view.cwd`, as a path in the checkpoint's tree; null when it leaves it. */
const treePathFor = (view: StoppedView, relativePath: string): string | null => {
  const trimmed = relativePath.trim();
  const absolute = posix.resolve(view.cwd, trimmed);
  if (!isInside(view.cwd, absolute)) return null;
  const inCwd = posix.relative(view.cwd, absolute);
  const treePath =
    view.prefix === "" ? inCwd : inCwd === "" ? view.prefix : `${view.prefix}/${inCwd}`;
  return treePath.split("/").includes(".git") ? null : treePath;
};

const treeIsh = (view: StoppedView, treePath: string) => `${view.commit}:${treePath}`;

interface TreeEntry {
  readonly type: "blob" | "tree" | "commit";
  readonly path: string;
}

// `<mode> SP <type> SP <oid> TAB <path>` records, NUL-terminated.
const parseTree = (stdout: string): Array<TreeEntry> =>
  stdout.split("\0").flatMap((record): Array<TreeEntry> => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const type = record.slice(0, tab).split(" ")[1];
    const path = record.slice(tab + 1);
    return path !== "" && (type === "blob" || type === "tree" || type === "commit")
      ? [{ type, path }]
      : [];
  });

const entryKind = (entry: TreeEntry): ProjectEntry["kind"] =>
  entry.type === "blob" ? "file" : "directory";

const scoreEntry = (entry: ProjectEntry, query: string): number | null => {
  const path = entry.path.toLowerCase();
  const name = posix.basename(path);
  const byName = scoreQueryMatch({
    value: name,
    query,
    exactBase: 0,
    prefixBase: 10,
    boundaryBase: 20,
    includesBase: 30,
    fuzzyBase: 200,
  });
  const byPath = scoreQueryMatch({
    value: path,
    query,
    exactBase: 5,
    prefixBase: 40,
    boundaryBase: 50,
    includesBase: 60,
    fuzzyBase: 400,
  });
  if (byName === null) return byPath;
  return byPath === null ? byName : Math.min(byName, byPath);
};

const matchRanges = (line: string, input: ProjectSearchContentsInput) => {
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  if (input.useRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.query, input.caseSensitive ? "gu" : "giu");
    } catch {
      return ranges;
    }
    for (const match of line.matchAll(pattern)) {
      if (match[0].length > 0)
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    return ranges;
  }
  const haystack = input.caseSensitive ? line : line.toLowerCase();
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  for (let index = haystack.indexOf(needle); index >= 0;) {
    ranges.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
};

const make = Effect.gen(function* () {
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  // safe.bareRepository=explicit (VcsProcess) refuses `git -C <bare>`, so every command names its git dir.
  const git = (
    gitDir: string,
    operation: string,
    args: ReadonlyArray<string>,
    options: Partial<VcsProcess.VcsProcessInput> = {},
  ) =>
    vcsProcess.run({
      operation: `StoppedSandboxReads.${operation}`,
      command: "git",
      cwd: gitDir,
      args: [`--git-dir=${gitDir}`, ...args],
      allowNonZeroExit: true,
      ...options,
    });

  const sandboxState = (sandboxId: SandboxId) =>
    projection.getSandbox(sandboxId).pipe(
      Effect.map((sandbox) => sandbox?.state ?? "destroyed"),
      Effect.orDie,
    );

  const refuseWrite: StoppedSandboxReads["Service"]["refuseWrite"] = Effect.fn(
    "StoppedSandboxReads.refuseWrite",
  )(function* (sandboxId) {
    return yield* new SandboxAsleep({ sandboxId, state: yield* sandboxState(sandboxId) });
  });

  const viewFor: StoppedSandboxReads["Service"]["viewFor"] = Effect.fn(
    "StoppedSandboxReads.viewFor",
  )(function* (rawCwd, sandboxId) {
    const cwd = posix.resolve(rawCwd);
    const sandbox = yield* projection.getSandbox(sandboxId).pipe(Effect.orDie);
    const asleep = new SandboxAsleep({ sandboxId, state: sandbox?.state ?? "destroyed" });
    if (sandbox === null) return yield* asleep;

    const threads = yield* projection.listSandboxThreads(sandboxId).pipe(Effect.orDie);
    const candidates: Array<{
      readonly threadId: ThreadId;
      readonly ref: string;
      readonly turn: number;
      readonly scopeCwd: string;
    }> = [];
    for (const { threadId } of threads) {
      const context = yield* projection.getCheckpointContext(threadId).pipe(Effect.orDie);
      const scopeCwds = new Map(
        context.checkpointScopes.map((scope) => [scope.id, posix.resolve(scope.cwd)]),
      );
      for (const checkpoint of context.checkpoints) {
        const scopeCwd = scopeCwds.get(checkpoint.scopeId);
        if (checkpoint.status !== "ready" || scopeCwd === undefined || !isInside(scopeCwd, cwd)) {
          continue;
        }
        candidates.push({
          threadId,
          ref: checkpoint.ref,
          turn: checkpoint.appRunOrdinal ?? 0,
          scopeCwd,
        });
      }
    }
    if (candidates.length === 0) return yield* asleep;

    // One for-each-ref: which candidates the mirror holds, and when each was captured.
    const gitDir = CheckpointMirror.mirrorGitDir(path, stateDir, sandbox.projectId);
    const refs = yield* git(gitDir, "viewFor", [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
      ...new Set(candidates.map((candidate) => candidate.ref)),
    ]).pipe(
      Effect.map((result) => {
        const held = new Map<string, { readonly oid: string; readonly capturedAt: number }>();
        if (result.exitCode !== 0) return held;
        for (const line of result.stdout.split("\n")) {
          const [refName, oid, capturedAt] = line.split("\0");
          if (refName && oid && capturedAt)
            held.set(refName, { oid, capturedAt: Number(capturedAt) });
        }
        return held;
      }),
      // No mirror yet reads like a pending sync.
      Effect.orElseSucceed(
        () => new Map<string, { readonly oid: string; readonly capturedAt: number }>(),
      ),
    );

    let best: (typeof candidates)[number] | undefined;
    let bestTip: { readonly oid: string; readonly capturedAt: number } | undefined;
    for (const candidate of candidates) {
      const tip = refs.get(candidate.ref);
      if (tip === undefined) continue;
      // The innermost checkout first, then the newest capture.
      const better =
        best === undefined ||
        bestTip === undefined ||
        candidate.scopeCwd.length > best.scopeCwd.length ||
        (candidate.scopeCwd.length === best.scopeCwd.length &&
          (tip.capturedAt > bestTip.capturedAt ||
            (tip.capturedAt === bestTip.capturedAt && candidate.turn > best.turn)));
      if (better) {
        best = candidate;
        bestTip = tip;
      }
    }
    if (best === undefined || bestTip === undefined) return yield* asleep;
    return {
      sandboxId,
      threadId: best.threadId,
      turn: best.turn,
      commit: bestTip.oid,
      gitDir,
      prefix: posix.relative(best.scopeCwd, cwd),
      cwd,
    };
  });

  const listTree = (
    view: StoppedView,
    treePath: string,
    recursive: boolean,
  ): Effect.Effect<Array<TreeEntry> | null, WorkspaceEntries.WorkspaceEntriesReadDirectoryError> =>
    git(
      view.gitDir,
      "listTree",
      ["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), treeIsh(view, treePath)],
      { maxOutputBytes: TREE_LIST_MAX_OUTPUT_BYTES },
    ).pipe(
      // A path the checkpoint doesn't hold is not a tree.
      Effect.map((result) => (result.exitCode === 0 ? parseTree(result.stdout) : null)),
      Effect.mapError(
        (cause) =>
          new WorkspaceEntries.WorkspaceEntriesReadDirectoryError({
            cwd: view.cwd,
            partialPath: treePath,
            parentPath: posix.join(view.cwd, treePath),
            cause,
          }),
      ),
    );

  /** Every file and folder under cwd, path-sorted and capped like the live index. */
  const listAll = Effect.fn("StoppedSandboxReads.listAll")(function* (view: StoppedView) {
    const entries = ((yield* listTree(view, view.prefix, true)) ?? [])
      .map((entry): ProjectEntry => ({ path: entry.path, kind: entryKind(entry) }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    return {
      entries: entries.slice(0, MAX_LIST_ENTRIES),
      truncated: entries.length > MAX_LIST_ENTRIES,
    };
  });

  const list: StoppedSandboxReads["Service"]["list"] = Effect.fn("StoppedSandboxReads.list")(
    function* (view, input) {
      if (input.directoryPath === undefined) return yield* listAll(view);
      const directoryPath = input.directoryPath;
      const treePath = treePathFor(view, directoryPath);
      const notADirectory = new WorkspaceEntries.WorkspaceEntriesReadDirectoryError({
        cwd: view.cwd,
        partialPath: directoryPath,
        parentPath: posix.resolve(view.cwd, directoryPath),
        cause: new Error("Directory must be inside the workspace and outside .git."),
      });
      if (treePath === null) return yield* notADirectory;
      const children = yield* listTree(view, treePath, false);
      if (children === null) return yield* notADirectory;
      const inCwd = posix.relative(view.cwd, posix.resolve(view.cwd, directoryPath));
      return {
        entries: children.map((child): ProjectEntry => ({
          path: inCwd === "" ? child.path : `${inCwd}/${child.path}`,
          kind: entryKind(child),
        })),
        truncated: false,
      };
    },
  );

  const search: StoppedSandboxReads["Service"]["search"] = Effect.fn("StoppedSandboxReads.search")(
    function* (view, input) {
      const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/ });
      const { entries, truncated } = yield* listAll(view);
      const ranked: Array<RankedSearchResult<ProjectEntry>> = [];
      let matched = 0;
      for (const entry of entries) {
        if (input.kind !== undefined && entry.kind !== input.kind) continue;
        if (input.imageOnly && (entry.kind !== "file" || !isProjectFaviconPath(entry.path)))
          continue;
        const score = query === "" ? 0 : scoreEntry(entry, query);
        if (score === null) continue;
        matched += 1;
        insertRankedSearchResult(
          ranked,
          { item: entry, score, tieBreaker: entry.path },
          input.limit,
        );
      }
      return {
        entries: ranked.map((result) => result.item),
        truncated: truncated || matched > input.limit,
      };
    },
  );

  const searchContents: StoppedSandboxReads["Service"]["searchContents"] = Effect.fn(
    "StoppedSandboxReads.searchContents",
  )(function* (view, input) {
    const chunks: Array<Uint8Array> = [];
    const run = yield* git(
      view.gitDir,
      "searchContents",
      [
        "grep",
        "-z",
        "-n",
        "-I",
        `--max-count=${CONTENT_SEARCH_MAX_MATCHES_PER_FILE}`,
        ...(input.caseSensitive ? [] : ["-i"]),
        ...(input.wholeWord ? ["-w"] : []),
        input.useRegex ? "-E" : "-F",
        "-e",
        input.query,
        view.commit,
        ...(view.prefix === "" ? [] : ["--", view.prefix]),
      ],
      { onStdoutChunk: (chunk) => chunks.push(chunk), outputMode: "truncate" },
    ).pipe(
      // The live search answers within this budget with what it found; so does this one.
      Effect.timeoutOption(CONTENT_SEARCH_TIME_BUDGET),
      Effect.mapError(
        (cause) =>
          new WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed({
            cwd: view.cwd,
            queryLength: input.query.length,
            pageSize: input.limit,
            reason: "git grep in the checkpoint mirror failed.",
            cause,
          }),
      ),
    );
    if (run._tag === "Some" && run.value.exitCode !== 0 && run.value.exitCode !== 1) {
      return yield* new WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed({
        cwd: view.cwd,
        queryLength: input.query.length,
        pageSize: input.limit,
        reason: run.value.stderr.split("\n")[0] || "git grep failed.",
      });
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    // A timed-out search may end mid-line.
    if (run._tag === "None") lines.pop();
    const revPrefix = `${view.commit}:`;
    const pathPrefix = view.prefix === "" ? "" : `${view.prefix}/`;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    for (const line of lines) {
      const [name, lineNumber, ...rest] = line.split("\0");
      if (name === undefined || lineNumber === undefined || rest.length === 0) continue;
      const path = name.startsWith(revPrefix) ? name.slice(revPrefix.length) : name;
      const content = rest.join("\0");
      const lineContent = content.slice(0, CONTENT_SEARCH_MAX_LINE_LENGTH);
      matches.push({
        path: path.startsWith(pathPrefix) ? path.slice(pathPrefix.length) : path,
        lineNumber: Number(lineNumber),
        lineContent,
        matchRanges: matchRanges(lineContent, input),
      });
      if (matches.length > input.limit) break;
    }
    return {
      matches: matches.slice(0, input.limit),
      truncated: run._tag === "None" || matches.length > input.limit,
    };
  });

  const browse: StoppedSandboxReads["Service"]["browse"] = Effect.fn("StoppedSandboxReads.browse")(
    function* (view, input) {
      const resolved = isExplicitRelativePath(input.partialPath)
        ? posix.resolve(view.cwd, input.partialPath)
        : posix.resolve(input.partialPath);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolved : posix.dirname(resolved);
      const namePrefix = endsWithSeparator ? "" : posix.basename(resolved);
      // `~` and paths outside the checkout name the stopped machine's disk, which the checkpoint lacks.
      const root = posix.resolve(
        view.cwd,
        ...view.prefix
          .split("/")
          .filter(Boolean)
          .map(() => ".."),
      );
      if (input.partialPath.startsWith("~") || !isInside(root, parentPath)) {
        return { parentPath, entries: [] };
      }
      const treePath = posix.relative(root, parentPath);
      if (treePath.split("/").includes(".git")) return { parentPath, entries: [] };
      const children = (yield* listTree(view, treePath, false)) ?? [];
      const showHidden = endsWithSeparator || namePrefix.startsWith(".");
      const lowerPrefix = namePrefix.toLowerCase();
      return {
        parentPath,
        entries: children
          .filter(
            (child) =>
              child.type !== "blob" &&
              child.path.toLowerCase().startsWith(lowerPrefix) &&
              (showHidden || !child.path.startsWith(".")),
          )
          .map((child) => ({ name: child.path, fullPath: posix.join(parentPath, child.path) }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const readFile: StoppedSandboxReads["Service"]["readFile"] = Effect.fn(
    "StoppedSandboxReads.readFile",
  )(function* (view, input) {
    const requested = input.relativePath.trim();
    const outside = new WorkspacePaths.WorkspacePathOutsideRootError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    // An absolute path reads only inside the checkout: the rest of the machine's disk is not in the checkpoint.
    const relativePath = posix.isAbsolute(requested)
      ? posix.relative(view.cwd, requested)
      : requested;
    const treePath = requested.startsWith("~") ? null : treePathFor(view, relativePath);
    if (treePath === null || treePath === view.prefix) return yield* outside;
    const displayPath = posix.relative(view.cwd, posix.resolve(view.cwd, relativePath));
    const resolvedPath = posix.join(view.cwd, displayPath);
    const operationError = (operation: "stat" | "read", cause: unknown) =>
      new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath,
        operationPath: resolvedPath,
        operation,
        cause,
      });

    const check = yield* git(view.gitDir, "readFile", ["cat-file", "--batch-check"], {
      stdin: `${treeIsh(view, treePath)}\n`,
    }).pipe(Effect.mapError((cause) => operationError("stat", cause)));
    const [oid, type, size] = check.stdout.trim().split(" ");
    if (check.exitCode !== 0 || oid === undefined || type === "missing" || size === undefined) {
      if (input.allowMissing === true) {
        return {
          relativePath: displayPath,
          contents: "",
          byteLength: 0,
          truncated: false,
          exists: false,
        };
      }
      return yield* operationError("stat", new Error("The file is not in the checkpoint."));
    }
    if (type !== "blob") {
      return yield* new WorkspaceFileSystem.WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath,
      });
    }

    const chunks: Array<Uint8Array> = [];
    let collected = 0;
    yield* git(view.gitDir, "readFile", ["cat-file", "blob", oid], {
      allowNonZeroExit: false,
      outputMode: "truncate",
      maxOutputBytes: WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES,
      onStdoutChunk: (chunk) => {
        const room = WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES - collected;
        if (room <= 0) return;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(kept);
        collected += kept.length;
      },
    }).pipe(Effect.mapError((cause) => operationError("read", cause)));
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0)) {
      return yield* new WorkspaceFileSystem.WorkspaceBinaryFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath,
      });
    }
    const byteLength = Number(size);
    const truncated = byteLength > WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES;
    return {
      relativePath: displayPath,
      // Streaming decode drops a character the byte limit split, as the live read does.
      contents: new TextDecoder("utf-8").decode(bytes, { stream: truncated }),
      byteLength,
      truncated,
    };
  });

  return StoppedSandboxReads.of({
    viewFor,
    refuseWrite,
    list,
    search,
    searchContents,
    browse,
    readFile,
  });
});

export const layer = Layer.effect(StoppedSandboxReads, make);
