#!/usr/bin/env bash
# The base image builder's startup-script, run as root on Canonical's stock Ubuntu 24.04: unpacks the
# provision tree from instance metadata, runs provision.sh and vm/install-vm.sh, reports `ok` or
# `failed:<step>` as the guest attribute pair/provision, and powers off so the server captures the
# disk. It needs no path to the Pair server and no credential.
#
# Compute Engine runs a startup script on every boot, so a builder that already reported reports
# the same result again and powers off, and a machine that is not a builder is left alone.
# PAIR_METADATA_DIR (CI only) reads the metadata keys as files from that directory instead.
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd /

STATE=/var/lib/pair-base-build
METADATA=http://169.254.169.254/computeMetadata/v1/instance
# Room for provision.sh's packages, Node, Codex, Claude Code and Chrome, with a margin.
MIN_FREE_KB=$((4 * 1024 * 1024))

say() {
  echo "pair-base-build: $*"
}

# read_metadata <key> <out>: exit 0, 22 when the key is absent, else another non-zero.
read_metadata() {
  if [ -n "${PAIR_METADATA_DIR:-}" ]; then
    if [ -f "$PAIR_METADATA_DIR/$1" ]; then cp "$PAIR_METADATA_DIR/$1" "$2"; else return 22; fi
    return 0
  fi
  local code=0
  curl -fsS --retry 10 --retry-connrefused --retry-delay 2 --connect-timeout 5 --max-time 120 \
    -H 'Metadata-Flavor: Google' -o "$2" "$METADATA/attributes/$1" || code=$?
  return "$code"
}

# report <result>: the guest attribute the server polls, and a line on the serial console as well.
report() {
  install -d -m 0755 "$STATE"
  printf '%s\n' "$1" >"$STATE/result"
  say "result $1"
  echo "pair-provision-result=$1" >/dev/console 2>/dev/null || true
  if [ -z "${PAIR_METADATA_DIR:-}" ]; then
    curl -fsS --retry 10 --retry-connrefused --retry-delay 2 --connect-timeout 5 --max-time 30 \
      -X PUT --data "$1" -H 'Metadata-Flavor: Google' "$METADATA/guest-attributes/pair/provision" ||
      say "could not write the guest attribute pair/provision (is enable-guest-attributes TRUE?)"
  fi
}

power_off() {
  sync
  systemctl --no-block poweroff || poweroff
}

work="$(mktemp -d /var/tmp/pair-base-build.XXXXXX)"

role_code=0
read_metadata pair-role "$work/role" || role_code=$?
if [ "$role_code" -eq 22 ] || { [ "$role_code" -eq 0 ] && [ "$(tr -d '[:space:]' <"$work/role")" != base ]; }; then
  say "not a base image builder; nothing to do"
  rm -rf "$work"
  exit 0
fi

if [ -f "$STATE/result" ]; then
  report "$(cat "$STATE/result")"
  rm -rf "$work"
  power_off
  exit 0
fi

step=metadata
finish() {
  local status=$?
  trap - EXIT
  # Whatever fails from here, the builder still reports and powers off.
  set +e
  if [ "$status" -eq 0 ] && [ "$step" = finished ]; then report ok; else report "failed:$step"; fi
  rm -rf "$work"
  rm -f /etc/apt/apt.conf.d/90pair-base-build
  power_off
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

if [ "$role_code" -ne 0 ]; then
  say "could not read pair-role from instance metadata"
  exit 1
fi
read_metadata pair-provision "$work/provision.b64"
version=dev
if read_metadata pair-version "$work/version"; then version="$(tr -d '[:space:]' <"$work/version")"; fi
case "$version" in
  '' | *[!0-9A-Za-z.+-]*)
    say "pair-version is not a version"
    exit 1
    ;;
esac
say "building the base image for Pair $version"

# First boot's cloud-init and Ubuntu's daily apt runs hold the apt and dpkg locks. A stop lets
# unattended-upgrade finish its current package (MinimalSteps, Ubuntu's default); anything else that
# holds a lock is waited for.
step=boot
if command -v cloud-init >/dev/null; then timeout 900 cloud-init status --wait >/dev/null || true; fi
for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service; do
  timeout 900 systemctl stop "$unit" 2>/dev/null || true
done
apt_busy() {
  local unit
  # Oneshot units read `activating` while they run.
  for unit in apt-daily.service apt-daily-upgrade.service; do
    case "$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || true)" in
      activating | deactivating) return 0 ;;
    esac
  done
  if pgrep -f /usr/bin/unattended-upgrade >/dev/null; then return 0; fi
  if command -v fuser >/dev/null &&
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; then
    return 0
  fi
  return 1
}
deadline=$((SECONDS + 20 * 60))
while apt_busy; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    say "apt was still busy after 20 minutes"
    exit 1
  fi
  sleep 5
done

step=disk
free_kb="$(df --output=avail -k / | tail -n 1 | tr -d '[:space:]')"
if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
  say "only ${free_kb} KB free on /; the builder's disk is too small"
  exit 1
fi

step=unpack
tree="$work/tree"
mkdir "$tree"
base64 -d <"$work/provision.b64" | tar -xzm --no-same-owner -C "$tree"
for required in provision.sh versions.env codex.env pair-bootstrap.sh vm/install-vm.sh; do
  if [ ! -f "$tree/$required" ]; then
    say "the provision tree has no $required"
    exit 1
  fi
done

step=provision
# Only for this build: a mirror hiccup is retried, and a late apt run is waited for.
cat >/etc/apt/apt.conf.d/90pair-base-build <<'APT'
Acquire::Retries "5";
DPkg::Lock::Timeout "1200";
APT
# needrestart would restart services mid-build, this script's runner among them.
PAIR_VERSION="$version" NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l bash "$tree/provision.sh"
rm -f /etc/apt/apt.conf.d/90pair-base-build

step=install
bash "$tree/vm/install-vm.sh"

step=finished
