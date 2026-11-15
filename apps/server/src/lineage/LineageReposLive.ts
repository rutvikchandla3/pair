import { BranchLineageError, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import { LineageRepos } from "./LineageRepos.ts";

const SEED_HEAD_REF = "refs/t3/seed/origin/HEAD";
const PAIR_COMMITTER = {
  GIT_COMMITTER_NAME: "Pair",
  GIT_COMMITTER_EMAIL: "pair@users.noreply.github.com",
};

/** Where a carried commit stays reachable in the mirror, under the receiving thread. */
export const lineageCommitRef = (threadId: ThreadId, sha: string) =>
  `refs/t3/lineage/${Base64Url.encode(threadId)}/${sha}`;

export const lineageFailed = (message: string) =>
  new BranchLineageError({ reason: "failed", message });

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Git on a thread's machine, the server, or the mirror (pass `--git-dir`), as a plain process on
 * the host, the way `MirrorSync` runs it; bundles stream to a server file instead of a string.
 */
export const runGit = Effect.fn("LineageTransport.runGit")(function* (
  host: WorkspaceHost,
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string>; readonly toFile?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const child = yield* host.spawner.spawn(
    ChildProcess.make("git", args, {
      cwd,
      stdin: "ignore",
      ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      options.toFile === undefined
        ? child.stdout.pipe(Stream.decodeText(), Stream.mkString)
        : child.stdout.pipe(Stream.run(fs.sink(options.toFile)), Effect.as("")),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr: stderr.slice(-2000), exitCode: Number(exitCode) } satisfies GitResult;
}, Effect.scoped);

const gitOk = (
  host: WorkspaceHost,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: Record<string, string>; readonly toFile?: string },
) =>
  runGit(host, cwd, args, options).pipe(
    Effect.mapError((cause) => lineageFailed(`git ${args[0] ?? ""} failed: ${String(cause)}`)),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(lineageFailed(result.stderr.trim() || `git ${args.join(" ")} failed.`)),
    ),
  );

/** The commits of `oids` the repository at `cwd` (or `--git-dir`, in `args`) holds. */
const heldCommits = Effect.fn("LineageTransport.heldCommits")(function* (
  host: WorkspaceHost,
  cwd: string,
  oids: ReadonlyArray<string>,
  gitDirArgs: ReadonlyArray<string> = [],
) {
  if (oids.length === 0) return new Set<string>();
  const result = yield* runGit(host, cwd, [
    ...gitDirArgs,
    "rev-list",
    "--no-walk",
    "--ignore-missing",
    ...oids,
  ]).pipe(Effect.mapError((cause) => lineageFailed(String(cause))));
  return new Set(result.stdout.split("\n").filter((line) => line !== ""));
});

/** Git in a project's mirror on the server, which is bare: every command names its directory. */
export const mirrorGit = Effect.fn("LineageTransport.mirrorGit")(function* (
  projectId: ProjectId,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
) {
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const gitDir = mirror.gitDir(projectId);
  return yield* gitOk(
    hosts.local,
    gitDir,
    [`--git-dir=${gitDir}`, ...args],
    env === undefined ? {} : { env: { ...PAIR_COMMITTER, ...env } },
  );
});

const tempBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const dir = path.join(stateDir, "sandbox", "tmp");
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const file = path.join(
    dir,
    `lineage-${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}.bundle`,
  );
  yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore));
  return file;
}).pipe(Effect.mapError((cause) => lineageFailed(`No room for a bundle: ${String(cause)}`)));

/** Prerequisites both sides hold, so a bundle carries only what the receiver lacks. */
const sharedPrerequisites = Effect.fn("LineageTransport.sharedPrerequisites")(function* (
  host: WorkspaceHost,
  cwd: string,
  candidates: ReadonlyArray<string | undefined>,
) {
  const wanted = [...new Set(candidates.filter((oid) => oid !== undefined))];
  return [...(yield* heldCommits(host, cwd, wanted))];
});

/**
 * Copies commits from a checkout on a machine (or the server) into the mirror under
 * `lineageCommitRef(owner, sha)`. The server picks every ref name; the machine only makes bytes.
 */
const pushToMirror = Effect.fn("LineageTransport.pushToMirror")(function* (input: {
  readonly projectId: ProjectId;
  readonly owner: ThreadId;
  readonly cwd: string;
  readonly commits: ReadonlyArray<string>;
}) {
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  if (input.commits.length === 0) return;
  yield* mirror.ensure(input.projectId).pipe(Effect.mapError((e) => lineageFailed(e.message)));
  const host = yield* hosts
    .forPath(input.cwd)
    .pipe(Effect.mapError(() => lineageFailed("That thread's machine isn't reachable.")));
  const refs = input.commits.map((sha) => lineageCommitRef(input.owner, sha));
  // Temporary refs in the clone name the commits for `git bundle`; the mirror keeps its own.
  yield* Effect.forEach(
    input.commits,
    (sha, index) => gitOk(host, input.cwd, ["update-ref", refs[index]!, sha]),
    { discard: true },
  );
  const tips = yield* mirror
    .tips(input.projectId, [SEED_HEAD_REF])
    .pipe(Effect.mapError((e) => lineageFailed(e.message)));
  const prerequisites = yield* sharedPrerequisites(host, input.cwd, [tips.get(SEED_HEAD_REF)]);
  const file = yield* tempBundle;
  const bundled = yield* runGit(
    host,
    input.cwd,
    ["bundle", "create", "--quiet", "-", ...refs, ...prerequisites.map((oid) => `^${oid}`)],
    { toFile: file },
  ).pipe(
    Effect.mapError((cause) => lineageFailed(String(cause))),
    Effect.ensuring(
      Effect.forEach(refs, (ref) => runGit(host, input.cwd, ["update-ref", "-d", ref]), {
        discard: true,
      }).pipe(Effect.ignore),
    ),
  );
  if (bundled.exitCode === 0) {
    yield* mirror
      .importBundle({
        projectId: input.projectId,
        bundlePath: file,
        refs: refs.map((ref) => ({ source: ref, target: ref })),
      })
      .pipe(Effect.mapError((e) => lineageFailed(e.message)));
    return;
  }
  if (!bundled.stderr.includes("Refusing to create empty bundle")) {
    return yield* lineageFailed(bundled.stderr.trim() || "git bundle failed.");
  }
  // Every commit is reachable from the seed, which the mirror holds.
  yield* mirror
    .updateRefs(input.projectId, new Map(refs.map((ref, index) => [ref, input.commits[index]!])))
    .pipe(Effect.mapError((e) => lineageFailed(e.message)));
}, Effect.scoped);

/**
 * Brings mirror commits into a checkout's repository, the way `MirrorSync.restore` does: a bundle
 * from the mirror, written into the receiving clone and fetched under the same lineage refs.
 */
const pullFromMirror = Effect.fn("LineageTransport.pullFromMirror")(function* (input: {
  readonly projectId: ProjectId;
  readonly owner: ThreadId;
  readonly cwd: string;
  readonly commits: ReadonlyArray<string>;
}) {
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* hosts
    .forPath(input.cwd)
    .pipe(Effect.mapError(() => lineageFailed("That thread's machine isn't reachable.")));
  const held = yield* heldCommits(host, input.cwd, input.commits);
  const wanted = input.commits.filter((sha) => !held.has(sha));
  if (wanted.length === 0) return;
  const refs = new Map(wanted.map((sha) => [lineageCommitRef(input.owner, sha), sha]));
  yield* mirror
    .updateRefs(input.projectId, refs)
    .pipe(Effect.mapError((e) => lineageFailed(e.message)));
  const gitDir = mirror.gitDir(input.projectId);
  const tips = yield* mirror
    .tips(input.projectId, [SEED_HEAD_REF])
    .pipe(Effect.mapError((e) => lineageFailed(e.message)));
  const prerequisites = yield* sharedPrerequisites(host, input.cwd, [tips.get(SEED_HEAD_REF)]);
  const file = yield* tempBundle;
  yield* gitOk(
    hosts.local,
    gitDir,
    [
      `--git-dir=${gitDir}`,
      "bundle",
      "create",
      "--quiet",
      "-",
      ...refs.keys(),
      ...prerequisites.map((oid) => `^${oid}`),
    ],
    { toFile: file },
  );
  const commonDir = (yield* gitOk(host, input.cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).trim();
  const remote = `${commonDir}/t3-lineage-${path.basename(file)}`;
  yield* Effect.addFinalizer(() =>
    host.fileSystem.remove(remote, { force: true }).pipe(Effect.ignore),
  );
  const bytes = yield* fs
    .readFile(file)
    .pipe(Effect.mapError((cause) => lineageFailed(String(cause))));
  yield* host.fileSystem
    .writeFile(remote, bytes)
    .pipe(Effect.mapError((cause) => lineageFailed(String(cause))));
  yield* gitOk(host, input.cwd, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    ...[...refs.keys()].map((ref) => `+${ref}:${ref}`),
  ]);
}, Effect.scoped);

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | CheckpointMirror.CheckpointMirror
    | WorkspaceHosts.WorkspaceHosts
  >();

  const threadOf = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
      Effect.mapError(() => lineageFailed(`Could not read thread ${threadId}.`)),
      Effect.filterOrFail(
        (thread): thread is NonNullable<typeof thread> =>
          thread !== null && thread.deletedAt === null,
        () => new BranchLineageError({ reason: "not-found", message: "That thread is gone." }),
      ),
    );

  const cwdFor: LineageRepos["Service"]["cwdFor"] = Effect.fn("LineageRepos.cwdFor")(
    function* (threadId) {
      const thread = yield* threadOf(threadId);
      if (thread.roots !== undefined) {
        return yield* lineageFailed("Branch off doesn't support workspace threads yet.");
      }
      if (thread.worktreePath === null) {
        return yield* lineageFailed("This thread has no checkout of its own.");
      }
      return thread.worktreePath;
    },
  );

  const carry = Effect.fn("LineageRepos.carry")(function* ({
    from,
    to,
    commits,
  }: Parameters<LineageRepos["Service"]["carry"]>[0]) {
    if (commits.length === 0) return;
    const [source, target] = [yield* threadOf(from), yield* threadOf(to)];
    // One clone holds both: a machine's threads share it, and local threads share the project's.
    if (source.sandboxId === target.sandboxId) return;
    const toCwd = yield* cwdFor(to);
    const toHost = yield* hosts
      .forPath(toCwd)
      .pipe(Effect.mapError(() => lineageFailed("That thread's machine isn't reachable.")));
    const inTarget = yield* heldCommits(toHost, toCwd, commits);
    const needed = commits.filter((sha) => !inTarget.has(sha));
    if (needed.length === 0) return;
    const projectId = target.projectId;
    yield* mirror.ensure(projectId).pipe(Effect.mapError((e) => lineageFailed(e.message)));
    const gitDir = mirror.gitDir(projectId);
    const inMirror = yield* heldCommits(hosts.local, gitDir, needed, [`--git-dir=${gitDir}`]);
    const fromMachine = needed.filter((sha) => !inMirror.has(sha));
    if (fromMachine.length > 0) {
      // A sleeping machine's captured work is in the mirror already; never wake one for this.
      const record =
        source.sandboxId === undefined
          ? null
          : yield* projections
              .getSandbox(source.sandboxId)
              .pipe(Effect.mapError(() => lineageFailed("Could not read the machine.")));
      if (record !== null && record.state !== "ready") {
        return yield* lineageFailed(
          "Those commits are on a machine that's asleep and haven't reached the mirror yet.",
        );
      }
      yield* pushToMirror({ projectId, owner: to, cwd: yield* cwdFor(from), commits: fromMachine });
    }
    yield* pullFromMirror({ projectId, owner: to, cwd: toCwd, commits: needed });
  });

  return LineageRepos.of({
    cwdFor,
    // @effect-diagnostics-next-line effectFnOpportunity:off
    carry: (input) => carry(input).pipe(Effect.provide(context)),
  });
});

export const layer = Layer.effect(LineageRepos, make);
