#!/bin/sh
# pair-runner.service's ExecStartPre, as root on every boot of a Pair VM: copies this boot's bootstrap
# from the cloud's instance metadata to the file pair-bootstrap reads, as the Docker driver writes it
# into the container. Never prints the bootstrap: the journal and the serial console are not secret.
set -eu

DIR=/etc/pair-runner

product="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
case "$product" in
  "Google Compute Engine") ;;
  *)
    echo "pair-vm-boot: unsupported cloud (product name \"$product\")" >&2
    exit 1
    ;;
esac

# metadata <key> <out>: the instance attribute, or non-zero when it is absent or unreachable. The
# address, not metadata.google.internal, so a boot does not wait on DNS.
metadata() {
  curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --connect-timeout 5 --max-time 30 \
    -H 'Metadata-Flavor: Google' -o "$2" \
    "http://169.254.169.254/computeMetadata/v1/instance/attributes/$1"
}

install -d -m 0700 "$DIR"
umask 077
staging="$(mktemp -d "$DIR/.boot-XXXXXX")"
trap 'rm -rf "$staging"' EXIT

if ! metadata pair-generation "$staging/generation"; then
  echo "pair-vm-boot: no pair-generation in instance metadata" >&2
  exit 1
fi
generation="$(tr -d '[:space:]' <"$staging/generation")"
case "$generation" in
  '' | *[!0-9]*)
    echo "pair-vm-boot: pair-generation is not a number" >&2
    exit 1
    ;;
esac

# The same generation is a reboot of a machine whose runner already enrolled: its bootstrap was
# spent and deleted, and a second boot cannot enroll again (as a restarted container cannot).
if [ "$generation" = "$(cat "$DIR/generation" 2>/dev/null || true)" ]; then
  exit 0
fi

if ! metadata pair-bootstrap "$staging/bootstrap.env"; then
  echo "pair-vm-boot: no pair-bootstrap in instance metadata" >&2
  exit 1
fi
if [ ! -s "$staging/bootstrap.env" ]; then
  echo "pair-vm-boot: pair-bootstrap is empty" >&2
  exit 1
fi
chmod 0600 "$staging/bootstrap.env"
mv -f "$staging/bootstrap.env" "$DIR/bootstrap.env"
printf '%s\n' "$generation" >"$staging/generation"
chmod 0644 "$staging/generation"
mv -f "$staging/generation" "$DIR/generation"
echo "pair-vm-boot: wrote the bootstrap for generation $generation"
