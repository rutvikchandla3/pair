#!/bin/sh
# The compute driver contract's stand-in guest on boat (T3_TEST_BOAT=1 only; a session machine
# never gets it). The driver runs it in place of pair-boat-boot with the generation as $1: it reads
# the bootstrap the driver wrote, keeps the marker on the disk, and posts the hello.
set -eu

generation="$1"
# NAME='value' lines, single-quoted by the driver.
eval "$(cat /tmp/pair-boot/bootstrap.env)"
rm -f /tmp/pair-boot/bootstrap.env

marker=null
if [ -f "$HOME/contract-marker" ]; then
  marker="\"$(cat "$HOME/contract-marker")\""
fi
printf 'g%s' "$generation" >"$HOME/contract-marker"
sync

curl -fsS --retry 30 --retry-all-errors --retry-delay 2 \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"sandboxId\":\"$PAIR_SANDBOX_ID\",\"generation\":$generation,\"enroll\":\"$PAIR_RUNNER_ENROLL\",\"marker\":$marker}" \
  "$PAIR_RUNNER_URL/hello"
