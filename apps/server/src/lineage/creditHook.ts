/**
 * The hooks Pair installs in a worktree that received an offer. They are POSIX `sh` with no node
 * dependency, because an agent's plain `git commit` runs them on the machine as well.
 *
 * Credit entries live at `<git dir>/pair/credit/<n>/{path,coauthor,lines}`: one file per field, so
 * `grep -Fx -f lines` matches recorded lines without the hook parsing JSON or escaping anything.
 */

/** Hooks git runs from `core.hooksPath`; each forwards to the project's own hook of that name. */
const FORWARDED_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
] as const;

/** Trimmed the same way the hook's awk trims staged lines, so both sides compare equal. */
export const trimCreditLine = (line: string) => line.replace(/^[ \t\r]+|[ \t\r]+$/g, "");

/** Lines made only of whitespace, punctuation or symbols (`}`, `);`, blank) never earn credit. */
export const isCreditableLine = (line: string) => !/^[\p{P}\p{S}\s]*$/u.test(line);

// The project's hooks folder: its non-worktree core.hooksPath (relative to where hooks run, as git
// resolves it), else $GIT_COMMON_DIR/hooks. Pair's own folder is skipped so a hook never runs itself.
const RUN_PROJECT_HOOK = `run_project_hook() {
  name=$1
  shift
  dir=$(git config --local --type=path --get core.hooksPath 2>/dev/null) ||
    dir=$(git config --global --type=path --get core.hooksPath 2>/dev/null) ||
    dir=$(git config --system --type=path --get core.hooksPath 2>/dev/null) ||
    dir=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
  case $dir in
    /*) ;;
    *) dir=$PWD/$dir ;;
  esac
  hook=$dir/$name
  [ -f "$hook" ] && [ -x "$hook" ] || exit 0
  self=$(cd "$(dirname "$0")" && pwd -P)
  [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$self" ] && exit 0
  exec "$hook" "$@"
}
`;

const forwardingShim = (name: string) =>
  `#!/bin/sh
# Installed by Pair. Runs the project's own ${name} hook, if it has one.
${RUN_PROJECT_HOOK}
run_project_hook ${name} "$@"
`;

const commitMsgHook = () =>
  `#!/bin/sh
# Installed by Pair. Credits a teammate whose applied lines this commit adds, then runs the
# project's own commit-msg hook, if it has one.
${RUN_PROJECT_HOOK}
staged_added_lines() {
  git diff --cached -U0 --no-color --no-ext-diff --no-renames -- ":(top,literal)$1" |
    awk 'body && /^\\+/ { line = substr($0, 2); gsub(/^[ \\t\\r]+|[ \\t\\r]+$/, "", line); print line; next } /^@@/ { body = 1 }'
}

credit_dir="$(git rev-parse --absolute-git-dir)/pair/credit"
if [ -d "$credit_dir" ]; then
  for entry in "$credit_dir"/*/; do
    [ -f "\${entry}path" ] && [ -f "\${entry}coauthor" ] && [ -f "\${entry}lines" ] || continue
    IFS= read -r path < "\${entry}path"
    IFS= read -r coauthor < "\${entry}coauthor"
    if staged_added_lines "$path" | grep -Fxq -f "\${entry}lines"; then
      git interpret-trailers --in-place --if-exists addIfDifferent \\
        --trailer "Co-authored-by: $coauthor" "$1"
    fi
  done
fi

run_project_hook commit-msg "$@"
`;

export const creditHookFiles = (): ReadonlyArray<{
  readonly name: string;
  readonly content: string;
}> => [
  { name: "commit-msg", content: commitMsgHook() },
  ...FORWARDED_HOOK_NAMES.map((name) => ({ name, content: forwardingShim(name) })),
];
