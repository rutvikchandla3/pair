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
  installDiff,
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
    expect(recipeFromDraft(draftFromRecipe(recipe))).toEqual({
      ok: true,
      recipe,
      secretValues: {},
    });
  });

  it("keeps a typed secret's value out of the recipe, and a saved one stays saved", () => {
    const held: TeamImageRecipe = {
      ...recipe,
      buildSecrets: { ...recipe.buildSecrets, GH_TOKEN: { kind: "server" } },
    };
    const draft = draftFromRecipe(held, new Set(["GH_TOKEN"]));
    expect(draft.environment).toContainEqual({
      name: "GH_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
    });
    expect(recipeFromDraft(draft)).toEqual({ ok: true, recipe: held, secretValues: {} });

    const typed = recipeFromDraft({
      ...draft,
      environment: [
        ...draft.environment.filter((variable) => variable.name !== "GH_TOKEN"),
        { name: "GH_TOKEN", value: "ghp_fake_value", sensitive: true, valueRedacted: false },
      ],
    });
    expect(typed).toEqual({ ok: true, recipe: held, secretValues: { GH_TOKEN: "ghp_fake_value" } });
    if (!typed.ok) return;
    expect(JSON.stringify(typed.recipe)).not.toContain("ghp_fake_value");
    expect(recipeChanges(held, typed.recipe, projectName, typed.secretValues)).toEqual([
      "Build secrets: changed GH_TOKEN",
    ]);
  });

  it.each<{
    name: string;
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    error: string;
  }>([
    {
      name: "a secret with no value yet",
      environment: [{ name: "TOKEN", value: "", sensitive: true }],
      error: "Enter a value for TOKEN.",
    },
    {
      // A restored revision names a value removed since.
      name: "a server-held secret whose value is gone",
      environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: false }],
      error: "Enter a value for TOKEN.",
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

describe("installDiff", () => {
  const render = (from: string, to: string) =>
    installDiff(from, to).map(
      ({ kind, text }) => `${kind === "same" ? " " : kind === "added" ? "+" : "-"}${text}`,
    );

  it.each([
    ["adds a line", "a\nb\n", "a\nb\nc\n", [" a", " b", "+c"]],
    ["removes one", "a\nb\nc\n", "a\nc\n", [" a", "-b", " c"]],
    ["replaces one in place", "a\nb\nc", "a\nx\nc", [" a", "-b", "+x", " c"]],
    ["inserts between repeats", "a\na", "a\nb\na", [" a", "+b", " a"]],
    ["fills an empty script", "", "a\nb\n", ["+a", "+b"]],
    ["clears a script", "a\n", "", ["-a"]],
    ["keeps an unchanged script as it is", "a\nb\n", "a\nb", [" a", " b"]],
  ])("%s", (_name, from, to, expected) => {
    expect(render(from, to)).toEqual(expected);
  });

  it("shows a huge replaced middle as removed then added", () => {
    const from = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const to = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    const lines = installDiff(`keep\n${from}\nend`, `keep\n${to}\nend`);
    expect(lines).toHaveLength(1202);
    expect(lines[0]).toEqual({ kind: "same", text: "keep" });
    expect(lines[1]?.kind).toBe("removed");
    expect(lines[601]?.kind).toBe("added");
    expect(lines.at(-1)).toEqual({ kind: "same", text: "end" });
  });
});
