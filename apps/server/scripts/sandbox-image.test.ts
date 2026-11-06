import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CODEX_RELEASES } from "../src/provider/codexReleases.ts";
import { codexEnv } from "./sandbox-image.ts";

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
