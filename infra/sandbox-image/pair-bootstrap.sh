#!/bin/sh
# Image entrypoint (docs/product/cloud/03-runner.md 2.1): make sure the runner bundle for
# PAIR_RUNNER_BUILD is present, then run `t3 runner`. Mirrors cloud/pinnedRuntime.ts: staging
# directory install, SHA-256 check, .install-complete sentinel, stall timeout.
set -eu

ENV_FILE=/etc/pair-runner/bootstrap.env
BUNDLES=/opt/pair-runner
RUN_DIR=/run/pair-runner

# Docker writes the four values to a file so `docker inspect` never shows the secret.
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
  rm -f "$ENV_FILE"
fi
: "${PAIR_RUNNER_URL:?}" "${PAIR_SANDBOX_ID:?}" "${PAIR_RUNNER_BUILD:?}" "${PAIR_RUNNER_ENROLL:?}"
export PAIR_RUNNER_URL PAIR_SANDBOX_ID PAIR_RUNNER_BUILD PAIR_RUNNER_ENROLL

# A fresh volume is root-owned.
install -d -o t3 -g t3 "/t3-sandbox/$PAIR_SANDBOX_ID"

# fetch <path> <out>: GET from the server with the enrollment secret, which goes through curl's
# stdin config and never argv. PAIR_RUNNER_URL is http(s)://host or unix:/path/to/socket.
fetch() {
  case "$PAIR_RUNNER_URL" in
    unix:*) base=http://runner sock="${PAIR_RUNNER_URL#unix:}" ;;
    *) base="${PAIR_RUNNER_URL%/}" sock= ;;
  esac
  printf 'header = "Authorization: Bearer %s"\n' "$PAIR_RUNNER_ENROLL" |
    curl -fsS --config - --speed-limit 1 --speed-time 60 ${sock:+--unix-socket "$sock"} \
      -o "$2" "$base$1"
}

# ensure_bundle <build id>: leaves $BUNDLES/<id> usable or exits.
ensure_bundle() {
  dir="$BUNDLES/$1"
  if [ -f "$dir/MANIFEST.json" ] || [ -f "$dir/.install-complete" ]; then
    return 0
  fi
  staging="$(mktemp -d "$BUNDLES/.install-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  fetch "/runner/v1/bundle/$1.tar.gz" "$staging/bundle.tar.gz"
  fetch "/runner/v1/bundle/$1.sha256" "$staging/bundle.sha256"
  expected="$(cut -d ' ' -f 1 "$staging/bundle.sha256")"
  echo "$expected  $staging/bundle.tar.gz" | sha256sum -c --quiet -
  mkdir "$staging/tree"
  tar -xzf "$staging/bundle.tar.gz" -C "$staging/tree"
  : >"$staging/tree/.install-complete"
  rm -rf "$dir"
  mv "$staging/tree" "$dir"
  rm -rf "$staging"
  trap - EXIT
}

ensure_bundle "$PAIR_RUNNER_BUILD"
build="$PAIR_RUNNER_BUILD"
tries=0
while :; do
  code=0
  "$BUNDLES/$build/t3" runner || code=$?
  # 75: the server runs another build (03 2.2). Fetch the one it named, once.
  if [ "$code" -ne 75 ] || [ "$tries" -ge 1 ] || [ ! -s "$RUN_DIR/server-build" ]; then
    exit "$code"
  fi
  tries=$((tries + 1))
  build="$(cat "$RUN_DIR/server-build")"
  ensure_bundle "$build"
  PAIR_RUNNER_BUILD="$build"
  export PAIR_RUNNER_BUILD
done
