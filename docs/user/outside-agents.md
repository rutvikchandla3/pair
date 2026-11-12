# Agents and automation

Agents that Pair did not start, and your own scripts, can work with an
environment through its MCP server. They can read projects and threads, start
and message threads, and check which providers and models are available. This
covers Claude Code or Codex in your own terminal, ChatGPT, bots, scripts and CI
jobs. An agent either signs in once, or uses an [API token](#api-tokens) you
create. Either way you choose what it may do, and it acts as you.

## Get the MCP URL

In **Settings → Environments**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a sign-in code from
**Settings → Sharing & access** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment can approve without a code, up to
the access that browser has. Only an admin can approve Full access.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
An agent without OAuth support can connect with an
[API token](#connect-with-a-token) instead.

## API tokens

An API token lets a script, a CI job or an agent act as you without a browser
sign-in. It works only for agents and scripts; it cannot open the app.

Create one in **Settings → Sharing & access → Authorized clients → Create API
token**. Name it, choose its access from the same levels as an agent sign-in,
and choose when it expires: in 30, 90 or 365 days. A token never has more access
than you do, so only an admin can create one with Full access.

The token is shown once. Treat it like a password: anyone who has it can act as
you. Send it only over `https` or to `localhost`, for the same reason as a
sign-in. To replace a token, create a new one and revoke the old one.

## Connect with a token

Any MCP client that can send a header can use a token. Give it the MCP URL and
the header `Authorization: Bearer <token>`. For Claude Code:

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp \
  --header "Authorization: Bearer $T3CODE_TOKEN"
```

Clients that support OAuth can still [sign in](#approve-a-sign-in) instead.

## Scripts and CI

`t3 thread` starts, messages and reads threads from a shell. Point it at an
environment with `T3CODE_URL` (or `--url`) and a token in `T3CODE_TOKEN`:

```sh
export T3CODE_URL=https://<environment-address>
export T3CODE_TOKEN=<token>
id=$(npx t3 thread start <project> "Find why the tests are slow")
npx t3 thread send "$id" "Now fix it" --wait
npx t3 thread show "$id"
npx t3 thread list --project <project>
```

`<project>` is a project id, the project's folder on that machine, or its title.
The token is read only from the environment, so it stays out of your shell
history. For unattended runs, create the token with **Auto** or **Auto-accept
edits**: with Supervised, a run stops at its first approval and `--wait` exits 2.

On the machine that runs the environment, leave out `T3CODE_URL`, and `.` means
the project that contains the current folder. Without a token, `t3 thread` acts
as the machine's owner; with `T3CODE_TOKEN` set, it acts as the token's member,
so on a shared team machine each person sets their own.

A new thread uses the project's default model and permission mode, and runs in
the project folder unless you pass `--worktree <base-branch>`, or
`--cloud <base-branch>` for a cloud machine, when your server has Cloud set up.
A thread in a [workspace](./workspaces.md) always runs in a new worktree, or on a cloud machine.
`send` never
interrupts: a busy thread gets the message as its next turn. Pass `-` as the
message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id. A revoked or expired token fails
with "The token was rejected."

## Agents working with agents

A connected agent can start threads, message them, wait for them and read their
results, so one agent can hand work to others and collect it. An agent Pair
started can also move its own thread into a new worktree. A thread an agent
starts belongs to whoever the agent acts for: you, for an agent you approved or
a token you created, and the thread's owner, for an agent running in a Pair
thread.

Agents start cloud threads and cloud tasks the same way, when your server has
Cloud set up, or, from your Mac, through
[its link to Pair Cloud](#pair-cloud-from-your-macs-agents). A cloud task starts from its thread's
pushed branch.

## Pair Cloud from your Mac's agents

Link your Mac to your team's Pair Cloud once, and agents in threads on your Mac can start cloud
threads there that belong to you: on your accounts, under the team's machine limit.

To link, open **Settings → Environments → Linked environments** and choose **Link**. Pair Cloud is
preselected when it is the only machine listed, and your app, when it is connected to Pair Cloud,
makes the sign-in code itself. Pick the access: the most an agent from your Mac, or a thread you
move, may do there. A member's link goes up to **Auto**, not **Full access**. A link to Pair Cloud
needs no Labs beta. It lasts 30 days, like any link; link again to renew it. **Forget** removes
it on your Mac, and revoking it in Pair Cloud's **Settings → Sharing & access** ends it there.
Removing you from the team ends it too. See [Link another
environment](./remote-access.md#link-another-environment) for the rest.

Below full access, agents on your Mac can change only the threads their link started there, not
your teammates' threads, Pair Cloud's projects or its settings.

With the link:

- `t3_thread_launch` with Pair Cloud's environment, or `delegate_task` with `isolation: "cloud"`,
  starts a cloud thread from a branch that is on `origin`.
- `t3 thread start … --environment <Pair Cloud> --cloud <base>` does the same from a terminal.
- `t3_thread_continue_in_cloud` moves a thread that has unpushed work, as **Continue in cloud**
  does: see [Move a thread](./cloud.md#move-a-thread-between-your-mac-and-pair-cloud). An agent
  moving its own thread should end its turn after the call.

Pair Cloud never reaches back to your Mac: every move and launch starts from your Mac.

## Webhooks

To start work when another service calls a URL, use a project's
[webhook automations](./project-settings.md#webhook-automations).

## Provider accounts

Agents and scripts run on the environment's providers. To route a provider
through OpenRouter or another router, see
[OpenRouter](./providers-claude.md#openrouter) and
[other routers](./providers-claude.md#other-routers).

Pair doesn't pool or rotate teammates' personal subscriptions. They are licensed
per person, and sharing them can break the provider's terms. Each member can
[connect their own account](./team.md#your-own-provider-account), or the team can use API keys, directly or through
[a proxy such as OpenRouter](./providers-claude.md#openrouter).

## Remove an agent

Approved agents and API tokens appear under **Settings → Sharing & access →
Authorized clients** like other clients. Revoke one there to cut off its access
immediately. A sign-in lasts 30 days; after that the agent asks you to approve
it again. Removing a member from a team also revokes their tokens.
