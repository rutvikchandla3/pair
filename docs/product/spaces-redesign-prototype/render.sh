#!/bin/bash
# usage: ./render.sh <outdir> <board[:width:height]>...   THEME=dark for dark mode
# Renders boards from index.html with headless Chrome. CHROME overrides the binary.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
CHROME=${CHROME:-google-chrome}
OUT=$1; shift; mkdir -p "$OUT"
for spec in "$@"; do
  IFS=: read -r id w h <<<"$spec"; w=${w:-1440}; h=${h:-900}
  suffix=""; hash="#/$id"; if [ "$THEME" = dark ]; then suffix="-dark"; hash="#/$id/dark"; fi
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor="${SCALE:-1}" --virtual-time-budget=1500 --window-size="$w,$h" \
    --screenshot="$OUT/$id$suffix.png" "file://$DIR/index.html$hash" >/dev/null 2>&1
  echo "$OUT/$id$suffix.png"
done
