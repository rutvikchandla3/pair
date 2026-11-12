# Spaces

Status: proposal, 2026-11-12. Nothing here is built. The design is approved as a
[prototype](./spaces-prototype/README.md), and the agent is specified in
[spaces-agent.md](./spaces-agent.md). Line references are from `feat/pair` at `7e6040c51`.

A Space is a room for one piece of work. It has an owner, chosen members, a Brief, a group chat,
tasks, and `@pair`. People decide things in the room. Agents do the work in tasks. `@pair` connects
the two when someone tags it.

Spaces live on Pair Cloud, because tasks are cloud threads.

## Decided

These were settled in design review. Build them as written.

### Members

- **Chosen per space.** The creator picks members from the team. Only members see the space in
  the sidebar and can open its room. The members list says "Only members can see this space."
- **Joining.**
  - A teammate who opens a link to the space and isn't a member sees Not a member. They can
    Request to join, and cancel that request.
  - The owner sees the request in the members popover, with a dot on the header avatar stack, and
    adds them from there.
  - Only the owner adds people.
- **Owner.**
  - The creator owns the space.
  - The owner can transfer ownership ("Make owner"), remove members, archive and unarchive, and
    change the name, the project, and who pays for `@pair`.
  - Anyone can leave. The owner must transfer ownership before leaving.
- **Removing or leaving keeps the work.** A removed member's tasks stay in the space and keep
  running on their account. Their rows read "Kousik (removed)". The person still sees those tasks
  in Assigned to me. Removing offers Undo in a toast.
- **Header avatar stack.** The owner comes first, then the other members in the order they joined.
- **System lines.** Adding, removing, transferring and archiving each leave a one-line row in the
  room, for example "Rutvik removed Kousik · 11:21".

### The room

- **A group chat.** It has messages, a date divider, a "New" divider and a composer.
- **Reply is an inline quote-reply.** A reply shows the quoted line above it. There are no side
  threads.
- **Mentions are tokens the composer inserts,** not text the server parses.
  - Mentioning a member notifies only that member.
  - Mentioning `@pair` queues a reply ([spaces-agent §3](./spaces-agent.md#3-triggers-and-the-queue)).
  - There is no @everyone. Other posts give unread state, not a notification.
- **The composer hint** says what will happen: "Kousik will be notified", or "Pair replies here ·
  Team Claude key". Its placeholder reads "Message the space · @ to mention Pair or a teammate",
  shortened to "Message the space" on a phone.
- **Task chips.** A task mentioned in the room renders as a chip with its live status icon. It
  links to the task.

### The Brief and notes

- **The Brief** is what the people say the work is. It is written when the space is created, and
  `@pair` and every task read it first. `@pair` never edits it.
- **Pair's notes** are `@pair`'s memory: decisions, open questions, and how we work. Members can
  read, edit and remove them ([spaces-agent §5](./spaces-agent.md#5-memory-pairs-notes)).
- Both live in the panel's Notes tab.

### Tasks

- **A task is an ordinary cloud thread** that belongs to the space. It has one owner, per
  [decisions](./decisions.md#threads).
- **Creating a task.**
  - Any member creates one from New task, with a description, an owner, a model and a base. The
    base is a branch, or "continue pair-be#482".
  - `@pair` can also create one ([spaces-agent §6](./spaces-agent.md#6-tools-and-permissions)).
- **An assigned task waits for its owner.**
  - A task assigned to a teammate is Not started, and nothing runs until they open it and press
    Start task.
  - It runs on the assignee's own account, and they pick the model.
  - Before starting, the assignee can choose Runs on, Assign to someone else, or Can't take it.
    Can't take it hands the task back to the creator with a reason and leaves a line in the room.
  - The creator sees Remind, Reassign and Edit. Other members see it read-only.
- **No account.** If the owner has no account a cloud machine can use, Start is disabled and a
  banner asks them to connect one. New task warns about this before you assign.
- **Status is derived, never stored.** One shared classifier, `spaceTaskState` in
  `packages/shared`, maps a thread to its status. The panel, the sidebar, chips, mobile and `@pair`
  all use it. The icons are in the
  [prototype README](./spaces-prototype/README.md#status-icons). The statuses:
  - Not started
  - Working
  - Needs \<person\>, with the reason: an answer or an approval
  - Failed
  - Limited
  - Stopped
  - In review: a pull request is open
  - Done
- **Other people's tasks.**
  - A member viewing someone else's task can message it. Their message queues behind the owner's
    turn, as today.
  - Stop asks first ("Stop Kousik's turn?").
  - The model is locked to the owner.

### Layout

- **Sidebar.**
  - At the top, Assigned to me with a count.
  - A Spaces section with a + button. Each space row has an unread dot.
  - Under the open space, up to two sub-rows for tasks that need you, then "N more".
  - An Archived section, when there is something to show.
- **The room's right panel follows Capy.**
  - Tabs: Overview, Notes, and + (a new task, or open a surface). It also has expand and hide.
  - Overview groups tasks under grey header rows with a count and a chevron: Needs you, In
    progress, Not started, In review, and Done (collapsed).
  - Each row has two lines: a status icon and a bold title, then a muted line with the avatar,
    owner and reason. A relative time sits on the right.
  - A New task row ends the list.
- **The task screen** is the existing thread view. Its header shows the space. Its right side is
  the existing panel with its + menu (browser, terminal, changes, files, PR), plus an Overview tab
  that lists the space's tasks.
- **Mobile.** The room is the feed and the composer. The tasks and members lists open as bottom
  sheets, with a medium and a large detent. The composer hides while a sheet is open.
- **Dialogs** are centred over a dimmed room on desktop. Below 640px they are bottom sheets.

### Archive

- **Only the owner archives.** The confirm reads "It becomes read-only for all 4 members and moves
  to Archived in the sidebar. Running tasks keep running."
- **An archived room is read-only.**
  - A bar reading "Archived by Rutvik · read-only" replaces the composer.
  - New task, message actions and inline Undo are hidden.
- **Unarchive** is in that bar, the room ⋯ menu, and the hover ⋯ on the Archived sidebar row. The
  archive toast also offers Undo.

### Notifications

- Everything in [decisions](./decisions.md#presence-and-notifications) still applies. Spaces add
  three notifications:
  - A mention notifies the named member.
  - A `@pair` reply notifies the person who tagged it.
  - Being assigned a task notifies the assignee.
- Creating a space notifies the members you added ("Kousik, Hanad and Ankur were notified.").

### Later

- **The Overview panel spreads.** It ships in Spaces first. Later it appears in any thread that
  has subagents.

## Who can do what

| Action                                 | Owner                                                 | Member | Non-member        |
| -------------------------------------- | ----------------------------------------------------- | ------ | ----------------- |
| See the space, read the room and tasks | Yes                                                   | Yes    | No (Not a member) |
| Post, mention, tag `@pair`             | Yes                                                   | Yes    | No                |
| Create a task, assign it at creation   | Yes                                                   | Yes    | No                |
| Start, reassign or hand back a task    | As its owner, per [decisions](./decisions.md#threads) | Same   | No                |
| Edit or remove a note                  | Yes                                                   | Yes    | No                |
| Add members, accept a join request     | Yes                                                   | No     | Request to join   |
| Remove members, transfer ownership     | Yes                                                   | No     | No                |
| Rename, change the project or who pays | Yes                                                   | No     | No                |
| Archive, unarchive                     | Yes                                                   | No     | No                |
| Leave                                  | After a transfer                                      | Yes    | —                 |

## Every surface

These are Spaces' entries in the AGENTS.md "Hit every surface" list:

- **Clients.** Web, desktop and mobile get the same behaviour. Shared logic goes in
  `packages/client-runtime`: the status classifier, mention parsing and the "for you" wording.
- **Agents.**
  - Every user action is a service method that MCP tools can reach. `@pair` goes through the
    same methods.
  - A post from an agent or an API token never triggers `@pair`.
- **Contracts.** Spaces, membership, join requests, room posts and a thread's space live in
  `packages/contracts`.
- **The way back.** Each action in has its reverse:
  - Archive and Unarchive.
  - Remove and Undo.
  - Request to join and Cancel request.
  - Leave and "Ask to be added back".
  - An assignment, and Can't take it.
- **Connection modes.** Clients only send commands and render projections, so local, relay and
  tunnel connections behave the same.

## Open

- **Who edits the Brief.** We recommend any member, as with a thread's title, which is shared
  state. Each edit leaves a line in the room.
- **The `decisions.md` non-goal "An activity feed, side chat, and @mentions for now."** Spaces
  contradicts it. The proposed rewording is in [spaces-agent §14.2](./spaces-agent.md#14-open-decisions).
- **The `@pair`-specific questions** are in [spaces-agent §14](./spaces-agent.md#14-open-decisions).
