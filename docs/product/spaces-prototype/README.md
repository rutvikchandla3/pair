# Spaces prototype

This is the clickable prototype for [Spaces](../spaces.md) and [@pair](../spaces-agent.md), at v2:
repositories and workspaces, tasks with N threads, stored status, and the Team Claude key. It is a
design reference, not code to ship. Build the real UI from `apps/web` components and tokens, and
match what these screens show. Where a screen and [spaces.md](../spaces.md) disagree, spaces.md wins.

- **Canvas:** `screens/canvas.json` lays out every board side by side, in the order below. The
  published canvas is https://claude.ai/artifact/T4KuyZQeZVfH5Ax9PsZLgY; republish it after changing
  a screen.
- **Locally:** open any `screens/*.dc.html` in a browser. `support.js` is a small shim that renders
  the `{{bindings}}`, `<sc-if>` blocks and the `DCLogic` state class.
- **One state at a time:** append `#state=<json>` to the URL. The comment at the top of each
  screen's script lists its state keys, and the table below names the main ones.
- **Screenshots:** `./render.sh TaskDetail.dc.html out.png 1440 900 '{"task":"gen"}' dark` renders
  at 2x with headless Chrome. Widths under 500 also need ImageMagick. On Linux, point `CHROME` at a
  Chrome binary.
- **Styles:** each screen inlines `shared.css` between `/*shared-start*/` and `/*shared-end*/`.
  Those tokens mirror `apps/web/src/index.css`; `--input-foreground` (indigo, "needs an answer")
  and `--destructive` (red fills) are new.

## Cast

The viewer is Rutvik, the space owner and a server admin, unless a state says otherwise. The space
is "Question creation", with the repositories pair-fe and pair-be, so its workspace is also
"Question creation". The members are Kousik, Hanad and Ankur. Kousalya is on Pair Cloud but not a
member. A second space, "Onboarding revamp", has an unread dot.

| Task                          | Owner  | Status      | Threads                                                               |
| ----------------------------- | ------ | ----------- | --------------------------------------------------------------------- |
| Seed role catalog             | Rutvik | In progress | 1, in the workspace, needs Rutvik's approval to run `pnpm db:migrate` |
| Sample role fixtures          | Kousik | In progress | 1, in pair-be, failed on fixtures.test.ts                             |
| Preview renderer              | Ankur  | In progress | 2: Ankur's in pair-fe needs an answer; Hanad's in pair-be is idle     |
| Generate question from prompt | Kousik | In progress | 2: Prompt builder (workspace) working; Eval fixtures (pair-be) idle   |
| Difficulty tagging            | Hanad  | To do       | None, assigned by Rutvik                                              |
| Question schema v2            | Rutvik | In review   | 1, pair-be#482 open                                                   |
| Prompt library loader         | Hanad  | Done        | 1, pair-be#471 merged                                                 |
| Legacy CSV import             | Ankur  | Canceled    | 1, idle                                                               |

"Generate question from prompt" is the key example: Eval fixtures finished its turn, and the task is
still In progress.

## Boards

| #   | Board                            | File                        | What it settles                                                                                     | Main state keys                                                                                            |
| --- | -------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Space room                       | `Main.dc.html`              | Sidebar, chat, the workspace label, the Overview panel and its groups, the status menu, no-key hint | `tab`, `menu: "status"`, `done`, `canceled`, `nokey: "admin" \| "member"`, `addkey`, `asked`, `mention`    |
| 2   | Task page                        | `TaskDetail.dc.html`        | Breadcrumb, properties line, description, Threads, Activity, assigned and handed-back states        | `task: "gen" \| "seed" \| … \| "csv"`, `viewer: "hanad"`, `cant`, `merged`, `menu`, `rowmenu`, `full`      |
| 2b  | Thread in a task                 | `Task.dc.html`              | The thread view's breadcrumb and status chip, the agent's status record and Undo, run states        | `view`, `run: "working" \| "needs" \| "limited" \| "stopped" \| "ended"`, `moved: true \| "undone"`, `tab` |
| 2c  | Add a thread to a task           | `AttachThread.dc.html`      | Add to task: space, task or new task, the sharing confirm, attached, removed                        | `pick: "space" \| "task" \| "confirm"`, `task`, `attached`, `removed`, `viewer: "kousik"`                  |
| 5   | New space, first @pair ask       | `SpaceEmpty.dc.html`        | An empty room, @pair splitting the Brief into tasks, records with Undo, and @pair off               | `phase`, `viewer`, `nokey`, `addkey`, `asked`, `undone`                                                    |
| 5b  | @pair proposes tasks             | `SpaceProposal.dc.html`     | The proposal card (approve, untick, change owner), the read-only view for others, and dismissed     | `phase: "proposal" \| "created" \| "dismissed"`, `viewer`, `pick`                                          |
| 6   | Not a member                     | `NotMember.dc.html`         | Request to join, cancelling it, after Leave, and a shared thread link                               | `sent`, `thread`, `left`, `keep`                                                                           |
| 4   | New space                        | `NewSpace.dc.html`          | Name, Repositories and the workspace line, the Brief, members, the @pair field, create states       | `repos`, `wsEdit`, `wsName`, `nokey`, `adding`, `err`, `creating`, `created`                               |
| 4b  | New space, picking people        | `NewSpacePicker.dc.html`    | The member picker, including no match                                                               | `q`, `open`, `add`                                                                                         |
| 7   | New task                         | `NewTask.dc.html`           | Title, description, starting status, owner, and starting a thread now for your own task             | `status`, `owner`, `start`, `runsin`, `model`, `base`, `err: "account"`                                    |
| 7b  | New task, picking an owner       | `NewTaskAssign.dc.html`     | Assigning to a teammate creates no thread; Away and account readiness per row                       | `owner: "k" \| "h" \| "a"`, `pop`                                                                          |
| 7c  | Start a thread on a task         | `StartThread.dc.html`       | Runs in, model, base per repository, account, the prefilled prompt, starting and Cancel start       | `runsin`, `model`, `base`, `account: "none"`, `prompt`, `starting`                                         |
| 8   | Space settings                   | `SpaceSettings.dc.html`     | Name, repositories, the @pair section, transfer, leave with reassign, archive; owner and member     | `viewer`, `key: "set" \| "none"`, `edit: "repos"`, `repos`, `confirm`, `saved`                             |
| 8b  | Members                          | `SpaceMembers.dc.html`      | The members popover: add, join requests, make owner, remove and leave                               | `open`, `menu`, `req`, `confirm`, `toast`                                                                  |
| 8c  | Remove a member                  | `SpaceMemberRemove.dc.html` | The remove confirm with "Reassign them to", "(removed)" rows and Undo                               | `confirm: "remove" \| "leave"`, `reassign`, `keep`, `removed`                                              |
| 8d  | Archived space                   | `SpaceArchived.dc.html`     | A read-only room, the Archived sidebar section, and Unarchive in three places                       | `toast`, `owner`, `menu: "room" \| "side"`                                                                 |
| 8e  | Settings → Team, Team Claude key | `TeamClaudeKey.dc.html`     | The key card, the Add/Replace/Remove dialogs, the member view, Ask Rutvik and settings search       | `key: "set"`, `viewer: "member"`, `dialog`, `checking`, `error`, `toast`, `search`                         |
| 9   | Mobile room                      | `MobileRoom.dc.html`        | 390×844: the feed, the tasks and members sheets with detents, a confirm card, no key                | `sheet`, `detent`, `tab`, `nokey`, `asked`, `leave`, `reassign`                                            |
| 9b  | Mobile task page                 | `MobileTask.dc.html`        | The task page on a phone, and the Start a thread / Add existing thread sheet                        | `task: "gen" \| "schema"`, `add`                                                                           |
| 9c  | Mobile change status             | `MobileStatus.dc.html`      | The Change status action sheet                                                                      | `status`                                                                                                   |
| 10  | What @pair did, and Undo         | `PairActions.dc.html`       | Confirm cards, records, status moves and Undo, stale and cancelled cards, the queue, Retry          | `card`, `viewer`, `status: "moved" \| "undone"`, `undoer`, `queue`, `failed`                               |

In `Main`, `nokey: "member"` renders the room as Kousik, a member who isn't an admin. The three
mobile boards share one script, so their state keys are listed together in each file.

## Icons

**Task status** is stored. It is the icon on every task row, chip, sidebar sub-row and status
control.

| Status      | Icon                        | Colour token           |
| ----------- | --------------------------- | ---------------------- |
| To do       | empty circle                | `--muted-foreground`   |
| In progress | half-filled circle          | `--info-foreground`    |
| In review   | three-quarter-filled circle | `--success-foreground` |
| Done        | check circle                | `--success-foreground` |
| Canceled    | circle with an x            | `--muted-foreground`   |

**Thread activity** is derived from a thread. It is on thread rows, and is the small lead glyph on a
task's line 2 while a thread is live.

| Activity        | Icon                            | Colour token           |
| --------------- | ------------------------------- | ---------------------- |
| Working         | dashed circle                   | `--info-foreground`    |
| Needs an answer | question bubble                 | `--input-foreground`   |
| Needs approval  | shield with a question mark     | `--warning-foreground` |
| Failed          | alert circle                    | `--error-foreground`   |
| Limited         | the existing usage-limit status | `--warning-foreground` |
| Stopped         | filled grey square              | `--muted-foreground`   |
| Idle            | none; muted text                | `--muted-foreground`   |

A status move record leads with an arrow in a circle. An undo record leads with ↶. Pull requests
use the pull-request icon, muted, with the number.
