#!/bin/zsh
# usage: render.sh <Screen.dc.html> <out.png> [width=1440] [height=900] [state-json] [light|dark]
# Renders one prototype screen at 2x with headless Chrome. Widths under 500 also need ImageMagick.
D=${0:A:h}/screens
W=${3:-1440}; H=${4:-900}; STATE=${5:-}; SCHEME=${6:-light}
OUT=${2:A}
SRC="file://$D/$1"
[[ -n $STATE ]] && SRC="$SRC#state=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$STATE")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
FLAGS=(--headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 --virtual-time-budget=1500)
if [[ $SCHEME == dark ]]; then FLAGS+=(--force-dark-mode --blink-settings=preferredColorScheme=0); else FLAGS+=(--blink-settings=preferredColorScheme=1); fi
if (( W >= 500 )); then
  "$CHROME" $FLAGS --window-size=$W,$H --screenshot="$OUT" "$SRC" >/dev/null 2>&1
else
  # Headless Chrome lays out at least 500px wide, so narrow widths render in an iframe and get cropped.
  T=$(mktemp -d)
  print -r -- "<html><body style=\"margin:0\"><iframe src=\"$SRC\" width=\"$W\" height=\"$H\" style=\"border:0;display:block\"></iframe></body></html>" > $T/wrap.html
  "$CHROME" $FLAGS --window-size=600,$((H+300)) --screenshot="$T/shot.png" "file://$T/wrap.html" >/dev/null 2>&1
  magick "$T/shot.png" -crop $((W*2))x$((H*2))+0+0 +repage "$OUT"
  rm -rf $T
fi
echo "$OUT"
