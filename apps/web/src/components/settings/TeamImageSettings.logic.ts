import {
  isReservedSandboxEnvName,
  TEAM_IMAGE_INSTALL_MAX_CHARS,
  type ProjectId,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
  type TeamImageBuild,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import { teamImageFailureMessage } from "@t3tools/client-runtime/team-image-presentation";

/** What the editor holds: the recipe with build env and secrets as one variable list. */
export interface TeamImageDraft {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly install: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
}

export const NPM_TOKEN_WARNING =
  "This writes the token into ~/.npmrc, and every machine gets it. Use `_authToken=${NPM_TOKEN}` in .npmrc instead.";

export const RECIPE_CHANGED_MESSAGE =
  "Someone saved the recipe since you opened it. Copy your change, then reload.";

const RESERVED_BUILD_NAME_MESSAGE = "Pair sets this variable on every machine.";

export function reservedBuildName(name: string): string | null {
  return isReservedSandboxEnvName(name) ? RESERVED_BUILD_NAME_MESSAGE : null;
}

// `npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN`, also with pnpm and a quoted value.
const NPM_AUTH_TOKEN_LINE =
  /\b(?:npm|pnpm)\s+config\s+set\s+\S*:_authToken["']?[=\s]+["']?\$\{?[A-Za-z_]/;

/** The warning for an install script that writes a token into `~/.npmrc`; null when none does. */
export function npmTokenWarning(install: string): string | null {
  const writesToken = install
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && NPM_AUTH_TOKEN_LINE.test(line));
  return writesToken ? NPM_TOKEN_WARNING : null;
}

export function draftFromRecipe(recipe: TeamImageRecipe): TeamImageDraft {
  return {
    projectIds: recipe.projectIds,
    install: recipe.install,
    environment: [
      ...Object.entries(recipe.buildEnv).map(([name, value]) => ({
        name,
        value,
        sensitive: false,
      })),
      ...Object.entries(recipe.buildSecrets).map(([name, secret]) => ({
        name,
        value: secret,
        sensitive: true,
      })),
    ],
  };
}

export type RecipeFromDraft =
  | { readonly ok: true; readonly recipe: TeamImageRecipe }
  | { readonly ok: false; readonly error: string };

/** A build secret is a reference; a typed-in value never reaches the recipe. */
export function recipeFromDraft(draft: TeamImageDraft): RecipeFromDraft {
  const buildEnv: Record<string, string> = {};
  const buildSecrets: Record<string, SecretReference> = {};
  const seen = new Set<string>();
  for (const variable of draft.environment) {
    if (seen.has(variable.name)) return { ok: false, error: `${variable.name} is set twice.` };
    seen.add(variable.name);
    if (!variable.sensitive) {
      buildEnv[variable.name] = typeof variable.value === "string" ? variable.value : "";
    } else if (typeof variable.value === "string") {
      return {
        ok: false,
        error: `${variable.name} is a secret. Pick where it comes from; a recipe holds references, never values.`,
      };
    } else {
      buildSecrets[variable.name] = variable.value;
    }
  }
  if (draft.install.length > TEAM_IMAGE_INSTALL_MAX_CHARS) {
    return {
      ok: false,
      error: `The install script is over ${TEAM_IMAGE_INSTALL_MAX_CHARS.toLocaleString("en-US")} characters.`,
    };
  }
  return {
    ok: true,
    recipe: {
      base: { type: "pair" },
      projectIds: draft.projectIds,
      buildEnv,
      buildSecrets,
      install: draft.install,
    },
  };
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (text === "") return counts;
  for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Lines present in `to` but not `from`, and the reverse, counting repeats; order is not compared. */
function installLineChanges(
  from: string,
  to: string,
): { readonly added: number; readonly removed: number } {
  const before = lineCounts(from);
  const after = lineCounts(to);
  let added = 0;
  let removed = 0;
  for (const [line, count] of after) added += Math.max(0, count - (before.get(line) ?? 0));
  for (const [line, count] of before) removed += Math.max(0, count - (after.get(line) ?? 0));
  return { added, removed };
}

const secretKey = (secret: SecretReference) => `${secret.provider}:${secret.reference}`;

function nameChanges(
  label: string,
  from: Readonly<Record<string, string>>,
  to: Readonly<Record<string, string>>,
): string | null {
  const added = Object.keys(to).filter((name) => !(name in from));
  const removed = Object.keys(from).filter((name) => !(name in to));
  const changed = Object.keys(to).filter((name) => name in from && from[name] !== to[name]);
  const parts = [
    added.length > 0 ? `added ${added.join(", ")}` : null,
    removed.length > 0 ? `removed ${removed.join(", ")}` : null,
    changed.length > 0 ? `changed ${changed.join(", ")}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `${label}: ${parts.join("; ")}`;
}

/**
 * What differs between two recipes, one line per part, for the editor's "unsaved changes" and a
 * restored revision. `projectName` turns an id into what people call it.
 */
export function recipeChanges(
  from: TeamImageRecipe,
  to: TeamImageRecipe,
  projectName: (projectId: ProjectId) => string,
): ReadonlyArray<string> {
  const lines: string[] = [];
  const addedProjects = to.projectIds.filter((id) => !from.projectIds.includes(id));
  const removedProjects = from.projectIds.filter((id) => !to.projectIds.includes(id));
  if (addedProjects.length > 0 || removedProjects.length > 0) {
    lines.push(
      `Pre-cloned projects: ${[
        addedProjects.length > 0 ? `added ${addedProjects.map(projectName).join(", ")}` : null,
        removedProjects.length > 0
          ? `removed ${removedProjects.map(projectName).join(", ")}`
          : null,
      ]
        .filter((part) => part !== null)
        .join("; ")}`,
    );
  }
  if (from.install !== to.install) {
    const { added, removed } = installLineChanges(from.install, to.install);
    lines.push(
      added === 0 && removed === 0
        ? "Install script: lines reordered"
        : `Install script: ${added} line${added === 1 ? "" : "s"} added, ${removed} removed`,
    );
  }
  const env = nameChanges("Build env", from.buildEnv, to.buildEnv);
  if (env !== null) lines.push(env);
  const secrets = nameChanges(
    "Build secrets",
    Object.fromEntries(Object.entries(from.buildSecrets).map(([n, s]) => [n, secretKey(s)])),
    Object.fromEntries(Object.entries(to.buildSecrets).map(([n, s]) => [n, secretKey(s)])),
  );
  if (secrets !== null) lines.push(secrets);
  return lines;
}

export const EDIT_WITH_AGENT_PROMPT =
  "Help me change the team image. Read the recipe with t3_team_image_read, try changes in this machine's terminal, then update the install script and start a build.";

/** The first message of **Fix with an agent**: the failure and its tail, then the same ask. */
export function fixWithAgentPrompt(build: Pick<TeamImageBuild, "number" | "failure">): string {
  const failure = build.failure;
  const tail = failure?.logTail ?? [];
  return [
    `Team image build ${build.number} failed${failure === undefined ? "." : `: ${teamImageFailureMessage(failure)}`}`,
    tail.length === 0 ? null : `The last lines of its log:\n\n${tail.join("\n")}`,
    EDIT_WITH_AGENT_PROMPT.replace("Help me change the team image.", "Help me fix it."),
  ]
    .filter((part) => part !== null)
    .join("\n\n");
}
