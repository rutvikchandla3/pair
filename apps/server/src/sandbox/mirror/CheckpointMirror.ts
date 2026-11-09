import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_HEADER_BYTES = 1024 * 1024;
const BUNDLE_HEADER_CHUNK_BYTES = 64 * 1024;
// Seeding copies objects only remote branches reach, and a bundle may be 512 MiB.
const LONG_GIT_TIMEOUT_MS = 10 * 60_000;
const SEED_ORIGIN_REFSPEC = "+refs/remotes/origin/*:refs/t3/seed/origin/*";

export class CheckpointMirrorError extends Schema.TaggedError<CheckpointMirrorError>()(
  "CheckpointMirrorError",
  {
    projectId: ProjectId,
    operation: Schema.Literals(["seed", "import", "delete-refs", "remove", "maintain"]),
    reason: Schema.Literals([
      "missing-project",
      "missing-prerequisite",
      "invalid-objects",
      "too-large",
      "git",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Checkpoint mirror ${this.operation} failed for project ${this.projectId}: ${this.reason}.`;
  }
}

export interface MirrorRefUpdate {
  /** The ref name inside the bundle. */
  readonly source: string;
  /** Where it lands in the mirror. */
  readonly target: string;
}

export class CheckpointMirror extends Context.Service<
  CheckpointMirror,
  {
    /** `<stateDir>/sandbox/mirrors/<base64url(projectId)>.git`. Never under /t3-sandbox/. */
    readonly gitDir: (projectId: ProjectId) => string;
    /** Creates and seeds the mirror once; later calls refresh only the seed's origin refs. */
    readonly ensure: (projectId: ProjectId) => Effect.Effect<string, CheckpointMirrorError>;
    /** The oids the mirror holds for these refs; absent refs are left out. */
    readonly tips: (
      projectId: ProjectId,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, CheckpointMirrorError>;
    /** Checks every object strictly, then moves only the named refs. Others in the bundle are ignored. */
    readonly importBundle: (input: {
      readonly projectId: ProjectId;
      readonly bundlePath: string;
      readonly refs: ReadonlyArray<MirrorRefUpdate>;
    }) => Effect.Effect<ReadonlyMap<string, string>, CheckpointMirrorError>;
    /** Points refs (target -> oid) at objects the mirror already holds; a missing object fails. */
    readonly updateRefs: (
      projectId: ProjectId,
      refs: ReadonlyMap<string, string>,
    ) => Effect.Effect<void, CheckpointMirrorError>;
    readonly deleteRefs: (
      projectId: ProjectId,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<void, CheckpointMirrorError>;
    /** `git maintenance run --auto`, which also prunes objects of deleted refs. */
    readonly maintain: (projectId: ProjectId) => Effect.Effect<void, CheckpointMirrorError>;
    /** Deletes refs under `sandboxThreadRefPrefix(threadId)`. */
    readonly deleteThreadNamespace: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<void, CheckpointMirrorError>;
    readonly remove: (projectId: ProjectId) => Effect.Effect<void>;
    /** Every mirror's size on disk; files removed mid-walk count as nothing. */
    readonly diskBytes: Effect.Effect<number>;
  }
>()("t3/sandbox/mirror/CheckpointMirror") {}

/** For readers that never write, which need no lock and no seed (StoppedSandboxReads). */
export const mirrorGitDir = (path: Path.Path, stateDir: string, projectId: ProjectId) =>
  path.join(stateDir, "sandbox", "mirrors", `${Base64Url.encode(projectId)}.git`);

/** A thread's own mirror namespace; the id is encoded because a ThreadId may not be a valid ref segment. */
export const sandboxThreadRefPrefix = (threadId: ThreadId) =>
  `refs/t3/sandbox/${Base64Url.encode(threadId)}/`;

/** A checkout's working tree when its machine last went to sleep; same name in clone and mirror. */
export const sandboxSnapshotRef = (threadId: ThreadId) =>
  CheckpointRef.make(`${sandboxThreadRefPrefix(threadId)}snapshot`);

interface BundleHeader {
  readonly prerequisites: ReadonlyArray<string>;
  readonly refs: ReadonlyMap<string, string>;
  /** Byte offset of the pack that follows the header. */
  readonly packOffset: number;
}

const OID = "[0-9a-f]{40}";
const OID_ONLY = new RegExp(`^${OID}$`);
const PREREQUISITE_LINE = new RegExp(`^-(${OID})(?: .*)?$`);
const REF_LINE = new RegExp(`^(${OID}) (refs/\\S+|HEAD)$`);

/** Parses a v2 bundle header (`git help bundle-format`); null when it is not one. */
const parseBundleHeader = (text: string, packOffset: number): BundleHeader | null => {
  const [signature, ...lines] = text.split("\n");
  if (signature !== "# v2 git bundle") return null;
  const prerequisites: string[] = [];
  const refs = new Map<string, string>();
  for (const line of lines) {
    const prerequisite = PREREQUISITE_LINE.exec(line);
    if (prerequisite !== null) {
      prerequisites.push(prerequisite[1]!);
      continue;
    }
    const ref = REF_LINE.exec(line);
    if (ref === null) return null;
    refs.set(ref[2]!, ref[1]!);
  }
  return { prerequisites, refs, packOffset };
};

const indexOfBlankLine = (bytes: Uint8Array, from: number) => {
  for (let index = Math.max(1, from); index < bytes.length; index++) {
    if (bytes[index] === 0x0a && bytes[index - 1] === 0x0a) return index - 1;
  }
  return -1;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const mirrorsDir = path.join(stateDir, "sandbox", "mirrors");
  const writeLocks = yield* KeyedLock.make<ProjectId>();

  const gitDir = (projectId: ProjectId) => mirrorGitDir(path, stateDir, projectId);

  const fail =
    (
      projectId: ProjectId,
      operation: CheckpointMirrorError["operation"],
      reason: CheckpointMirrorError["reason"],
    ) =>
    (cause?: unknown) =>
      new CheckpointMirrorError({
        projectId,
        operation,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });

  // safe.bareRepository=explicit (VcsProcess) makes every mirror command name its git dir.
  const runInMirror = (
    projectId: ProjectId,
    operation: CheckpointMirrorError["operation"],
    args: ReadonlyArray<string>,
    options: Pick<GitVcsDriver.ExecuteGitInput, "stdin" | "allowNonZeroExit" | "timeoutMs"> = {},
  ) => {
    const dir = gitDir(projectId);
    return git
      .execute({
        operation: `CheckpointMirror.${operation}`,
        cwd: dir,
        args: [`--git-dir=${dir}`, ...args],
        ...options,
      })
      .pipe(Effect.mapError(fail(projectId, operation, "git")));
  };

  const mirrorExists = (projectId: ProjectId, operation: CheckpointMirrorError["operation"]) =>
    fs.exists(gitDir(projectId)).pipe(Effect.mapError(fail(projectId, operation, "git")));

  /** The top of the git checkout holding the project root, if there is one. */
  const checkoutRoot = (projectId: ProjectId, workspaceRoot: string) =>
    git
      .execute({
        operation: "CheckpointMirror.checkoutRoot",
        cwd: workspaceRoot,
        args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const root = result.stdout.trim();
          return result.exitCode === 0 && root !== "" ? Option.some(root) : Option.none<string>();
        }),
        Effect.mapError(fail(projectId, "seed", "git")),
      );

  const ensure: CheckpointMirror["Service"]["ensure"] = Effect.fn("CheckpointMirror.ensure")(
    function* (projectId) {
      const project = yield* projects
        .get(projectId)
        .pipe(Effect.mapError(fail(projectId, "seed", "git")));
      if (Option.isNone(project)) return yield* fail(projectId, "seed", "missing-project")();
      const checkout = yield* checkoutRoot(projectId, project.value.workspaceRoot);
      const dir = gitDir(projectId);
      return yield* writeLocks.withLock(
        projectId,
        Effect.gen(function* () {
          if (!(yield* mirrorExists(projectId, "seed"))) {
            const tmp = `${dir}.tmp`;
            yield* Effect.gen(function* () {
              yield* fs.makeDirectory(mirrorsDir, { recursive: true, mode: 0o700 });
              yield* fs.chmod(mirrorsDir, 0o700);
              yield* fs.remove(tmp, { recursive: true, force: true });
            }).pipe(Effect.mapError(fail(projectId, "seed", "git")));
            // --template= leaves no hooks, so no mirror command can run one.
            const args = Option.match(checkout, {
              onNone: () => ["init", "--quiet", "--bare", "--template=", tmp],
              onSome: (root) => ["clone", "--quiet", "--bare", "--local", "--template=", root, tmp],
            });
            yield* git
              .execute({
                operation: "CheckpointMirror.seed",
                cwd: mirrorsDir,
                args,
                timeoutMs: LONG_GIT_TIMEOUT_MS,
              })
              .pipe(Effect.mapError(fail(projectId, "seed", "git")));
            yield* fs.rename(tmp, dir).pipe(Effect.mapError(fail(projectId, "seed", "git")));
          }
          if (Option.isSome(checkout)) {
            yield* runInMirror(
              projectId,
              "seed",
              [
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                checkout.value,
                SEED_ORIGIN_REFSPEC,
              ],
              { timeoutMs: LONG_GIT_TIMEOUT_MS },
            );
          }
          return dir;
        }),
      );
    },
  );

  const readRefs = (
    projectId: ProjectId,
    operation: CheckpointMirrorError["operation"],
    patterns: ReadonlyArray<string>,
  ) =>
    runInMirror(projectId, operation, [
      "for-each-ref",
      "--format=%(objectname)%00%(refname)",
      ...patterns,
    ]).pipe(
      Effect.map((result) => {
        const refs = new Map<string, string>();
        for (const line of result.stdout.split("\n")) {
          const [oid, refName] = line.split("\0");
          if (oid && refName) refs.set(refName, oid);
        }
        return refs;
      }),
    );

  const tips: CheckpointMirror["Service"]["tips"] = Effect.fn("CheckpointMirror.tips")(
    function* (projectId, refs) {
      if (refs.length === 0 || !(yield* mirrorExists(projectId, "import"))) return new Map();
      // for-each-ref also matches below a pattern; keep exact names only.
      const found = yield* readRefs(projectId, "import", refs);
      const wanted = new Set(refs);
      return new Map([...found].filter(([refName]) => wanted.has(refName)));
    },
  );

  const readBundleHeader = Effect.fn("CheckpointMirror.readBundleHeader")(
    function* (projectId: ProjectId, bundlePath: string) {
      const file = yield* fs.open(bundlePath, { flag: "r" });
      let bytes = new Uint8Array(0);
      while (bytes.length < MAX_BUNDLE_HEADER_BYTES) {
        const chunk = yield* file.readAlloc(BUNDLE_HEADER_CHUNK_BYTES);
        if (Option.isNone(chunk)) break;
        const next = new Uint8Array(bytes.length + chunk.value.length);
        next.set(bytes);
        next.set(chunk.value, bytes.length);
        const searchFrom = bytes.length;
        bytes = next;
        const blank = indexOfBlankLine(bytes, searchFrom);
        if (blank >= 0) {
          return parseBundleHeader(new TextDecoder().decode(bytes.subarray(0, blank)), blank + 2);
        }
      }
      return null;
    },
    Effect.scoped,
    (effect, projectId) => effect.pipe(Effect.mapError(fail(projectId, "import", "git"))),
  );

  const removeTemporaryPacks = Effect.fn("CheckpointMirror.removeTemporaryPacks")(
    function* (projectId: ProjectId) {
      const packDir = path.join(gitDir(projectId), "objects", "pack");
      for (const name of yield* fs.readDirectory(packDir)) {
        if (name.startsWith("tmp_")) yield* fs.remove(path.join(packDir, name), { force: true });
      }
    },
    Effect.ignore({ log: true }),
  );

  const importBundle: CheckpointMirror["Service"]["importBundle"] = Effect.fn(
    "CheckpointMirror.importBundle",
  )(function* ({ projectId, bundlePath, refs }) {
    const invalid = fail(projectId, "import", "invalid-objects");
    const info = yield* fs.stat(bundlePath).pipe(Effect.mapError(fail(projectId, "import", "git")));
    if (Number(info.size) > MAX_BUNDLE_BYTES) {
      return yield* fail(projectId, "import", "too-large")();
    }
    const header = yield* readBundleHeader(projectId, bundlePath);
    if (header === null) return yield* invalid("Not a v2 git bundle.");
    const updates = new Map<string, string>();
    for (const { source, target } of refs) {
      const oid = header.refs.get(source);
      if (oid === undefined) return yield* invalid(`The bundle does not carry ${source}.`);
      updates.set(target, oid);
    }

    return yield* writeLocks.withLock(
      projectId,
      Effect.gen(function* () {
        if (header.prerequisites.length > 0) {
          const check = yield* runInMirror(projectId, "import", ["cat-file", "--batch-check"], {
            stdin: `${header.prerequisites.join("\n")}\n`,
          });
          const missing = check.stdout
            .split("\n")
            .filter((line) => line.endsWith(" missing"))
            .map((line) => line.slice(0, -" missing".length));
          if (missing.length > 0) {
            return yield* fail(projectId, "import", "missing-prerequisite")(missing.join(", "));
          }
        }

        // Fetching a bundle skips fetch.fsckObjects, so only index-pack --strict admits objects:
        // it checks just this pack and keeps nothing when a check fails.
        const indexed = yield* git
          .execute({
            operation: "CheckpointMirror.import",
            cwd: gitDir(projectId),
            args: [
              `--git-dir=${gitDir(projectId)}`,
              "index-pack",
              "--strict",
              "--fix-thin",
              "--stdin",
            ],
            stdin: fs.stream(bundlePath, { offset: header.packOffset }),
            allowNonZeroExit: true,
            timeoutMs: LONG_GIT_TIMEOUT_MS,
          })
          .pipe(Effect.result);
        if (Result.isFailure(indexed) || indexed.success.exitCode !== 0) {
          yield* removeTemporaryPacks(projectId);
          return yield* invalid(
            Result.isFailure(indexed) ? indexed.failure : indexed.success.stderr.trim(),
          );
        }

        if (updates.size > 0) {
          yield* runInMirror(projectId, "import", ["update-ref", "--stdin"], {
            stdin: [...updates].map(([target, oid]) => `update ${target} ${oid}\n`).join(""),
          });
        }
        return updates;
      }),
    );
  });

  const updateRefs: CheckpointMirror["Service"]["updateRefs"] = Effect.fn(
    "CheckpointMirror.updateRefs",
  )(function* (projectId, refs) {
    if (refs.size === 0) return;
    // Oids come from the sandbox; a stray newline would smuggle another update-ref command.
    for (const oid of refs.values()) {
      if (!OID_ONLY.test(oid)) {
        return yield* fail(projectId, "import", "invalid-objects")(`Not an object id: ${oid}`);
      }
    }
    yield* writeLocks.withLock(
      projectId,
      runInMirror(projectId, "import", ["update-ref", "--stdin"], {
        stdin: [...refs].map(([target, oid]) => `update ${target} ${oid}\n`).join(""),
      }),
    );
  });

  const maintain: CheckpointMirror["Service"]["maintain"] = Effect.fn("CheckpointMirror.maintain")(
    function* (projectId) {
      yield* writeLocks.withLock(
        projectId,
        Effect.gen(function* () {
          if (!(yield* mirrorExists(projectId, "maintain"))) return;
          yield* runInMirror(projectId, "maintain", ["maintenance", "run", "--auto", "--quiet"], {
            timeoutMs: LONG_GIT_TIMEOUT_MS,
          });
        }),
      );
    },
  );

  const deleteMirrorRefs = (
    projectId: ProjectId,
    refs: ReadonlyArray<string>,
  ): Effect.Effect<void, CheckpointMirrorError> =>
    refs.length === 0
      ? Effect.void
      : runInMirror(projectId, "delete-refs", ["update-ref", "--stdin"], {
          stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
        }).pipe(Effect.asVoid);

  const deleteRefs: CheckpointMirror["Service"]["deleteRefs"] = Effect.fn(
    "CheckpointMirror.deleteRefs",
  )(function* (projectId, refs) {
    yield* writeLocks.withLock(
      projectId,
      Effect.gen(function* () {
        if (!(yield* mirrorExists(projectId, "delete-refs"))) return;
        yield* deleteMirrorRefs(projectId, refs);
      }),
    );
  });

  const deleteThreadNamespace: CheckpointMirror["Service"]["deleteThreadNamespace"] = Effect.fn(
    "CheckpointMirror.deleteThreadNamespace",
  )(function* (projectId, threadId) {
    yield* writeLocks.withLock(
      projectId,
      Effect.gen(function* () {
        if (!(yield* mirrorExists(projectId, "delete-refs"))) return;
        // Without the trailing slash, for-each-ref matches this whole segment only.
        const namespace = sandboxThreadRefPrefix(threadId).slice(0, -1);
        const refs = yield* readRefs(projectId, "delete-refs", [namespace]);
        yield* deleteMirrorRefs(projectId, [...refs.keys()]);
      }),
    );
  });

  const removeDirectories = (projectId: ProjectId) =>
    Effect.forEach(
      [gitDir(projectId), `${gitDir(projectId)}.tmp`],
      (dir) => fs.remove(dir, { recursive: true, force: true }),
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Failed to remove the checkpoint mirror of project ${projectId}.`, cause),
      ),
    );

  const remove: CheckpointMirror["Service"]["remove"] = Effect.fn("CheckpointMirror.remove")(
    function* (projectId) {
      yield* writeLocks.withLock(projectId, removeDirectories(projectId));
    },
  );

  const diskBytes = Effect.gen(function* () {
    if (!(yield* fs.exists(mirrorsDir))) return 0;
    let total = 0;
    for (const entry of yield* fs.readDirectory(mirrorsDir, { recursive: true })) {
      const info = yield* fs.stat(path.join(mirrorsDir, entry)).pipe(Effect.option);
      if (info._tag === "Some" && info.value.type === "File") total += Number(info.value.size);
    }
    return total;
  }).pipe(
    Effect.orElseSucceed(() => 0),
    Effect.withSpan("CheckpointMirror.diskBytes"),
  );

  // A crash between a project's deletion commit and `remove` leaves its mirror behind.
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(mirrorsDir))) return;
    const rows = yield* projects.list({ includeDeleted: true });
    const live = new Set(rows.filter((row) => row.deletedAt === null).map((row) => row.projectId));
    for (const name of yield* fs.readDirectory(mirrorsDir)) {
      const encoded = name.endsWith(".git")
        ? name.slice(0, -".git".length)
        : name.endsWith(".git.tmp")
          ? name.slice(0, -".git.tmp".length)
          : null;
      if (encoded === null) continue;
      const decoded = Base64Url.decodeString(encoded);
      if (Result.isFailure(decoded) || Base64Url.encode(decoded.success) !== encoded) continue;
      const projectId = ProjectId.make(decoded.success);
      if (!live.has(projectId)) yield* removeDirectories(projectId);
    }
  }).pipe(Effect.ignore({ log: true }));

  return CheckpointMirror.of({
    gitDir,
    ensure,
    tips,
    importBundle,
    updateRefs,
    deleteRefs,
    maintain,
    deleteThreadNamespace,
    remove,
    diskBytes,
  });
});

export const layer = Layer.effect(CheckpointMirror, make);
