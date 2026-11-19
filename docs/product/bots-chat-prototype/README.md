# Bots, chat-first prototype

Static boards for [Bots v4](../bots.md). Open `index.html` in a browser; `#/` lists every board,
`#/<id>/dark` shows the dark theme.

Most boards show one moment: Tuesday 10:55, one bot (Atlas), two sessions in the pair repo.
Sidebar drag flicker is done; Rate limit threads API is working after the user answered its
question. `day` shows a whole busy day instead.

| Board      | Shows                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| `chat`     | The bot page: one T3 chat, fold-labelled updates, thread links, a question      |
| `day`      | A busy day: 5 jobs, ~20 updates merged into folds, an open question, a catch-up |
| `busy`     | Typing while the bot is mid-turn; T3 queues it ahead of Pair's updates          |
| `first`    | A new bot's empty chat                                                          |
| `memory`   | The Memory panel next to the chat                                               |
| `menu`     | ⋯: Pause, Models, Rename, Delete                                                |
| `sessions` | A session opened from the sidebar, nested under the bot                         |
| `states`   | Bot row states and the Inbox items                                              |
| `mobile`   | Bots tab with nested sessions; the bot's chat                                   |
| `faces`    | The face system: four shapes in five colours, at every size                     |
| `create`   | **+** opens New bot, prefilled; Enter creates                                   |
| `profile`  | ⋯ → Edit bot…: face, name, role, voice                                          |
| `voices`   | Crisp and Candid on the same moments; questions and fold labels stay plain      |
| `machine`  | Work outside a project gets a session, so the chat is free seconds later        |

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ./render.sh out chat:1440:1000 day:1440:1180 busy first memory menu sessions states:1440:760 mobile:1400:980 faces:1440:640 create profile voices:1440:760 machine
```

`proto.css` and `app.js` are copied from the spaces prototype so the boards match the app's tokens.
