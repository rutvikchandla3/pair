#!/usr/bin/env bash
# Boots a built sandbox image and checks the tools and the provider pins recorded in it.
set -euo pipefail

image="${1:?usage: sandbox-image-smoke.sh <image>}"

run() { docker run --rm --user t3 --entrypoint "$@"; }

run bash "$image" -lc 'claude --version && codex --version && node --version && gh --version && sudo -n true'
pinned() { run jq "$image" -r ".providers.$1" /etc/pair-image.json; }
run claude "$image" --version | grep -qF "$(pinned claudeAgent)"
run codex "$image" --version | grep -qF "$(pinned codex)"
