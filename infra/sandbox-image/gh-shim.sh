#!/bin/sh
# Installed as /usr/local/bin/gh, ahead of the real /usr/bin/gh: gh gets the token git would get
# for this repository's origin, minted per call and never written to disk.
GH_TOKEN="$(t3 runner git-credential token --host "${GH_HOST:-github.com}")" || exit 1
export GH_TOKEN
exec /usr/bin/gh "$@"
