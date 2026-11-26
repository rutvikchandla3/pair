# Pair

Your team's coding agents, on one shared server.

Pair is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, Inc., used under the MIT License.

Pair is an "agent harness control surface". It runs the coding agents on your team's server and lets everyone control them from the web, desktop, and mobile apps.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on the server, Pair can control them.

## What Pair adds

Pair adds **Team** to T3 Code, so several people can share one server ([Team](./docs/user/team.md)):

- **Members and roles.** Invite people from **Settings → Team**. Admins manage settings, providers and access; members start and prompt threads, approve requests, and use terminals and source control.
- **Sign-in links.** Each invite is a one-time sign-in link. Members add their other devices with their own links, and removing a member signs out all of their devices.
- **The Team shelf.** Threads other members own sit on a **Team** shelf in the sidebar, with the owner's avatar on each row.
- **Assign to…** hands a thread over to another member, from the thread's menu or the command palette.
- **Follow and notifications.** Follow teammates' threads, and get notified only about the turns and threads that concern you.

See [Pair features](./docs/product/pair-features.md) for everything Pair adds and what is coming next.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

> [!WARNING]
> Pair currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider on the server before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the Pair server ([setup guide](./docs/user/providers-fx.md))

### Run Pair on your team server

Pair runs from this repository on the team VM. `npx t3`, t3.codes downloads, package managers and the App Store and Play Store apps install upstream T3 Code, not Pair.

1. Install [`vp`](#install-vp), then build:

   ```bash
   git clone https://github.com/rutvikchandla3/t3code.git pair
   cd pair
   vp i
   vp run build
   ```

2. Turn off in-app updates, or an update installs upstream T3 Code over Pair. Write `/etc/t3code/policy.json`:

   ```json
   {
     "schemaVersion": 1,
     "organization": "Your team",
     "limits": { "updates": { "mode": "off" } }
   }
   ```

   Give desktop builds you hand to teammates the same policy. See [Managed policy](./docs/user/managed-policy.md).

3. Start the server with `vp run start`. `node apps/server/dist/bin.mjs up` sets up remote access and the background service; the command is `t3` in the rest of the docs.

To update Pair, pull this repository, rebuild, and restart the server.

## Upstream T3 Code

These install upstream T3 Code, which has no Team features. It can still connect to a Pair server.

### Command line (upstream)

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Pair as a background service](./docs/user/background-service.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

Pair uses Vite+ so you'll need to install the global `vp` command-line tool.

## License

[MIT](./LICENSE)
