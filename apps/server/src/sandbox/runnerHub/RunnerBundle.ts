// @effect-diagnostics nodeBuiltinImport:off - Effect has no synchronous digest for the tree hash.
import * as NodeCrypto from "node:crypto";

import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";

export const RUNNER_MANIFEST_FILE = "MANIFEST.json";

export const RunnerManifest = Schema.Struct({
  runnerBuildId: Schema.String,
  protocolVersion: Schema.Number,
  node: Schema.String,
  builtFrom: Schema.Literals(["release", "source"]),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerManifest));
export const encodeRunnerManifest = Schema.encodeEffect(Schema.fromJsonString(RunnerManifest));

export interface RunnerBundleInfo {
  readonly runnerBuildId: string;
  /** What Docker bind-mounts read-only at `/opt/pair-runner/<id>`. */
  readonly directory: string;
  readonly tarballPath: string;
  readonly tarballSha256: string;
}

export class RunnerBundleUnavailableError extends Schema.TaggedError<RunnerBundleUnavailableError>()(
  "RunnerBundleUnavailableError",
  {
    reason: Schema.Literals(["not-bundled", "build-failed"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === "not-bundled"
      ? "This server was built without a runner tree, so it cannot start cloud machines. Install a Pair Cloud release."
      : `The runner bundle could not be prepared${this.detail ? `: ${this.detail}` : "."}`;
  }
}

/** The runner build this server serves to its sandboxes (03 §2.2). */
export class RunnerBundle extends Context.Service<
  RunnerBundle,
  {
    /** Released: the `runner/` tree beside the server (`dist/` or the executable). From source: built once per process (P7). */
    readonly current: Effect.Effect<RunnerBundleInfo, RunnerBundleUnavailableError>;
  }
>()("t3/sandbox/runnerHub/RunnerBundle") {}

const sha256Hex = (data: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

/**
 * The bundle's content id: sha256 over one `<path>\0<0755|0644>\0<sha256>\n` line per file, sorted
 * by path, without `MANIFEST.json` (which holds the id). Releases and dev builds both use this.
 */
export const computeRunnerBuildId = Effect.fn("RunnerBundle.computeRunnerBuildId")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lines: Array<string> = [];
  for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
    const relative = entry.split(path.sep).join("/");
    if (relative === RUNNER_MANIFEST_FILE) continue;
    const file = path.join(directory, entry);
    const info = yield* fs.stat(file);
    if (info.type !== "File") continue;
    const mode = (info.mode & 0o111) === 0 ? "0644" : "0755";
    lines.push(`${relative}\0${mode}\0${sha256Hex(yield* fs.readFile(file))}\n`);
  }
  lines.sort();
  return sha256Hex(lines.join(""));
});

const unavailable = (detail: string) =>
  new RunnerBundleUnavailableError({ reason: "build-failed", detail });

const runChecked = Effect.fn("RunnerBundle.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { ...(cwd === undefined ? {} : { cwd }), shell: false }),
  );
  const [, stderr, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.runDrain),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* unavailable(`${args[0] ?? command} exited ${exitCode}: ${stderr.slice(-2000)}`);
  }
}, Effect.scoped);

/** Reads a finished tree and tars it once into `<stateDir>/runner/<id>.tar.gz`. */
const fromTree = Effect.fn("RunnerBundle.fromTree")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const manifest = yield* fs
    .readFileString(path.join(directory, RUNNER_MANIFEST_FILE))
    .pipe(Effect.flatMap(decodeManifest));
  const runnerBuildId = manifest.runnerBuildId;
  const runnerDir = path.join(stateDir, "runner");
  const tarballPath = path.join(runnerDir, `${runnerBuildId}.tar.gz`);
  if (!(yield* fs.exists(tarballPath))) {
    yield* fs.makeDirectory(runnerDir, { recursive: true });
    const partial = `${tarballPath}.${NodeCrypto.randomUUID()}.partial`;
    yield* runChecked("tar", ["-czf", partial, "-C", directory, "."]).pipe(
      Effect.onError(() => fs.remove(partial, { force: true }).pipe(Effect.ignore)),
    );
    yield* fs.rename(partial, tarballPath);
  }
  return {
    runnerBuildId,
    directory,
    tarballPath,
    tarballSha256: sha256Hex(yield* fs.readFile(tarballPath)),
  } satisfies RunnerBundleInfo;
});

const readReleased = Effect.fn("RunnerBundle.readReleased")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(path.join(directory, RUNNER_MANIFEST_FILE)))) {
    return yield* new RunnerBundleUnavailableError({ reason: "not-bundled", detail: directory });
  }
  return yield* fromTree(directory);
});

/** Packs a dev bundle (with Replay, P5) into a staging dir, then renames it to its id. */
const buildFromSource = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const serverDir = yield* path.fromFileUrl(new URL("../../../", import.meta.url));
  const runnerDir = path.join(stateDir, "runner");
  const staging = path.join(runnerDir, `.staging-${NodeCrypto.randomUUID()}`);
  yield* Effect.logInfo("building the dev runner bundle", { staging });
  yield* runChecked(
    yield* HostProcess.ExecutablePath,
    [
      path.join(serverDir, "scripts/cli.ts"),
      "build-runner",
      "--dev",
      "--out",
      staging,
      "--externals-cache",
      runnerDir,
    ],
    serverDir,
  ).pipe(
    Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
  const runnerBuildId = yield* computeRunnerBuildId(staging);
  const directory = path.join(runnerDir, runnerBuildId);
  if (yield* fs.exists(directory)) {
    yield* fs.remove(staging, { recursive: true, force: true });
  } else {
    yield* fs.rename(staging, directory);
  }
  return yield* fromTree(directory);
});

const isUnavailable = Schema.is(RunnerBundleUnavailableError);

type PrepareError =
  | RunnerBundleUnavailableError
  | PlatformError.PlatformError
  | PlatformError.BadArgument
  | Schema.SchemaError;
type PrepareServices =
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

const make = Effect.fn("RunnerBundle.make")(function* (
  prepare: Effect.Effect<RunnerBundleInfo, PrepareError, PrepareServices>,
) {
  const context = yield* Effect.context<PrepareServices>();
  const lock = yield* Semaphore.make(1);
  // Like Effect.cached, except that a failed build is retried by the next caller.
  let ready = Option.none<RunnerBundleInfo>();
  const prepareOnce = Effect.suspend(() =>
    Option.isSome(ready)
      ? Effect.succeed(ready.value)
      : prepare.pipe(
          // Only the uncached path: a source build is slow, a cached read is not.
          Effect.withSpan("RunnerBundle.current"),
          Effect.tap((info) =>
            Effect.sync(() => {
              ready = Option.some(info);
            }),
          ),
        ),
  );
  const current = Effect.suspend(() =>
    Option.isSome(ready) ? Effect.succeed(ready.value) : Semaphore.withPermit(lock, prepareOnce),
  ).pipe(
    Effect.mapError((cause) => (isUnavailable(cause) ? cause : unavailable(cause.message))),
    Effect.provideContext(context),
  );
  return RunnerBundle.of({ current });
});

export const layer = Layer.effect(
  RunnerBundle,
  // Same test as runClaudeWorker: a `.ts` module means the server runs from source. Released, the
  // module's directory is `dist/` (npm) or the executable's own (a CLI archive).
  make(
    import.meta.url.endsWith(".ts")
      ? buildFromSource
      : Effect.gen(function* () {
          const path = yield* Path.Path;
          return yield* readReleased(path.join(import.meta.dirname, "runner"));
        }),
  ),
);

/** A released tree at `directory`, as the release smoke and the load test serve it. */
export const layerFromTree = (directory: string) =>
  Layer.effect(RunnerBundle, make(readReleased(directory)));

export interface RunnerBundleTestFile {
  readonly path: string;
  readonly content: string;
  readonly executable?: boolean;
}

/** A bundle over a temp tree of these files, with its `MANIFEST.json`. */
export const layerTest = (files: ReadonlyArray<RunnerBundleTestFile>) =>
  Layer.effect(
    RunnerBundle,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-bundle-" });
      for (const file of files) {
        const target = path.join(directory, file.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, file.content);
        yield* fs.chmod(target, file.executable ? 0o755 : 0o644);
      }
      const manifest: typeof RunnerManifest.Type = {
        runnerBuildId: yield* computeRunnerBuildId(directory),
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        node: ">=22",
        builtFrom: "source",
      };
      yield* fs.writeFileString(
        path.join(directory, RUNNER_MANIFEST_FILE),
        yield* encodeRunnerManifest(manifest),
      );
      return yield* make(fromTree(directory));
    }),
  );
