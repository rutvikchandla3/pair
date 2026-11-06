#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ProviderDriverKind } from "@t3tools/contracts";

import packageJson from "../package.json" with { type: "json" };
import { CODEX_RELEASES, type CodexReleaseAsset } from "../src/provider/codexReleases.ts";
import { BUNDLED_MODEL_MANIFEST } from "../src/provider/ModelManifest.ts";
import {
  resolveProviderCompatibility,
  type ProviderCompatibilityPolicy,
} from "../src/provider/providerCompatibility.ts";

export class SandboxImageCodexReleaseError extends Schema.TaggedError<SandboxImageCodexReleaseError>()(
  "SandboxImageCodexReleaseError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

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

const LINUX_RELEASES = [
  { key: "linux-x64", suffix: "AMD64" },
  { key: "linux-arm64", suffix: "ARM64" },
] as const;

/** The `codex.env` that provision.sh reads, from the table managed Codex installs from. */
export const codexEnv = Effect.fn("sandboxImage.codexEnv")(function* (
  releases: Readonly<Record<string, CodexReleaseAsset>>,
) {
  const assets: Array<{ suffix: string; asset: CodexReleaseAsset }> = [];
  for (const { key, suffix } of LINUX_RELEASES) {
    const asset = releases[key];
    if (asset === undefined) {
      return yield* new SandboxImageCodexReleaseError({
        detail: `CODEX_RELEASES has no ${key} entry.`,
      });
    }
    assets.push({ suffix, asset });
  }
  const [{ asset: first }, { asset: second }] = assets as [(typeof assets)[0], (typeof assets)[0]];
  if (first.version !== second.version) {
    return yield* new SandboxImageCodexReleaseError({
      detail: "CODEX_RELEASES lists different versions for linux-x64 and linux-arm64.",
    });
  }
  return [
    `CODEX_VERSION=${first.version}`,
    ...assets.flatMap(({ suffix, asset }) => [
      `CODEX_URL_${suffix}=${asset.url}`,
      `CODEX_SHA256_${suffix}=${asset.sha256}`,
    ]),
    "",
  ].join("\n");
});

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
  Command.withSubcommands([contextCommand, buildCommand, checkProvidersCommand]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
