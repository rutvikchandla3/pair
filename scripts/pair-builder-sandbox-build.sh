#!/usr/bin/env bash
# Builds the Pair Builder sandbox image for the `t3code` workspace kind
# (packaging/pair-builder-sandbox/Dockerfile, repository root as the build context).
#
# Usage: scripts/pair-builder-sandbox-build.sh [docker build flags...]
#        e.g. --build-arg CLAUDE_CODE_VERSION=2.1.316, --no-cache
# Env:   T3CODE_BUILDER_SANDBOX_IMAGE (default t3code-builder-sandbox:dev)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${T3CODE_BUILDER_SANDBOX_IMAGE:-t3code-builder-sandbox:dev}"

echo "==> building $image"
DOCKER_BUILDKIT=1 docker build \
  -f "$repo_root/packaging/pair-builder-sandbox/Dockerfile" \
  -t "$image" "$@" "$repo_root"
echo "==> done: $image"
