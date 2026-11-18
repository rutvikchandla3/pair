#!/bin/bash
# Checks entrypoint.sh against the sandbox image, with this directory's entrypoint and gateway
# mounted over the baked ones (no rebuild needed). Needs Docker; runs with no network.
#   - workspace bootstrap: clone, nested repo, task branch, identity, task context; restarts keep
#     the checkout, the branch and the work;
#   - model credentials: only a regular root-owned file nobody else can write reaches the gateway,
#     the gateway picks the one kind it carries, and no key reaches `t3`.
# Usage: packaging/pair-builder-sandbox/entrypoint.test.sh [image]   (default t3code-builder-sandbox:dev)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image="${1:-t3code-builder-sandbox:dev}"
name="t3code-entrypoint-test-$$"
fixtures="$(mktemp -d)"
fail=0
secret="sk-test-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  docker rm -f "$name" "$name-empty" >/dev/null 2>&1 || true
  rm -rf "$fixtures"
}
trap cleanup EXIT INT TERM

check() {
  if [ "$2" = "$3" ]; then
    echo "ok    $1"
  else
    echo "FAIL  $1: got '$2', want '$3'"
    fail=1
  fi
}

in_t3() { docker exec --user t3 "$1" sh -c "$2"; }

# Two bare repositories the container clones over file://.
make_fixture() {
  mkdir -p "$fixtures/fixtures"
  git init --quiet --bare --initial-branch=main "$fixtures/fixtures/$1.git"
  git clone --quiet "$fixtures/fixtures/$1.git" "$fixtures/work-$1" 2>/dev/null
  printf '%s\n' "$1" >"$fixtures/work-$1/README.md"
  git -C "$fixtures/work-$1" add README.md
  git -C "$fixtures/work-$1" -c user.name=t -c user.email=t@t -c commit.gpgsign=false \
    commit --quiet -m init
  git -C "$fixtures/work-$1" push --quiet origin main
  rm -rf "$fixtures/work-$1"
}
make_fixture app
make_fixture lib

# The final process (the server's place) records its environment and waits.
create() {
  docker create --name "$1" --network none --cap-drop NET_RAW \
    --security-opt no-new-privileges:true --pids-limit 1024 \
    -v "$here/entrypoint.sh:/opt/pair-builder/entrypoint.sh:ro" \
    -v "$here/model-gateway.ts:/opt/pair-builder/model-gateway.ts:ro" \
    -e PAIR_BUILDER_REPOS="$2" -e PAIR_BUILDER_BRANCH=pair/br-7-test \
    -e PAIR_BUILDER_GIT_NAME=Ada -e PAIR_BUILDER_GIT_EMAIL=ada@example.com \
    -e 'PAIR_BUILDER_TASK={"key":"BR-7","title":"Fix payouts","description":"Round down.","space":"Pay"}' \
    -e ANTHROPIC_API_KEY=create-time-value -e PORTKEY_API_KEY=create-time-value \
    "$image" sh -c 'env >/tmp/final.env; exec sleep 600' >/dev/null
  # Owned by t3, so git trusts them as clone sources.
  tar -C "$fixtures" --owner=1000 --group=1000 -cf - fixtures | docker cp - "$1:/"
}

wait_booted() {
  for _ in $(seq 1 60); do
    if docker exec "$1" test -s /tmp/final.env 2>/dev/null; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$1")" != true ]; then break; fi
    sleep 1
  done
  docker logs "$1" >&2 || true
  echo "entrypoint.test.sh: $1 did not boot" >&2
  exit 1
}

start() {
  docker start "$1" >/dev/null
  wait_booted "$1"
}

restart() {
  docker exec "$name" rm -f /tmp/final.env
  log_mark="$(docker logs "$name" 2>&1 | wc -l)"
  docker restart -t 5 "$name" >/dev/null
  wait_booted "$name"
}

# Logs since the last restart.
boot_logs() { docker logs "$name" 2>&1 | tail -n "+$((${log_mark:-0} + 1))"; }

final_env() { docker exec "$name" sh -c "grep -E '^$1=' /tmp/final.env | cut -d= -f2-" || true; }

# upload <owner uid> <mode> <contents>: copies a credentials file in like the Builder API does.
upload() {
  local dir
  dir="$(mktemp -d)"
  printf '%s' "$3" >"$dir/credentials.env"
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ]; then
    docker exec "$name" rm -f /var/lib/pair-builder/credentials.env
  fi
  tar -C "$dir" --owner="$1" --group="$1" --mode="$2" -cf - credentials.env |
    docker cp - "$name:/var/lib/pair-builder"
  rm -rf "$dir"
}

gateway_line() { boot_logs | grep -E '^model-gateway: (no usable|forwarding)' | tail -1; }

repos='[{"full_name":"acme/app","clone_url":"file:///fixtures/app.git"},{"full_name":"acme/lib","clone_url":"file:///fixtures/lib.git"}]'
create "$name" "$repos"
upload 0 0600 "# no key
AUTH_TOKEN_VALUE='no-ai-gateway-key'
"
start "$name"

# 1. Bootstrap.
root=/projects/challenge
check "the first repo is the workspace root" "$(in_t3 "$name" "git -C $root remote get-url origin")" \
  file:///fixtures/app.git
check "the root repo is on the task branch" "$(in_t3 "$name" "git -C $root branch --show-current")" \
  pair/br-7-test
check "the second repo is nested on the task branch" \
  "$(in_t3 "$name" "git -C $root/lib branch --show-current")" pair/br-7-test
check "the nested repo is excluded from the root repo" \
  "$(in_t3 "$name" "grep -cxF /lib/ $root/.git/info/exclude")" 1
check "the repos carry the git identity" \
  "$(in_t3 "$name" "git -C $root/lib config user.email") $(in_t3 "$name" 'git config --global user.name')" \
  "ada@example.com Ada"
check "the workspace belongs to t3" "$(docker exec "$name" stat -c %U $root $root/lib/README.md | sort -u)" t3
# The agent controls the repo's config and hooks, so root's git must keep refusing it.
check "root's git refuses the agent's repo" \
  "$(docker exec "$name" git -C $root rev-parse --abbrev-ref HEAD >/dev/null 2>&1 && echo trusted || echo refused)" \
  refused
check "t3 works in the workspace on the task branch" "$(in_t3 "$name" "git -C $root rev-parse --abbrev-ref HEAD")" \
  pair/br-7-test
check "the task file is written" \
  "$(docker exec "$name" node -p 'require("/var/lib/pair-builder/task.json").key')" BR-7
check "the agent sees the task" \
  "$(docker exec "$name" grep -c 'BR-7 — Fix payouts\|Round down.' /etc/claude-code/CLAUDE.md)" 2
check "the agent cannot change its task context" \
  "$(in_t3 "$name" 'echo x >>/etc/claude-code/CLAUDE.md' 2>/dev/null && echo writable || echo denied)" denied

# 2. The no-key marker: the gateway answers 401; the workload env has no credentials at all.
check "the no-key marker is understood" "$(gateway_line)" \
  "model-gateway: no usable model credentials (no-key); model calls answer 401"
check "create-time credentials never reach t3" \
  "$(final_env ANTHROPIC_API_KEY)$(final_env PORTKEY_API_KEY)$(final_env AUTH_TOKEN_VALUE)" ""
check "Claude Code talks to the loopback gateway" "$(final_env ANTHROPIC_BASE_URL)" \
  http://127.0.0.1:8071
check "with a per-boot loopback token" "$(final_env ANTHROPIC_AUTH_TOKEN | tr -d '0-9a-f' | wc -c)" 1
first_token="$(final_env ANTHROPIC_AUTH_TOKEN)"

# 3. Restarts keep the checkout, the branch and the work.
in_t3 "$name" "cd $root && echo work >work.txt && git add work.txt && git commit --quiet -m work \
  && git switch --quiet -c feature && echo draft >draft.txt"
work_sha="$(in_t3 "$name" "git -C $root rev-parse pair/br-7-test")"
restart
check "a restart keeps the branch the user is on" "$(in_t3 "$name" "git -C $root branch --show-current")" \
  feature
check "a restart does not move the task branch" \
  "$(in_t3 "$name" "git -C $root rev-parse pair/br-7-test")" "$work_sha"
check "a restart keeps uncommitted work" "$(in_t3 "$name" "cat $root/draft.txt")" draft
check "a restart does not clone again" "$(boot_logs | grep -c 'cloning' || true)" 0
check "the loopback token changes per boot" \
  "$([ "$(final_env ANTHROPIC_AUTH_TOKEN)" != "$first_token" ] && echo new || echo same)" new

# 4. A key: only the gateway gets it, and nothing t3 can read holds it.
upload 0 0600 "ANTHROPIC_API_KEY='$secret'
ANTHROPIC_BASE_URL='https://api.anthropic.test/'
"
restart
check "a root-owned file configures the gateway" "$(gateway_line)" \
  "model-gateway: forwarding to the anthropic gateway at https://api.anthropic.test"
check "t3 cannot read the credentials file" \
  "$(in_t3 "$name" 'cat /var/lib/pair-builder/credentials.env' >/dev/null 2>&1 && echo readable || echo denied)" \
  denied
gateway_pid="$(docker exec "$name" pgrep -u pair-gateway -o node)"
check "t3 cannot read the gateway's memory or environment" \
  "$(in_t3 "$name" "cat /proc/$gateway_pid/environ /proc/$gateway_pid/mem" >/dev/null 2>&1 && echo readable || echo denied)" \
  denied
# The needle sits outside the scanned paths, so the scan's own argv does not hold the key.
printf '%s\n' "$secret" | docker exec -i "$name" sh -c 'cat >/run/needle && chmod 0644 /run/needle'
check "no process environment, argv or file t3 can read holds the key" \
  "$(in_t3 "$name" 'grep -rlsF -f /run/needle /proc/[0-9]*/environ /proc/[0-9]*/cmdline /home/t3 /var/lib/t3code /projects /tmp /etc /opt 2>/dev/null | grep -v "^/proc/self/" | while read -r f; do echo "$f $(tr "\0" " " <"/proc/$(echo "$f" | cut -d/ -f3)/cmdline" 2>/dev/null)"; done')" ""
docker exec "$name" rm -f /run/needle
check "the key is not in the container config" \
  "$(docker inspect "$name" | grep -c "\"ANTHROPIC_API_KEY=$secret\"" || true)" 0

# 5. Files root does not trust are ignored; the gateway then refuses model calls.
upload 1000 0600 "ANTHROPIC_API_KEY='$secret'
"
restart
check "a t3-owned file is ignored" \
  "$(boot_logs | grep -c 'ignoring /var/lib/pair-builder/credentials.env: not a regular file owned by root')" 1
check "and the gateway has no credentials" "$(gateway_line)" \
  "model-gateway: no usable model credentials (unavailable); model calls answer 401"

upload 0 0620 "ANTHROPIC_API_KEY='$secret'
"
restart
check "a group-writable file is ignored" \
  "$(boot_logs | grep -c 'ignoring /var/lib/pair-builder/credentials.env: writable by group or others')" 1

docker exec "$name" sh -c "printf \"ANTHROPIC_API_KEY='%s'\n\" '$secret' >/root/elsewhere.env \
  && chmod 0600 /root/elsewhere.env && rm -f /var/lib/pair-builder/credentials.env \
  && ln -s /root/elsewhere.env /var/lib/pair-builder/credentials.env"
restart
check "a symlink is ignored" \
  "$(boot_logs | grep -c 'ignoring /var/lib/pair-builder/credentials.env: not a regular file owned by root')" 1

upload 0 0600 "PORTKEY_API_KEY='pk'
PORTKEY_URL='https://portkey.test'
ANTHROPIC_API_KEY='$secret'
"
restart
check "an ambiguous file is refused" \
  "$(boot_logs | grep -c 'refusing an ambiguous credentials file (it carries portkey and anthropic)')" 1

# 6. No repositories: an empty repository with the task as its README.
create "$name-empty" '[]'
docker start "$name-empty" >/dev/null
wait_booted "$name-empty"
check "without repos the workspace is a new repository" \
  "$(in_t3 "$name-empty" "git -C $root log --format=%s -1; cat $root/README.md; git -C $root branch --show-current")" \
  "Initial commit
# BR-7 Fix payouts
pair/br-7-test"

if [ "$fail" -ne 0 ]; then
  docker logs "$name" >&2 || true
  exit 1
fi
echo "entrypoint.test.sh: all checks passed"
