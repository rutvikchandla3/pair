import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface RunnerConfigShape {
  /** `PAIR_RUNNER_URL`: `http(s)://host` or `unix:/path`. */
  readonly url: string;
  readonly sandboxId: string;
  readonly runnerBuildId: string;
  readonly enrollment: Option.Option<Redacted.Redacted<string>>;
  /** Tmpfs for the sandbox token and the bootstrap's `server-build` hand-off. */
  readonly stateDir: string;
}

export class RunnerConfig extends Context.Service<RunnerConfig, RunnerConfigShape>()(
  "t3/sandbox/runner/RunnerConfig",
) {}

export class RunnerConfigError extends Schema.TaggedError<RunnerConfigError>()(
  "RunnerConfigError",
  { missing: Schema.String },
) {
  override get message(): string {
    return `t3 runner needs ${this.missing}`;
  }
}

const DEFAULT_STATE_DIR = "/run/pair-runner";

/**
 * Reads the bootstrap's values. The enrollment secret comes from `PAIR_RUNNER_ENROLL`, else the
 * driver-mounted `<stateDir>/enroll`, and both are deleted before anything dials.
 */
export const readRunnerConfig = Effect.fn("RunnerConfig.read")(function* () {
  const env = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const required = (name: string) => {
    const value = env[name]?.trim();
    return value ? Effect.succeed(value) : Effect.fail(new RunnerConfigError({ missing: name }));
  };
  const url = yield* required("PAIR_RUNNER_URL");
  const sandboxId = yield* required("PAIR_SANDBOX_ID");
  const runnerBuildId = yield* required("PAIR_RUNNER_BUILD");
  const stateDir = env.PAIR_RUNNER_DIR?.trim() || DEFAULT_STATE_DIR;

  const fromEnv = env.PAIR_RUNNER_ENROLL?.trim();
  delete env.PAIR_RUNNER_ENROLL;
  const enrollFile = path.join(stateDir, "enroll");
  const fromFile = yield* fs.readFileString(enrollFile).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  yield* fs.remove(enrollFile, { force: true }).pipe(Effect.ignore);
  const secret = fromEnv || fromFile;

  return {
    url,
    sandboxId,
    runnerBuildId,
    enrollment: secret ? Option.some(Redacted.make(secret)) : Option.none(),
    stateDir,
  } satisfies RunnerConfigShape;
});
