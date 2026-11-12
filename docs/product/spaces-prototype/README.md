# Spaces prototype

This is the clickable prototype for [Spaces](../spaces.md) and [@pair](../spaces-agent.md). A
senior-designer review approved every screen at 4/5 on 2026-11-12. It is a design reference, not
code to ship. Build the real UI from `apps/web` components and tokens, and match what these screens
show.

- **Canvas:** https://claude.ai/artifact/T4KuyZQeZVfH5Ax9PsZLgY. It shows every screen side by side,
  and each one is clickable.
- **Locally:** open any `screens/*.dc.html` in a browser. `support.js` is a small shim that renders
  the `{{bindings}}`, `<sc-if>` blocks and the `DCLogic` state class.
- **One state at a time:** append `#state=<json>` to the URL. The comment at the top of each
  screen's script lists its state keys.
- **Screenshots:** `./render.sh Main.dc.html out.png 1440 900 '{"tab":"notes"}' dark` renders at 2x
  with headless Chrome. Widths under 500 also need ImageMagick. On Linux, point `CHROME` at a
  Chrome binary.
- **Styles:** each screen inlines `shared.css` between `/*shared-start*/` and `/*shared-end*/`.
  Those tokens mirror `apps/web/src/index.css`; `--input-foreground` (indigo, "needs an answer")
  and `--destructive` (red fills) are new.

## Screens

The cast in every screen: the space "Question creation", repositories pair-fe and pair-be, owner
Rutvik, and members Kousik, Hanad and Ankur. Kousalya is on Pair Cloud but not a member.

| #   | Screen                     | File                          | What it settles                                                                                                                              |
| --- | -------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Space room                 | `Main.dc.html`                | The room: sidebar, chat, quote-reply, @pair, composer hints, the Overview and Notes panel                                                    |
| 2   | Task, running              | `Task.dc.html`                | The task screen: the existing thread with its panel, plus Overview. Covers member and owner views, needs, limited, stopped, asleep and ended |
| 3   | Task assigned, not started | `TaskUnstarted.dc.html`       | The assignee's view: Start, Runs on, Assign to…, Can't take it, and no account                                                               |
| 3b  | Someone else's task        | `TaskUnstartedViewer.dc.html` | The same screen for the creator (Remind, Reassign, Edit) and for other members (read-only)                                                   |
| 4   | New space                  | `NewSpace.dc.html`            | Name, project, Brief, members, who pays for @pair. Covers validation, creating and created                                                   |
| 4b  | New space, picking people  | `NewSpacePicker.dc.html`      | The member picker, including no match                                                                                                        |
| 5   | First @pair ask            | `SpaceEmpty.dc.html`          | An empty room, @pair splitting the Brief, records with Undo, and the viewer-dependent "for you"                                              |
| 5b  | @pair proposes tasks       | `SpaceProposal.dc.html`       | The proposal card (approve, untick, change owner), the read-only view for others, and dismissed                                              |
| 6   | Not a member               | `NotMember.dc.html`           | Request to join, cancelling it, and after Leave                                                                                              |
| 7   | New task                   | `NewTask.dc.html`             | Description, owner, model, base branch or continue a PR, and the account error                                                               |
| 7b  | New task, picking an owner | `NewTaskAssign.dc.html`       | Assigning to a teammate: the model is theirs to pick, and account readiness shows per row                                                    |
| 8   | Space settings             | `SpaceSettings.dc.html`       | Name, project, who pays, transfer, leave and archive. Owner and non-owner views                                                              |
| 8b  | Members                    | `SpaceMembers.dc.html`        | The members popover: add, join requests, make owner, remove and leave                                                                        |
| 8c  | Remove a member            | `SpaceMemberRemove.dc.html`   | The remove confirm, "(removed)" task rows and Undo                                                                                           |
| 8d  | Archived space             | `SpaceArchived.dc.html`       | A read-only room, the Archived sidebar section, and Unarchive in three places                                                                |
| 9   | Mobile room                | `MobileRoom.dc.html`          | 390×844: the feed, the tasks and members sheets with detents, and a confirm card                                                             |
| 10  | What @pair did             | `PairActions.dc.html`         | The confirm card, records, Undo, stale and cancelled cards, the queue, and failed with Retry                                                 |

## Status icons

| Status          | Icon                            | Colour token           |
| --------------- | ------------------------------- | ---------------------- |
| Not started     | empty circle                    | `--muted-foreground`   |
| Working         | dashed circle                   | `--info-foreground`    |
| Needs an answer | question bubble                 | `--input-foreground`   |
| Needs approval  | shield with a question mark     | `--warning-foreground` |
| Failed          | alert circle                    | `--error-foreground`   |
| Limited         | the existing usage-limit status | `--warning-foreground` |
| Stopped         | filled grey square              | `--muted-foreground`   |
| In review       | pull request                    | `--success-foreground` |
| Done            | check circle                    | `--success-foreground` |
