# Cloud threads

A cloud thread runs its agent, terminals and setup script on its own machine instead of in the
server's checkout. Many agents can work at once without sharing files or ports, and the
transcript, diffs and approvals stay on your Pair server like any other thread.

Cloud turns keep running while your laptop is closed, as long as the Pair server itself is always
on. A server running inside the desktop app stops cloud turns when that computer sleeps or shuts
down, and **Settings → Cloud** says so. Put Cloud on an always-on team server, such as one running
as a [background service](./background-service.md).

Cloud works on servers with one member too. Nothing changes for anyone until an admin adds a
driver.

## Turn on Cloud

Cloud machines are Docker containers. Admins set them up in **Settings → Cloud**:

1. Choose **Add Docker driver**.
2. Leave **Docker host** empty to use Docker on the server's own machine (or the server's
   `DOCKER_HOST`). For another Docker host, enter its `tcp://` address or a `unix://` socket;
   `ssh://` is not supported, so forward the socket instead. A remote host also needs a
   **Runner URL**: an address of this Pair server that its machines can reach.
3. Pick a **Machine size** and save.
4. Choose **Test**. It starts a machine, checks that it connects back and runs git, removes it, and
   shows how long each step took.

Plain Docker is not a security boundary: an agent in a machine can reach the host's Docker network
and kernel. Use rootless Docker or gVisor. The driver's row shows which one is in use, and the
page warns while any driver runs on plain Docker.

Machines start from Pair's published base image for your server version, which the server
downloads by itself. To use a registry mirror or your own build, enter its name under
**Base image**. The page also shows the limits: how many machines may run at once (a quarter of the
Docker host's CPUs) and how many may start each minute. A machine started past a limit waits for a
free slot.

**Environment variables** in **Settings → Cloud** are set in every machine's terminals, scripts and
agents. Projects can add their own.

Removing a driver stops the cloud threads on its machines.

## Choose which projects use Cloud

Once a driver is saved, every project allows cloud threads. To change that, open
**Settings → Projects**, choose the project, and look under **New threads**:

- **Allow cloud threads** off keeps new threads in that project on this server. Cloud threads it
  already has keep running.
- **Workspace** set to **Cloud** makes new threads in that project start in Cloud.
- **Project cloud variables** are set on that project's machines, over the team's variables.

The machine clones the project's `origin` remote, so a project needs one.

## Start a cloud thread

In a new thread, choose **Cloud** in the composer's workspace menu, then a base branch that exists
on `origin`: Pair refuses a branch you have not pushed yet. You choose Cloud when a thread starts;
an existing thread stays where it is.

You can also run **New cloud thread** from the command palette. It has no default shortcut; bind
`chat.newCloud` in [Keybindings](./keybindings.md). **New thread on branch** from a cloud thread
opens another cloud thread.

On a phone, choose **Cloud** in the new thread screen's workspace menu. It appears once the
environment has a driver.

Scripts and agents start cloud threads too: see `--cloud` in
[Scripts and CI](./outside-agents.md#scripts-and-ci) and
[Agents working with agents](./outside-agents.md#agents-working-with-agents).

Side chats and forks of a cloud thread run on the same machine. A fork of a teammate's cloud thread
says so, because its agent can read that teammate's credentials there.

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
While it sleeps, the thread's files and diffs show as of its last turn; terminals need it awake.

Anyone can wake or retry a machine. Only the thread's owner or an admin can choose **Sleep now** or
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

A cloud thread signs its agent in without any login saved on the server:

- **Claude** needs a setup token from `claude setup-token` or an API key, set as
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the instance's **Environment variables** in
  **Settings → Providers**.
- **Codex** works with a ChatGPT account connected in Pair, or an `OPENAI_API_KEY` in the
  instance's environment variables. A `codex login` made on the server works there only.

In a cloud thread, the model picker marks other accounts **Local only** and says what to add.
Other providers are not supported in Cloud yet. Members can bring their own accounts too: see
[Your own provider account](./team.md#your-own-provider-account).

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

Cloud threads push only to github.com for now.

## What agents in a machine can read

An agent in a cloud thread can read its thread's provider credential, its git credential (your own
GitHub token, when that is what pushes), and the machine's environment variables. Pair writes none
of them to the machine's disk, but anyone who can prompt the thread can ask its agent to print what
it was started with. Membership is still the trust boundary: invite only people you trust with
those credentials.

## Phone

The mobile app starts cloud threads, shows each thread's machine status, and offers the same
machine actions. **Settings → Machines** shows each environment's drivers, running and waiting
machines, base image and limits. It appears once a connected environment has a driver; change
Cloud's settings on the web or desktop app.

## Coming from Conductor Cloud

1. Install Pair as a team server on an always-on machine with Docker, and [invite](./team.md) your
   team.
2. Add a Docker driver as above.
3. Have members [connect GitHub](./team.md#connect-your-account) or paste a token, or add the
   GitHub App key.
4. Paste your Conductor install script into each project's setup script, using `apt-get` where it
   used `dnf`.
5. Add Claude setup tokens or API keys, or Codex accounts, as in [Provider accounts](#provider-accounts).

Conductor transcripts are not imported.
