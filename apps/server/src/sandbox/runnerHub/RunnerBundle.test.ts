// @effect-diagnostics nodeBuiltinImport:off - the test checks the digest independently.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as RunnerBundle from "./RunnerBundle.ts";

/** Writes the files in the given order into a fresh temp dir and hashes it. */
const treeId = (files: ReadonlyArray<readonly [path: string, content: string, mode: number]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-tree-" });
    for (const [file, content, mode] of files) {
      const target = path.join(directory, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
      yield* fs.chmod(target, mode);
    }
    return yield* RunnerBundle.computeRunnerBuildId(directory);
  });

it.layer(NodeServices.layer)("RunnerBundle", (it) => {
  it.effect(
    "the tree id ignores file order and MANIFEST.json, and covers contents and exec bits",
    () =>
      Effect.gen(function* () {
        const base = yield* treeId([
          ["runner.mjs", "runner", 0o644],
          ["t3", "#!/bin/sh", 0o755],
          ["node_modules/node-pty/index.js", "pty", 0o644],
        ]);
        assert.match(base, /^[0-9a-f]{64}$/);
        assert.equal(
          yield* treeId([
            ["node_modules/node-pty/index.js", "pty", 0o644],
            ["t3", "#!/bin/sh", 0o755],
            ["runner.mjs", "runner", 0o644],
            ["MANIFEST.json", "{}", 0o644],
          ]),
          base,
        );
        assert.notEqual(
          yield* treeId([
            ["runner.mjs", "runner2", 0o644],
            ["t3", "#!/bin/sh", 0o755],
            ["node_modules/node-pty/index.js", "pty", 0o644],
          ]),
          base,
        );
        assert.notEqual(
          yield* treeId([
            ["runner.mjs", "runner", 0o644],
            ["t3", "#!/bin/sh", 0o644],
            ["node_modules/node-pty/index.js", "pty", 0o644],
          ]),
          base,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("tars the tree once and reports the tarball's digest", () =>
    Effect.gen(function* () {
      const bundle = yield* RunnerBundle.RunnerBundle;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const info = yield* bundle.current;
      assert.equal(yield* bundle.current, info);
      assert.isTrue(info.tarballPath.endsWith(`/runner/${info.runnerBuildId}.tar.gz`));
      assert.equal(info.runnerBuildId, yield* RunnerBundle.computeRunnerBuildId(info.directory));
      const listing = yield* spawner
        .spawn(ChildProcess.make("tar", ["-tzf", info.tarballPath]))
        .pipe(
          Effect.flatMap((child) => child.stdout.pipe(Stream.decodeText(), Stream.mkString)),
          Effect.scoped,
        );
      assert.sameMembers(
        listing.split("\n").filter((line) => line.length > 0 && !line.endsWith("/")),
        ["./MANIFEST.json", "./runner.mjs", "./t3"],
      );
      assert.equal(
        info.tarballSha256,
        NodeCrypto.createHash("sha256")
          .update(yield* fs.readFile(info.tarballPath))
          .digest("hex"),
      );
    }).pipe(
      Effect.provide(
        RunnerBundle.layerTest([
          { path: "runner.mjs", content: "runner" },
          { path: "t3", content: "#!/bin/sh", executable: true },
        ]).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-runner-bundle-test-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("serves a released tree from any directory, and calls a missing tree not-bundled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tree = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-release-" });
      yield* fs.writeFileString(path.join(tree, "runner.mjs"), "runner");
      const runnerBuildId = yield* RunnerBundle.computeRunnerBuildId(tree);
      yield* fs.writeFileString(
        path.join(tree, RunnerBundle.RUNNER_MANIFEST_FILE),
        yield* RunnerBundle.encodeRunnerManifest({
          runnerBuildId,
          protocolVersion: 1,
          node: ">=22",
          builtFrom: "release",
        }),
      );
      const current = (directory: string) =>
        RunnerBundle.RunnerBundle.pipe(
          Effect.flatMap((bundle) => bundle.current),
          Effect.provide(RunnerBundle.layerFromTree(directory)),
        );

      const info = yield* current(tree);
      assert.equal(info.runnerBuildId, runnerBuildId);
      assert.equal(info.directory, tree);
      assert.equal(
        info.tarballSha256,
        NodeCrypto.createHash("sha256")
          .update(yield* fs.readFile(info.tarballPath))
          .digest("hex"),
      );

      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-release-" });
      const error = yield* Effect.flip(current(empty));
      assert.equal(error.reason, "not-bundled");
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-runner-bundle-test-" })),
    ),
  );
});
