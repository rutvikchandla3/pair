import type { VcsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import { creditHookFiles, isCreditableLine, trimCreditLine } from "./creditHook.ts";

export class LineageGitError extends Schema.TaggedError<LineageGitError>()("LineageGitError", {
  operation: Schema.String,
  reason: Schema.Literals(["branch-exists", "offer-conflict", "head-moved", "failed"]),
  paths: Schema.optional(Schema.Array(Schema.String)),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "branch-exists":
        return "That branch already exists.";
      case "offer-conflict":
        return "These commits don't combine cleanly on the branch's base.";
      case "head-moved":
        return "The branch has moved since the update.";
      case "failed":
        return this.detail ?? `${this.operation} failed.`;
    }
  }
}

export type LineageGitFailure = LineageGitError | VcsError;

export interface LineageAuthor {
  readonly name: string;
  readonly email: string;
}

/** A dangling commit of a working tree; no ref points at it. */
export interface WorktreeTree {
  readonly commit: string;
  readonly tree: string;
}

export interface OfferFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
}

export interface OfferFilePatch {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: OfferFile["status"];
  /** From its `diff --git` line. */
  readonly patch: string;
}

export interface FileLines {
  readonly path: string;
  readonly lines: ReadonlyArray<string>;
}

export interface UpdatePreview {
  readonly files: ReadonlyArray<{ readonly path: string; readonly status: "clean" | "conflict" }>;
  readonly conflicts: ReadonlyArray<string>;
}

export interface StartedUpdate<Result> {
  readonly preUpdateHead: string;
  /** The brancher's uncommitted work, committed before the update; null when the tree was clean. */
  readonly wipCommit: string | null;
  readonly result: Result;
}

export type UpdateResult =
  | { readonly type: "merged"; readonly mergeCommit: string }
  | { readonly type: "conflicted"; readonly conflictedPaths: ReadonlyArray<string> };

export type BringBackResult =
  | { readonly type: "picked"; readonly commits: ReadonlyArray<string> }
  | {
      readonly type: "conflicted";
      readonly conflictedPaths: ReadonlyArray<string>;
      /** New commits made before the conflict. */
      readonly picked: ReadonlyArray<string>;
      /** Commits after the conflicted one, still to bring back once it is resolved. */
      readonly remaining: ReadonlyArray<string>;
    };

export interface UpdateState {
  /** A merge or cherry-pick is still open (MERGE_HEAD or CHERRY_PICK_HEAD). */
  readonly mergeOpen: boolean;
  readonly pathsWithMarkers: ReadonlyArray<string>;
}

export interface OfferCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly patchId: string;
}

export interface BuiltOffer {
  readonly tip: string;
  readonly files: ReadonlyArray<OfferFile>;
  readonly additions: number;
  readonly deletions: number;
}

export type OfferCheck =
  | { readonly clean: true; readonly resultTree: string }
  | { readonly clean: false; readonly paths: ReadonlyArray<string> };

export interface ReturnedOffer {
  readonly type: "returned";
  readonly reason: "conflict" | "retries";
  readonly paths: ReadonlyArray<string>;
}

export type ApplyResult =
  | {
      readonly type: "applied";
      readonly files: ReadonlyArray<OfferFile>;
      readonly addedLines: ReadonlyArray<FileLines>;
    }
  | ReturnedOffer;

export type RevertResult =
  | { readonly type: "reverted"; readonly files: ReadonlyArray<OfferFile> }
  | ReturnedOffer;

export interface OfferWriteInput {
  readonly cwd: string;
  readonly base: string;
  readonly tip: string;
  /** Test seam: runs between the check and the write. */
  readonly beforeWrite?: Effect.Effect<void>;
  readonly maxTries?: number;
}

export interface LineageGitShape {
  readonly worktreeTree: (input: {
    readonly cwd: string;
  }) => Effect.Effect<WorktreeTree, LineageGitFailure>;
  readonly createSnapshot: (input: {
    readonly cwd: string;
    readonly checkpoint: string;
    readonly sourceHead: string;
    readonly previousSnapshot: string | null;
    readonly author: LineageAuthor;
    readonly message: string;
    /** Snapshots already made for this branch. An undone one with the same tree, parents and second must not come back. */
    readonly avoid?: ReadonlyArray<string>;
  }) => Effect.Effect<string, LineageGitFailure>;
  readonly addBranchWorktree: (input: {
    readonly repoCwd: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly startCommit: string;
  }) => Effect.Effect<void, LineageGitFailure>;
  readonly previewUpdate: (input: {
    readonly cwd: string;
    readonly snapshot: string;
    readonly base: string;
  }) => Effect.Effect<UpdatePreview, LineageGitFailure>;
  readonly startUpdate: (input: {
    readonly cwd: string;
    readonly snapshot: string;
    readonly author: LineageAuthor;
    readonly message: string;
    readonly wipMessage: string;
  }) => Effect.Effect<StartedUpdate<UpdateResult>, LineageGitFailure>;
  readonly updateState: (input: {
    readonly cwd: string;
    readonly conflictedPaths: ReadonlyArray<string>;
  }) => Effect.Effect<UpdateState, LineageGitFailure>;
  readonly abortUpdate: (input: {
    readonly cwd: string;
    readonly preUpdateHead: string;
    readonly wipCommit: string | null;
  }) => Effect.Effect<void, LineageGitFailure>;
  readonly undoUpdate: (input: {
    readonly cwd: string;
    readonly mergeCommit: string;
    readonly preUpdateHead: string;
    readonly wipCommit: string | null;
    readonly pushed: boolean;
    readonly author: LineageAuthor;
  }) => Effect.Effect<{ readonly undoCommit: string | null }, LineageGitFailure>;
  readonly offerCommits: (input: {
    readonly cwd: string;
    readonly sourceHead: string;
    readonly sourceTree: string;
    readonly exclude: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<OfferCommit>, LineageGitFailure>;
  readonly buildOffer: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly commits: ReadonlyArray<string>;
    readonly author: LineageAuthor;
    readonly message: string;
  }) => Effect.Effect<BuiltOffer, LineageGitFailure>;
  readonly checkOffer: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly tip: string;
    readonly against: string;
  }) => Effect.Effect<OfferCheck, LineageGitFailure>;
  readonly applyOffer: (input: OfferWriteInput) => Effect.Effect<ApplyResult, LineageGitFailure>;
  readonly revertOffer: (input: OfferWriteInput) => Effect.Effect<RevertResult, LineageGitFailure>;
  readonly cherryPickBack: (input: {
    readonly cwd: string;
    readonly commits: ReadonlyArray<string>;
    readonly author: LineageAuthor;
    readonly wipMessage: string;
  }) => Effect.Effect<StartedUpdate<BringBackResult>, LineageGitFailure>;
  readonly installCreditHook: (input: {
    readonly cwd: string;
    readonly hooksDir?: string;
  }) => Effect.Effect<{ readonly hooksDir: string }, LineageGitFailure>;
  readonly recordCredit: (input: {
    readonly cwd: string;
    readonly coAuthor: string;
    readonly lines: ReadonlyArray<FileLines>;
  }) => Effect.Effect<void, LineageGitFailure>;
  /** Keeps only recorded lines still uncommitted in their file; succeeds with how many remain. */
  readonly pruneCredit: (input: {
    readonly cwd: string;
  }) => Effect.Effect<{ readonly remainingLines: number }, LineageGitFailure>;
  /** The commit `rev` names, or null when it names none. */
  readonly resolveCommit: (input: {
    readonly cwd: string;
    readonly rev: string;
  }) => Effect.Effect<string | null, LineageGitFailure>;
  /** Paths with uncommitted changes, untracked files included. */
  readonly uncommittedPaths: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, LineageGitFailure>;
  /** Commits everything uncommitted as `author`; null when there was nothing. */
  readonly commitAll: (input: {
    readonly cwd: string;
    readonly author: LineageAuthor;
    readonly message: string;
  }) => Effect.Effect<string | null, LineageGitFailure>;
  /** The merge on HEAD that brought `snapshot` in, or null when HEAD doesn't contain it. */
  readonly mergeOf: (input: {
    readonly cwd: string;
    readonly snapshot: string;
  }) => Effect.Effect<string | null, LineageGitFailure>;
  /** The branch's upstream contains `commit`. */
  readonly isPushed: (input: {
    readonly cwd: string;
    readonly commit: string;
  }) => Effect.Effect<boolean, LineageGitFailure>;
  /** `base..tip` file by file, in `buildOffer`'s file order. */
  readonly offerDiff: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly tip: string;
  }) => Effect.Effect<ReadonlyArray<OfferFilePatch>, LineageGitFailure>;
}

export class LineageGit extends Context.Service<LineageGit, LineageGitShape>()(
  "t3/lineage/LineageGit",
) {}

// A project's config can name an fsmonitor command or keep an untracked cache; neither runs here.
const HARDENED_CONFIG_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
// Scratch split-index writes can expire sharedindex files the real index still uses.
const INDEX_CONFIG_ARGS = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
];
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PAIR_IDENTITY = {
  GIT_AUTHOR_NAME: "Pair",
  GIT_AUTHOR_EMAIL: "pair@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Pair",
  GIT_COMMITTER_EMAIL: "pair@users.noreply.github.com",
};
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

const authorEnv = (author: LineageAuthor): NodeJS.ProcessEnv => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
});

const nulFields = (stdout: string) => stdout.split("\0").filter((field) => field.length > 0);
const unique = <A>(values: Iterable<A>) => [...new Set(values)];

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Git C-quotes paths with control characters, quotes or backslashes, even with quotePath off. */
const unquoteGitPath = (raw: string) => {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = body[++index] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(index, index + 3), 8));
      index += 2;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

/** Added lines per new path in a `diff-tree -p` patch. */
const parseAddedLines = (patch: string) => {
  const added = new Map<string, string[]>();
  let path: string | null = null;
  let inBody = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = null;
      inBody = false;
    } else if (!inBody && line.startsWith("+++ ")) {
      const target = line.slice(4);
      path = target === "/dev/null" ? null : unquoteGitPath(target).replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      inBody = true;
    } else if (inBody && path !== null && line.startsWith("+")) {
      const lines = added.get(path) ?? [];
      lines.push(line.slice(1));
      added.set(path, lines);
    }
  }
  return added;
};

/** `merge-tree --name-only -z --no-messages`: the tree, then each conflicted path once. */
const parseMergeTree = (stdout: string, exitCode: number) => {
  const [tree = "", ...paths] = stdout.split("\0");
  return { tree, conflicts: exitCode === 1 ? unique(paths.filter((path) => path.length > 0)) : [] };
};

const parseOfferFiles = (nameStatus: string, numstat: string): OfferFile[] => {
  const counts = new Map<string, { additions: number; deletions: number }>();
  const stats = numstat.split("\0");
  for (let index = 0; index < stats.length; index++) {
    const [added = "", deleted = "", inlinePath = ""] = stats[index]!.split("\t");
    if (added === "") continue;
    // A rename's numstat names no path inline; the old and new paths follow as fields.
    const path = inlinePath === "" ? ((index += 2), stats[index] ?? "") : inlinePath;
    counts.set(path, {
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
    });
  }
  const files: OfferFile[] = [];
  const fields = nulFields(nameStatus);
  for (let index = 0; index < fields.length; index++) {
    const code = fields[index]!;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const previousPath = fields[++index]!;
      const path = fields[++index]!;
      files.push({
        path,
        ...(kind === "R" ? { previousPath } : {}),
        status: kind === "R" ? "renamed" : "added",
        ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
      });
      continue;
    }
    const path = fields[++index]!;
    files.push({
      path,
      status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified",
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
    });
  }
  return files;
};

/** A multi-file patch cut at each `diff --git` line. */
const splitPatch = (patch: string) => {
  const chunks: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) chunks.push(line);
    else if (chunks.length > 0) chunks[chunks.length - 1] += `\n${line}`;
  }
  return chunks.map((chunk) => (chunk.endsWith("\n") ? chunk : `${chunk}\n`));
};

const CreditEntry = Schema.Struct({
  path: Schema.String,
  coAuthor: Schema.String,
  lines: Schema.Array(Schema.String),
});
type CreditEntry = typeof CreditEntry.Type;
const CreditRecord = Schema.Struct({ entries: Schema.Array(CreditEntry) });
const decodeCreditRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditRecord));
const encodeCreditRecord = Schema.encodeEffect(Schema.fromJsonString(CreditRecord));

interface GitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
}

interface RepoPaths {
  readonly commonDir: string;
  readonly gitDir: string;
  readonly top: string;
  readonly indexPath: string;
}

const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const failed = (operation: string, detail: string) =>
    new LineageGitError({ operation, reason: "failed", detail });

  const git = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: GitOptions = {},
  ) =>
    vcsProcess.run({
      operation: `LineageGit.${operation}`,
      command: "git",
      cwd,
      args: ["-C", cwd, ...HARDENED_CONFIG_ARGS, ...args],
      spawnOutsideCwd: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: "error",
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
    });

  const gitLine = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: GitOptions,
  ) => git(operation, cwd, args, options).pipe(Effect.map((result) => result.stdout.trim()));

  const refExists = (operation: string, cwd: string, ref: string) =>
    git(operation, cwd, ["rev-parse", "--quiet", "--verify", ref], { allowNonZeroExit: true }).pipe(
      Effect.map((result) => result.exitCode === 0),
    );

  const fileSystemFor = (operation: string, cwd: string) =>
    hosts.forPath(cwd).pipe(
      Effect.map((host) => host.fileSystem),
      Effect.mapError((cause) => failed(operation, cause.message)),
    );

  const repoPaths = Effect.fnUntraced(function* (operation: string, cwd: string) {
    const lines = (yield* git(operation, cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--absolute-git-dir",
      "--show-toplevel",
      "--git-path",
      "index",
    ])).stdout.split("\n");
    const [commonDir = "", gitDir = "", top = "", indexPath = ""] = lines;
    if (top === "") return yield* failed(operation, "Not inside a git worktree.");
    return { commonDir, gitDir, top, indexPath } satisfies RepoPaths;
  });

  /** A scratch file in the repository's common git dir, removed when `use` ends. */
  const withScratchFile = Effect.fn("LineageGit.withScratchFile")(function* <A, E, R>(
    operation: string,
    repo: RepoPaths,
    use: (scratchPath: string) => Effect.Effect<A, E, R>,
  ) {
    const fileSystem = yield* fileSystemFor(operation, repo.top);
    const scratchPath = path.join(repo.commonDir, `pair-lineage-${yield* random.uuidV4()}`);
    return yield* use(scratchPath).pipe(
      Effect.ensuring(
        Effect.forEach(
          [scratchPath, `${scratchPath}.lock`],
          (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    );
  });

  const mergeTree = Effect.fnUntraced(function* (
    operation: string,
    cwd: string,
    input: { readonly base: string; readonly ours: string; readonly theirs: string },
  ) {
    const result = yield* git(
      operation,
      cwd,
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        "--no-messages",
        `--merge-base=${input.base}`,
        input.ours,
        input.theirs,
      ],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return yield* failed(operation, result.stderr.trim() || "git merge-tree failed.");
    }
    return parseMergeTree(result.stdout, result.exitCode);
  });

  const unmergedPaths = (operation: string, cwd: string) =>
    git(operation, cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).pipe(
      Effect.map((result) => unique(nulFields(result.stdout))),
    );

  const changedPaths = (operation: string, cwd: string, from: string, to: string) =>
    git(operation, cwd, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]).pipe(
      Effect.map((result) => nulFields(result.stdout)),
    );

  const offerFiles = Effect.fnUntraced(function* (
    operation: string,
    cwd: string,
    base: string,
    tip: string,
  ) {
    const nameStatus = yield* git(operation, cwd, [
      "diff-tree",
      "-r",
      "-z",
      "-M",
      "--name-status",
      base,
      tip,
    ]);
    const numstat = yield* git(operation, cwd, [
      "diff-tree",
      "-r",
      "-z",
      "-M",
      "--numstat",
      base,
      tip,
    ]);
    return parseOfferFiles(nameStatus.stdout, numstat.stdout);
  });

  const addedLinesBetween = Effect.fnUntraced(function* (
    operation: string,
    cwd: string,
    from: string,
    to: string,
    options: { readonly renames: boolean; readonly paths?: ReadonlyArray<string> },
  ) {
    const patch = yield* git(operation, cwd, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "-r",
      "-p",
      "-U0",
      "--no-color",
      options.renames ? "-M" : "--no-renames",
      from,
      to,
      ...(options.paths === undefined
        ? []
        : ["--", ...options.paths.map((file) => `:(top,literal)${file}`)]),
    ]);
    return parseAddedLines(patch.stdout);
  });

  const worktreeTree: LineageGitShape["worktreeTree"] = Effect.fn("LineageGit.worktreeTree")(
    function* ({ cwd }) {
      const operation = "worktreeTree";
      const repo = yield* repoPaths(operation, cwd);
      const fileSystem = yield* fileSystemFor(operation, repo.top);
      return yield* withScratchFile(operation, repo, (indexPath) =>
        Effect.gen(function* () {
          const env = { GIT_INDEX_FILE: indexPath };
          const stage = git(
            operation,
            repo.top,
            [...INDEX_CONFIG_ARGS, "-c", "core.safecrlf=false", "add", "-A"],
            { env },
          );
          // Starting from a copy of the real index reuses its stat cache, so unchanged files are not
          // rehashed. Its mtime goes back a second so racily clean entries are still checked.
          const copied = yield* Effect.gen(function* () {
            const { mtime } = yield* fileSystem.stat(repo.indexPath);
            if (Option.isNone(mtime)) return false;
            const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
            if (indexTime <= 0) return false;
            yield* fileSystem.copyFile(repo.indexPath, indexPath);
            yield* fileSystem.utimes(indexPath, indexTime, indexTime);
            yield* stage;
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!copied) {
            yield* fileSystem.remove(indexPath, { force: true }).pipe(Effect.ignore);
            yield* git(operation, repo.top, [...INDEX_CONFIG_ARGS, "read-tree", "HEAD"], { env });
            yield* stage;
          }
          const tree = yield* gitLine(operation, repo.top, ["write-tree"], { env });
          const commit = yield* gitLine(
            operation,
            repo.top,
            ["commit-tree", tree, "-p", "HEAD", "-m", "Pair working tree"],
            { env: PAIR_IDENTITY },
          );
          return { commit, tree };
        }),
      );
    },
  );

  const createSnapshot: LineageGitShape["createSnapshot"] = Effect.fn("LineageGit.createSnapshot")(
    function* (input) {
      const operation = "createSnapshot";
      const avoid = new Set(input.avoid ?? []);
      const parents = [
        input.sourceHead,
        ...(input.previousSnapshot === null ? [] : [input.previousSnapshot]),
      ];
      const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      for (let attempt = 0; attempt < 10; attempt++) {
        const sha = yield* gitLine(
          operation,
          input.cwd,
          [
            "commit-tree",
            `${input.checkpoint}^{tree}`,
            ...parents.flatMap((parent) => ["-p", parent]),
            "-m",
            input.message,
          ],
          {
            env: {
              ...authorEnv(input.author),
              ...(attempt === 0 ? {} : { GIT_AUTHOR_DATE: `@${nowSeconds + attempt} +0000` }),
            },
          },
        );
        if (!avoid.has(sha)) return sha;
      }
      return yield* failed(operation, "Could not make a new snapshot commit.");
    },
  );

  const addBranchWorktree: LineageGitShape["addBranchWorktree"] = Effect.fn(
    "LineageGit.addBranchWorktree",
  )(function* (input) {
    const operation = "addBranchWorktree";
    if (yield* refExists(operation, input.repoCwd, `refs/heads/${input.branch}`)) {
      return yield* new LineageGitError({ operation, reason: "branch-exists" });
    }
    yield* git(operation, input.repoCwd, [
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktreePath,
      input.startCommit,
    ]);
  });

  const previewUpdate: LineageGitShape["previewUpdate"] = Effect.fn("LineageGit.previewUpdate")(
    function* ({ cwd, snapshot, base }) {
      const operation = "previewUpdate";
      const ours = yield* worktreeTree({ cwd });
      const merge = yield* mergeTree(operation, cwd, { base, ours: ours.commit, theirs: snapshot });
      const conflicts = new Set(merge.conflicts);
      const files = (yield* changedPaths(operation, cwd, base, snapshot)).map((file) => ({
        path: file,
        status: conflicts.has(file) ? ("conflict" as const) : ("clean" as const),
      }));
      return { files, conflicts: merge.conflicts };
    },
  );

  /** Commits everything uncommitted as `author`; null when there is nothing. */
  const commitWip = Effect.fnUntraced(function* (
    operation: string,
    top: string,
    author: LineageAuthor,
    message: string,
  ) {
    const status = yield* git(
      operation,
      top,
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      {
        env: { GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (status.stdout.length === 0) return null;
    yield* git(operation, top, ["add", "-A"]);
    yield* git(operation, top, ["commit", "--no-verify", "--quiet", "-m", message], {
      env: authorEnv(author),
    });
    return yield* gitLine(operation, top, ["rev-parse", "HEAD"]);
  });

  /** Moves HEAD back to `preUpdateHead`, turning the wip commit into uncommitted work again. */
  const restoreBranch = Effect.fnUntraced(function* (
    operation: string,
    top: string,
    preUpdateHead: string,
    wipCommit: string | null,
  ) {
    const target = wipCommit ?? preUpdateHead;
    if ((yield* gitLine(operation, top, ["rev-parse", "HEAD"])) !== target) {
      // --keep refuses rather than overwrite a local change in a file it has to reset.
      yield* git(operation, top, ["reset", "--quiet", "--keep", target]);
    }
    if (wipCommit === null) return;
    yield* git(operation, top, ["reset", "--quiet", "--soft", preUpdateHead]);
    yield* git(operation, top, ["reset", "--quiet"]);
  });

  const startUpdate: LineageGitShape["startUpdate"] = Effect.fn("LineageGit.startUpdate")(
    function* (input) {
      const operation = "startUpdate";
      const { top } = yield* repoPaths(operation, input.cwd);
      const preUpdateHead = yield* gitLine(operation, top, ["rev-parse", "HEAD"]);
      const wipCommit = yield* commitWip(operation, top, input.author, input.wipMessage);
      const merge = yield* git(
        operation,
        top,
        ["merge", "--no-ff", "--no-edit", "--no-verify", "-m", input.message, input.snapshot],
        { env: authorEnv(input.author), allowNonZeroExit: true },
      );
      if (merge.exitCode === 0) {
        const mergeCommit = yield* gitLine(operation, top, ["rev-parse", "HEAD"]);
        return { preUpdateHead, wipCommit, result: { type: "merged" as const, mergeCommit } };
      }
      if (yield* refExists(operation, top, "MERGE_HEAD")) {
        const conflictedPaths = yield* unmergedPaths(operation, top);
        return {
          preUpdateHead,
          wipCommit,
          result: { type: "conflicted" as const, conflictedPaths },
        };
      }
      yield* restoreBranch(operation, top, preUpdateHead, wipCommit);
      return yield* failed(operation, merge.stderr.trim() || "git merge failed.");
    },
  );

  const updateState: LineageGitShape["updateState"] = Effect.fn("LineageGit.updateState")(
    function* ({ cwd, conflictedPaths }) {
      const operation = "updateState";
      const { top } = yield* repoPaths(operation, cwd);
      const mergeOpen =
        (yield* refExists(operation, top, "MERGE_HEAD")) ||
        (yield* refExists(operation, top, "CHERRY_PICK_HEAD"));
      const fileSystem = yield* fileSystemFor(operation, top);
      const pathsWithMarkers = yield* Effect.filter(conflictedPaths, (file) =>
        fileSystem.readFileString(path.join(top, file)).pipe(
          Effect.map((contents) => CONFLICT_MARKER.test(contents)),
          Effect.orElseSucceed(() => false),
        ),
      );
      return { mergeOpen, pathsWithMarkers };
    },
  );

  const abortUpdate: LineageGitShape["abortUpdate"] = Effect.fn("LineageGit.abortUpdate")(
    function* ({ cwd, preUpdateHead, wipCommit }) {
      const operation = "abortUpdate";
      const { top } = yield* repoPaths(operation, cwd);
      if (yield* refExists(operation, top, "MERGE_HEAD")) {
        yield* git(operation, top, ["merge", "--abort"]);
      } else if (yield* refExists(operation, top, "CHERRY_PICK_HEAD")) {
        yield* git(operation, top, ["cherry-pick", "--abort"]);
      }
      yield* restoreBranch(operation, top, preUpdateHead, wipCommit);
    },
  );

  const undoUpdate: LineageGitShape["undoUpdate"] = Effect.fn("LineageGit.undoUpdate")(
    function* (input) {
      const operation = "undoUpdate";
      const { top } = yield* repoPaths(operation, input.cwd);
      if (input.pushed) {
        // Pushed history is never rewritten: a commit undoes the merge instead.
        yield* git(operation, top, ["revert", "--no-edit", "-m", "1", input.mergeCommit], {
          env: authorEnv(input.author),
        });
        return { undoCommit: yield* gitLine(operation, top, ["rev-parse", "HEAD"]) };
      }
      if ((yield* gitLine(operation, top, ["rev-parse", "HEAD"])) !== input.mergeCommit) {
        return yield* new LineageGitError({ operation, reason: "head-moved" });
      }
      yield* restoreBranch(operation, top, input.preUpdateHead, input.wipCommit);
      return { undoCommit: null };
    },
  );

  const offerCommits: LineageGitShape["offerCommits"] = Effect.fn("LineageGit.offerCommits")(
    function* ({ cwd, sourceHead, sourceTree, exclude }) {
      const operation = "offerCommits";
      const repo = yield* repoPaths(operation, cwd);
      const excluded = new Set(exclude);
      const candidates = (yield* git(operation, repo.top, [
        "rev-list",
        "--no-merges",
        "--reverse",
        "HEAD",
        "--not",
        sourceHead,
      ])).stdout
        .split("\n")
        .filter((sha) => sha.length > 0 && !excluded.has(sha));
      if (candidates.length === 0) return [];

      // A commit's change is in effect on a tree when its diff applies to that tree in reverse.
      // One line of context keeps a nearby later edit from hiding it, while still anchoring deletions.
      // Both trees are read into scratch indexes, so no working tree or real index is touched.
      const inEffect = yield* withScratchFile(operation, repo, (tipIndex) =>
        withScratchFile(operation, repo, (sourceIndex) =>
          withScratchFile(operation, repo, (patchPath) =>
            Effect.gen(function* () {
              yield* git(operation, repo.top, ["read-tree", "HEAD^{tree}"], {
                env: { GIT_INDEX_FILE: tipIndex },
              });
              yield* git(operation, repo.top, ["read-tree", `${sourceTree}^{tree}`], {
                env: { GIT_INDEX_FILE: sourceIndex },
              });
              const appliesInReverse = (index: string) =>
                git(
                  operation,
                  repo.top,
                  ["apply", "--check", "-R", "--cached", "--whitespace=nowarn", patchPath],
                  { env: { GIT_INDEX_FILE: index }, allowNonZeroExit: true },
                ).pipe(Effect.map((result) => result.exitCode === 0));
              return yield* Effect.filter(candidates, (sha) =>
                Effect.gen(function* () {
                  // Written by git straight to disk, so file bytes never pass through a JS string.
                  yield* git(operation, repo.top, [
                    "diff-tree",
                    "-p",
                    "--binary",
                    "--full-index",
                    "-U1",
                    "--no-renames",
                    "--no-color",
                    `--output=${patchPath}`,
                    sha,
                  ]);
                  return (
                    (yield* appliesInReverse(tipIndex)) && !(yield* appliesInReverse(sourceIndex))
                  );
                }),
              );
            }),
          ),
        ),
      );
      if (inEffect.length === 0) return [];

      const patches = yield* git(
        operation,
        repo.top,
        [
          "diff-tree",
          "--stdin",
          "-p",
          "-U1",
          "--binary",
          "--full-index",
          "--no-renames",
          "--no-color",
        ],
        { stdin: `${inEffect.join("\n")}\n` },
      );
      const patchIds = new Map<string, string>();
      for (const line of (yield* git(operation, repo.top, ["patch-id", "--stable"], {
        stdin: patches.stdout,
      })).stdout.split("\n")) {
        const [patchId, sha] = line.split(" ");
        if (patchId && sha) patchIds.set(sha, patchId);
      }
      const details = new Map<string, { subject: string; authorName: string }>();
      const log = yield* git(operation, repo.top, [
        "log",
        "--no-walk=unsorted",
        "--format=%H%x00%an%x00%s%x00",
        ...inEffect,
      ]);
      const fields = log.stdout.split("\0");
      for (let index = 0; index + 2 < fields.length; index += 3) {
        details.set(fields[index]!.trim(), {
          authorName: fields[index + 1]!,
          subject: fields[index + 2]!,
        });
      }

      // A change cherry-picked back counts once: the newest commit with its patch id stays.
      const seen = new Set<string>();
      const kept: OfferCommit[] = [];
      for (const sha of [...inEffect].reverse()) {
        const patchId = patchIds.get(sha) ?? sha;
        if (seen.has(patchId)) continue;
        seen.add(patchId);
        const detail = details.get(sha) ?? { subject: "", authorName: "" };
        kept.push({ sha, patchId, ...detail });
      }
      return kept.reverse();
    },
  );

  const buildOffer: LineageGitShape["buildOffer"] = Effect.fn("LineageGit.buildOffer")(function* ({
    cwd,
    base,
    commits,
    author,
    message,
  }) {
    const operation = "buildOffer";
    const env = authorEnv(author);
    let accumulated = base;
    let tree = yield* gitLine(operation, cwd, ["rev-parse", `${base}^{tree}`]);
    // Cherry-picks in memory: each commit's own change, onto what came before it.
    for (const sha of commits) {
      const parent = yield* gitLine(operation, cwd, ["rev-parse", `${sha}^1`]);
      const merge = yield* mergeTree(operation, cwd, {
        base: parent,
        ours: accumulated,
        theirs: sha,
      });
      if (merge.conflicts.length > 0) {
        return yield* new LineageGitError({
          operation,
          reason: "offer-conflict",
          paths: merge.conflicts,
          detail: sha,
        });
      }
      tree = merge.tree;
      accumulated = yield* gitLine(
        operation,
        cwd,
        ["commit-tree", tree, "-p", accumulated, "-m", message],
        { env },
      );
    }
    const tip = yield* gitLine(operation, cwd, ["commit-tree", tree, "-p", base, "-m", message], {
      env,
    });
    const files = yield* offerFiles(operation, cwd, base, tip);
    return {
      tip,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  });

  const checkOffer: LineageGitShape["checkOffer"] = Effect.fn("LineageGit.checkOffer")(function* ({
    cwd,
    base,
    tip,
    against,
  }) {
    const merge = yield* mergeTree("checkOffer", cwd, { base, ours: against, theirs: tip });
    return merge.conflicts.length === 0
      ? { clean: true as const, resultTree: merge.tree }
      : { clean: false as const, paths: merge.conflicts };
  });

  /** Writes `paths` as `tree` has them, through a scratch index; HEAD and the real index stay. */
  const writePaths = Effect.fnUntraced(function* (
    operation: string,
    repo: RepoPaths,
    tree: string,
    paths: ReadonlyArray<string>,
  ) {
    const present = new Set<string>();
    const batch = yield* git(operation, repo.top, ["cat-file", "--batch-check=%(objecttype)"], {
      stdin: paths.map((file) => `${tree}:${file}\n`).join(""),
    });
    batch.stdout.split("\n").forEach((type, index) => {
      if (type === "blob" && index < paths.length) present.add(paths[index]!);
    });
    yield* withScratchFile(operation, repo, (indexPath) =>
      Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: indexPath };
        yield* git(operation, repo.top, [...INDEX_CONFIG_ARGS, "read-tree", tree], { env });
        if (present.size === 0) return;
        yield* git(
          operation,
          repo.top,
          [...INDEX_CONFIG_ARGS, "checkout-index", "--force", "-z", "--stdin"],
          {
            env,
            stdin: `${[...present].join("\0")}\0`,
          },
        );
      }),
    );
    const fileSystem = yield* fileSystemFor(operation, repo.top);
    yield* Effect.forEach(
      paths.filter((file) => !present.has(file)),
      (file) =>
        fileSystem
          .remove(path.join(repo.top, file), { force: true })
          .pipe(Effect.mapError((cause) => failed(operation, cause.message))),
      { discard: true },
    );
  });

  /**
   * Merges `theirs` onto a fresh capture of the worktree and writes only the offer's files. When one
   * of them changes between the check and the write, it checks again, up to `maxTries` times.
   */
  const writeOffer = Effect.fnUntraced(function* (
    operation: string,
    input: OfferWriteInput & { readonly mergeBase: string; readonly theirs: string },
    files: ReadonlyArray<OfferFile>,
  ) {
    const repo = yield* repoPaths(operation, input.cwd);
    const paths = unique(
      files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
    );
    const offerPaths = new Set(paths);
    const maxTries = input.maxTries ?? 3;
    for (let attempt = 1; ; attempt++) {
      const checked = yield* worktreeTree({ cwd: repo.top });
      const merge = yield* mergeTree(operation, repo.top, {
        base: input.mergeBase,
        ours: checked.commit,
        theirs: input.theirs,
      });
      if (merge.conflicts.length > 0) {
        return { type: "returned" as const, reason: "conflict" as const, paths: merge.conflicts };
      }
      if (input.beforeWrite) yield* input.beforeWrite;
      const current = yield* worktreeTree({ cwd: repo.top });
      const moved =
        current.tree === checked.tree
          ? []
          : (yield* changedPaths(operation, repo.top, checked.tree, current.tree)).filter((file) =>
              offerPaths.has(file),
            );
      if (moved.length > 0) {
        if (attempt >= maxTries) {
          return { type: "returned" as const, reason: "retries" as const, paths: moved };
        }
        continue;
      }
      yield* writePaths(operation, repo, merge.tree, paths);
      return null;
    }
  });

  const applyOffer: LineageGitShape["applyOffer"] = Effect.fn("LineageGit.applyOffer")(
    function* (input) {
      const operation = "applyOffer";
      const files = yield* offerFiles(operation, input.cwd, input.base, input.tip);
      const returned = yield* writeOffer(
        operation,
        { ...input, mergeBase: input.base, theirs: input.tip },
        files,
      );
      if (returned !== null) return returned;
      const added = yield* addedLinesBetween(operation, input.cwd, input.base, input.tip, {
        renames: true,
      });
      const addedLines = [...added].flatMap(([file, lines]) => {
        const creditable = unique(lines.map(trimCreditLine).filter(isCreditableLine));
        return creditable.length === 0 ? [] : [{ path: file, lines: creditable }];
      });
      return { type: "applied" as const, files, addedLines };
    },
  );

  const revertOffer: LineageGitShape["revertOffer"] = Effect.fn("LineageGit.revertOffer")(
    function* (input) {
      const operation = "revertOffer";
      const files = yield* offerFiles(operation, input.cwd, input.base, input.tip);
      const returned = yield* writeOffer(
        operation,
        { ...input, mergeBase: input.tip, theirs: input.base },
        files,
      );
      return returned ?? { type: "reverted" as const, files };
    },
  );

  const cherryPickBack: LineageGitShape["cherryPickBack"] = Effect.fn("LineageGit.cherryPickBack")(
    function* ({ cwd, commits, author, wipMessage }) {
      const operation = "cherryPickBack";
      const { top } = yield* repoPaths(operation, cwd);
      const env = authorEnv(author);
      const preUpdateHead = yield* gitLine(operation, top, ["rev-parse", "HEAD"]);
      const wipCommit = yield* commitWip(operation, top, author, wipMessage);
      const picked: string[] = [];
      for (const [index, sha] of commits.entries()) {
        const pick = yield* git(operation, top, ["cherry-pick", sha], {
          env,
          allowNonZeroExit: true,
        });
        if (pick.exitCode !== 0) {
          if (!(yield* refExists(operation, top, "CHERRY_PICK_HEAD"))) {
            yield* restoreBranch(operation, top, preUpdateHead, wipCommit);
            return yield* failed(operation, pick.stderr.trim() || "git cherry-pick failed.");
          }
          const conflictedPaths = yield* unmergedPaths(operation, top);
          if (conflictedPaths.length === 0) {
            // Already on the branch: nothing to bring back for this one.
            yield* git(operation, top, ["cherry-pick", "--skip"]);
            continue;
          }
          return {
            preUpdateHead,
            wipCommit,
            result: {
              type: "conflicted" as const,
              conflictedPaths,
              picked,
              remaining: commits.slice(index + 1),
            },
          };
        }
        // A cherry-pick keeps the original author; the brought-back commit is the brancher's.
        yield* git(
          operation,
          top,
          ["commit", "--amend", "--no-edit", "--no-verify", "--quiet", "--reset-author"],
          {
            env,
          },
        );
        picked.push(yield* gitLine(operation, top, ["rev-parse", "HEAD"]));
      }
      return { preUpdateHead, wipCommit, result: { type: "picked" as const, commits: picked } };
    },
  );

  const creditPaths = Effect.fnUntraced(function* (operation: string, cwd: string) {
    const repo = yield* repoPaths(operation, cwd);
    const pairDir = path.join(repo.gitDir, "pair");
    return {
      repo,
      pairDir,
      recordPath: path.join(pairDir, "credit.json"),
      entriesDir: path.join(pairDir, "credit"),
      fileSystem: yield* fileSystemFor(operation, repo.top),
    };
  });

  const installCreditHook: LineageGitShape["installCreditHook"] = Effect.fn(
    "LineageGit.installCreditHook",
  )(function* ({ cwd, hooksDir }) {
    const operation = "installCreditHook";
    const { repo, pairDir, fileSystem } = yield* creditPaths(operation, cwd);
    const dir = hooksDir ?? path.join(pairDir, "hooks");
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(dir, { recursive: true });
      yield* Effect.forEach(
        creditHookFiles(),
        ({ name, content }) =>
          Effect.gen(function* () {
            const file = path.join(dir, name);
            yield* fileSystem.writeFileString(file, content);
            yield* fileSystem.chmod(file, 0o755);
          }),
        { discard: true },
      );
    }).pipe(Effect.mapError((cause) => failed(operation, cause.message)));
    // With worktree config on, a bare repository's core.bare and core.worktree must move to the
    // main worktree's own config, or every linked worktree would read them (as `git sparse-checkout` does).
    yield* git(operation, repo.top, ["config", "--local", "extensions.worktreeConfig", "true"]);
    for (const key of ["core.bare", "core.worktree"]) {
      const value = yield* git(operation, repo.top, ["config", "--local", "--get", key], {
        allowNonZeroExit: true,
      });
      const setting = value.stdout.trim();
      if (value.exitCode !== 0 || (key === "core.bare" && setting !== "true")) continue;
      yield* git(operation, repo.top, [
        "config",
        "--file",
        path.join(repo.commonDir, "config.worktree"),
        key,
        setting,
      ]);
      yield* git(operation, repo.top, ["config", "--local", "--unset", key]);
    }
    yield* git(operation, repo.top, ["config", "--worktree", "core.hooksPath", dir]);
    return { hooksDir: dir };
  });

  const readCredit = Effect.fnUntraced(function* (
    fileSystem: Effect.Success<ReturnType<typeof fileSystemFor>>,
    recordPath: string,
  ) {
    const contents = yield* fileSystem.readFileString(recordPath).pipe(Effect.option);
    if (Option.isNone(contents)) return [];
    // A record that no longer decodes credits no one rather than blocking the apply.
    return yield* decodeCreditRecord(contents.value).pipe(
      Effect.map((record) => record.entries),
      Effect.orElseSucceed((): ReadonlyArray<CreditEntry> => []),
    );
  });

  const writeCredit = Effect.fnUntraced(function* (
    operation: string,
    paths: Effect.Success<ReturnType<typeof creditPaths>>,
    entries: ReadonlyArray<CreditEntry>,
  ) {
    const { fileSystem, recordPath, entriesDir } = paths;
    yield* Effect.gen(function* () {
      yield* fileSystem.remove(entriesDir, { recursive: true, force: true });
      if (entries.length === 0) {
        yield* fileSystem.remove(recordPath, { force: true });
        return;
      }
      yield* fileSystem.makeDirectory(entriesDir, { recursive: true });
      yield* fileSystem.writeFileString(recordPath, yield* encodeCreditRecord({ entries }));
      yield* Effect.forEach(
        entries,
        (entry, index) =>
          Effect.gen(function* () {
            const dir = path.join(entriesDir, String(index));
            yield* fileSystem.makeDirectory(dir, { recursive: true });
            yield* fileSystem.writeFileString(path.join(dir, "path"), `${entry.path}\n`);
            yield* fileSystem.writeFileString(path.join(dir, "coauthor"), `${entry.coAuthor}\n`);
            yield* fileSystem.writeFileString(
              path.join(dir, "lines"),
              `${entry.lines.join("\n")}\n`,
            );
          }),
        { discard: true },
      );
    }).pipe(Effect.mapError((cause) => failed(operation, cause.message)));
  });

  const recordCredit: LineageGitShape["recordCredit"] = Effect.fn("LineageGit.recordCredit")(
    function* ({ cwd, coAuthor, lines }) {
      const operation = "recordCredit";
      const paths = yield* creditPaths(operation, cwd);
      const author = coAuthor.replace(/[\r\n]+/g, " ").trim();
      const entries = [...(yield* readCredit(paths.fileSystem, paths.recordPath))];
      for (const file of lines) {
        if (/[\r\n]/.test(file.path)) continue;
        const recorded = file.lines.map(trimCreditLine).filter(isCreditableLine);
        if (recorded.length === 0) continue;
        const index = entries.findIndex(
          (entry) => entry.path === file.path && entry.coAuthor === author,
        );
        const existing = index === -1 ? [] : entries[index]!.lines;
        const entry = {
          path: file.path,
          coAuthor: author,
          lines: unique([...existing, ...recorded]),
        };
        if (index === -1) entries.push(entry);
        else entries[index] = entry;
      }
      yield* writeCredit(operation, paths, entries);
    },
  );

  const pruneCredit: LineageGitShape["pruneCredit"] = Effect.fn("LineageGit.pruneCredit")(
    function* ({ cwd }) {
      const operation = "pruneCredit";
      const paths = yield* creditPaths(operation, cwd);
      const entries = yield* readCredit(paths.fileSystem, paths.recordPath);
      if (entries.length === 0) return { remainingLines: 0 };
      const capture = yield* worktreeTree({ cwd });
      const uncommitted = yield* addedLinesBetween(
        operation,
        paths.repo.top,
        "HEAD",
        capture.commit,
        {
          renames: false,
          paths: unique(entries.map((entry) => entry.path)),
        },
      );
      const kept = entries.flatMap((entry) => {
        const present = new Set((uncommitted.get(entry.path) ?? []).map(trimCreditLine));
        const lines = entry.lines.filter((line) => present.has(line));
        return lines.length === 0 ? [] : [{ ...entry, lines }];
      });
      yield* writeCredit(operation, paths, kept);
      return { remainingLines: kept.reduce((sum, entry) => sum + entry.lines.length, 0) };
    },
  );

  const resolveCommit: LineageGitShape["resolveCommit"] = Effect.fn("LineageGit.resolveCommit")(
    function* ({ cwd, rev }) {
      const result = yield* git(
        "resolveCommit",
        cwd,
        ["rev-parse", "--quiet", "--verify", `${rev}^{commit}`],
        { allowNonZeroExit: true },
      );
      const sha = result.stdout.trim();
      return result.exitCode === 0 && sha !== "" ? sha : null;
    },
  );

  const uncommittedPaths: LineageGitShape["uncommittedPaths"] = Effect.fn(
    "LineageGit.uncommittedPaths",
  )(function* ({ cwd }) {
    const status = yield* git(
      "uncommittedPaths",
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      { env: { GIT_OPTIONAL_LOCKS: "0" } },
    );
    return unique(nulFields(status.stdout).map((entry) => entry.slice(3)));
  });

  const commitAll: LineageGitShape["commitAll"] = Effect.fn("LineageGit.commitAll")(function* ({
    cwd,
    author,
    message,
  }) {
    const { top } = yield* repoPaths("commitAll", cwd);
    return yield* commitWip("commitAll", top, author, message);
  });

  const mergeOf: LineageGitShape["mergeOf"] = Effect.fn("LineageGit.mergeOf")(function* ({
    cwd,
    snapshot,
  }) {
    const operation = "mergeOf";
    const contained = yield* git(
      operation,
      cwd,
      ["merge-base", "--is-ancestor", snapshot, "HEAD"],
      { allowNonZeroExit: true },
    );
    if (contained.exitCode !== 0) return null;
    const merges = yield* git(operation, cwd, [
      "rev-list",
      "--merges",
      "--parents",
      "HEAD",
      "--not",
      `${snapshot}^@`,
    ]);
    for (const line of merges.stdout.split("\n")) {
      const [sha, ...parents] = line.trim().split(" ");
      if (sha && parents.slice(1).includes(snapshot)) return sha;
    }
    return null;
  });

  const isPushed: LineageGitShape["isPushed"] = Effect.fn("LineageGit.isPushed")(function* ({
    cwd,
    commit,
  }) {
    const operation = "isPushed";
    const upstream = yield* git(
      operation,
      cwd,
      ["rev-parse", "--quiet", "--verify", "@{upstream}"],
      { allowNonZeroExit: true },
    );
    if (upstream.exitCode !== 0) return false;
    const contained = yield* git(
      operation,
      cwd,
      ["merge-base", "--is-ancestor", commit, upstream.stdout.trim()],
      { allowNonZeroExit: true },
    );
    return contained.exitCode === 0;
  });

  const offerDiff: LineageGitShape["offerDiff"] = Effect.fn("LineageGit.offerDiff")(function* ({
    cwd,
    base,
    tip,
  }) {
    const operation = "offerDiff";
    const files = yield* offerFiles(operation, cwd, base, tip);
    // The same diff queue as `offerFiles`, so patches line up with files by position.
    const patch = yield* git(operation, cwd, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "-r",
      "-p",
      "-M",
      "--no-color",
      base,
      tip,
    ]);
    const chunks = splitPatch(patch.stdout.trimEnd());
    return files.map(({ additions: _additions, deletions: _deletions, ...file }, index) => ({
      ...file,
      patch: chunks[index] ?? "",
    }));
  });

  return LineageGit.of({
    offerDiff,
    resolveCommit,
    uncommittedPaths,
    commitAll,
    mergeOf,
    isPushed,
    worktreeTree,
    createSnapshot,
    addBranchWorktree,
    previewUpdate,
    startUpdate,
    updateState,
    abortUpdate,
    undoUpdate,
    offerCommits,
    buildOffer,
    checkOffer,
    applyOffer,
    revertOffer,
    cherryPickBack,
    installCreditHook,
    recordCredit,
    pruneCredit,
  });
});

export const layer = Layer.effect(LineageGit, make);
