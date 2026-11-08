#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Effect has no synchronous digest for the lockfile hash.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { listBundledModules } from "../../../scripts/lib/cli-external-packages.ts";
import { stageRuntimeExternals } from "../../../scripts/build-cli-archive.ts";
import { injectLinuxArm64Sea } from "../../../scripts/lib/linux-arm64-sea.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };
import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
  ServerCliRunnerBundleCheckError,
} from "./cliErrors.ts";
import { SCENARIOS as DEV_REPLAY_SCENARIOS } from "./dev-replay-agent.ts";
import {
  computeRunnerBuildId,
  encodeRunnerManifest,
  RUNNER_MANIFEST_FILE,
  type RunnerManifest,
} from "../src/sandbox/runnerHub/RunnerBundle.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args.map(String),
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

const RUNNER_MAX_BYTES = 25 * 1024 * 1024;
const RUNNER_EXTERNALS = ["node-pty", "@ff-labs/fff-node"];
const RUNNER_SHIM = '#!/bin/sh\nexec node "$(dirname "$0")/runner.mjs" "$@"\n';

/** What the runner must never carry (03 §2.1); the lint fence sees direct imports only. */
const isFencedRunnerModule = (module: string) =>
  /(?:^|\/)src\/(?:orchestration-v2|persistence|auth)\//.test(module) ||
  (/(?:^|\/)src\/provider\//.test(module) &&
    !module.endsWith("src/provider/CodexManagedTokenProtocol.ts"));

/** Installs the runner's native externals into `stageDir/node_modules`, linux x64 and arm64 glibc. */
const stageRunnerExternals = Effect.fn("stageRunnerExternals")(function* (
  repoRoot: string,
  stageDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir,
    platform: "linux",
    arch: "universal",
    version: serverPackageJson.version,
    packages: RUNNER_EXTERNALS,
  });
  // The sandbox image is Ubuntu (glibc), and conpty is Windows-only: both would double the size.
  // A Linux host skips musl variants on its own; staging from macOS installs them all.
  const nodeModules = path.join(stageDir, "node_modules");
  for (const scope of yield* fs.readDirectory(nodeModules)) {
    if (!scope.startsWith("@")) continue;
    for (const entry of yield* fs.readDirectory(path.join(nodeModules, scope))) {
      if (entry.endsWith("-musl")) {
        yield* fs.remove(path.join(nodeModules, scope, entry), { recursive: true });
      }
    }
  }
  yield* fs.remove(path.join(nodeModules, "node-pty/third_party"), {
    recursive: true,
    force: true,
  });
});

/**
 * Builds the runner bundle into `out` (docs/product/cloud/03-runner.md §2): the unsplit runner and
 * history worker, linux externals, the `t3` shim and `MANIFEST.json` with the tree's id. `cache`
 * keeps the externals install per lockfile, for source-run servers.
 */
const buildRunner = Effect.fn("buildRunner")(function* (input: {
  readonly out: string;
  readonly dev: boolean;
  readonly externalsCache: string | undefined;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const out = path.resolve(input.out);

  yield* fs.remove(out, { recursive: true, force: true });
  yield* fs.makeDirectory(out, { recursive: true });
  const pack = yield* resolveSpawnCommand("vp", ["pack"]);
  yield* runCommand(
    ChildProcess.make(pack.command, pack.args, {
      cwd: serverDir,
      env: {
        ...process.env,
        T3CODE_PACK_EXE: "",
        T3CODE_PACK_RUNNER_ONLY: "1",
        T3CODE_RUNNER_OUT_DIR: out,
        T3CODE_RUNNER_DEV: input.dev ? "1" : "",
      },
      stdout: input.verbose ? "inherit" : "ignore",
      stderr: "inherit",
      shell: pack.shell,
    }),
  );

  const fenced = listBundledModules(yield* fs.readFileString(path.join(out, "runner.mjs"))).filter(
    isFencedRunnerModule,
  );
  if (fenced.length > 0) {
    return yield* new ServerCliRunnerBundleCheckError({
      check: "fenced-module",
      detail: `runner.mjs inlines ${fenced.join(", ")}`,
    });
  }
  const workerImports = findEsmImportsOfExternalPackages(
    yield* fs.readFileString(path.join(out, "claude-history-worker.mjs")),
  );
  if (workerImports.length > 0) {
    return yield* new ServerCliRunnerBundleCheckError({
      check: "worker-import",
      detail: `claude-history-worker.mjs imports ${workerImports.join(", ")}`,
    });
  }

  if (input.dev) {
    // At the agent's own relative paths: it resolves `new URL(scenario.file, import.meta.url)`.
    for (const scenario of DEV_REPLAY_SCENARIOS) {
      const target = path.resolve(out, "replay", scenario.file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copyFile(path.resolve(serverDir, "scripts", scenario.file), target);
    }
  }

  if (input.externalsCache === undefined) {
    const stageDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-externals-" });
    yield* stageRunnerExternals(repoRoot, stageDir);
    yield* fs.copy(path.join(stageDir, "node_modules"), path.join(out, "node_modules"));
  } else {
    const lockHash = NodeCrypto.createHash("sha256")
      .update(yield* fs.readFile(path.join(repoRoot, "pnpm-lock.yaml")))
      .digest("hex");
    const cached = path.join(input.externalsCache, `externals-${lockHash}`);
    if (!(yield* fs.exists(cached))) {
      const stageDir = `${cached}.staging-${NodeCrypto.randomUUID()}`;
      yield* fs.makeDirectory(stageDir, { recursive: true });
      yield* stageRunnerExternals(repoRoot, stageDir).pipe(
        Effect.onError(() =>
          fs.remove(stageDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
      yield* fs.rename(stageDir, cached);
    }
    yield* fs.copy(path.join(cached, "node_modules"), path.join(out, "node_modules"));
  }

  yield* fs.writeFileString(path.join(out, "t3"), RUNNER_SHIM);
  yield* fs.chmod(path.join(out, "t3"), 0o755);

  let bytes = 0;
  for (const entry of yield* fs.readDirectory(out, { recursive: true })) {
    const info = yield* fs.stat(path.join(out, entry));
    if (info.type === "File") bytes += Number(info.size);
  }
  if (bytes > RUNNER_MAX_BYTES) {
    return yield* new ServerCliRunnerBundleCheckError({
      check: "size",
      detail: `${bytes} bytes, over ${RUNNER_MAX_BYTES}`,
    });
  }

  const manifest: typeof RunnerManifest.Type = {
    runnerBuildId: yield* computeRunnerBuildId(out),
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    node: serverPackageJson.engines.node,
    builtFrom: input.dev ? "source" : "release",
  };
  yield* fs.writeFileString(
    path.join(out, RUNNER_MANIFEST_FILE),
    `${yield* encodeRunnerManifest(manifest)}\n`,
  );
  yield* Effect.log(`[cli] Built runner ${manifest.runnerBuildId} (${bytes} bytes) in ${out}`);
}, Effect.scoped);

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found. Skipping client bundle.");
      }

      yield* buildRunner({
        out: path.join(serverDir, "dist/runner"),
        dev: false,
        externalsCache: undefined,
        verbose: config.verbose,
      });
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const target = Option.getOrUndefined(config.target);
      // TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
      const linuxArm64 =
        !target &&
        (yield* HostProcess.Platform) === "linux" &&
        (yield* HostProcess.Architecture) === "arm64";
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            T3CODE_PACK_EXE: linuxArm64 ? "bundle" : "1",
            T3CODE_PACK_EXE_TARGET: target ?? "",
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // Executables reject non-builtin imports even when bundling succeeds; inspect the emitted graph.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      // TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
      if (linuxArm64) {
        yield* injectLinuxArm64Sea({
          bundlePath,
          outputPath: path.join(serverDir, "dist-exe/t3"),
          nodeVersion: rootPackageJson.engines.node,
          verbose: config.verbose,
        });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    `Build the server as a Node single-executable. Native builds require Node ${rootPackageJson.engines.node}; explicit cross-target builds need a Node 25.7+ host for --build-sea. Linux ARM64 builds only on a Linux ARM64 host. The binary still resolves native packages from a node_modules tree beside it.`,
  ),
);

const buildRunnerCmd = Command.make(
  "build-runner",
  {
    out: Flag.String("out").pipe(Flag.withDescription("Directory to write the bundle tree to.")),
    dev: Flag.Boolean("dev").pipe(
      Flag.withDescription("Add the Replay (dev) agent and its transcripts."),
      Flag.withDefault(false),
    ),
    externalsCache: Flag.String("externals-cache").pipe(
      Flag.withDescription("Keep the native externals install here, keyed by pnpm-lock.yaml."),
      Flag.optional,
    ),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    buildRunner({
      out: config.out,
      dev: config.dev,
      externalsCache: Option.getOrUndefined(config.externalsCache),
      verbose: config.verbose,
    }),
).pipe(
  Command.withDescription(
    "Build the sandbox runner bundle (runner.mjs, externals, MANIFEST.json).",
  ),
);

/** Publish after the GitHub release exists; the launcher downloads from it. */
const publishCmd = Command.make(
  "publish",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-launcher.ts."),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const packagesDir = path.resolve(config.packagesDir);
      const launcherTarball = path.join(packagesDir, "t3.tgz");
      if (!(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");
      const spawnCommand = yield* resolveSpawnCommand("npm", [...args, launcherTarball]);
      yield* Effect.log(`[cli] npm ${args.join(" ")} t3.tgz`);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: packagesDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );
    }),
).pipe(Command.withDescription("Publish the t3 launcher to npm."));

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildRunnerCmd, buildExeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
