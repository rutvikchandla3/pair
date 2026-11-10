import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import packageJson from "../package.json" with { type: "json" };
import { BUNDLED_MODEL_MANIFEST } from "../src/provider/ModelManifest.ts";
import type { ProviderCompatibilityPolicy } from "../src/provider/providerCompatibility.ts";
import { checkProviderPins, planRelease, readProviderPins } from "./sandbox-image.ts";

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

it.effect(
  "planRelease publishes the server's exact version to the running repo's lowercased GHCR",
  () =>
    Effect.gen(function* () {
      const base = {
        eventName: "push",
        refName: `v${packageJson.version}`,
        inputVersion: "",
        runId: "42",
        repositoryOwner: "Acme-Fork",
        serverVersion: packageJson.version,
      };
      const image = "ghcr.io/acme-fork/t3-sandbox";
      const cases = [
        {
          name: "a tag matching the server version publishes that version",
          input: base,
          expected: {
            version: packageJson.version,
            tag: packageJson.version,
            image,
            dryRun: false,
          },
        },
        {
          name: "a manual run publishes a dry-run tag",
          input: {
            ...base,
            eventName: "workflow_dispatch",
            refName: "main",
            inputVersion: "v9.9.9",
          },
          expected: { version: "9.9.9", tag: "9.9.9-dryrun.42", image, dryRun: true },
        },
        {
          name: "a tag that is not the server version fails",
          input: { ...base, refName: "v9.9.9" },
          error: "does not match the server version",
        },
        {
          name: "a manual run needs a release version",
          input: { ...base, eventName: "workflow_dispatch", inputVersion: "latest" },
          error: "not a release version",
        },
        {
          name: "a pull request never publishes",
          input: { ...base, eventName: "pull_request" },
          error: "pull_request",
        },
      ];
      for (const { name, input, ...outcome } of cases) {
        if ("error" in outcome) {
          assert.include((yield* Effect.flip(planRelease(input))).message, outcome.error, name);
        } else {
          assert.deepStrictEqual(yield* planRelease(input), outcome.expected, name);
        }
      }
    }),
);
