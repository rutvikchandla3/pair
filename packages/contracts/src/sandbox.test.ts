import { describe, expect, it } from "vite-plus/test";

import { sandboxImageLabel } from "./sandbox.ts";

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
  ])("labels $name", ({ baseImage, label }) => {
    expect(sandboxImageLabel(baseImage === undefined ? {} : { baseImage })).toBe(label);
  });
});
