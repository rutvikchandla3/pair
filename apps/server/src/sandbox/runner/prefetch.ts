// @effect-diagnostics nodeBuiltinImport:off - runs before any server is reachable over the runner socket; plain Node HTTP keeps undici out of the bundle.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const BUILD_ID = /^[0-9a-f]{64}$/;
const DEFAULT_ROOT = "/opt/pair-runner";
const DEFAULT_STATE_DIR = "/run/pair-runner";

export class RunnerPrefetchError extends Schema.TaggedError<RunnerPrefetchError>()(
  "RunnerPrefetchError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `t3 runner prefetch: ${this.detail}`;
  }
}

const decodeManifestId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runnerBuildId: Schema.String })),
);

const manifestId = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readFileString(`${directory}/MANIFEST.json`).pipe(
    Effect.map((text) => Option.map(decodeManifestId(text), (manifest) => manifest.runnerBuildId)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** `PAIR_RUNNER_URL` is `http(s)://host` or `unix:/path` (infra/sandbox-image/pair-bootstrap.sh). */
const download = (runnerUrl: string, path: string, token: string) =>
  Effect.callback<Buffer, RunnerPrefetchError>((resume) => {
    const unix = runnerUrl.startsWith("unix:") ? runnerUrl.slice("unix:".length) : undefined;
    const url = new URL(path, unix === undefined ? runnerUrl : "http://runner");
    const request = (url.protocol === "https:" ? NodeHttps : NodeHttp).request(
      url,
      {
        ...(unix === undefined ? {} : { socketPath: unix }),
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (cause) =>
          resume(Effect.fail(new RunnerPrefetchError({ detail: `${path}: ${cause.message}` }))),
        );
        response.on("end", () =>
          resume(
            response.statusCode === 200
              ? Effect.succeed(Buffer.concat(chunks))
              : Effect.fail(
                  new RunnerPrefetchError({ detail: `${path} answered ${response.statusCode}` }),
                ),
          ),
        );
      },
    );
    request.on("error", (cause) =>
      resume(Effect.fail(new RunnerPrefetchError({ detail: `${path}: ${cause.message}` }))),
    );
    request.end();
    return Effect.sync(() => request.destroy());
  });

/**
 * `t3 runner prefetch <runnerBuildId>`, for image builds (05): installs that build under
 * `/opt/pair-runner/<id>` with the bootstrap's sentinel. Its own tree when the ids match (no
 * network), else the bundle routes with the sandbox token. Staging dir, then one rename.
 */
export const prefetch = Effect.fn("RunnerPrefetch.prefetch")(function* (runnerBuildId: string) {
  if (!BUILD_ID.test(runnerBuildId)) {
    return yield* new RunnerPrefetchError({ detail: `not a runner build id: ${runnerBuildId}` });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const root = env.PAIR_RUNNER_ROOT?.trim() || DEFAULT_ROOT;
  const target = path.join(root, runnerBuildId);
  if (Option.contains(yield* manifestId(fs, target), runnerBuildId)) return;

  const staging = path.join(root, `.staging-${NodeCrypto.randomUUID()}`);
  yield* Effect.gen(function* () {
    const ownTree = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    if (Option.contains(yield* manifestId(fs, ownTree), runnerBuildId)) {
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.copy(ownTree, staging);
    } else {
      const runnerUrl = env.PAIR_RUNNER_URL?.trim();
      if (!runnerUrl) {
        return yield* new RunnerPrefetchError({ detail: "PAIR_RUNNER_URL is not set" });
      }
      const stateDir = env.PAIR_RUNNER_DIR?.trim() || DEFAULT_STATE_DIR;
      const token = (yield* fs.readFileString(path.join(stateDir, "token"))).trim();
      const base = `/runner/v1/bundle/${runnerBuildId}`;
      const expected = (yield* download(runnerUrl, `${base}.sha256`, token))
        .toString()
        .split(/\s/)[0];
      const tarball = yield* download(runnerUrl, `${base}.tar.gz`, token);
      const actual = NodeCrypto.createHash("sha256").update(tarball).digest("hex");
      if (actual !== expected) {
        return yield* new RunnerPrefetchError({ detail: `digest ${actual}, expected ${expected}` });
      }
      yield* fs.makeDirectory(staging, { recursive: true });
      const archive = path.join(staging, "bundle.tar.gz");
      yield* fs.writeFile(archive, tarball);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exitCode = yield* spawner
        .spawn(ChildProcess.make("tar", ["-xzf", archive, "-C", staging]))
        .pipe(
          Effect.flatMap((child) =>
            Effect.andThen(child.stderr.pipe(Stream.runDrain), child.exitCode),
          ),
          Effect.scoped,
        );
      if (exitCode !== 0) {
        return yield* new RunnerPrefetchError({ detail: `tar exited ${exitCode}` });
      }
      yield* fs.remove(archive);
    }
    yield* fs.writeFileString(path.join(staging, ".install-complete"), runnerBuildId);
    // A concurrent prefetch may have won; its tree has the same id.
    if (yield* fs.exists(target)) return yield* fs.remove(staging, { recursive: true });
    yield* fs.rename(staging, target);
  }).pipe(
    Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});
