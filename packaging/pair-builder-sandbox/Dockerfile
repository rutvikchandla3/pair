# syntax=docker/dockerfile:1.20
# Pair Builder sandbox image for the `t3code` workspace kind (see README.md).
# Build context: the repository root.
#   docker build -f packaging/pair-builder-sandbox/Dockerfile -t t3code-builder-sandbox:dev .

# The root package.json `engines.node`, pinned by digest so rebuilds get the same base.
ARG NODE_IMAGE=node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0

# ── Server build: the same `dist/bin.mjs` bundle the release ships ──────────────────────────
FROM ${NODE_IMAGE} AS build

# node-pty and esbuild run install scripts; node-pty falls back to node-gyp without a prebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# The repo's pinned pnpm (`packageManager`); Node 26 no longer ships corepack.
COPY package.json ./
RUN pnpm_spec="$(node -p 'require("./package.json").packageManager')" \
 && npm install --global --allow-scripts="${pnpm_spec%@*}" "$pnpm_spec" \
 && npm cache clean --force
ENV CI=1 \
    PNPM_HOME=/pnpm

# Manifests first, so source edits do not reinstall dependencies. pnpm needs every workspace
# manifest to check the lockfile, even for a filtered install.
COPY --parents pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs patches **/package.json ./
RUN --mount=type=cache,id=t3code-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter=@t3tools/monorepo --filter='t3...' --filter='@t3tools/scripts...'

COPY . .
# `cli.ts build` is the release build (`vp pack`). Without apps/web/dist it skips the web client,
# which the Builder host serves itself.
RUN node apps/server/scripts/cli.ts build \
 && test -f apps/server/dist/bin.mjs \
 && test ! -e apps/server/dist/client

# The server's production dependencies, resolved from the lockfile (the bundle loads the
# native and runtime-external ones from here).
RUN --mount=type=cache,id=t3code-pnpm-store,target=/pnpm/store \
    pnpm --filter=t3 deploy --prod --store-dir /pnpm/store /opt/t3code \
 && rm -rf /opt/t3code/src /opt/t3code/scripts /opt/t3code/integration /opt/t3code/dist/*.map

# ── Runtime ─────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git openssh-client procps ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

# `t3` runs the server and the agent; `pair-gateway` only holds the model credentials.
RUN userdel --remove node \
 && groupadd --gid 1000 t3 \
 && useradd --uid 1000 --gid t3 --create-home --home-dir /home/t3 --shell /bin/bash t3 \
 && groupadd --system pair-gateway \
 && useradd --system --gid pair-gateway --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin pair-gateway

# Claude Code, the agent behind T3 Code's Claude provider. Matches the server's
# @anthropic-ai/claude-agent-sdk (0.3.N ships with Claude Code 2.1.N).
ARG CLAUDE_CODE_VERSION=2.1.316
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

COPY --from=build /opt/t3code /opt/t3code
RUN ln -s /opt/t3code/dist/bin.mjs /usr/local/bin/t3 \
 && chmod 0755 /opt/t3code/dist/bin.mjs \
 && t3 --version

# /var/lib/pair-builder belongs to root: the Builder uploads credentials.env there, and the
# entrypoint writes task.json. Only the T3 home and the workspace belong to `t3`. Directories
# come first: COPY --chmod would give the ones it creates the file's mode.
RUN install -d -o root -g root -m 0755 /opt/pair-builder /etc/t3code /etc/claude-code \
      /var/lib/pair-builder /projects \
 && install -d -o t3 -g t3 -m 0700 /var/lib/t3code \
 && install -d -o t3 -g t3 -m 0755 /projects/challenge
COPY --chmod=0755 packaging/pair-builder-sandbox/entrypoint.sh /opt/pair-builder/entrypoint.sh
COPY --chmod=0644 packaging/pair-builder-sandbox/model-gateway.ts /opt/pair-builder/model-gateway.ts
COPY --chmod=0644 packaging/pair-builder-sandbox/policy.json /etc/t3code/policy.json
RUN t3 policy check /etc/t3code/policy.json

ENV PAIR_BUILDER_PORT=8070 \
    PAIR_BUILDER_WORKSPACE_ROOT=/projects/challenge

LABEL org.opencontainers.image.title="T3 Code Pair Builder sandbox" \
      com.pair.builder.workspace-kind="t3code"

EXPOSE 8070

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/pair-builder/entrypoint.sh"]
