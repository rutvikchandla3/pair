#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CODEX_RELEASES, type CodexReleaseAsset } from "../src/provider/codexReleases.ts";

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
  Command.withSubcommands([contextCommand, buildCommand]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
