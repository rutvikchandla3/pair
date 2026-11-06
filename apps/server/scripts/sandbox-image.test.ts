import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import packageJson from "../package.json" with { type: "json" };
import { CODEX_RELEASES } from "../src/provider/codexReleases.ts";
import { BUNDLED_MODEL_MANIFEST } from "../src/provider/ModelManifest.ts";
import type { ProviderCompatibilityPolicy } from "../src/provider/providerCompatibility.ts";
import { checkProviderPins, codexEnv, readProviderPins } from "./sandbox-image.ts";

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

const policy = (
  driver: string,
  t3CodeRange: string,
  ranges: ProviderCompatibilityPolicy["ranges"],
): ProviderCompatibilityPolicy => ({ driver, t3CodeRange, ranges });

const POLICIES = [
  policy("claudeAgent", ">=1.0.0", [
    { range: "<2.0.0", status: "unsupported" },
    { range: ">=2.0.0 <2.1.0", status: "graceful" },
    { range: ">=2.1.0", status: "supported" },
  ]),
  policy("codex", ">=1.0.0", [{ range: ">=0.100.0", status: "supported" }]),
];

it("checkProviderPins grades pins against the manifest for the release version", () => {
  const pins = { claudeAgent: "2.1.311", codex: "0.200.0" };
  const cases = [
    { name: "supported pins pass", pins, policies: POLICIES, version: "1.2.0", expected: [] },
    {
      name: "an unsupported pin fails",
      pins: { ...pins, claudeAgent: "1.9.0" },
      policies: POLICIES,
      version: "1.2.0",
      expected: [{ driver: "claudeAgent", version: "1.9.0", status: "unsupported" }],
    },
    {
      name: "a graceful pin fails",
      pins: { ...pins, claudeAgent: "2.0.5" },
      policies: POLICIES,
      version: "1.2.0",
      expected: [{ driver: "claudeAgent", version: "2.0.5", status: "graceful" }],
    },
    {
      name: "a driver with no policy fails",
      pins,
      policies: POLICIES.slice(0, 1),
      version: "1.2.0",
      expected: [{ driver: "codex", version: "0.200.0", status: "no policy" }],
    },
    {
      name: "a t3CodeRange that excludes the release fails",
      pins,
      policies: POLICIES,
      version: "0.9.0",
      expected: [
        { driver: "claudeAgent", version: "2.1.311", status: "no policy" },
        { driver: "codex", version: "0.200.0", status: "no policy" },
      ],
    },
  ];
  for (const { name, pins, policies, version, expected } of cases) {
    assert.deepStrictEqual(checkProviderPins(pins, policies, version), expected, name);
  }
});

it.layer(NodeServices.layer)("readProviderPins", (it) => {
  it.effect("the repo's pins are supported by the bundled manifest for this server version", () =>
    Effect.gen(function* () {
      const pins = yield* readProviderPins();
      assert.deepStrictEqual(
        checkProviderPins(pins, BUNDLED_MODEL_MANIFEST.compatibility, packageJson.version),
        [],
      );
    }),
  );
});
