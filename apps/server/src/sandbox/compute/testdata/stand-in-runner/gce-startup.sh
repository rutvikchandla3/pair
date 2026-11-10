#!/bin/sh
# The compute driver contract's stand-in guest on Compute Engine (T3_TEST_GCE=1 only; a session
# machine never gets a startup script). It runs at every boot: it reads this generation's
# bootstrap from instance metadata, keeps the marker on the boot disk, and posts the hello.
set -eu

metadata() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

# NAME='value' lines, single-quoted by the driver.
eval "$(metadata pair-bootstrap)"
generation="$(metadata pair-generation)"

dir="/t3-sandbox/$PAIR_SANDBOX_ID"
mkdir -p "$dir"
marker=null
if [ -f "$dir/contract-marker" ]; then
  marker="\"$(cat "$dir/contract-marker")\""
fi
printf 'g%s' "$generation" >"$dir/contract-marker"
sync

curl -fsS --retry 30 --retry-all-errors --retry-delay 2 \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"sandboxId\":\"$PAIR_SANDBOX_ID\",\"generation\":$generation,\"enroll\":\"$PAIR_RUNNER_ENROLL\",\"marker\":$marker}" \
  "$PAIR_RUNNER_URL/hello"
