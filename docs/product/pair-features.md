# Pair features

What Pair adds to T3 Code so a team of 8–10 can share one server, and where each piece stands.
Every slice's last pull request updates this page when it lands. The rules these features follow are
in [Product decisions](./decisions.md).

**Status:** **On main** means merged and usable. A server with one member behaves exactly like
T3 Code throughout.

## On main

### Team: members, attribution, personal state · [#1](https://github.com/rutvikchandla3/t3code/pull/1)

- **Members and roles.** Admins invite people from **Settings → Team** with a one-time sign-in
  link. Admins manage settings, providers and access. Members start and prompt threads, approve
  requests, and use terminals and source control. `t3 member invite|signin-link|list|remove` does
  the same on a headless server.
- **Devices.** Members add their own devices with **Add a device**. Removing a member signs out
  all of their devices, and their threads stay.
- **Who did what.** Messages show their author. Approvals, answers, stops and reverts say who did
  them.
- **The agent knows who is speaking.** Once two people have prompted a thread, the agent sees
  `Message from <name>:` before each new message.
- **Personal sidebar.** Pins, order, unread state and snoozes are yours alone. Other people's
  threads sit on the **Team** shelf with the owner's avatar.
- **Ownership.** Every thread has an owner. **Assign to…** hands it over, from the thread menu or
  the command palette. Only the owner or an admin can delete it.
- **Worktrees by default.** On a team server, new threads start in a new worktree, so people don't
  overwrite each other's changes.

### Follow, notifications, share links · [#5](https://github.com/rutvikchandla3/t3code/pull/5) [#6](https://github.com/rutvikchandla3/t3code/pull/6) [#7](https://github.com/rutvikchandla3/t3code/pull/7) [#8](https://github.com/rutvikchandla3/t3code/pull/8)

- **Follow** a teammate's thread from the sidebar, thread menu, command palette or header to keep
  it in your own sections and count its unread state. Owning, prompting or answering a thread
  follows it automatically.
- **Notifications go to the people a thread concerns:** the member who prompted the turn and the
  owner, never everyone. You are never notified about your own actions.
- **Copy thread** on a team server copies a link to your own server. A teammate who opens it while
  signed out sees how to sign in and lands on the thread afterwards.

### The Pair name · [#10](https://github.com/rutvikchandla3/t3code/pull/10)

- Pair's name, mark and icons across web, desktop, mobile, the CLI and the user guides.
- Install identifiers, `t3` commands and upstream services are unchanged.

### Git identity · [#12](https://github.com/rutvikchandla3/t3code/pull/12) [#13](https://github.com/rutvikchandla3/t3code/pull/13)

- **Commits from the git button** are authored by the member who clicked, using the git email from
  their invite or **Edit profile**. The server stays the committer.
- **Agents commit as the thread's owner,** from the next session after an Assign. Cursor and
  OpenCode v2 still commit as the server.
- **Pull requests Pair opens** end with `Requested by <name> via Pair`.
- Clearing your git email makes your commits the server's again.

### Presence · [#15](https://github.com/rutvikchandla3/t3code/pull/15) [#16](https://github.com/rutvikchandla3/t3code/pull/16) [#17](https://github.com/rutvikchandla3/t3code/pull/17)

- **Who is here.** The server tracks who is viewing and typing, and sends nothing while you're
  alone. The thread header shows who else is viewing, with away members drawn hollow.
- **"Bob is typing"** above the composer.
- **Viewers in the sidebar** on each thread's row, and **Online** or **Away** in **Settings → Team**.
  Away means no input for 10 minutes.

### Team API · [#19](https://github.com/rutvikchandla3/t3code/pull/19) [#20](https://github.com/rutvikchandla3/t3code/pull/20)

- **API tokens.** Members create their own tokens in **Settings → Sharing & access → Authorized
  clients**, for the MCP endpoint, so scripts, CI and other agents can start, message and read
  threads as them. A token is shown once, expires after 30, 90 or 365 days, and is capped at the
  member's own access.
- Members revoke their own clients and approve an agent's sign-in with one click.
- **`t3 thread` from anywhere** with a token, acting as its member, and one guide to agents and
  automation: [Agents and automation](../user/outside-agents.md).

### Collaborative control · [#23](https://github.com/rutvikchandla3/t3code/pull/23) [#24](https://github.com/rutvikchandla3/t3code/pull/24) [#25](https://github.com/rutvikchandla3/t3code/pull/25) [#26](https://github.com/rutvikchandla3/t3code/pull/26)

- **No hijacking a teammate's turn.** Sending while someone else's turn runs queues your message
  and leaves their approvals alone. **Steer now** redirects on purpose.
- **The timeline records who changed what:** renames, archive, settle, permission changes,
  assignments and pull request links, each naming the member.
- **Queued messages belong to their author** and show who wrote them. Only the author or the
  thread owner can send, remove or reorder one, and only the author can edit its text.
- **Revert warns** when it would discard a teammate's turns: "Discards 2 turns by Alice".

### GitHub sign-in · [#29](https://github.com/rutvikchandla3/t3code/pull/29) [#30](https://github.com/rutvikchandla3/t3code/pull/30) [#31](https://github.com/rutvikchandla3/t3code/pull/31)

- **Connect your GitHub** on your own row in **Settings → Team**, through your team's own GitHub
  App and its device flow. The token stays on the server, and **Disconnect** or removing the member
  deletes it. Admins see one **Set up GitHub** line until the app is configured.
- **Pull requests open as you** when you're connected. If GitHub refuses, Pair opens it with the
  server's account, adds `Requested by <name> via Pair`, and the toast says why.
- **Sign in with GitHub** on the sign-in page replaces the sign-in link for members who connected,
  or whom an admin invited by GitHub username (in the invite dialog or `t3 member invite --github`).
- Without a GitHub App, nothing changes.

### Bring your own subscription · [#33](https://github.com/rutvikchandla3/t3code/pull/33) [#34](https://github.com/rutvikchandla3/t3code/pull/34) [#35](https://github.com/rutvikchandla3/t3code/pull/35) [#36](https://github.com/rutvikchandla3/t3code/pull/36)

- **Your own Claude or ChatGPT account.** Add it under **Your provider accounts** in **Settings →
  Team**, or from the command palette, then sign it in, rename it or remove it. Only you can pick
  it for a thread, and the server enforces that.
- **The model picker** hides teammates' accounts. A thread already on one shows it disabled with
  its owner's name, and anyone prompting that thread uses it.
- **New threads you start** use your own account of the same provider, and never a teammate's.
- **Usage per member.** Settings → Team shows each member's turns and tokens for the last 7 days.
- **Leaving the team** signs a member's accounts out and turns them off. Admins can hand an
  instance to a member with the **Owner** setting in **Settings → Providers**.

### Mobile parity · [#38](https://github.com/rutvikchandla3/t3code/pull/38) [#39](https://github.com/rutvikchandla3/t3code/pull/39) [#40](https://github.com/rutvikchandla3/t3code/pull/40) [#41](https://github.com/rutvikchandla3/t3code/pull/41)

- **The team on your phone.** The iOS and Android apps show authors on messages, each thread's
  owner and the Team shelf, with **Follow** and **Assign to…** in the thread menus.
- **Same rules as the web.** Sending on a teammate's turn queues your message; hold Send for
  **Steer now**. Queued messages show their author, and approvals say who answered them.
- **Presence.** Your phone reports the thread on screen and your typing, and counts as **Away** in
  the background. The thread header shows who else is viewing.
- **Your own accounts.** The model picker leaves out teammates' accounts, and new tasks default to
  your own. You add your account on the web.
- **Push per member.** A team server pushes to the members a thread concerns, through Pair's
  mobile app ([setup](../operations/team-push.md)); a Pair Cloud server does so from its first
  member. A push carries only the thread's title.
  **Settings → Notifications** shows whether each team server notifies the device.
- Checked end to end with mobile's own logic over the WebSocket. The phone screens still need a
  pass on real devices.

### Cloud threads on Docker

- **Off until an admin adds a driver.** **Settings → Cloud** adds a Docker driver on the server's
  machine or another Docker host, tests it end to end, and warns on plain Docker and on a server
  inside the desktop app. Solo servers get Cloud too. Projects can opt out or default to Cloud.
- **A machine per thread.** **Cloud** in the workspace menu, **New cloud thread** in the command
  palette, the phone's new thread screen, `t3 thread start --cloud`, `t3_thread_launch` and
  `delegate_task` start one. Side chats and forks share it. The agent, terminals and setup script
  run there; transcripts, diffs and approvals stay on the server.
- **Lifecycle you can see.** Header, sidebar and status line show Starting, Waiting (team cap and
  start rate), Asleep, Failed and Discarded, with Wake, Retry, Sleep now and Discard. A Docker
  machine sleeps once its threads settle, and diffs stay readable from the server's mirror.
- **Credentials per thread.** Claude runs on a setup token or API key, Codex on a managed ChatGPT
  account or API key; other accounts show "Local only". Pushes use the team's GitHub App, else the
  owner's own GitHub or pasted token, else "Connect GitHub to push". github.com only.
- **"Machine failed"** notifies the prompter and the owner. The phone has a read-only
  **Settings → Machines** page.
- User guide: [Cloud threads](../user/cloud.md).

### Pair Cloud

- **A team's own cloud-only server.** A Linux release with its runner, installed from the release's
  `install.sh`, run as a background service on the team's domain. Only it offers Cloud; local
  servers route a Cloud pick to the matching Pair Cloud project, from a pushed branch, on desktop,
  web and mobile.
- **Projects by repository.** Admins add `owner/name` from github.com; members' GitHub and provider
  accounts live on Pair Cloud.
- **Machines that sleep and come back.** Idle and settled machines sleep after a snapshot, wake on a
  message, a viewer or a terminal key, and stay readable while asleep. Archived and unused disks go
  after 7 and 30 days, and a lost disk rebuilds from the server's mirror.
- **Running it.** Team cap per driver, `t3 drain` before upgrades, restore mode after restoring a
  backup, webhook URLs on the public origin, scheduled and webhook runs in cloud, pushes to Pair's
  one mobile app, and pull request reads through the team's GitHub App.
- Install guide: [Install Pair Cloud](../user/pair-cloud.md).

### Moving sessions

- **Continue in cloud** from a thread on the Mac (menu, command palette, phone): unpushed commits
  and uncommitted files go too, with a preview to leave files out. Nothing is pushed to GitHub.
- **Continue locally** on desktop: the owner moves a cloud thread home; anyone else gets a copy and
  the cloud thread stays live.
- **The agent link**: one member-scoped link from the Mac to Pair Cloud. Local agents launch,
  delegate and move threads there as the member.
- User guide: [Move a thread](../user/cloud.md#move-a-thread-between-your-mac-and-pair-cloud).

### Workspaces

- **One thread, several repositories.** A workspace is a project made of 2 to 8 other git
  projects on the same server. **New workspace** in the command palette, `t3 project add --root`
  and `t3_project_create` with `roots` create one; **Settings → Projects** edits its repositories.
- **A folder per thread.** Each thread gets a worktree of every repository, side by side in one
  folder, on one branch name, each from its own default branch. The agent starts in that folder,
  with an `AGENTS.md` and `CLAUDE.md` that list the repositories.
- **Safe edits.** Threads keep the repositories they started with, and a project a workspace uses
  can't be deleted.
- Not built yet: combined checkpoints and diffs, per-repository git and pull request controls,
  automatic folder cleanup, and Cloud.
- User guide: [Workspaces](../user/workspaces.md).

## Not planned

- **Pooling or rotating teammates' personal subscriptions.** They are licensed per person, and
  sharing them can break the provider's terms.
- **A separate VM per workspace.** See [Market signals](./market-signals.md).
