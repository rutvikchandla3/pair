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

## Who did what

Messages from other people show their name. Resolved requests say **Approved by**, **Declined
by**, or **Answered by**, and stops and reverts say who did them.

Once two or more people have prompted the same thread, the agent sees each new message as
`Message from <name>:` so it knows who is asking. Threads only one person has prompted are sent
to the agent unchanged.

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
message to a snoozed thread wakes it only for you.

## New threads use a worktree

On a server with more than one member, new threads start in **New worktree** unless you or the
project chose a workspace mode, so people don't overwrite each other's changes in the main
checkout. Settings show this as **New worktree (team default)**.
