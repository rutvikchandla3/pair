import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { sandboxImageLabel, TeamImageBuildId } from "./sandbox.ts";

const decodeBuildId = Schema.decodeSync(TeamImageBuildId);

describe("sandboxImageLabel", () => {
  it.each([
    { name: "no base image recorded", baseImage: undefined, label: "Pair base" },
    {
      name: "a Pair version",
      baseImage: { ref: "ghcr.io/pair/t3-sandbox:1.2.3", digest: "sha256:a", version: "1.2.3" },
      label: "Pair base 1.2.3",
    },
    {
      name: "an override without a version",
      baseImage: { ref: "registry.example.com/base:7", digest: "sha256:b", version: null },
      label: "Base image registry.example.com/base:7",
    },
    {
      name: "a team build over a recorded base",
      baseImage: { ref: "ghcr.io/pair/t3-sandbox:1.2.3", digest: "sha256:a", version: "1.2.3" },
      imageBuild: { id: decodeBuildId("tib_0123456789abcdef0123"), number: 14 },
      label: "Build 14",
    },
  ])("labels $name", ({ baseImage, imageBuild, label }) => {
    expect(
      sandboxImageLabel({
        ...(baseImage === undefined ? {} : { baseImage }),
        ...(imageBuild === undefined ? {} : { imageBuild }),
      }),
    ).toBe(label);
  });
});
