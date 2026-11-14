#!/bin/sh
# Run by the boat driver as root (through sudo) once a sandbox is ready: moves this boot's bootstrap,
# which the driver wrote to /tmp through boat's files API, to the file pair-bootstrap reads, and
# starts the runner. boat resumes a stopped machine without a reboot, so nothing else starts it.
# Never prints the bootstrap: command output can reach the server's log.
set -eu

exec 9>/run/pair-boat-boot.lock
flock 9

DIR=/etc/pair-runner
SRC=/tmp/pair-boot/bootstrap.env

case "${1:-}" in
  '' | *[!0-9]*)
    echo "pair-boat-boot: generation is not a number" >&2
    exit 1
    ;;
esac

# Skip only a runner of this generation that already enrolled. One still enrolling is restarted
# with the newest secret; the one it holds stays valid too, so either enrolls.
if [ "$1" = "$(cat "$DIR/generation" 2>/dev/null || true)" ] &&
  systemctl is-active --quiet pair-runner.service && [ -s /run/pair-runner/token ]; then
  rm -f "$SRC"
  exit 0
fi

if [ ! -s "$SRC" ]; then
  echo "pair-boat-boot: no bootstrap" >&2
  exit 1
fi
install -d -m 0700 "$DIR"
install -m 0600 -o root -g root "$SRC" "$DIR/bootstrap.env"
rm -f "$SRC"
printf '%s\n' "$1" >"$DIR/generation"
# Also replaces a runner of an older generation, such as one left by a forced stop.
systemctl restart --no-block pair-runner.service
