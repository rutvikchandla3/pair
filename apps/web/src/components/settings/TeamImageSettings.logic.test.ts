import {
  ProjectId,
  SecretProviderId,
  type ProviderInstanceEnvironmentVariable,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromRecipe,
  fixWithAgentPrompt,
  NPM_TOKEN_WARNING,
  npmTokenWarning,
  recipeChanges,
  recipeFromDraft,
} from "./TeamImageSettings.logic";

const web = ProjectId.make("project-web");
const api = ProjectId.make("project-api");
const docs = ProjectId.make("project-docs");
const names: Record<string, string> = { [web]: "web", [api]: "api", [docs]: "docs" };
const projectName = (id: ProjectId) => names[id] ?? id;

const onepassword = SecretProviderId.make("onepassword");
const recipe: TeamImageRecipe = {
  base: { type: "pair" },
  projectIds: [web, api],
  buildEnv: { NODE_OPTIONS: "--max-old-space-size=4096" },
  buildSecrets: { NPM_TOKEN: { provider: onepassword, reference: "Eng/npm-read" } },
  install: "sudo apt-get install -y jq\npnpm install\n",
};

describe("npmTokenWarning", () => {
  it.each([
    ["npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN", true],
    ['npm config set "//registry.npmjs.org/:_authToken" "${NPM_TOKEN}"', true],
    ['npm config set //registry.npmjs.org/:_authToken "${NPM_TOKEN}"', true],
    ["pnpm config set //npm.pkg.github.com/:_authToken=$GH_TOKEN", true],
    ["  # npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN", false],
    ["npm config set //registry.npmjs.org/:_authToken abc123", false],
    ["echo '_authToken=${NPM_TOKEN}' >> .npmrc", false],
    ["npm config set registry https://registry.npmjs.org", false],
  ])("on %j warns: %s", (install, warns) => {
    expect(npmTokenWarning(`set -e\n${install}\nmake`)).toBe(warns ? NPM_TOKEN_WARNING : null);
  });
});

describe("the recipe and its draft", () => {
  it("round-trips a recipe", () => {
    expect(recipeFromDraft(draftFromRecipe(recipe))).toEqual({ ok: true, recipe });
  });

  it.each<{
    name: string;
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    error: string;
  }>([
    {
      name: "a secret typed in as a value",
      environment: [{ name: "TOKEN", value: "hunter2", sensitive: true }],
      error:
        "TOKEN is a secret. Pick where it comes from; a recipe holds references, never values.",
    },
    {
      name: "a secret with no value yet",
      environment: [{ name: "TOKEN", value: "", sensitive: true }],
      error:
        "TOKEN is a secret. Pick where it comes from; a recipe holds references, never values.",
    },
    {
      name: "a name set twice",
      environment: [
        { name: "A", value: "1", sensitive: false },
        {
          name: "A",
          value: { provider: SecretProviderId.make("p"), reference: "r" },
          sensitive: true,
        },
      ],
      error: "A is set twice.",
    },
  ])("refuses $name", ({ environment, error }) => {
    expect(recipeFromDraft({ ...draftFromRecipe(recipe), environment })).toEqual({
      ok: false,
      error,
    });
  });
});

describe("recipeChanges", () => {
  it("names nothing for equal recipes", () => {
    expect(recipeChanges(recipe, recipe, projectName)).toEqual([]);
  });

  it("names each part that changed", () => {
    const changed: TeamImageRecipe = {
      ...recipe,
      projectIds: [web, docs],
      install: "sudo apt-get install -y jq postgresql-client\npnpm install\nmake db\n",
      buildEnv: { NODE_OPTIONS: "--max-old-space-size=8192", CI: "1" },
      buildSecrets: {},
    };
    expect(recipeChanges(recipe, changed, projectName)).toEqual([
      "Pre-cloned projects: added docs; removed api",
      "Install script: 2 lines added, 1 removed",
      "Build env: added CI; changed NODE_OPTIONS",
      "Build secrets: removed NPM_TOKEN",
    ]);
  });

  it("notices a secret that points elsewhere and a reordered script", () => {
    const moved: TeamImageRecipe = {
      ...recipe,
      install: "pnpm install\nsudo apt-get install -y jq\n",
      buildSecrets: { NPM_TOKEN: { provider: onepassword, reference: "Eng/other" } },
    };
    expect(recipeChanges(recipe, moved, projectName)).toEqual([
      "Install script: lines reordered",
      "Build secrets: changed NPM_TOKEN",
    ]);
  });
});

describe("fixWithAgentPrompt", () => {
  it("carries the failure and the log tail, then asks for the fix", () => {
    const prompt = fixWithAgentPrompt({
      number: 15,
      failure: {
        phase: "install",
        detail: "x",
        exitCode: 100,
        logTail: ["E: Unable to locate package jqq", "exit 100"],
      },
    });
    expect(prompt).toBe(
      [
        "Team image build 15 failed: The install script exited with 100.",
        "The last lines of its log:\n\nE: Unable to locate package jqq\nexit 100",
        "Help me fix it. Read the recipe with t3_team_image_read, try changes in this machine's terminal, then update the install script and start a build.",
      ].join("\n\n"),
    );
  });
});
