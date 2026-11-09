import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TeamImageError, TeamImageRecipe } from "./sandboxImage.ts";

const isRecipe = Schema.is(TeamImageRecipe);
const decodeError = Schema.decodeUnknownSync(TeamImageError);

const recipe = {
  base: { type: "pair" },
  projectIds: ["project-1"],
  buildEnv: { NODE_ENV: "production" },
  buildSecrets: { NPM_TOKEN: { provider: "vault", reference: "team/npm" } },
  install: "apt-get install -y jq",
};

describe("team image contracts", () => {
  it.each([
    { name: "a complete recipe", change: {}, valid: true },
    { name: "a name in both maps", change: { buildEnv: { NPM_TOKEN: "x" } }, valid: false },
    {
      name: "50 projects",
      change: { projectIds: Array.from({ length: 50 }, (_, i) => `project-${i}`) },
      valid: true,
    },
    {
      name: "51 projects",
      change: { projectIds: Array.from({ length: 51 }, (_, i) => `project-${i}`) },
      valid: false,
    },
    { name: "a repeated project", change: { projectIds: ["a", "a"] }, valid: false },
    { name: "a 64,000-character script", change: { install: "x".repeat(64_000) }, valid: true },
    { name: "a 64,001-character script", change: { install: "x".repeat(64_001) }, valid: false },
    { name: "an image base", change: { base: { type: "image", ref: "r" } }, valid: false },
  ])("the recipe takes $name: $valid", ({ change, valid }) => {
    expect(isRecipe({ ...recipe, ...change })).toBe(valid);
  });

  it.each([
    { reason: "recipe-changed", decoded: "recipe-changed" },
    { reason: "from-a-newer-server", decoded: null },
  ])("TeamImageError reads reason $reason as $decoded", ({ reason, decoded }) => {
    expect(decodeError({ _tag: "TeamImageError", reason, message: "No." }).reason).toBe(decoded);
  });
});
