#!/usr/bin/env bash
# Run once as root on a VM after provision.sh (base-build.sh does): installs what the Dockerfile adds
# after provision.sh, as a systemd unit in place of the entrypoint, and leaves the disk ready to be
# captured as a machine image.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The files the runner's boot reads, as the Dockerfile copies pair-bootstrap.sh.
install -m 0755 "$here/../pair-bootstrap.sh" /usr/local/bin/pair-bootstrap
install -m 0755 "$here/pair-vm-boot.sh" /usr/local/bin/pair-vm-boot
install -m 0644 "$here/pair-runner.service" /etc/systemd/system/pair-runner.service
install -d -m 0700 /etc/pair-runner
rm -f /etc/pair-runner/bootstrap.env /etc/pair-runner/generation
systemctl daemon-reload
systemctl enable pair-runner.service

# Chrome's own sandbox needs unprivileged user namespaces, which Ubuntu 24.04 allows only to a
# profile that grants them: PreviewBrowserHost.APPARMOR_PROFILE with the machine's Chrome path.
# A container gets no profile and runs Chrome without its sandbox.
cat >/etc/apparmor.d/pair-chrome <<'APPARMOR'
# Written by Pair's machine image: lets the machine's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile pair-chrome /opt/pair-chrome/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/pair-chrome>
}
APPARMOR
apparmor_parser -r /etc/apparmor.d/pair-chrome
sudo -u t3 -H pair-chrome --dump-dom about:blank >/dev/null

# Docker for agents, from Ubuntu's archive. The VM is the sandbox, so the daemon is the machine's own.
# Bridges take the network's MTU: Docker's 1500 is over a VPC's default 1460 and stalls large packets.
mtu="$(cat "/sys/class/net/$(ip -o route show default | awk '{print $5; exit}')/mtu")"
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<DOCKER
{
  "mtu": $mtu,
  "default-network-opts": { "bridge": { "com.docker.network.driver.mtu": "$mtu" } }
}
DOCKER
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends docker.io docker-compose-v2 docker-buildx
rm -rf /var/lib/apt/lists/*
systemctl enable --now docker.service
# The runner starts agents with t3's groups (setpriv --init-groups), so they need no sudo.
usermod -aG docker t3
sudo -u t3 -H docker version >/dev/null
sudo -u t3 -H docker compose version >/dev/null
sudo -u t3 -H docker buildx version >/dev/null

# Agents run apt; Ubuntu's own upgrades would hold the dpkg lock under them.
for unit in apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl disable --now "$unit"; fi
done
for unit in apt-daily.service apt-daily-upgrade.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl mask "$unit"; fi
done
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Unattended-Upgrade "0";
APT

# Each machine made from the image gets its own host keys and machine id on first boot.
if command -v cloud-init >/dev/null; then
  cloud-init clean --logs --seed
fi
# systemd generates a machine id on a boot that finds this, and would reuse a D-Bus copy of the old.
printf 'uninitialized\n' >/etc/machine-id
if [ -f /var/lib/dbus/machine-id ] && [ ! -L /var/lib/dbus/machine-id ]; then
  rm -f /var/lib/dbus/machine-id
fi
