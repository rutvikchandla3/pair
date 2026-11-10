// @effect-diagnostics nodeBuiltinImport:off - random bytes that gzip cannot shrink.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CODEX_RELEASES } from "../../provider/codexReleases.ts";
import {
  codexEnv,
  PROVISION_TREE_MAX_BYTES,
  readReleasedTree,
  readSourceTree,
} from "./SandboxProvisionTree.ts";

const infraDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../../../infra/sandbox-image", import.meta.url));
});

it.layer(NodeServices.layer)("codexEnv", (it) => {
  it.effect("maps both Linux releases", () =>
    Effect.gen(function* () {
      const env = yield* codexEnv(CODEX_RELEASES);
      const x64 = CODEX_RELEASES["linux-x64"]!;
      const arm64 = CODEX_RELEASES["linux-arm64"]!;
      assert.deepStrictEqual(env.trim().split("\n"), [
        `CODEX_VERSION=${x64.version}`,
        `CODEX_URL_AMD64=${x64.url}`,
        `CODEX_SHA256_AMD64=${x64.sha256}`,
        `CODEX_URL_ARM64=${arm64.url}`,
        `CODEX_SHA256_ARM64=${arm64.sha256}`,
      ]);
    }),
  );

  it.effect("fails when a Linux release is missing", () =>
    Effect.gen(function* () {
      const { "linux-arm64": _, ...withoutArm } = CODEX_RELEASES;
      const error = yield* Effect.flip(codexEnv(withoutArm));
      assert.include(error.message, "linux-arm64");
    }),
  );
});

it.layer(NodeServices.layer)("SandboxProvisionTree", (it) => {
  it.effect("a release's copy of the tree and the checkout's give one hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* infraDir;
      // What `sandbox-image.ts context` writes and build-cli-archive.ts ships as sandbox-image/.
      const released = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provision-tree-" });
      yield* fs.copy(source, released, { overwrite: true });
      yield* fs.writeFileString(path.join(released, "codex.env"), yield* codexEnv(CODEX_RELEASES));

      const fromSource = yield* readSourceTree(source);
      const fromRelease = yield* readReleasedTree(released);
      assert.strictEqual(fromRelease.sha256, fromSource.sha256);
      assert.strictEqual(fromRelease.tarGzBase64, fromSource.tarGzBase64);
      assert.isBelow(fromSource.tarGzBase64.length, PROVISION_TREE_MAX_BYTES);
      assert.strictEqual(
        fromSource.baseBuildScript,
        yield* fs.readFileString(path.join(source, "vm/base-build.sh")),
      );

      yield* fs.writeFileString(path.join(released, "vm/extra.sh"), "true\n");
      assert.notStrictEqual((yield* readReleasedTree(released)).sha256, fromSource.sha256);
    }),
  );

  it.effect("refuses a missing tree and one over the metadata limit by reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provision-tree-" });
      assert.strictEqual((yield* Effect.flip(readReleasedTree(empty))).reason, "not-bundled");
      assert.strictEqual(
        (yield* Effect.flip(readSourceTree(path.join(empty, "missing")))).reason,
        "not-bundled",
      );

      yield* fs.writeFileString(path.join(empty, "provision.sh"), "#!/bin/sh\n");
      yield* fs.writeFileString(path.join(empty, "codex.env"), "CODEX_VERSION=1\n");
      yield* fs.makeDirectory(path.join(empty, "vm"));
      yield* fs.writeFileString(path.join(empty, "vm/base-build.sh"), "#!/bin/sh\n");
      yield* fs.writeFile(
        path.join(empty, "blob.bin"),
        NodeCrypto.randomBytes(PROVISION_TREE_MAX_BYTES),
      );
      assert.strictEqual((yield* Effect.flip(readReleasedTree(empty))).reason, "too-large");
    }),
  );
});
