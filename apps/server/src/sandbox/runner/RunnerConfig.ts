import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { RunnerInfo } from "@t3tools/contracts/runner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { TEAM_IMAGE_BUILD_OUTPUT } from "../image/teamImageBuildProgram.ts";

/** What the runner tells the server about the machine in `runner.hello`. */
export type RunnerHostFacts = Pick<
  RunnerInfo,
  "agent" | "tmpDirectory" | "bundleDirectory" | "imageEnvironment"
>;

export interface RunnerConfigShape {
  /** `PAIR_RUNNER_URL`: `http(s)://host` or `unix:/path`. */
  readonly url: string;
  readonly sandboxId: string;
  readonly runnerBuildId: string;
  readonly enrollment: Option.Option<Redacted.Redacted<string>>;
  /** Tmpfs for the sandbox token and the bootstrap's `server-build` hand-off. */
  readonly stateDir: string;
  readonly facts: RunnerHostFacts;
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

export const DEFAULT_STATE_DIR = "/run/pair-runner";
/** Where the bootstrap unpacks each bundle, by build id. */
const BUNDLES_DIR = "/opt/pair-runner";
/** The image's agent user (infra/sandbox-image/provision.sh). */
const DEFAULT_AGENT_USER = "t3";

/** `name:x:uid:gid:gecos:home:shell` from `/etc/passwd`. */
const passwdEntry = (passwd: string, user: string) => {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== user || fields.length < 7) continue;
    const uid = Number(fields[2]);
    if (!Number.isInteger(uid) || uid < 0) return undefined;
    return { uid, homeDirectory: fields[5]!, shell: fields[6]! || "/bin/sh" };
  }
  return undefined;
};

const decodeBuildManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ imageEnv: Schema.Record(Schema.String, Schema.String) })),
);

/**
 * What the image sets on every process: the runner's own environment, then a team build's
 * `imageEnv` from its manifest (a base image has none; an unreadable one counts as none).
 */
export const imageEnvironmentFrom = (
  env: Readonly<Record<string, string | undefined>>,
  manifestText: string | null,
): Record<string, string> => {
  const manifest = manifestText === null ? Option.none() : decodeBuildManifest(manifestText);
  const merged = { ...env, ...(Option.isSome(manifest) ? manifest.value.imageEnv : {}) };
  const imageEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value !== undefined && !name.startsWith("PAIR_")) imageEnvironment[name] = value;
  }
  return imageEnvironment;
};

/**
 * Reads the bootstrap's values. The enrollment secret comes from the bootstrap's
 * `<stateDir>/enroll`, never the environment (`/proc/<pid>/environ`), and is deleted before
 * anything dials.
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
  const agentUser = env.PAIR_AGENT_USER?.trim() || DEFAULT_AGENT_USER;
  // Agents never fall back to running as the runner's root.
  const agent = passwdEntry(
    yield* fs.readFileString("/etc/passwd").pipe(Effect.orElseSucceed(() => "")),
    agentUser,
  );
  if (agent === undefined) {
    return yield* new RunnerConfigError({ missing: `the agent user ${agentUser}` });
  }
  const imageEnvironment = imageEnvironmentFrom(
    env,
    yield* fs.readFileString(TEAM_IMAGE_BUILD_OUTPUT).pipe(Effect.orElseSucceed(() => null)),
  );

  const enrollFile = path.join(stateDir, "enroll");
  const secret = yield* fs.readFileString(enrollFile).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  yield* fs.remove(enrollFile, { force: true }).pipe(Effect.ignore);

  return {
    url,
    sandboxId,
    runnerBuildId,
    enrollment: secret ? Option.some(Redacted.make(secret)) : Option.none(),
    stateDir,
    facts: {
      agent,
      tmpDirectory: env.TMPDIR?.trim() || "/tmp",
      bundleDirectory: path.join(BUNDLES_DIR, runnerBuildId),
      imageEnvironment,
    },
  } satisfies RunnerConfigShape;
});
