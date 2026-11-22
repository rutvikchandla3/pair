# Pair Builder sandbox image (`t3code`)

`t3code-builder-sandbox:dev` is the image Pair Builder runs, one container per task, for the
`t3code` workspace kind (`BUILDER_WORKSPACE_T3CODE_IMAGE` in pair-be). It holds the Pair server
built from this repository, run headless, plus Claude Code and a loopback model gateway. The Builder
host serves the web client, so the image has no web bundle. It implements the sandbox runtime
contract of the pluggable-workspaces spec (§1). The server's Pair Builder host mode implements
`/health`, the ingress identity, `POST /api/host/sessions` and the `sessions.snapshot` webhook.

## Build

From the repository root:

```sh
scripts/pair-builder-sandbox-build.sh            # = the command below
DOCKER_BUILDKIT=1 docker build -f packaging/pair-builder-sandbox/Dockerfile \
  -t t3code-builder-sandbox:dev .
```

The build stage installs from `pnpm-lock.yaml` with the repo's pinned pnpm, runs the release
server build (`node apps/server/scripts/cli.ts build`, which is `vp pack`), and `pnpm deploy --prod`s the
server's runtime dependencies into `/opt/t3code`. The base image is the root `engines.node`
version, pinned by digest. Claude Code is pinned by `CLAUDE_CODE_VERSION`: keep it at the CLI release
that matches `@anthropic-ai/claude-agent-sdk` (SDK `0.3.N` ships with CLI `2.1.N`).
`Dockerfile.dockerignore` keeps local `.env` files, `node_modules` and the client apps out of the
context. Boot needs no network unless there are repositories to clone.

Tests:

```sh
vp test run packaging/pair-builder-sandbox/model-gateway.test.ts   # gateway
packaging/pair-builder-sandbox/entrypoint.test.sh [image]          # entrypoint, against the image
```

## Runtime

`tini` runs `entrypoint.sh` as root, which:

1. checks `/var/lib/pair-builder/credentials.env` and starts the model gateway as `pair-gateway`;
2. writes `/var/lib/pair-builder/task.json` and the agent's task context
   (`/etc/claude-code/CLAUDE.md`, Claude Code's managed memory; no repository file changes);
3. bootstraps the workspace as `t3` (`setpriv`): no repos gives `git init` on `main` with a README
   commit. One repo is cloned into the workspace root. Further repos go in `<root>/<name>`, listed
   in the root repo's `.git/info/exclude`. It runs `checkout -B $PAIR_BUILDER_BRANCH` only when that
   branch does not exist, and sets the git identity globally and per repo;
4. runs `t3 serve --host 0.0.0.0 --port $PAIR_BUILDER_PORT --base-dir /var/lib/t3code <root>` as `t3`.
   If the server or the gateway exits, the container stops.

Restarts repeat every step without re-cloning, moving a branch or touching work. Root never follows
a path `t3` can change: everything root writes is in root-owned directories. Root's git also keeps
refusing the workspace ("dubious ownership"), because the agent controls its config and hooks: inspect
it with `docker exec --user t3 <container> git ...`.

| Path                      | Owner      | Holds                                           |
| ------------------------- | ---------- | ----------------------------------------------- |
| `/var/lib/pair-builder`   | root       | `credentials.env` (Builder upload), `task.json` |
| `/var/lib/t3code`         | `t3`, 0700 | T3 home: database, settings, secrets            |
| `/projects/challenge`     | `t3`       | the workspace (`PAIR_BUILDER_WORKSPACE_ROOT`)   |
| `/home/t3`                | `t3`       | git and Claude Code config                      |
| `/etc/t3code/policy.json` | root       | managed policy (below)                          |

Environment: the contract's `PAIR_BUILDER_*` variables. The entrypoint reads `PORT`,
`WORKSPACE_ROOT`, `REPOS`, `BRANCH`, `GIT_NAME`, `GIT_EMAIL` and `TASK`. The others pass through to
the server: `INGRESS_TOKEN`, `SANDBOX_ID`, `EVENTS_URL`/`EVENTS_TOKEN`, `WORKSPACE_KIND`. Model
credentials in the container env are dropped; only the file counts.

## Model credentials

Before every start the Builder uploads `credentials.env` (root, 0600) through the Docker archive API.
It holds one of `PLATFORM_NAMESPACE` + `AI_PLATFORM_V2_URL`, `PORTKEY_API_KEY` + `PORTKEY_URL`,
`ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com`), or
`AUTH_TOKEN_VALUE='no-ai-gateway-key'`.

The key never reaches `t3`, the user the server, Claude Code and anything the agent starts run as.
The entrypoint accepts only a regular, root-owned file nobody else can write. It opens the file on a
descriptor for the gateway alone, before any `t3` process exists. The gateway
(`model-gateway.ts`, user `pair-gateway`, `127.0.0.1:8071`) parses the file as data (it is never
sourced). It refuses a file that carries more than one kind and keeps the key in its own memory,
which another user cannot read. The key is not in any environment, argv, image layer, file `t3` can
read, or `docker inspect`.

Claude Code gets `ANTHROPIC_BASE_URL=http://127.0.0.1:8071` and a per-boot random
`ANTHROPIC_AUTH_TOKEN`. That token is not a secret from the agent; it only marks callers from inside
this container. T3 treats the custom endpoint as authenticated, so Claude shows as ready. The
gateway forwards only `POST /v1/messages` and `/v1/messages/count_tokens`, streaming both ways
without buffering. It strips the caller's credentials, passes `anthropic-version`/`anthropic-beta`
through, and adds the kind's credentials:

- platform: `${AI_PLATFORM_V2_URL}/v1/messages`, `Authorization: Bearer $PLATFORM_NAMESPACE`
- portkey: `${PORTKEY_URL}/v1/messages`, `x-portkey-provider: anthropic`, `x-portkey-api-key`
- anthropic: `${ANTHROPIC_BASE_URL}/v1/messages`, `x-api-key`

Without a usable key it answers a 401 `authentication_error` with `x-should-retry: false`, so the
turn fails at once with the reason instead of retrying for minutes. It logs one line per call (path,
status, time), never headers or bodies. When the key changes, the Builder uploads a new file and
restarts the container.

Anyone who can use the sandbox can still spend the key through the gateway. That is the point of
it; it cannot take the key away.

## Defaults

`/etc/t3code/policy.json` is a [managed policy](../../docs/user/managed-policy.md). It never writes
the user's settings. It makes new threads default to Claude Sonnet 5.5, with Haiku 5.5 for titles and
other text generation, and starts them in the task's checkout on the task branch rather than in a new
worktree (team mode's default), since the Builder gives every task its own sandbox and branch. Users
can still change all three. It allows only the Claude provider and turns
off T3 Connect, telemetry, in-app updates and provider update checks; the image pins all versions.

## Quick check

```sh
docker create --name sbx-check --network pair-builder-sbx --cap-drop NET_RAW \
  --security-opt no-new-privileges:true -e PAIR_BUILDER_INGRESS_TOKEN=test \
  -e PAIR_BUILDER_BRANCH=pair/check t3code-builder-sandbox:dev
printf "AUTH_TOKEN_VALUE='no-ai-gateway-key'\n" >credentials.env
tar --owner=0 --group=0 --mode=0600 -cf - credentials.env | docker cp - sbx-check:/var/lib/pair-builder
docker start sbx-check && docker logs -f sbx-check       # "Listening on http://0.0.0.0:8070"
docker exec --user t3 sbx-check git -C /projects/challenge log --oneline -1
docker rm -f sbx-check; rm credentials.env
```
