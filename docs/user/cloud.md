# Cloud threads

A cloud thread runs its agent, terminals and setup script on its own machine instead of in the
server's checkout. Many agents can work at once without sharing files or ports, and the
transcript, diffs and approvals stay on your Pair server like any other thread.

Cloud turns keep running while your laptop is closed, because Cloud runs only on a server started
with `--cloud-only`, your team's Pair Cloud, on an always-on machine. To set one up, see
[Install Pair Cloud](./pair-cloud.md). The desktop app's own server never offers Cloud.

Cloud works on servers with one member too. On Pair Cloud every new thread is a cloud thread.

On any other server, Cloud leaves the composer, the command palette and the settings. Cloud
threads made earlier keep their machines: they sleep, wake from their kept disk and can be
discarded, but a discarded machine is not replaced. **Settings → Cloud** stays while drivers
remain, so an admin can remove them.

## Turn on Cloud

Cloud machines are Docker containers. Once [Pair Cloud is installed](./pair-cloud.md), admins set
them up in its **Settings → Cloud**:

1. Choose **Add driver**, then **Docker**.
2. Leave **Docker host** empty to use Docker on the server's own machine (or the server's
   `DOCKER_HOST`). For another Docker host, enter its `tcp://` address or a `unix://` socket;
   `ssh://` is not supported, so forward the socket instead. A remote host also needs a
   **Runner URL**: an address of this Pair server that its machines can reach, unless the server
   has a [runner listener](./pair-cloud.md#keep-machines-off-the-member-listener).
3. Pick a **Machine size** and save.
4. Choose **Test**. It starts a machine, checks that it connects back, runs git, checks that
   `sudo` works and reaches github.com, removes it, and shows how long each step took.

Plain Docker is not a security boundary: an agent in a machine can reach the host's Docker network
and kernel. Use rootless Docker or gVisor. The driver's row shows which one is in use, and the
page warns while any driver runs on plain Docker.

Machines start from Pair's published base image for your server version, which the server
downloads by itself. To use a registry mirror or your own build, enter its name under
**Base image**. The page also shows the limits: how many machines may run at once and how many may
start each minute. A driver runs a quarter of its Docker host's CPUs at once unless you set
**Machines at once** in its form; a change applies to the next start without restarting anything.
A machine started past a limit waits for a free slot. Lowering the limit stops nothing that already
runs.

**Environment variables** in **Settings → Cloud** are set in every machine's terminals, scripts and
agents. Projects can add their own.

A Pair Cloud server that runs in your own Google Cloud project can use that project's Compute
Engine VMs as machines instead: choose **Add driver**, then **Google Cloud**.

With more than one driver, new machines start on the first one until you choose another:
press **Use for new machines** on its row. Machines already running stay where they are.

Removing a driver stops the cloud threads on its machines.

## Choose which projects use Cloud

Once a driver is saved, every project allows cloud threads. To change that, open
**Settings → Projects**, choose the project, and look under **New threads**:

- **Allow cloud threads** off stops new cloud threads in that project. Cloud threads it already
  has keep running.
- **Project cloud variables** are set on that project's machines, over the team's variables.

The machine clones the project's `origin` remote, so a project needs one.

## Start a cloud thread

A new thread on Pair Cloud starts in **Cloud**, the only choice in the composer's workspace menu.
Pick a base branch that exists on `origin`: Pair refuses a branch you have not pushed yet.

From a project on your own machine, connect your app to Pair Cloud too and pick **Cloud** in the
workspace menu. The thread starts on Pair Cloud, in the project with the same `origin` on
github.com, from the branch you picked; with several Pair Clouds connected, the menu shows
**Cloud on** each one. When Pair Cloud doesn't have the project yet, the menu offers
**Add to Pair Cloud** instead. Push the branch first: Pair says "Push <branch> first." until
`origin` has it, and warns that commits you haven't pushed won't be included. To take unpushed
work along, start the thread on your Mac and
[continue it in cloud](#move-a-thread-between-your-mac-and-pair-cloud).

When the machine starts from a [team image](./pair-cloud.md#build-a-team-image) that doesn't
include the thread's project, the thread says "Not in the team image" and clones the project as
usual.

You can also run **New cloud thread** from the command palette. It has no default shortcut; bind
`chat.newCloud` in [Keybindings](./keybindings.md). **New thread on branch** from a cloud thread
opens another cloud thread.

On a phone, new threads on Pair Cloud start in Cloud too, and the new thread screen offers Cloud
for a project on your Mac the same way.

Scripts and agents start cloud threads too: see `--cloud` in
[Scripts and CI](./outside-agents.md#scripts-and-ci) and
[Agents working with agents](./outside-agents.md#agents-working-with-agents).

Side chats and forks of a cloud thread run on the same machine, so
[sharing the thread](#who-can-open-a-cloud-thread) shares them too. A fork of a teammate's cloud
thread says so, because its agent can read that teammate's credentials there.

On a Cloud server, scheduled and webhook tasks that start a new thread run in Cloud too, from the
task's base branch on `origin`. Turn on **Discard the machine when the run settles** in the task to
give each run a machine that is deleted once the run settles; the transcript and diffs stay. A run
that cannot get a machine fails with the reason in the task list, and never runs on the server.

A run is private to the member who created the task. Choose who else can open its runs under
**Share runs with** in the task editor, on the web; the phone's editor has no such control yet. Tasks
that existed before sharing are shared with everyone on the team. Everyone can still see the task
and that it ran.

## Move a thread between your Mac and Pair Cloud

A thread lives on one server. To change which, you continue it on the other: Pair starts a new
thread there with the work and the conversation, and leaves the original where it is. Your Mac
always starts the move, in both directions; Pair Cloud never reaches into it.

### Continue in cloud

On a thread on your Mac, choose **Continue in cloud…** in the thread's menu or the command palette.
Pair shows what goes: the branch's commits since its base branch, and the files you changed or
added that Git doesn't ignore. Uncheck a file to leave it out; it goes as last committed, or not at
all if it's new. Write the first message for the cloud thread, and confirm.

The thread continues on Pair Cloud in the project with the same `origin`, as a new thread you own,
with the conversation so far as read-only history ([handoffs](./portable-handoffs.md)). It starts
with at most the access you gave your Mac's link. It uses the same model when one of your accounts
on Pair Cloud, or the team's, can run it (yours first), and that account's default model otherwise.
Your Mac's thread says **Continued in cloud** and links to the new one;
its worktree and branch stay as they were. Nothing is pushed to GitHub, so this works for a branch
you never pushed. If you're on the base branch itself, the cloud thread gets a new branch.

What stays on your Mac:

- Ignored files such as `.env`, `node_modules` and build output. The project's
  [setup script](#setup-scripts-in-cloud) can recreate them.
- Earlier checkpoints: their diffs stay on the Mac's thread.
- Terminals, running processes and previews.
- Approvals and pull request links.
- The provider's own session. The cloud agent starts a new one from the handoff.

An untracked file that isn't ignored, such as a local secrets file, goes along unless you uncheck
it.

It needs:

- The project on Pair Cloud, with its `origin` on github.com. **Add to Pair Cloud** adds it
  otherwise.
- An account on Pair Cloud, with the same notice as for Cloud.
- Your Mac linked to Pair Cloud: see [Pair Cloud from your Mac's
  agents](./outside-agents.md#pair-cloud-from-your-macs-agents). The dialog offers **Link** when it
  isn't.
- No turn running. The menu says so while one is.

The upload is at most 512 MB. When it's over, leave out large untracked files, or push the branch
first.

### Continue locally

In the desktop app, or the web app your own computer's server shows, choose **Continue locally**
in a cloud thread's menu or the command palette.
Pair brings the thread's branch, its uncommitted work and its conversation into a new worktree and
thread in your project with the same `origin`, on your computer's own provider sign-ins.

- When the thread is yours, it moves. The cloud thread says it continued on your computer and
  settles, so its machine can sleep. The new thread keeps the branch's name.
- When it's a teammate's thread shared with you, you get a copy on a new branch ending in `-copy`, and their cloud thread
  keeps going.

An asleep machine isn't woken: Pair uses what it saved when it went to sleep, and asks you to wake
the machine first when it saved nothing. It refuses while a turn is running or waiting for an
answer. The option shows only when your computer has the project and a link to Pair Cloud. The
download is at most 512 MB; fetch `origin` on your computer first when it's over.

## What the status means

The thread header, the sidebar row and the status line above the composer show the machine's
state while it is not simply running:

| Status                      | What happens                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Starting machine**        | The machine boots, then clones the repository and runs the setup script. Messages you send wait for it.     |
| **Waiting for a machine**   | The team is at its machine limit or start rate. The thread starts when a slot frees up.                     |
| **Reconnecting to machine** | The server lost its link to the machine and is getting it back.                                             |
| **Asleep**                  | The machine is stopped with its files kept. Sending a message or choosing **Wake machine** starts it again. |
| **Waking machine**          | The machine is starting again with its files.                                                               |
| **Machine failed**          | The machine could not start or stopped unexpectedly. Choose **Retry** or **Discard**.                       |
| **Machine discarded**       | The machine and its files are gone. Choose **Start a new machine**, or send a message, for a fresh one.     |

A Docker machine goes to sleep once every thread on it is settled or archived and none is running.
It also sleeps after an hour with no running turn, nobody viewing its threads, and no activity in
its terminals, or after 5 minutes of that while another machine waits for a slot. A turn waiting
for your answer keeps its machine awake for 2 hours, then stops. Sending a message, opening a
thread that isn't settled or archived, typing in a terminal, or reverting wakes it.

While it sleeps, its files, search and Changes are read-only and show as of the moment it slept
(or its last turn, when nothing was saved at sleep). Its terminals stop and keep their output;
after a wake, typing in one starts a new shell.

A machine that sleeps for 7 days with every thread archived, or goes 30 days with no activity on any
of its threads, has its disk deleted and shows as **Machine discarded**. Its threads stay readable,
and waking one rebuilds the machine from the server's copy of its work. The agent starts a new
session there with the conversation so far ([handoffs](./portable-handoffs.md)). Admins change both
in **Settings → Cloud → Compute**.

Anyone who can open the thread can wake or retry its machine. Only the thread's owner or an admin can choose **Sleep now** or
**Discard machine**, from the thread's menu (on a phone, the **Machine** menu in the thread
header). Discarding deletes the machine's disk; the transcript and diffs stay. When a machine
fails, the member who started the turn and the thread's owner are
[notified](./team.md#follow-threads-and-notifications).

## Setup scripts in Cloud

The project's setup script (an action set to **Run automatically on worktree creation**) runs on
every new cloud thread, inside its machine. `T3CODE_SANDBOX=1` is set there, and project paths
point into the machine, so a script can tell the two apart.

The base image is Ubuntu with git, Node, the GitHub CLI, Claude and Codex. The agent's user has
passwordless `sudo`, so install anything else in the setup script, for example
`sudo apt-get install -y postgresql-client`.

## Provider accounts

Cloud threads use accounts added on Pair Cloud. Your Mac's own sign-ins stay on your Mac. Add your
own under **Your provider accounts** on your row in Pair Cloud's **Settings → Team** (see
[Your own provider account](./team.md#your-own-provider-account)):

- **Claude** needs a setup token from `claude setup-token` or an API key.
- **Codex** works with a ChatGPT account connected in Pair, or an API key.

Admins can add a team account instead: a Claude instance with `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`, or a Codex instance with `OPENAI_API_KEY`, in its **Environment variables** in
**Settings → Providers**. A login made in a terminal on the server works there only.

When you pick Cloud with no account Pair Cloud can use, the composer says **Add an account on Pair
Cloud**; without a GitHub connection it says **Connect GitHub on Pair Cloud**. **Open Settings**
opens Pair Cloud's **Settings → Team**, and the phone's new thread screen shows the same notice. In
a cloud thread, the model picker marks other accounts **Local only** and says what to
add. Other providers are not supported in Cloud yet.

## Pushing and pull requests

A cloud thread pushes with the team's GitHub App when an admin has added its key, and otherwise
with the thread owner's own GitHub. The same credential lets the machine clone a private
repository. Without either, the thread shows **Connect GitHub to push**. See
[Pushing from cloud threads](./source-control.md#pushing-from-cloud-threads) for the App, and
[Bring your own GitHub token](./team.md#bring-your-own-github-token) for a member's own.

Pair's pull request list and review panel read GitHub with the server's own sign-in in
**Settings → Source Control**. Where the server has no sign-in that can read a repository, they
read it with the team's GitHub App instead, if the App is installed there. The App's token is
read-only and the list's viewer is the App's bot, so the panel offers no write actions and
**Authored** and **Reviewing** come back empty. Sign the server in to GitHub to comment, review or
merge from Pair.

When a machine can't clone a private repository, the thread says "Pair Cloud can't read
<repository>. Connect GitHub to clone private repos, in Settings → Team."

Cloud threads push only to github.com for now.

## Browser

A cloud thread's **Browser** tab runs Chrome on the thread's machine. You and the thread's agent
share its tabs, and anyone who can open the thread sees them, on the web, the desktop app and the
phone. `localhost` in a tab is the machine, so a dev server the agent or your terminal starts
opens as `http://localhost:<port>`, and the tab's list of running servers shows the machine's
ports. **Stop** on a listed server stops it in the machine.

The tab streams from the machine on every device, including the desktop app, which uses its own
built-in browser only for threads on your Mac. Pages on the internet load from the machine's
network, not yours.

- **Opening a tab wakes the machine.** While someone watches a tab, the machine stays awake. When
  it goes to sleep, its tabs close; open a tab again to wake it.
- **One profile per machine.** Cookies and logins stay on the machine between sessions, and side
  chats and forks on the same machine share them. Incognito tabs and the agent's tabs keep their
  own storage. Your named profiles and cookie import stay on your Mac.
- **What doesn't carry over.** Audio doesn't play. You can watch a tab on the phone, but open new tabs from the web or
  desktop app.
- **Older team images.** A machine started from a team image built before the browser came to
  Pair Cloud says "This machine's image has no browser." An admin rebuilds the
  [team image](./pair-cloud.md#build-a-team-image), then start a new session.

## Who can open a cloud thread

A cloud thread is private. Only you can see it, in the sidebar, the **Team** shelf, search and the
archive, until you share it. Someone who opens a link to a thread they cannot open sees "This
thread is private, or it no longer exists." The page does not say which. A thread that existed
before your server offered sharing stays open to everyone on the team until its owner changes that.

Share a thread you own from any of these:

- The **Share** button in the thread header.
- **Share…** in the thread's menu or its sidebar row's menu.
- **Share thread** in the command palette, or a shortcut you bind to **Thread: Share…** in
  [Keybindings](./keybindings.md).

The mobile app has **Share** in the thread's menu too. For anyone but the owner the item reads
**Share… (owner only)** and is disabled.

In the dialog, add people by name or GitHub username. Under **General access**, choose **Only
people added** or **Everyone on** your team, which includes people who join later. Changes apply at
once, and **Remove** takes access away at once. The thread appears on the **Team** shelf of each
person you add, with a **Shared with you** notification. A chip beside the title shows who has
access, and a quiet line in the thread says who shared it with whom.

What people you share with can do:

- Read the thread, prompt it, open its terminal, and fork it, as with any
  [teammate's thread](./team.md#prompting-someone-elses-turn).
- Choose **Continue locally**, which gives them a copy.
- Read the credentials on its machine: its provider sign-in and git token. Share only with people
  you trust with them.

They cannot share the thread with anyone else, and only you can **Assign to…** it to another
member.

Sharing covers the thread's machine, so it covers every side chat and fork on it, which share one
disk and one set of credentials. You cannot share one of them alone.

An agent in a thread can read another cloud thread only when everyone who can open its own thread
can open that one, and agents cannot change who has access. Mentioning a thread in a message sends
the agent its title and id, so the same rule decides whether it can read it.

What private does not cover:

- **GitHub.** A pushed branch, its commits and its pull request are as visible as the repository.
  Private covers the conversation, the terminal, uncommitted work and checkpoints.
- **A shared provider account.** What the provider shows other users of an account, such as usage
  and sometimes session history, is outside Pair. Use your own account to avoid it.
- **Plain Docker.** A machine that escapes its container reaches the server's host and everything
  on it. Settings → Cloud warns when a driver is plain Docker; use rootless Docker or gVisor.
- **The network between machines.** On a flat network, a dev server in one machine can answer
  another. gVisor with Pair's private network block, or VMs behind the kit's firewall, keep
  machines apart.
- **Whoever runs the server.** Someone with a shell on the server's host can read its files. Pair
  keeps members apart in the app, not from the person who operates the server.

An admin cannot open a private thread either, not even in search. **Settings → Cloud** gives admins
an **All machines** list, because machines cost money. A machine the admin cannot open shows
**Private** and its owner's name, with its state, size, driver and age, and no title, branch or link. **Sleep**
and **Discard machine** work on it as usual. Members who are not admins get no list. If an owner
leaves the team, an admin gives their cloud threads to a member or deletes them; see
[Offboard a member](./pair-cloud.md#offboard-a-member).

## What agents in a machine can read

An agent in a cloud thread can read its thread's provider credential, its git credential (your own
GitHub token, when that is what pushes), and the machine's environment variables. Pair writes none
of them to the machine's disk, but anyone who can prompt the thread can ask its agent to print what
it was started with. That is you and the people you share the thread with, so share a cloud thread
only with people you trust with those credentials. Every member can use the server's machines and
provider accounts, so invite only people you trust with them.

## Phone

Install Pair's mobile app and add Pair Cloud to it with a sign-in link. Pair Cloud sends its
notifications to the app itself, without T3 Connect. The app starts cloud threads, shows each
thread's machine status, and offers the same machine actions. **Settings → Machines** shows each
environment's drivers, running and waiting machines, base image and limits. It appears once a connected environment has a driver; change
Cloud's settings on the web or desktop app.

On a thread on your Mac, the **Cloud** menu in the thread header, or the thread's long-press menu,
offers **Continue in cloud…** too, and its preview opens as a sheet. Your Mac does the upload, so
the phone must be connected to both your Mac and Pair Cloud, and the Mac must already be linked.
Continue locally isn't offered on the phone.

## Coming from Conductor Cloud

See [Coming from Conductor Cloud](./pair-cloud.md#coming-from-conductor-cloud) in the install guide.
