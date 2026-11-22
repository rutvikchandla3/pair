#!/bin/sh
# The compute driver contract's stand-in guest on Agent37 (T3_TEST_AGENT37=1 only; a session
# machine never gets it). The driver runs it in place of the bootstrap hand-off, with the
# generation as $1 and the bootstrap as $2: it keeps the marker on the disk and posts the hello.
set -eu

generation="$1"
# NAME='value' lines, single-quoted by the driver.
eval "$2"

marker=null
if [ -f /root/contract-marker ]; then
  marker="\"$(cat /root/contract-marker)\""
fi
printf 'g%s' "$generation" >/root/contract-marker
sync

curl -fsS --retry 30 --retry-all-errors --retry-delay 2 \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"sandboxId\":\"$PAIR_SANDBOX_ID\",\"generation\":$generation,\"enroll\":\"$PAIR_RUNNER_ENROLL\",\"marker\":$marker}" \
  "$PAIR_RUNNER_URL/hello"
