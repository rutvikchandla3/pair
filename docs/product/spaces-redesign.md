# Spaces redesign: a calm sidebar, and building together

Status: approved 2026-11-14, built 2026-11-15. Builds on [Spaces v2](./spaces.md) and
[private cloud threads](./cloud/11-private-threads.md) as they stand on `feat/pair`. The screens are in
the [prototype](./spaces-redesign-prototype/index.html).

## The feedback

1. **The sidebar gets spammy.** With 10 tasks assigned to you, several spaces and many threads of your
   own, the sidebar becomes a long list. Everything teammates share sits in one flat **Team** shelf, and
   20 shared threads are hard to get through.
2. **Collaboration stops at watching.** A teammate who is shared a thread gets its chat and nothing
   else. They can't start their own session or worktree on that cloud machine and work in parallel
   without getting into the owner's conversation. Pair is good at "see what I built", but not at "I've
   built something, let's build the rest together".

## Why it happens

**Sidebar.** On `feat/pair` the sidebar stacks the Spaces block (Assigned to me, Spaces with needs-you
task sub-rows and their threads, Archived) on top of T3 Code's own list (Pinned, Active, Working, Team,
Snoozed, Settled).

- "Needs you" shows up in four places: the Assigned count, task sub-rows, the Working shelf and unread
  Team rows. One task can show three times.
- Lists that grow with the team render one row per item, so the sidebar grows with headcount.
- Team is flat and ordered by activity. Nobody can scan it by person or by space.

**Collaboration.** A shared member can prompt the owner's thread, fork it, open a side chat, or
**Continue locally**.

- **Fork and side chat** copy the source's `worktreePath` on a cloud machine
  ([07 §2](./cloud/07-access-and-data.md#2-restore-revert-and-fork)), so a teammate's agent edits the
  owner's files mid-turn.
- **Prompting** goes into the owner's conversation.
- **Continue locally** leaves the machine behind.
- **Start a thread** on a task boots a new machine from a pushed branch, which takes minutes and has
  none of the owner's uncommitted work.

## Principles

- **The sidebar holds places, not work.** Lists that grow with the team live on pages. In the sidebar
  each is one row.
- **Attention lives in one place.** Everything waiting on you is in **Inbox**. Everywhere else,
  attention is a count or a glyph, never a second row. Inbox is attention, not activity.
- **Every thread has one home.**
  - Yours: Threads.
  - A teammate's thread on a space task: that task.
  - A branch: its source's lineage.
  - A thread shared with you by name: Shared with you.
  - Pin or Follow brings any of them into your Threads, as today.
- **Your own branch, never their chat or their checkout.** Building together means parallel branches,
  each in its own worktree, with hand-offs that happen only when someone agrees to them.
- **Solo stays T3 Code.** With one member, none of this shows.

## Part 1: The sidebar

```text
Pair Cloud ▾                         ✎
Search                              ⌘K
Inbox                               4   ← the only indigo number: items that need you
My tasks                                ← a place: no count
Shared with you                         ← a place: no count, no dot

Spaces                              +
  Question creation                 2   ← muted: that space's share of the Inbox count
  Onboarding revamp                 1
  Billing v3                        ·   ← grey dot: unread room, nothing waiting on you
  Mobile push                       1
  Docs site
  2 more

Threads                             ⚲   ← T3 Code's list, unchanged
```

### Rules

- **Three fixed rows.** Inbox, My tasks and Shared with you each open a page in the main column. They
  replace Assigned to me, the needs-you sub-rows and the Team shelf.
- **One row per space, and no sub-rows.**
  - The row is selected while you are anywhere inside the space: its room, a task page, or a thread
    on one of its tasks.
  - Its muted number is the count of Inbox **Needs you** items that belong to that space. Inbox's is
    the only indigo number in the sidebar. With nothing waiting, an unread room shows a grey dot.
    Space names are never bold.
  - After the first five spaces, in your order (drag to reorder), comes "N more". It carries the
    hidden spaces' total and expands in place. Archived spaces don't count toward N. They sit under
    an **Archived** sub-header inside the expansion. Mobile uses the same rule.
  - A space you're added to goes to the top of your order, and Inbox's For you says "Kousik added you
    to Billing v3".
- **Threads is T3 Code's list:** Pinned, Active, Working, Snoozed and Settled, unchanged.
  - A thread on a space task leads with the space glyph, and its tooltip names the space and task.
  - A branch leads with the branch glyph.
  - A teammate's thread shows its owner's avatar on the right.
  - A thread that has branches shows ⑂ and the branchers' avatars on the right.
- **A teammate's thread is never a sidebar row** unless you pin it, follow it or prompt it. Pin and
  Follow stay until you undo them. A follow that prompting added ends when the thread settles, or once
  your last turn on it has ended and you've read it, whichever comes first. So Threads doesn't fill up
  over a month.

### Inbox

One list of what waits on you, newest first, in two groups:

- **Needs you**, which is counted:
  - approvals and questions on threads that concern you;
  - tasks assigned to you and not started, or handed back to you;
  - changes offered to a thread you own (Part 2).
- **For you**, which isn't counted:
  - mentions;
  - `@pair` replies to you;
  - threads shared with you by name.

Rules:

- Each row names the reason, the thread or task, where it lives, who is involved, and when.
- A preview pane answers in place: "Answering here answers in the thread".
- An item leaves when it's handled. **Done** (`e`) clears a For you item early.
- **Snooze** (`h`) on a thread's item snoozes that thread, through the existing Snoozed shelf. On a
  task item it snoozes only that item.
- `j`/`k` move and Enter opens, while the list has focus.
- **Go to Inbox**, **Go to My tasks** and **Go to Shared with you** are palette commands that can be
  bound to a key. They're unbound by default. The natural chord for Inbox, ⌘⇧I or Ctrl+Shift+I,
  opens the browser's developer tools on the web.

Inbox is derived from state that already exists. It is not an activity feed, and the
[decisions](./decisions.md#non-goals) non-goal stands. The server keeps it as a per-member projection
and sends a count plus a paged list, so no client needs every thread's shell to work it out.

### My tasks

The open tasks you own across every space. They are grouped by status, In progress first, and Done
and Canceled are collapsed. Rows use the Overview panel's two lines plus the space's name. **Group by
space** is a toggle. My tasks replaces Assigned to me.

### Shared with you

Threads whose owner shared them with you by name or through Everyone on the team.

- Grouped by person. Groups and rows are ordered by last activity, so presence never reorders them;
  it shows as a dot on the avatar.
- There is a search field and filters for person and state (Working, Needs someone, Idle, Settled).
- Task threads stay in their tasks. They're one ⌘K away, and an **Include task threads** filter shows
  them here too.
- Rows offer **Follow** on hover.
- The server paginates the list, and the client virtualizes it.

On mobile, My tasks and Shared with you are screens of their own, and their filters open in a
sheet.

## Part 2: Building together

### Lineage

**Branch off** gives you your own thread on top of someone's work:

- **Its own worktree and branch.** It starts from the source's latest checkpoint, which includes
  uncommitted work. It can also start from an earlier turn or from a branch such as `main`.
- **Your account.** The thread runs on your account, and you own it.
- **The source is never touched.** The source's conversation and files stay as they are.
- **The same task.** It joins the source's task, if it has one, so the same people can see it.

Branch off is a Pair Cloud feature in v1. Local threads keep New worktree and Fork as they are.

A source and its branches form a **lineage**. It shows as one chip in the header's meta line, and the
chip's popover lists the source and its branches. Lineage is git, not location, so it works the same
whether a branch runs on the source's machine or on a new one.

### Runs on: their machine or a new one

The draft asks one question, as a two-option control:

| Option               | Starts in   | You share                                                         | Good for                                       |
| -------------------- | ----------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| **Kousik's machine** | seconds     | Its running database and services, installed dependencies, caches | Building on what's running, in a tight loop    |
| **New machine**      | about 1 min | Nothing. It starts from the same checkpoint                       | Migrations, heavy builds, anything destructive |

Under the selected option, one line says what it means:

- **Kousik's machine:** "Shares Kousik's running database and services. Kousik, Rutvik and Ankur can
  open this machine and reach your Claude and GitHub sign-ins from its terminal. Machine time counts
  toward Kousik." This exact string is used on every surface.
- **New machine:** "Its own database and services, on your machine time. Kousik, Rutvik and Ankur can
  open it and reach your Claude and GitHub sign-ins, as with any thread you share." The option's
  card says "About a minute · own database and services", never "isolated".

The first time, the draft selects the source's machine. After that it remembers your last choice. A
busy machine (three or more threads working) always selects **New machine**. Whatever is selected,
its line is shown in full. A busy or failed machine adds its reason above the line, never in place
of it.

Each thread on a machine gets its own `PORT` and `PAIR_THREAD_SLOT` in its environment, so dev servers
don't collide. Each thread gets its own preview link, and a project's setup script can use the slot
to create a per-thread database. A branch on a shared machine is also told, in its first instructions,
that the database and services are shared with the source.

### Update, Offer, Apply

Lineage moves code with two verbs. Both go through git and the mirror, so they work the same whichever
machine a branch runs on. The mechanics are in [12 Branch off: the git model](./cloud/12-branch-off.md).
The promises:

- **Credit follows the code.** Work in a thread belongs to its owner, as today. What's new is that a
  teammate whose offered changes land in a thread is credited.
  - That credit is `Co-authored-by: Hanad` on the commit that includes his changes, whoever makes
    it.
  - On a branch, the source's work arrives in commits authored as the source's owner.
- **Reverting never rewrites pushed history.**

**Update from Prompt builder** brings in what changed on the source since the last Update you kept.

- **Between turns.** It runs between your branch's turns. During a turn the button reads **Update after
  this turn**.
- **A preview first.** For example: "3 files from Prompt builder · 1 conflicts with yours:
  `src/schema.ts`".
  - A clean Update merges at once, and your agent is told what changed on its next turn.
  - A conflict offers two choices and says what each one costs:
    - **Update and let my agent resolve it** starts one turn on your account with a fixed prompt.
    - **Update and resolve it myself** leaves conflict markers in your worktree.
- **While a conflict is open**, one row is pinned above the composer: "Resolving update from Prompt
  builder · `src/schema.ts` · **Abort update**".
  - You can keep prompting. Your agent is told a merge is open and which files have markers, and is
    told not to abort or stash it.
  - **Offer** and **Undo update** wait until it's resolved.
  - **Abort update** puts your branch back exactly as it was. The row is the same on mobile.
- **When the source reverts your applied work**, the Update row says what happened to it:
  - If your branch still has those commits: "Kousik reverted your applied changes. You still have them
    here, and can offer them again."
  - If an Update removed them from your branch too: "Kousik reverted your applied changes, and this
    Update removed them here too · **Bring them back**". The link adds them to your branch again, ready to
    offer.

**Offer to Kousik** proposes your work to the source.

- **It carries only your work.**
  - It holds your commits that the source doesn't have yet, and never the source's own work.
  - Uncommitted files of yours are committed first, as you, in the dialog.
  - **View changes** shows only your lines.
- **It's checked first.** Before it's sent, the offer is checked against the tree Apply will write to,
  the source's uncommitted work included. If it wouldn't apply cleanly, it isn't sent: "Update from
  Prompt builder first".
- **One open offer per branch.** Offering again replaces the open one, and the card says "updated".
- **"To offer"** counts the changes your branch has and the source doesn't. Applied ones stop counting
  at once. An offer carries exactly what's counted.
- **A card, not a message.** An offer appears as a card in the source thread's timeline and never
  enters the message queue, so an offer nobody has decided on holds nothing up. It goes to the
  source's current owner.
- **Withdraw.** The sender can withdraw it until it's applied. If an Apply and a Withdraw race, the
  first one wins.
- **Agents.** An offer an agent makes reads "Hanad's agent offers…", as agent messages carry no
  person's name today.

**Apply** is the owner's answer. **Decline** is the other.

- **What Apply writes.**
  - Hanad's changes go into the owner's files, uncommitted, as one recorded step: "Applied Hanad's
    changes from Rationale per question · 3 files".
  - The owner's own uncommitted work is left as it is.
  - The next commit that includes those changes adds `Co-authored-by: Hanad`. That holds whether the
    git button makes the commit or the owner's agent does.
- **When.** Only between turns. During a turn, **Apply** arms the step and the card reads "Applies
  when this turn ends". The step runs at that boundary, before the next queued message.
- **A turn that breaks it.** If that turn makes the offer conflict, the offer goes back to the sender
  as "Prompt builder changed since · Update and offer again".
- **The agent is told.** The owner's agent gets a one-line note on its next turn: "Hanad's changes from
  Rationale per question were applied to your files: 3 files. Credit him when you commit them." A
  turn's changed-files summary never counts an Apply or an Update.
- **Undo.** **Revert Hanad's changes** removes his lines from the owner's files as one recorded step,
  and later turns stay. **Revert to a turn** before the Apply discards them too, and its confirm names
  them: "This also discards Hanad's applied changes (3 files)."

**Undo update** is offered on the Update row until your next turn. A turn that resolved the Update's
conflict doesn't count as that next turn. Undo puts your branch back as it was before the Update, and
the next Update brings everything back.

### How a lineage ships

- **The source's pull request ships the lineage.** A branch offers, and is discouraged from opening its
  own pull request while its source is open.
  - In a branch, the git button leads with **Offer to Kousik**.
  - **Push** and **Create PR** sit behind a warning: "Prompt builder's pull request ships this work.
    Pushing also includes Kousik's unpushed work, authored as him."
- **When the source's PR merges,** the branch's chip reads "Prompt builder shipped in pair-be#482 · 2
  commits not in it".
- **When the source settles without a PR,** it reads "Prompt builder is settled · 2 commits not in it".
- Either way it offers two actions:
  - **Start from main with them** moves your unshipped commits onto `main`, and this branch becomes a
    thread of its own, with its own PR.
    - Conflicts with `main` resolve as an Update's do.
    - On the source's machine, this step also moves you to your own machine, so a settled source's
      machine can sleep.
  - **Settle**.
- **A branch with nothing left to offer** shows "all applied" in its chip, with **Settle**, so Threads
  stays calm.
- **One level in v1.** Branch off isn't offered on a branch. To build on Hanad's branch, branch off
  it after its changes are applied, or branch off the source.

### Where it shows

- **The composer, on someone else's cloud thread.** Under the box: "Goes into Kousik's conversation ·
  Want to work on your own? **Branch off**". While his turn runs, it reads "…, after his current turn".
  It's the one always-visible entry, and it catches the person who feels stuck at the moment they feel
  it.
- **The lineage chip** in the header's meta line.
  - On a source: "⑂ 1 branch". With an offer waiting, its glyph turns indigo.
  - In a branch: "⑂ from Prompt builder · 2 to offer · 1 behind". "To offer" counts your commits that
    the source doesn't have yet. "Behind" counts the source's turns your branch doesn't have yet. The
    popover spells out the units: "2 commits to offer", "1 turn behind".
  - Its popover lists each thread with its owner, branch, ahead and behind, and where it runs, with
    **Update**, **Offer** and **Branch off…**. Each button appears only when it has work to do, on
    every surface.
  - The chip and its popover list only threads the viewer can open, and the count matches.
- **The header of a branch with commits to offer:** one button, **Offer to Kousik**.
- **⋯ menus.**
  - On someone else's cloud thread: **Branch off…** and **Side chat**, then Follow, Copy link and
    Continue locally. **Share…** and **Assign to…** show as owner-only. Fork stays the owner's tool, so
    nobody ends up in the owner's checkout by accident, and Fork is unchanged for your own threads and
    for local ones.
  - A non-owner's Side chat is read-only (plan mode).
- **The context summary.** "Start with a summary of Prompt builder's conversation" is written by
  your agent, on your account. It shows as your first message, and you can edit or remove it before
  starting.
- **Command palette:** Branch off, Update from source, Offer changes, and Go to Inbox, My tasks and
  Shared with you. Each is a keybinding command, unbound by default and listed in Settings →
  Keybindings.
- **The owner's terminal and previews** label the processes and ports that belong to other people's
  threads on the machine, such as "Hanad · :3001". A slow test run or a busy port then has a visible
  cause.
- **Spaces.**
  - **Start a thread** on a task opens the same draft. **Start from** defaults to the space's base on a
    new machine, as it does today. The task's threads are listed under it. Picking one turns the draft
    into Branch off, with its Runs on question and its line about who can reach your sign-ins.
  - The task page lists threads by lineage.
  - Room lines stay for status, assignment and links only. Branches and offers reach the thread, the
    Inbox and the row glyphs.
- **Mobile.**
  - Branch off is in the thread menu and under the composer, and opens a sheet.
  - The lineage chip is a pill under the title, and its popover is a sheet.
  - The offer card supports Apply and Decline. **View changes** opens a sheet with the diff.
  - Inbox approves in place.
  - The resolving-update row and the shipped chip look the same as on desktop.

### Threads on someone else's machine

| Question                                  | Rule                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can open it                           | The machine's access list. The machine owner's list governs.                                                                                                                                                                                                                                  |
| Credentials                               | Each thread's agent gets its owner's provider credential, and git answers with the thread owner's GitHub credential. Anyone who can open the machine can reach both, and the draft says so before Branch off. Running each member's agents as their own unix user is a follow-up (see below). |
| Share, Add to task, move to another space | Offered only after **Move to my own machine**. A branch can't widen access to someone else's machine. Staying on the source's task keeps the same audience.                                                                                                                                   |
| Sleep, Discard                            | The owner confirms by name: "Hanad's Rationale per question is on this machine too." Work up to each thread's last turn is in the mirror. After a discard, Hanad's next message offers him a new machine of his own, which he accepts.                                                        |
| The owner removes Hanad from sharing      | Existing copy: "Hanad has 1 thread on this machine and will lose access to it." The dialog adds **Move it to Hanad's own machine first**: a new machine on Hanad's machine time, with a timeline line in his thread saying who moved it.                                                      |
| Settle or archive the source              | Asks first: "Hanad's thread is still on this machine and keeps it running." The machine sleeps only when every thread on it is settled or archived ([cloud](../user/cloud.md)).                                                                                                               |
| Reassign the source                       | The machine goes with the source to its new owner. Branches stay where they are.                                                                                                                                                                                                              |
| Hanad leaves the team                     | `TeamRemoval` handles his cloud threads as it does today: they go to someone he picks, or they're deleted.                                                                                                                                                                                    |
| Cost                                      | Machine time counts toward the machine's owner, as it does today for side chats and forks ([04](./cloud/04-sandbox-lifecycle.md#shared-sandboxes-side-chats-and-forks)). Tokens count toward whoever prompted. The draft says so.                                                             |
| Load                                      | Advisory, under the team's existing cap on machines. With three or more threads working, the draft recommends **New machine**.                                                                                                                                                                |
| A branch on a new machine                 | It starts with its source's audience: the task's people, or the source machine's access list. After that it is the brancher's own machine, and its owner manages sharing as usual.                                                                                                            |
| Who sees a branch in the chip             | Only people who can open it. The chip's count and popover list only threads the viewer can open.                                                                                                                                                                                              |
| The brancher loses the source             | Update stops, open offers are withdrawn, and the branch stays theirs. Its chip reads "from a thread you can't open".                                                                                                                                                                          |
| The source is archived                    | Open offers wait until it's unarchived, and the sender sees "Waiting · Prompt builder is archived". Branches carry on, and Update uses its last checkpoint.                                                                                                                                   |
| The source is deleted                     | Open offers are withdrawn. Branches carry on, and their chip reads "from a deleted thread".                                                                                                                                                                                                   |

A thread can always choose **Move to my own machine** from ⋯. It continues on a new machine from its
latest checkpoint, keeps its conversation and lineage, and frees the old worktree.

### Who can do what

| Action                 | Thread owner        | Anyone who can open it | Notes                                      |
| ---------------------- | ------------------- | ---------------------- | ------------------------------------------ |
| Branch off             | Yes                 | Yes                    | Brancher's account; not on a branch in v1  |
| Update from the source | In their own branch | In their own branch    | Nobody else is asked                       |
| Offer to the source    | From their branch   | From their branch      | Refused if it wouldn't apply cleanly       |
| Apply or Decline       | Yes                 | No                     | No admin override, as with queued messages |
| Withdraw an offer      | The sender          | The sender             | Until applied                              |
| Revert applied changes | Yes                 | No                     | One recorded step; later turns stay        |
| Fork                   | Yes                 | No                     | Unchanged for your own threads             |
| Side chat              | Yes                 | Read-only              |                                            |

### Notifications

The rule from [decisions](./decisions.md#presence-and-notifications) still applies: notify only the
people a thread concerns.

- An offer notifies the source's owner.
- Apply and Decline notify the sender.
- A conflict at apply time notifies the sender.
- Discarding a machine notifies the owners of the other threads on it, by the same routing as
  "Machine failed".
- Branching off notifies nobody. The owner sees it in the lineage chip.

### Agents

- Branch off, Update and Offer are service methods with MCP tools.
  - `t3_thread_branch_off`.
  - `t3_thread_update_from_source` returns the preflight and takes `onConflict: "resolve" | "abort"`.
    It can also abort an open update, so no caller is left with a merge it can't close.
  - `t3_thread_offer_changes`, which can also withdraw.
- Apply and Decline are a person's and have no tool.
- **Bring them back** is a link on its row only. When asked, an agent can cherry-pick the commits
  itself.
- An agent or API token branches off only onto a new machine, unless the machine is its own
  member's, so nobody's machine time is spent unattended.
- A branch from a thread you can open but whose space you're not in doesn't join the task.

### Performance

Ahead, behind and "moved on" are computed when a checkpoint commits, and are sent with the thread
shell. Nothing polls, and nothing wakes a sleeping machine to compute them. Archived branches leave
the mirror with their thread's retention.

### Empty and unavailable states

- **Inbox:** "Nothing needs you." **My tasks:** "No open tasks. Tasks you own in any space show up
  here." **Shared with you:** "Nothing is shared with you by name. Your spaces' threads are in each
  space."
- **Their machine is asleep:** the option reads "Kousik's machine · asleep, wakes when you start".
- **Their machine failed or was discarded:** only **New machine** is offered.
- **No account:** the draft shows **Connect Claude**, and **Branch off** is disabled until you do.
- **No GitHub:** Branch off, Update and Offer still work. Pushing and pull requests say "Connect your
  GitHub".
- **Local threads, team servers and solo servers:** Branch off isn't shown in v1.

### The way back

- Branch off: archive the branch. Its worktree goes, and its branch stays in the mirror for the
  thread's retention.
- Offer: Withdraw. A declined offer can be offered again.
- Apply: Revert Hanad's changes.
- Update: Abort update while a conflict is open. Undo update until your next turn. After that, Revert
  to a turn in your own branch.
- Shipped: Start from main with them, or Settle.
- Their machine: Move to my own machine.

## Changes to decisions.md

- **Non-goals:** add "Inbox is attention, not activity. It lists what waits on you and clears itself."
- **Threads:** add "Branch off gives anyone who can open a cloud thread their own branch and worktree.
  Code moves back only through an offer that the owner applies, between turns."
- **Threads, revert:** extend "Revert confirms only when it discards someone else's turns" with "or
  someone else's applied changes".
- **Git and GitHub:** add "Applied changes credit their author with `Co-authored-by`. A branch holds
  its source's work in commits authored as the source's owner, and pushing a branch warns that it
  includes them."
- **Provider accounts:** amend "A machine never receives another member's credential" to "except a
  branch its owner started there, after the draft says who can reach it". The account still serves
  only its owner's threads, as licensed per person. Sharing a machine exposes it, and the draft says
  so.

## Contracts

These are the new schemas and RPCs in `packages/contracts`, and the actions that need guards in
`CLIENT_GUARDED_RPC_SCOPES`. Each one needs a permission test.

- **Inbox.** A per-member projection: a count and a paged list of items with a reason.
- **Lineage on the thread shell.** The source thread, ahead and behind, `updateInProgress` with
  conflicted paths, and shipped or settled state.
- **Offers.** A record with its state (open, applied, declined, withdrawn, returned), its commits and
  its diff summary.
- **Who can call what.**

  | Action                                                                         | Guard                                 |
  | ------------------------------------------------------------------------------ | ------------------------------------- |
  | `thread.branchOff`                                                             | Can open the source                   |
  | `thread.update`, `thread.abortUpdate`, `thread.undoUpdate`, `thread.bringBack` | The branch's owner                    |
  | `offer.create`, `offer.withdraw`                                               | The branch's owner                    |
  | `offer.apply`, `offer.decline`, `thread.revertOffer`                           | The source's owner. No admin override |
  | `thread.moveToOwnMachine`                                                      | The thread's owner                    |

- **The draft.** Runs on (source machine or new), Start from (a thread's latest checkpoint, a turn, or
  a branch), and a context summary flag.

## Docs to change when this lands

- [11 Private cloud threads](./cloud/11-private-threads.md) §2:
  - People a thread is shared with can no longer Fork it.
  - Their Side chat is read-only.
  - The Team shelf becomes Shared with you.
- [Team](../user/team.md): "Your threads and the Team shelf", "Spaces" (Assigned to me becomes My
  tasks and Inbox), and Follow's automatic end.
- [Working with threads](../user/thread-sidebar.md): the sidebar's new top rows.

## Rejected

- **A space rail on the left, as in Slack or Discord.** It adds permanent chrome and a second
  navigation model, and it breaks "Solo stays T3 Code".
- **A contextual sidebar that turns into the space's task tree.** It hides your own threads while
  you're in a space. The room's Overview panel already lists the tasks.
- **Grouping Team by person in the sidebar.** Ten people would add ten rows. Grouping belongs on a page.
- **A machine strip of tabs under the header.** It is a third header row on the busiest screen, and
  it groups by machine rather than lineage. Branches on a new machine fall out of it, and unrelated
  threads fall in.
- **Making Fork use a new worktree.** It would change Fork for everyone, local threads included.
- **Merging into the owner's worktree without asking.** It breaks "never hijack a teammate's turn".
- **Pull requests into the owner's branch.** They're too slow for a loop measured in minutes on one
  machine. The source's PR stays the path to `main`.
- **Committing applied changes on the owner's branch.** It keeps every line's author in `git blame`,
  but it needs a work-in-progress commit of the owner's own work before every Apply, and history
  surgery whenever a revert crosses one. Pair already credits teammates' work inside a thread to its
  owner, so `Co-authored-by` matches the existing rule.
- **Live co-driving of one chat.** Anyone can already prompt a shared thread, and it queues. Branch off
  is the parallel path. A time-boxed "join" mode, like Amp's multiplayer, isn't needed for this
  feedback.

## Settled for v1

- Only the source's owner applies.
- Machine load is advisory, under the team's existing cap.
- For you has no separate count.

## Follow-ups

- **A unix user per member on a shared machine,** so one agent can't read another member's token from
  its environment by accident. It needs:
  - a machine group;
  - `core.sharedRepository=group` and `safe.directory` entries;
  - group-writable dependency caches, so "seconds" still holds.

  v1 relies on the draft's disclosure.
