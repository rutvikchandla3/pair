# Bots prototype

Static boards for [Bots](../bots.md). Open `index.html` in a browser; `#/` lists every board, `#/<id>/dark`
shows the dark theme.

The data is one moment for every board (Tuesday 10:55, one bot named Atlas): jobs J-12 to J-16 in
flight, 3 sessions working, 2 Asks. Numbers in the header, sidebar, Inbox and rows agree.

| Board       | Shows                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| `briefing`  | Needs you, the decisions line, In progress with worst-session labels, Done this week   |
| `decisions` | Decided for you expanded, one being corrected                                          |
| `job`       | Job detail: sessions, decisions, timeline                                              |
| `stop`      | Stop job confirmation                                                                  |
| `report`    | A finished job's report with Next → Start job                                          |
| `answered`  | Answering in your own words; a one-click answer with Remember this and Change answer   |
| `playbook`  | Instructions, Learned notes with sources and citation counts, Check with me before     |
| `settings`  | ⋯ menu, Settings (Brain / Worker / Reviewer), Delete                                   |
| `chat`      | The home thread: quiet wake rows, a note saved from chat                               |
| `inbox`     | Asks next to approvals, answerable in place                                            |
| `create`    | First run: inline card, then example jobs                                              |
| `states`    | Worst-session rows, saved note, escalation, stall, usage limit, take over, stop, pause |
| `mobile`    | Briefing, Ask with send, report, Chat                                                  |

Render PNGs with headless Chrome:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ./render.sh out briefing job states:1440:1240 mobile:1800:980
THEME=dark ./render.sh out briefing
```

`proto.css` and `app.js` are copied from the spaces prototype so the boards match the app's tokens.
