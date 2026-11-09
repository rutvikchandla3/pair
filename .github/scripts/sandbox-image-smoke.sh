#!/usr/bin/env bash
# Boots a built sandbox image and checks the tools and the provider pins recorded in it.
set -euo pipefail

image="${1:?usage: sandbox-image-smoke.sh <image>}"

run() { docker run --rm --user t3 --entrypoint "$@"; }

# The gh on PATH is the credential shim, which needs the runner's t3, so check the real one under it.
run bash "$image" -lc 'claude --version && codex --version && node --version && /usr/bin/gh --version && [ "$(command -v gh)" = /usr/local/bin/gh ] && sudo -n true'
pinned() { run jq "$image" -r ".providers.$1" /etc/pair-image.json; }
run claude "$image" --version | grep -qF "$(pinned claudeAgent)"
run codex "$image" --version | grep -qF "$(pinned codex)"
