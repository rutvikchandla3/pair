#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ProviderDriverKind } from "@t3tools/contracts";

import packageJson from "../package.json" with { type: "json" };
import { CODEX_RELEASES } from "../src/provider/codexReleases.ts";
import { BUNDLED_MODEL_MANIFEST } from "../src/provider/ModelManifest.ts";
import {
  resolveProviderCompatibility,
  type ProviderCompatibilityPolicy,
} from "../src/provider/providerCompatibility.ts";
import { codexEnv } from "../src/sandbox/image/SandboxProvisionTree.ts";

export class SandboxImageDockerError extends Schema.TaggedError<SandboxImageDockerError>()(
  "SandboxImageDockerError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `docker build failed with exit code ${this.exitCode}.`;
  }
}

export class SandboxImageProviderPinError extends Schema.TaggedError<SandboxImageProviderPinError>()(
  "SandboxImageProviderPinError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class SandboxImageReleaseError extends Schema.TaggedError<SandboxImageReleaseError>()(
  "SandboxImageReleaseError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const imageSourceDir = Effect.fn("sandboxImage.imageSourceDir")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../infra/sandbox-image", import.meta.url));
});

const writeContext = Effect.fn("sandboxImage.writeContext")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* codexEnv(CODEX_RELEASES);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.copy(yield* imageSourceDir(), directory, { overwrite: true });
  yield* fs.writeFileString(path.join(directory, "codex.env"), env);
});

export interface ProviderPins {
  readonly claudeAgent: string;
  readonly codex: string;
}

const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";

/** The provider versions the image build installs, read from the files the build reads. */
export const readProviderPins = Effect.fn("sandboxImage.readProviderPins")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providersDir = path.join(yield* imageSourceDir(), "providers");
  const readJson = (name: string) =>
    fs.readFileString(path.join(providersDir, name)).pipe(Effect.map((text) => JSON.parse(text)));
  const manifest = yield* readJson("package.json");
  const lock = yield* readJson("package-lock.json");
  const pinned: unknown = manifest.dependencies?.[CLAUDE_PACKAGE];
  const locked: unknown = lock.packages?.[`node_modules/${CLAUDE_PACKAGE}`]?.version;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    return yield* new SandboxImageProviderPinError({
      detail: `${CLAUDE_PACKAGE} must be pinned to an exact version in providers/package.json, got ${String(pinned)}.`,
    });
  }
  if (locked !== pinned) {
    return yield* new SandboxImageProviderPinError({
      detail: `providers/package-lock.json resolves ${CLAUDE_PACKAGE} to ${String(locked)}, not ${pinned}.`,
    });
  }
  const codex = yield* codexEnv(CODEX_RELEASES).pipe(
    Effect.map((env) => /^CODEX_VERSION=(.+)$/m.exec(env)?.[1] ?? ""),
  );
  return { claudeAgent: pinned, codex } satisfies ProviderPins;
});

/** Pins the server's model manifest does not grade `supported` for this release. */
export const checkProviderPins = (
  pins: ProviderPins,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  pairVersion: string,
) =>
  (["claudeAgent", "codex"] as const).flatMap((driver) => {
    const status =
      resolveProviderCompatibility(
        policies,
        ProviderDriverKind.make(driver),
        pins[driver],
        pairVersion,
      )?.status ?? "no policy";
    return status === "supported" ? [] : [{ driver, version: pins[driver], status }];
  });

export interface ReleaseInput {
  readonly eventName: string;
  /** The tag for a tag push; the branch for a manual run. */
  readonly refName: string;
  /** The `version` input of a manual run. */
  readonly inputVersion: string;
  readonly runId: string;
  readonly repositoryOwner: string;
  readonly serverVersion: string;
}

export interface ReleasePlan {
  readonly version: string;
  readonly tag: string;
  readonly image: string;
  readonly dryRun: boolean;
}

// Also a valid Docker tag: no build metadata, which `+` would make unpushable.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/**
 * What a workflow run publishes. The server pulls `<image>:<server version>` and nothing else, so a
 * release tag must equal the server's own version; a manual run can only publish a dry-run tag.
 */
export const planRelease = Effect.fn("sandboxImage.planRelease")(function* (input: ReleaseInput) {
  const image = `ghcr.io/${input.repositoryOwner.toLowerCase()}/t3-sandbox`;
  if (input.eventName !== "push" && input.eventName !== "workflow_dispatch") {
    return yield* new SandboxImageReleaseError({
      detail: `Cannot publish the sandbox image for a ${input.eventName} event.`,
    });
  }
  const dryRun = input.eventName === "workflow_dispatch";
  const version = (dryRun ? input.inputVersion : input.refName).replace(/^v/, "");
  if (!RELEASE_VERSION.test(version)) {
    return yield* new SandboxImageReleaseError({
      detail: `"${version}" is not a release version like 1.2.3.`,
    });
  }
  if (!dryRun && version !== input.serverVersion) {
    return yield* new SandboxImageReleaseError({
      detail: `Tag ${input.refName} does not match the server version ${input.serverVersion}, which is the version a server pulls.`,
    });
  }
  return {
    version,
    tag: dryRun ? `${version}-dryrun.${input.runId}` : version,
    image,
    dryRun,
  } satisfies ReleasePlan;
});

const releasePlanCommand = Command.make(
  "release-plan",
  {
    event: Flag.String("event").pipe(Flag.withDescription("GITHUB_EVENT_NAME.")),
    refName: Flag.String("ref-name").pipe(Flag.withDescription("GITHUB_REF_NAME.")),
    inputVersion: Flag.String("input-version").pipe(
      Flag.withDefault(""),
      Flag.withDescription("The version input of a manual run."),
    ),
    runId: Flag.String("run-id").pipe(Flag.withDescription("GITHUB_RUN_ID.")),
    owner: Flag.String("owner").pipe(Flag.withDescription("GITHUB_REPOSITORY_OWNER.")),
  },
  (flags) =>
    Effect.gen(function* () {
      const plan = yield* planRelease({
        eventName: flags.event,
        refName: flags.refName,
        inputVersion: flags.inputVersion,
        runId: flags.runId,
        repositoryOwner: flags.owner,
        serverVersion: packageJson.version,
      });
      yield* Console.log(
        [
          `version=${plan.version}`,
          `tag=${plan.tag}`,
          `image=${plan.image}`,
          `dry-run=${plan.dryRun}`,
        ].join("\n"),
      );
    }),
).pipe(
  Command.withDescription(
    "Print the version, image tag and image name a workflow run publishes, as GITHUB_OUTPUT lines.",
  ),
);

const checkProvidersCommand = Command.make(
  "check-providers",
  {
    version: Flag.String("version").pipe(
      Flag.optional,
      Flag.withDescription("Release version to grade against, with or without a leading v."),
    ),
  },
  ({ version }) =>
    Effect.gen(function* () {
      const pairVersion = Option.match(version, {
        onNone: () => packageJson.version,
        onSome: (value) => value.replace(/^v/, ""),
      });
      const pins = yield* readProviderPins();
      const failures = checkProviderPins(pins, BUNDLED_MODEL_MANIFEST.compatibility, pairVersion);
      if (failures.length > 0) {
        return yield* new SandboxImageProviderPinError({
          detail: [
            `The image's provider CLIs are not supported by Pair ${pairVersion}:`,
            ...failures.map(({ driver, version, status }) => `  ${driver} ${version}: ${status}`),
          ].join("\n"),
        });
      }
    }),
).pipe(
  Command.withDescription(
    "Fail unless the pinned Claude Code and Codex are supported by this release's model manifest.",
  ),
);

const contextCommand = Command.make(
  "context",
  { directory: Argument.String("dir") },
  ({ directory }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* writeContext(path.resolve(directory));
    }),
).pipe(Command.withDescription("Assemble the base image's Docker build context into <dir>."));

const buildCommand = Command.make(
  "build",
  {
    tag: Flag.String("tag").pipe(
      Flag.withDefault("t3-sandbox:dev"),
      Flag.withDescription("Tag for the built base image."),
    ),
  },
  ({ tag }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-image-" });
      yield* writeContext(directory);
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          ["build", "--target", "base", "--build-arg", "PAIR_VERSION=dev", "-t", tag, directory],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      const exitCode = Number(yield* child.exitCode);
      if (exitCode !== 0) return yield* new SandboxImageDockerError({ exitCode });
    }),
).pipe(
  Command.withDescription(
    "Build the base sandbox image for this machine's architecture as t3-sandbox:dev.",
  ),
);

const cli = Command.make("sandbox-image").pipe(
  Command.withDescription("Build the Pair sandbox base image."),
  Command.withSubcommands([
    contextCommand,
    buildCommand,
    checkProvidersCommand,
    releasePlanCommand,
  ]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
