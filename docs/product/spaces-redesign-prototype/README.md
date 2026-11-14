# Spaces redesign prototype

The screens for [Spaces redesign](../spaces-redesign.md): a calm sidebar, and building together with
Branch off. The git model behind Branch off is in [spaces-redesign-git.md](../spaces-redesign-git.md). It is a design reference, not code to ship. Where a board and the spec disagree, the spec
wins.

- **Open it:** `index.html` lists every board. Append `/dark` to a board's hash for dark mode, as in
  `index.html#/lane/dark`.
- **Screenshots:** `./render.sh out compare:1440:2080 inbox lane` renders boards with headless Chrome.
  Most boards are 1440×900. The tall ones are `compare` (2080), `states` (2300), `empty` (700) and
  `mobile` (1800×1900).
- **Source:** `proto.css` holds the tokens, which mirror `apps/web/src/index.css`. `app.js` holds the
  cast, icons, both sidebars and the thread chrome, and `screens.js` holds the boards.

## Cast

Rutvik is the viewer on the sidebar boards: 10 open tasks, 7 spaces, 12 threads of his own and 14
threads shared with him by name. On the collaboration boards, Kousik owns **Prompt builder** on his
cloud machine. Hanad branches off it as **Rationale per question**, then offers his commits back, and
Kousik applies them. Rutvik and Ankur can open Kousik's machine too.
