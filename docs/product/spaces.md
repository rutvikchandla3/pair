# Spaces

Status: v2 design, 2026-11-13. v1 is built. v2 changes how repositories, tasks, status and the
Team Claude key work, and this page describes v2. The screens are in the
[prototype](./spaces-prototype/README.md), and the agent is specified in
[spaces-agent.md](./spaces-agent.md).

A Space is a room for one piece of work. It has an owner, chosen members, repositories, a Brief, a
group chat, tasks, and `@pair`. People decide things in the room. Agents do the work in cloud threads
attached to tasks. `@pair` connects the two when someone tags it.

Spaces live on Pair Cloud, because the threads that do the work are cloud threads.

## Decided

These were settled in design review. Build them as written.

### Members

- **Chosen per space.** The creator picks members from the team. Only members see the space in the
  sidebar and can open its room. The members list says "Only members can see this space."
- **Joining.**
  - A teammate who opens a link to the space and isn't a member sees Not a member. They can
    Request to join, and cancel that request.
  - The owner sees the request in the members popover, with a dot on the header avatar stack, and
    adds them from there.
  - Only the owner adds people.
- **Owner.**
  - The creator owns the space.
  - The owner can transfer ownership ("Make owner"), add and remove members, archive and unarchive,
    and change the name and the repositories.
  - The owner can't leave. Their ⋯ menu shows "Transfer ownership…" and a disabled "Leave space"
    with the hint "Transfer ownership first".
- **Removing a member keeps the work.**
  - If they own open tasks, the confirm offers "Reassign them to [You ▾]", ticked by default.
  - Their threads stay on the tasks and keep running on their account.
  - If the box is unticked, their task rows read "Kousik (removed) · Reassign".
  - A removed member's tasks drop out of their Assigned to me. Removing offers Undo in a toast.
- **Leaving mirrors removing.** The Leave dialog says "You own 2 open tasks. Reassign them to
  [Rutvik ▾]", with the space owner picked and the box ticked. The leaver's threads stay on the
  tasks. They stay the leaver's, under their own Projects, so the leaver can still stop them.
- **Header avatar stack.** The owner comes first, then the other members in the order they joined.
- **System lines.** Adding, removing, transferring and archiving each leave a one-line row in the
  room, for example "Rutvik removed Kousik · 11:21".

### Repositories and where threads run

- **A space has 1 to 8 repositories.** New space asks for Repositories, which are projects on the
  server. Pair already has workspaces: a project whose roots are other projects, so one thread checks
  out several repositories side by side.
- **2 or more repositories give the space a workspace.**
  - Pair reuses a workspace with exactly the same repositories. If several match, it takes the one
    named like the space, else the most recently used.
  - Otherwise it creates one named after the space. If a project already has that name, it adds a
    suffix ("Question creation 2"). The name can be edited in the dialog.
- **1 repository uses that project directly.**
- **The dialog says which before Create:**
  - "Creates the workspace Question creation with pair-fe and pair-be."
  - "Uses the workspace QC stack, which has the same repositories."
  - "Threads run in pair-be."
- **The header shows where threads run:** a workspace or folder icon, then the name and the
  repositories. The name is hidden when it equals the space name.
- **Changing repositories** is in Space settings. It reads "New threads use the new set. Existing
  threads keep theirs."
  - A shared workspace is never edited under other people. The space moves to a workspace that
    matches the new set, or to a new one, by the same rule as creation.
- **The space's workspace is only the default.**
  - Starting a thread offers Runs in, with the space's workspace preselected and every other project
    or workspace on the server in the same picker.
  - A thread attached from elsewhere keeps running where it was.
  - Every row that shows a thread says where it runs, muted.

### The room

- **A group chat.** It has messages, a date divider, a "New" divider and a composer.
- **Reply is an inline quote-reply.** A reply shows the quoted line above it. There are no side
  threads.
- **Mentions are tokens the composer inserts,** not text the server parses.
  - Mentioning a member notifies only that member.
  - Mentioning `@pair` queues a reply ([spaces-agent §3](./spaces-agent.md#3-triggers-and-the-queue)).
  - There is no @everyone. Other posts give unread state, not a notification.
- **"You" means the viewer everywhere**, including message headers ("You", "Pair · replying to
  you"). Other people keep their names.
- **The composer hint** says what will happen: "Kousik will be notified", or "Pair replies here".
  Its placeholder reads "Message the space · @ to mention Pair or a teammate", shortened to "Message
  the space" on a phone and while `@pair` is off.
- **Task chips.** A task mentioned in the room renders as a chip with its status icon. It links to
  the task page.
- **System lines for tasks.** Each status change, assignment and thread link leaves one row:
  - "Kousik moved [Generate question from prompt] to In review · 11:20"
  - "Hanad added a thread to [Preview renderer] · 11:02"
  - "Rutvik added this thread to [Seed role catalog] and shared it with Question creation · 10:12"

### The Brief and notes

- **The Brief** is what the people say the work is. It is written when the space is created, and
  `@pair` and every new thread on a task read it first. `@pair` never edits it.
- **Pair's notes** are `@pair`'s memory: decisions, open questions, and how we work. Members can
  read, edit and remove them ([spaces-agent §5](./spaces-agent.md#5-memory-pairs-notes)).
- Both live in the panel's Notes tab.

### Tasks

- **A task is a record, not a thread.** It has a title, a description, an owner (the person
  accountable), who created it and when, a status, and 0 to N cloud threads.
- **A thread belongs to at most one task.** A thread's ⋯ menu has "↳ Move to another task…" and
  "Remove from task".
- **Creating a task.** Any member creates one from New task, with a title, a description, an owner
  and a starting status (To do unless picked).
  - For your own task, New task can also start a thread now, with the same fields as Start a thread.
  - If that thread can't start (no account), Create task still creates the task, with no thread.
  - `@pair` can also create one ([spaces-agent §6](./spaces-agent.md#6-tools-and-permissions)).
- **Start a thread** is on the task page, for any member and any task.
  - The dialog has Runs in, the model, the base (a branch, or "continue pair-be#482") and the
    account.
  - In a workspace, the base line says which repository starts where.
  - The prompt is prefilled with the task's description, word for word, and can be edited.
  - The thread runs on the account of whoever starts it, and is linked to the task.
  - Without a usable account, the dialog offers Connect Claude and Start is disabled.
  - While it starts, "Cancel start" aborts, and nothing is linked.
- **Add to task** is in the header of any cloud thread you own.
  - You pick one of your spaces, then a task, or "New task in Question creation".
  - The confirm names who will see the thread: "Kousik, Hanad and Ankur will see this thread. They
    can message its agent; turns run on your Claude account. It keeps running in pair-be. Remove it
    from the task to stop sharing." The button is "Add and share".
- **Sharing follows the task.** Pair Cloud threads are private until shared.
  - Attaching a thread shares it with the space's members, who can message its agent on the owner's
    account, as with any shared thread.
  - There is no separate share. A member sees someone else's thread only because it is on a task.
    It shows under that task's sidebar sub-row, never under their own Projects, with line 2
    "Rutvik's thread".
  - Removing it from the task stops the sharing. Moving it to a task in another space shares it
    with that space instead.
- **Moving and removing threads.**
  - Only the thread's owner adds or moves it.
  - The thread's owner, the task's owner and the space owner can remove it. A removal by someone
    other than the thread's owner leaves a room line.
- **An assigned task waits for its owner.**
  - Assigning creates no thread and runs nothing.
  - The assignee sees "Rutvik assigned this to you", Start a thread, Assign to someone else, and
    Can't take it.
  - Can't take it hands the task back to its creator with a reason, and leaves a line in the room.
  - The creator sees Remind, Reassign and Edit.
- **Editing.** The creator and the owner edit the title and description, and reassign.
- **The task page** opens from a panel row, a chip or a sidebar sub-row, in the main column.
  - The header is the breadcrumb "Question creation / Seed role catalog" and a ⋯ menu: Copy link,
    Reassign, Edit, Cancel task.
  - Then the title, and a properties line: the status control, the owner, who created it and when,
    and pull requests across repositories.
  - The description, with Show more.
  - Threads: one borderless row per thread, with Start a thread and Add existing thread.
  - Activity: status changes, assignment and links, with who and when. A "Discuss in the room" link
    sits at the end, because discussion stays in the room.
  - The room's right panel stays open with this task highlighted.
- **A thread on a task** opens in the existing thread view.
  - Its header shows "Question creation / Seed role catalog / Prompt builder" and a read-only status
    chip that links to the task.
  - The first line of the thread says "You started this thread on [task]".
  - Its right side is the existing panel and its + menu, plus an Overview tab with the space's
    tasks.
  - Opening it highlights the task's sidebar sub-row.
- **Other people's threads.** A member can message any thread on a task. Their message queues
  behind the owner's turn, as today. Stop asks first ("Stop Kousik's turn?"). The model is locked to
  the thread's owner.

### Status

- **Status is stored, and people set it.** The five statuses are To do, In progress, In review,
  Done and Canceled.
  - Any member changes any task's status. The controls are on the task page's properties line, in
    the panel row's hover and context menu (keys 1 to 5), and in mobile's Change status sheet.
  - Canceled is how a task is dropped. Any status can be set back, so Done and Canceled are never
    one-way.
- **A turn ending never changes status.** v1 derived status from the thread, so a turn that finished
  without a pull request showed Done. A turn ending says nothing about the work.
- **No automatic Done, even when a pull request merges.** The task page may show a quiet
  suggestion, "pair-be#471 merged · Mark Done", which a person clicks or ignores.
- **Agents change status only when asked.**
  - A thread's agent can set its own task's status, and does it only when the user tells it to
    ("tests pass, move this to In review").
  - `@pair` can do the same when tagged
    ([spaces-agent §6](./spaces-agent.md#6-tools-and-permissions)).
- **One record form for every status move:** "[actor] moved [chip] to [Status] · asked by [X] ·
  [time] · Undo".
  - The actor is "Agent" inside the thread itself, the thread's title in task and room activity,
    "Pair" for `@pair`, and the person for their own move. A person's own move has no "asked by"
    and no Undo.
  - Any member can Undo an agent's or `@pair`'s move until the status changes again. After that,
    Undo is disabled with the tooltip "Status changed since".
  - An Undo leaves one line: "↶ Hanad undid this · [chip] is back to In progress · 11:14". The
    original record stays, muted, without its Undo.
- **Live activity is separate, derived, and always shown.** It comes from a task's threads: Working,
  Needs \<person\> (an answer or an approval), Failed, Limited, Stopped, or Idle.
  - It is the attention signal. A task's line 2 shows the most urgent activity across its threads:
    "Needs you · wants to run pnpm db:migrate", "2 threads · 1 working", "Thread failed:
    fixtures.test.ts", "No threads yet · assigned by Rutvik".
  - Needs you means a thread on the task is waiting on the viewer. For an assignee, a To do task
    someone else assigned them, with no threads, also counts, as "Assigned to you · not started",
    until they start a thread or change its status.
- The icons for both sets are in the [prototype README](./spaces-prototype/README.md#icons).

### The Team Claude key

- **`@pair` always replies on the server's Team Claude key**, an Anthropic API key. There is no
  per-space choice of who pays.
- **Its home is Settings → Team → Team Claude key.** Settings search finds it for "Claude key", "API
  key" and "Anthropic".
  - The card says "Pays for @pair in every space on this server. Members' own threads keep using
    their own accounts."
  - Status: "Not set", or "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 2m ago".
  - Server admins can Add key, Replace and Remove. Add opens a dialog with a password field and "Save
    and check", with the help line "Stored on this server. You won't see it again." It shows
    checking, then "Anthropic rejected this key" or saved.
  - Remove confirms "@pair stops replying in 3 spaces".
  - Everyone else sees the status read-only, and who the admins are.
- **Every place `@pair` is off points there:**
  - the composer hint "@pair is off · needs a Team Claude key", followed by "Add key" for an admin,
    which opens the same dialog in place, or "Ask Rutvik" for a member;
  - the @ mention menu, with Pair greyed and the reason;
  - New space's `@pair` field, with the same in-place Add key;
  - Space settings' `@pair` section.
- **"Ask Rutvik" drafts a message and never sends it.** The draft is "@Rutvik can you add a Team
  Claude key? Settings → Team", and the button then reads "Asked".
  - In a room, it goes in that room's composer.
  - From Settings → Team, it goes in the most recent space you share with that admin, with a
    "Drafted" toast and an Open link. With no shared space, it copies a link to the section.
  - From New space, it goes in the new room's composer after Create.
  - "Rutvik" is the admin to ask: the space owner if they are an admin, else the admin who added the
    key, else the first admin.

### Layout

- **Sidebar.**
  - At the top, Assigned to me with a count. Tasks in archived spaces don't count.
  - A Spaces section with a + button. Each space row has an unread dot.
  - Under the open space, up to two sub-rows for tasks that need you, then "N more". A sub-row leads
    with the task's status icon and shows only "Needs you" on the right.
  - An Archived section, when there is something to show.
- **The room's right panel follows Capy.**
  - Tabs: Overview, Notes, and + (a new task, or open a surface). It also has expand and hide.
  - Overview groups tasks under grey header rows with a count and a chevron: Needs you, In review,
    In progress, To do, Done (collapsed) and Canceled (a collapsed band).
  - Each row has two lines: the status icon and a bold title, then a muted line with the owner's
    avatar and name and the live activity. A relative time sits on the right. On your own rows,
    line 2 shows only your avatar.
  - A New task row ends the list.
  - Below 1100px the panel becomes an overlay under the header, with a shadow and one toggle.
- **Mobile.** The room is the feed and the composer. The tasks and members lists open as bottom
  sheets, with a medium and a large detent. The composer hides while a sheet is open.
  - A task opens a task page.
  - Change status is an action sheet, and so is Start a thread / Add existing thread.
- **Dialogs** are centred over a dimmed room on desktop. Below 640px they are bottom sheets.

### Archive

- **Only the owner archives.** The confirm reads "It becomes read-only for all 4 members and moves
  to Archived in the sidebar. Running threads keep running."
- **An archived space is read-only.**
  - A bar reading "Archived by Rutvik · read-only" replaces the composer.
  - New task, Start a thread, Add to task, the status control, message actions and Undo are hidden.
- **Unarchive** is in that bar, the room ⋯ menu, and the hover ⋯ on the Archived sidebar row. The
  archive toast also offers Undo.

### Notifications

- Everything in [decisions](./decisions.md#presence-and-notifications) still applies. Spaces add
  three notifications:
  - A mention notifies the named member.
  - A `@pair` reply notifies the person who tagged it.
  - Being assigned a task notifies the assignee.
- Creating a space notifies the members you added ("Kousik, Hanad and Ankur were notified.").

### Existing v1 tasks

Each v1 task becomes a task with its thread attached. Its status is set once, from what people did:

- Done, if its pull request merged or someone settled the thread;
- In review, if a pull request is open;
- To do, if it never started;
- In progress, otherwise. A turn that just ended stays In progress.

### Later

- **The Overview panel spreads.** It ships in Spaces first. Later it appears in any thread that
  has subagents.

## Who can do what

| Action                                          | Space owner             | Member                       | Non-member        |
| ----------------------------------------------- | ----------------------- | ---------------------------- | ----------------- |
| See the space, read the room, tasks and threads | Yes                     | Yes                          | No (Not a member) |
| Post, mention, tag `@pair`                      | Yes                     | Yes                          | No                |
| Create a task, assign it at creation            | Yes                     | Yes                          | No                |
| Start a thread on any task                      | Yes                     | Yes                          | No                |
| Change any task's status; Undo an agent's move  | Yes                     | Yes                          | No                |
| Edit a task, reassign it                        | As its creator or owner | Same                         | No                |
| Can't take it                                   | As its owner            | Same                         | No                |
| Add your own cloud thread to a task, or move it | Yes                     | Yes                          | No                |
| Remove a thread from a task                     | Any thread              | Your thread, or on your task | No                |
| Edit or remove a note                           | Yes                     | Yes                          | No                |
| Add members, accept a join request              | Yes                     | No                           | Request to join   |
| Remove members, transfer ownership              | Yes                     | No                           | No                |
| Rename, change the repositories                 | Yes                     | No                           | No                |
| Archive, unarchive                              | Yes                     | No                           | No                |
| Leave                                           | After a transfer        | Yes                          | —                 |

Adding, replacing and removing the Team Claude key follow server admin status, not space roles.

## Every surface

These are Spaces' entries in the AGENTS.md "Hit every surface" list:

- **Clients.** Web, desktop and mobile get the same behaviour. Shared logic goes in
  `packages/client-runtime`: the live-activity classifier, the panel's grouping, mention parsing,
  record copy and the "for you" wording.
- **Agents.**
  - Every user action is a service method that MCP tools can reach. `@pair` goes through the
    same methods.
  - A thread's agent reaches its task's status through one MCP tool, and uses it only when asked.
  - A post from an agent or an API token never triggers `@pair`.
- **Contracts.** Spaces, tasks, a thread's link to a task, membership, join requests, room posts and
  the Team Claude key's status live in `packages/contracts`.
- **The way back.** Each action in has its reverse:
  - Archive and Unarchive.
  - Remove a member and Undo.
  - Request to join and Cancel request.
  - Leave and "Ask to be added back".
  - An assignment, and Can't take it.
  - Add to task, and Remove from task.
  - Done or Canceled, and any other status. An agent's move, and Undo.
  - Add key, and Remove.
- **Connection modes.** Clients only send commands and render projections, so local, relay and
  tunnel connections behave the same.

## Open

- **Who edits the Brief.** We recommend any member, as with a thread's title, which is shared
  state. Each edit leaves a line in the room.
- **The `decisions.md` non-goal "An activity feed, side chat, and @mentions for now."** Spaces
  contradicts it. The proposed rewording is in [spaces-agent §14.1](./spaces-agent.md#14-open-decisions).
- **The `@pair`-specific questions** are in [spaces-agent §14](./spaces-agent.md#14-open-decisions).
