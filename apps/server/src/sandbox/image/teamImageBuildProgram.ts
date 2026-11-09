import { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const TEAM_IMAGE_ROOT = "/t3-sandbox/.image";
export const TEAM_IMAGE_BUILD_OUTPUT = "/etc/t3/build.json";
export const TEAM_IMAGE_PHASE_MARKER = "::t3-phase::";

/** What the program writes to `/etc/t3/build.json`; the server trusts nothing past this schema. */
export const TeamImageBuildOutput = Schema.Struct({
  pairVersion: Schema.String,
  providers: Schema.Record(Schema.String, Schema.String),
  repos: Schema.Array(
    Schema.Struct({ projectId: ProjectId, path: Schema.String, headSha: Schema.String }),
  ),
  imageEnv: Schema.Record(Schema.String, Schema.String),
});
export type TeamImageBuildOutput = typeof TeamImageBuildOutput.Type;

export interface TeamImageBuildProgramInput {
  readonly repos: ReadonlyArray<{
    readonly projectId: string;
    readonly url: string;
    readonly path: string;
    /** The variable holding the clone token, or null to clone without one. */
    readonly tokenVariable: string | null;
  }>;
  /** Build env, secret and token names, never recorded in `imageEnv`. */
  readonly excludedEnvNames: ReadonlyArray<string>;
  /** Tests point these at a temporary directory. */
  readonly paths?: {
    readonly imageRoot: string;
    readonly output: string;
    readonly baseInfo: string;
  };
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Debian's default; the env diff runs in a clean login shell so the spawn's env does not leak in.
const CLEAN_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const PROVIDER_CLIS: ReadonlyArray<readonly [string, string]> = [
  ["claudeAgent", "claude"],
  ["codex", "codex"],
];

/** The Bash text of `t3-build.sh`. It runs as t3 from `$HOME`, with `install.sh` beside it. */
export const teamImageBuildProgram = (input: TeamImageBuildProgramInput): string => {
  const paths = input.paths ?? {
    imageRoot: TEAM_IMAGE_ROOT,
    output: TEAM_IMAGE_BUILD_OUTPUT,
    baseInfo: "/etc/pair-image.json",
  };
  for (const repo of input.repos) {
    if (repo.tokenVariable !== null && !VARIABLE_NAME.test(repo.tokenVariable)) {
      throw new Error(`Not a variable name: ${repo.tokenVariable}`);
    }
  }
  const clones = input.repos.flatMap((repo, index) => {
    const helper =
      repo.tokenVariable === null
        ? []
        : [
            "-c",
            quote(
              `credential.helper=!f() { echo username=x-access-token; echo "password=\${${repo.tokenVariable}}"; }; f`,
            ),
          ];
    return [
      `  mkdir -p "$(dirname ${quote(repo.path)})"`,
      // The base's own helper asks the runner; `credential.helper=` clears it first.
      `  git -c credential.helper= ${helper.join(" ")} clone -- ${quote(repo.url)} ${quote(repo.path)}`,
      `  head_${index}="$(git -C ${quote(repo.path)} rev-parse HEAD)"`,
    ];
  });
  const verifyRepos = input.repos.map(
    (repo) =>
      `  git -C ${quote(repo.path)} rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null || fail "A clone has no commit at HEAD."`,
  );
  const repoArgs = input.repos.flatMap((repo, index) => [
    `--arg id${index} ${quote(repo.projectId)}`,
    `--arg path${index} ${quote(repo.path)}`,
    `--arg head${index} "$head_${index}"`,
  ]);
  const repoList = input.repos
    .map((_, index) => `{projectId: $id${index}, path: $path${index}, headSha: $head${index}}`)
    .join(", ");
  const excluded = JSON.stringify(["PWD", "SHLVL", "_", "OLDPWD", ...input.excludedEnvNames]);
  const providerCases = PROVIDER_CLIS.map(([kind, cli]) => `      ${kind}) ${cli} --version ;;`);

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "exec 2>&1",
    // A function, so Bash has read all of it before `clean` removes this file.
    "main() {",
    '  local build_dir="$HOME/.t3-build"',
    `  phase() { printf '${TEAM_IMAGE_PHASE_MARKER}%s\\n' "$1"; }`,
    `  fail() { printf '%s\\n' "$1"; exit 1; }`,
    "  capture_env() {",
    `    env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash PATH=${quote(CLEAN_PATH)} /bin/bash -lc 'env -0'`,
    "  }",
    "",
    "  phase preflight",
    '  [ "$(id -un)" = t3 ] || fail "The build must run as t3."',
    "  for tool in bash git sudo jq; do",
    '    command -v "$tool" >/dev/null || fail "The base image has no $tool."',
    "  done",
    "  local free_kb",
    "  free_kb=\"$(df -Pk / | awk 'NR == 2 { print $4 }')\"",
    '  [ "$free_kb" -ge 2097152 ] || fail "The build machine has less than 2 GiB free on /."',
    // The server writes these files through the runner, which runs as root.
    '  sudo chown -R t3:t3 "$build_dir"',
    "",
    "  phase clone",
    `  sudo install -d -o t3 -g t3 ${quote(paths.imageRoot)}`,
    ...clones,
    "",
    "  phase install",
    '  cd "$HOME"',
    '  capture_env >"$build_dir/env.before"',
    '  bash -euo pipefail "$build_dir/install.sh"',
    "",
    "  phase env",
    '  capture_env >"$build_dir/env.after"',
    "  local image_env",
    `  image_env="$(jq -n --rawfile before "$build_dir/env.before" --rawfile after "$build_dir/env.after" --argjson excluded ${quote(excluded)} '`,
    '    def parse: split("\\u0000") | map(select(length > 0) | index("=") as $i | {key: .[0:$i], value: .[$i + 1:]}) | from_entries;',
    "    ($before | parse) as $old",
    "    | $after | parse",
    "    | with_entries(select(.key as $name | $old[$name] != .value and ($excluded | any(. == $name) | not)))')\"",
    "",
    "  phase verify",
    "  local providers",
    `  providers="$(jq -r '.providers | keys[]' ${quote(paths.baseInfo)})"`,
    "  for provider in $providers; do",
    '    case "$provider" in',
    ...providerCases,
    "    esac",
    "  done",
    ...verifyRepos,
    "",
    "  phase clean",
    '  rm -rf "$build_dir" "$HOME/.bash_history"',
    "",
    "  phase manifest",
    `  sudo install -d -m 0755 "$(dirname ${quote(paths.output)})"`,
    `  jq -n --argjson imageEnv "$image_env" --slurpfile base ${quote(paths.baseInfo)} ${repoArgs.join(" ")} \\`,
    `    '{pairVersion: $base[0].pairVersion, providers: $base[0].providers, repos: [${repoList}], imageEnv: $imageEnv}' \\`,
    `    | sudo tee ${quote(paths.output)} >/dev/null`,
    `  sudo chmod 0644 ${quote(paths.output)}`,
    "}",
    'main "$@"',
    "",
  ].join("\n");
};
