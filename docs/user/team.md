# Team

Several people can share one Pair server, for example one running on a team VM. Everyone
signs in as a member, works in the same projects and threads, and sees who did what. A server
with one member looks and behaves exactly as it did before.

## Invite people

Open **Settings → Team** and choose **Invite member**. Send the link to the person you are
inviting. It works once and signs them in as that member. Members can run commands as the
server's user, so invite only people you would give SSH access to.

- **Admins** can do everything, including settings, providers, access and inviting people.
- **Members** can do everything else: start and prompt threads, approve requests, use
  terminals and source control.

To use Pair on another device, choose **Add a device** on your own row. An admin can create a
**Sign-in link** for any member. Removing a member signs out all of their devices at once; their
threads stay and can be assigned to someone else. The same actions are available from the
command line: see [Team members from the command line](./remote-access.md#team-members-from-the-command-line).
For scripts, CI and outside agents, create an [API token](./outside-agents.md#api-tokens) instead.

## Your own provider account

Bring your own Claude or ChatGPT subscription so your threads run on it instead of the team's.
Open **Settings → Team** and choose **Add account** under **Your provider accounts**, or run
**Add your provider account** from the command palette.

- **Claude:** paste an API key or a token from `claude setup-token`, or leave it empty and run the
  command Pair shows in a terminal. It signs Claude in to that account's own folder on the server.
- **ChatGPT:** sign in on OpenAI after adding the account. This needs Codex installed in Pair, so
  if Pair asks you to, ask an admin to set up ChatGPT accounts in **Settings → Providers**.

Only you can pick your account for a thread, and new threads you start use it when it matches the
provider they would have used. Anyone who prompts a thread that runs on your account uses it, and
teammates see your avatar on it in the model picker.

Settings → Team shows each member's turns and tokens for the last 7 days, counted against whoever
sent each prompt.

Your sign-in is saved on this server. Anyone who can run commands here, including agents, can read
it. Only you can pick this account for a thread, but anyone who prompts that thread uses it.

**Remove** signs the account out and deletes its saved login; threads that used it need another
provider. When an admin removes you from the team, your accounts are signed out and turned off the
same way. An admin can also give an instance to a member with the **Owner** setting in
**Settings → Providers**.

## Who did what

Messages from other people show their name. Resolved requests say **Approved by**, **Declined
by**, or **Answered by**, and stops and reverts say who did them.

The thread also gets a quiet line when someone renames, archives, settles, or reassigns it, changes
its permissions, switches its model, or links or opens a pull request from it. These lines start
when your server has a second member; earlier changes are not filled in.

Once two or more people have prompted the same thread, the agent sees each new message as
`Message from <name>:` so it knows who is asking. Threads only one person has prompted are sent
to the agent unchanged.

## Prompting someone else's turn

While another person's turn is running, your message waits in the queue instead of changing their
turn. Choose **Steer now** (Cmd/Ctrl-click Send) to send it into their turn anyway. A queued
message can be sent now, reordered, or removed by the person who wrote it or by the thread's owner;
only its author can edit the text.

## Commits and pull requests

Commits you make with the commit and pull request buttons are authored with your git email and
git name, falling back to your member name. Set them under **Edit profile** in **Settings →
Team**; an admin can set your email when inviting you, and clearing it makes your commits use the
server's git identity again. The committer is always the server's own git identity, so the server
still needs `user.name` and `user.email` configured.

Agents commit as the thread's owner, from the next session after Assign. Cursor and OpenCode (v2 or
an external server) commit as the server.

In a team, pull requests Pair opens with the server's GitHub account end with
`Requested by <name> via Pair`.

## GitHub

Each member can connect their own GitHub account on their row in **Settings → Team**. This needs a
GitHub App that your team owns. Until the server has one, admins see **Set up GitHub** at the top
of **Settings → Team**.

### Set up the GitHub App

1. On GitHub, open your organization's **Settings → Developer settings → GitHub Apps → New GitHub
   App**.
2. Tick **Enable Device Flow** and leave the callback URL empty. Under **Webhook**, untick
   **Active**.
3. Under **Repository permissions**, set **Contents** to read and write, **Pull requests** to read
   and write, and **Metadata** to read-only.
4. Create the app and copy its **Client ID**. It is public: there is no secret to store.
5. Choose **Install App** and install it on your organization. If you are not an owner of the
   organization, GitHub sends a request that an organization owner must approve.

Then give the client ID to the server as `T3CODE_GITHUB_APP_CLIENT_ID` and restart it:

- For the background service, add `T3CODE_GITHUB_APP_CLIENT_ID=<client id>` to
  [`service.env`](./background-service.md#configure-the-service-environment), then run
  `t3 service restart`.
- For `t3 serve` or the desktop app, set the variable in the shell environment that starts Pair,
  then start it again.

### Connect your account

On your own row, choose **Connect GitHub**, copy the code, and approve it on GitHub. The row then
shows **Connected as @you**. Each GitHub account can be connected to one member.

PRs you create from Pair open as you. If GitHub refuses, they open with the server's account and
say who requested them.

Your GitHub connection is stored on this server. Anyone who can run commands here, including
agents, could use it to act as you on GitHub.

**Disconnect** deletes the connection from the server. GitHub keeps the app authorized until you
revoke it at [github.com/settings/apps/authorizations](https://github.com/settings/apps/authorizations).
If GitHub stops accepting the connection, for example after you revoke the app there, your row
shows **Reconnect**.

An admin can set a member's GitHub username under **Edit**. A new username or an empty one
disconnects that member's account.

### Sign in with GitHub

Once the GitHub App is set up and someone on the team has added GitHub, the sign-in page offers
**Sign in with GitHub**. Choose it on a new device, copy the code, and approve it on GitHub. You
are signed in as your own member, and your GitHub connection is renewed.

To let someone join this way, add their **GitHub username** when you invite them. They can then
use the invite link or sign in with GitHub. A GitHub account that is not on the team cannot sign
in.

Only enter a code on GitHub that you started yourself on Pair's sign-in page. Someone who sends
you a code is asking you to sign them in as you.

## Your threads and the Team shelf

Every thread has an owner: the person who created it. Side chats and subagent threads belong to
the owner of the thread they came from.

- Your sidebar shows the threads you own. Other people's active threads are in the collapsed
  **Team** shelf, newest activity first, with the owner's avatar on each row.
- Pin someone else's thread to keep it in your own **Pinned** list.
- **Settled** lists only your own threads.
- To hand a thread over, choose **Assign to…** from the thread's menu or the command palette. You
  can also bind a shortcut to it in [Keybindings](./keybindings.md).
- Only a thread's owner or an admin can delete it.

## Follow threads and notifications

**Follow** a teammate's thread to keep it in your own sections and count its unread state; choose
it from the thread's menu, the command palette, or the eye button in the thread header.
**Unfollow** sends it back to the Team shelf. You follow a thread automatically when you own it,
send it a message, or answer one of its requests.

Notifications go only to the people a thread concerns:

- A finished or failed turn, or a request for approval or input, notifies the member who started
  that turn and the thread's owner.
- The owner hears when someone else messages, archives or sends a guest request to their thread,
  and you hear when a thread is assigned to you.
- Following a thread marks it unread for you, without notifications.

You are never notified about your own actions, or about a thread you're looking at.

On a team server, push notifications come from Pair, not T3 Connect, and need your team's own mobile build. Until that's set up, open the app to see new activity.

## Share a thread

On a team server, **Copy thread** copies a link to the thread on your own server. A teammate who
opens it while signed out is asked to sign in, and lands on the thread afterwards.

## See who's around

Avatars show who else has a thread open: in the thread header, and on the thread's row in the
sidebar. A **Bob is typing** line appears above the composer while someone types in that thread.
You never see yourself, and a hidden tab or Settings open over a thread doesn't count as viewing
it.

Someone with no input for 10 minutes is **Away**: their avatar is hollow, and **Settings → Team**
says **Away** instead of **Online**. Members who aren't connected show no status. Presence from
the mobile app isn't shown yet.

## What is yours and what is shared

Pins and their order, the order of your active threads, unread state, and snoozes are yours.
Nobody else sees them change.

Everything else is shared. Settling a thread settles it for everyone and removes everyone's pin
and snooze. A thread that anyone has pinned or snoozed doesn't settle automatically. Sending a
message to a snoozed thread wakes it only for you. Anyone can choose **Edit from here**, and it
warns first when that would discard someone else's turns.

## New threads use a worktree

On a server with more than one member, new threads start in **New worktree** unless you or the
project chose a workspace mode, so people don't overwrite each other's changes in the main
checkout. Settings show this as **New worktree (team default)**.
