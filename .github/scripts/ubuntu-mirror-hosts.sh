#!/usr/bin/env bash
# Prints `--add-host` flags for Ubuntu's apt mirrors when this machine's resolver cannot find them
# (Canonical's DNS has failed on Azure's resolver while public ones still answered).
set -euo pipefail

for host in archive.ubuntu.com security.ubuntu.com ports.ubuntu.com; do
  if getent ahostsv4 "$host" >/dev/null 2>&1; then continue; fi
  for resolver in 1.1.1.1 9.9.9.9 8.8.8.8; do
    address="$(dig +short +time=3 +tries=2 "@$resolver" "$host" A | grep -E '^[0-9.]+$' | head -n 1 || true)"
    if [ -n "$address" ]; then
      echo "--add-host=$host:$address"
      break
    fi
  done
done
