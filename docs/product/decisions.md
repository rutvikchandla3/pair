# Product decisions

The rules Pair's team features follow, and why. Read this before changing a team feature, so new
work doesn't quietly undo a decision. [Pair features](./pair-features.md) lists what shipped; this
page says how it must behave. The decisions came from a product design review during Slices 1–9
(2026-11).

## Principles

- **Solo stays T3 Code.** A server with one member and no compute driver looks and behaves exactly
  like T3 Code, down to the wire. Team behavior turns on only with a second active member. Cloud is
  not a team feature: only a cloud-only server, a team's Pair Cloud, offers it, solo or not. A
  desktop or other server never does. Contract changes are additive, and the server fills in "my"
  fields for whoever is looking, so older clients keep working.
- **Membership is the trust boundary.** A member who can run agents or terminals can read everything
  the machine running them can read. On a server with local threads that is the server's user,
  every file, credentials and the database included. On Pair Cloud it is the thread's machine, with
  the thread's provider credential and git credential, and whoever can open a thread can prompt it.
  Membership decides who may use the server and its accounts, not who can read a cloud thread: a
  cloud thread is private to its owner until they share it. Roles prevent accidents, not malice. The
  invite dialog says so: "Invite only people you'd give SSH access to.", or on Pair Cloud "Members
  can start cloud threads on this server's machines and provider accounts. They see a teammate's
  thread only when it is shared with them."
- **Quiet UI.** Team features add little: static avatars, one-line timeline rows, no animation and
  no activity feed. Presence sends nothing while you're alone.

## Members and roles

- Members are local to the server and join by invite link. Sign-in links and **Add a device**
  recover access, and `t3 member` on the host is the root of trust.
- Two roles. Only admins change settings, providers, members, access and T3 Connect, remove
  projects, and delete other people's threads. There is no Viewer role, because reading the
  filesystem reads credentials, and no per-project permissions.
- Everyone sees every project. On a team server, everyone sees every local thread too: private
  local threads would be theater on a shared shell. A cloud thread on Pair Cloud is the exception.
  It is private to its owner, shared with named members or with everyone on the team, and no role
  reads it without being added, admins included
  ([private threads](./cloud/11-private-threads.md)).
- A GitHub identity maps to a member only by proof: the device flow from a signed-in session, or a
  username an admin set that binds on first sign-in. No open sign-up.
- Removing a member revokes their sessions, push devices and GitHub token. Their threads stay,
  shown as "Former member" until reassigned, except cloud threads on Pair Cloud: removing a member
  who owns any asks an admin to give them to a member or delete them and their machines, without
  letting the admin open them. Their provider accounts are signed out and wiped but
  kept, disabled, as the record of whose account old threads used.

## Threads

- **One owner.** The creator owns a thread until **Assign to…** hands it over, and the previous
  owner keeps following it. Only the owner or an admin deletes it. On a cloud thread, only the owner
  assigns it, or an admin once the owner has left the team.
- **Anyone who can open a thread can prompt it.** No locks, no "driver".
- **Never hijack a teammate's turn.** Sending on someone else's running turn queues the message and
  leaves their approvals alone. **Steer now** is the deliberate way to interrupt; it also declines
  their pending approvals. On mobile it is a long-press on Send.
- **Queued messages belong to their author.** Only the author edits the text. The author or the
  owner can send it now, remove it or reorder it. Admins get no override; they can Assign or Stop.
- **Any member answers an approval.** The first answer wins, and the card says whose turn it is and
  who answered.
- **The agent learns who is speaking only when it's ambiguous.** Once a thread has two human
  authors, each message reaches the provider as `Message from <name>:`. The prefix never shows in
  the UI and history is never rewritten. Messages sent by API tokens or outside agents aren't a
  person's words, so they get no name.
- **Personal state:** pins, order, unread, snooze, follow, notification settings and drafts.
  **Shared state:** archive, settle, title, tags and linked pull requests.
- Revert confirms only when it discards someone else's turns. Undo covers only your own action.
- New threads on a team server start in a worktree, so people don't overwrite each other.
- Timeline rows for renames, archive, settle, permission and model changes, assignments and pull
  requests appear in team mode only, with no backfill. Plan-mode toggles get no row.

## Presence and notifications

- Presence lives in server memory only: Online or Away (no input for 10 minutes), viewing and
  typing. You never see yourself, Settings open over a thread isn't viewing it, and Away viewers
  stay in the stack, hollow. A backgrounded phone is Away and viewing nothing. No cursors or live
  drafts, ever.
- Notifications go only to the people a thread concerns: the member who prompted the turn and the
  owner, the owner when someone else messages or archives their thread, and you when a thread is
  assigned to you. Never for your own action, and never on a device that is showing the thread.
  Following gives unread state, not pings.
- **Machine failed** (a cloud thread's machine fails to start or wake) is routed like a failed
  turn: the prompter and the owner. Machines starting, sleeping, waking or waiting at a cap notify
  nobody; the status line says it.
- **Mobile push** goes through Expo to Pair's app build. T3 Connect push stays off on a team
  server because it can't route per member, and on a cloud-only server, which pushes from its first
  member. A member viewing a thread anywhere gets no push for it. A push carries the thread's title
  and never message or agent text. A device belongs to the auth session that registered it and goes
  away with that session.

## Provider accounts

- A turn always runs on the thread's provider instance, whoever prompts it. Never switch accounts
  per prompter, and never silently.
- Only its owner can pick a member's own account, admins included, and the server enforces it. An
  admin can't move an active member's account to someone else. Nobody else can sign it out.
  Assigning a thread doesn't move it off the old owner's account.
- Members manage their own accounts on the web. Mobile only respects ownership.
- Pair doesn't pool or rotate teammates' personal subscriptions: they are licensed per person.
  Point people at their own accounts, or API keys behind a proxy.
- Members add their provider accounts and connect GitHub on Pair Cloud, separately from their Mac.
  The Mac's own logins can't serve a cloud machine.
- **In cloud,** a thread's machine gets only its own thread's account credential, in memory, from
  an allowlisted environment when the provider process starts, never another member's. Pair writes
  no credential to a machine's disk or image. Claude works there with a setup token or an API key,
  Codex with a managed ChatGPT account or an API key; an account with neither is "Local only", and
  other providers are not supported in cloud.
- Usage shows every member's turns and tokens for the last 7 days, in team mode only, without
  dollars. The point is noticing whose account carries the team.

## Git and GitHub

- Commits from the UI are authored by whoever clicked. Agent sessions author as the thread's owner
  from their next launch. The server stays the committer, and terminals carry no author.
- Pull requests open as the connected member. Otherwise they open with the server's token and
  `Requested by <name> via Pair`, and the toast says why.
- In local threads, agents' `gh` never gets the owner's GitHub token: anyone can prompt the thread.
  Merging, reviewing and closing as the person aren't built yet; each needs an honest fallback
  first.
- **In cloud,** git and `gh` get a credential for the thread's own repository (or its fork) only:
  an installation token from the team's GitHub App when an admin added its key, which stays the
  recommended setup; else the owner's own GitHub, connected or pasted with **Use a token instead**,
  so pushes go out as the owner whoever prompts, and Settings says the agent can read it; else
  nothing, and the thread says "Connect GitHub to push".
- Each team registers its own GitHub App. Pair never points at upstream's "T3 Code for GitHub" app.

## API tokens

- A token is an outside client on `/mcp` only, never the internal `/api` or `/ws`, so it can't mint
  tokens or manage access.
- Members create their own in **Settings → Sharing & access → Authorized clients**, and nowhere
  else. They expire after 30, 90 or 365 days (default 90), Read only comes first, and the default
  mode is Supervised; unattended runs need Auto. Admins can't mint tokens for others, only revoke.
- With `T3CODE_TOKEN` set, a local `t3 thread` acts as that token's member.

## Identifiers and builds

- Install identifiers stay T3 Code's: `@t3tools/*`, `t3`, `T3CODE_*`, `~/.t3`, app.t3.codes and
  T3 Connect. T3's bundle ids, Apple team and EAS project stay the defaults, for T3's own builds.
- Pair ships one mobile app under its own store ids, Apple team and EAS project (the
  `pair-production` EAS profile), and any Pair server can push to it. No team builds its own;
  a fork can still set the overrides in [Team push notifications](../operations/team-push.md).
- Pair's app isn't listed on app.t3.codes, so copied thread and pairing links open in the browser
  until Pair has its own domain.

## Non-goals

- Private local threads, per-project permissions, a Viewer role, several teams on one server.
- An activity feed, side chat, and @mentions for now.
- Thread locks, shared composers, live cursors.
- Switching accounts per prompter, and account pools.
- Avatar uploads, SSO and billing.

## Open follow-ups

- **Release gate.** Nobody gets the Pair mobile build until a device pass on at least one iPhone
  and one Android phone. The checklists are in
  [#38](https://github.com/rutvikchandla3/t3code/pull/38)–[#41](https://github.com/rutvikchandla3/t3code/pull/41).
- **Needs real credentials:** members' own Claude and ChatGPT sign-in and turns, and a GitHub App
  with a test org.
- **Not exercised end to end:** Tailscale sharing and guest links on a team server.
- **Known bugs:**
  - Removing a member whose turn waits for an answer leaves it running until someone presses Stop.
  - A queued message held on a disabled account stays queued there when the thread switches.
  - On a thread whose account is disabled, the composer sends on another one without saying so.
    This comes from upstream.
- **Push limits:**
  - A phone connected through the relay gets no push in the background after its hourly session
    renewal, until it is opened.
  - An Assign in the event that first makes a server a team can be missed.
  - A connection opened before the second member joined sees push support only after reconnecting.
- **From [market signals](./market-signals.md):** a keyboard shortcut for the Git actions, sidebar
  groups you define, and a Pair-branded Mac build.
