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

## Installation

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

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Pair as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Pair uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
