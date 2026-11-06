# Market signals

What teams outside this repo are asking for, and how Pair answers it. Add new signals at the top. Record
what was asked, then map it to what Pair ships or plans; keep opinions out of the quotes.

## 2026-11: Conductor joins Meta

On 2026-11-04 Charlie Holtz announced that Conductor is joining Meta. Teams that run their agent work
through Conductor, and Conductor cloud in particular, started looking for a replacement the same day.

### What teams asked for

**Pulkit Gupta** ([post](https://x.com/pulkit_gupta2/status/2118181639792873680)), after more than a
year on Conductor: when Conductor launched cloud, his team went from about 5 PRs a day to 90+. Most
alternatives they tried fall short of Conductor, especially on UI/UX. What they need:

1. UI/UX as good as Conductor
2. Multiplayer with API access
3. Agent-to-agent communication
4. Custom proxy support to use a pool of Claude and Codex subscriptions

**Fletcher Richman** (@fletchrichman, 2026-11-05): there are many Conductor competitors, but only a
few true replacements for Conductor _cloud_. The bar:

1. Runs the full Claude Code / Codex harness and lets you bring your own subscriptions
2. A cloud VM for each workspace, provisioned for you
3. True multiplayer: agents can reference each other's work, humans can share sessions
4. An iOS app to manage sessions

He names Paradev, Amp, replicas.dev and Typed as the ones that qualify.

**Fred Rivett** (@fredrivett, 2026-11), "requirements for conductor replacement":

1. Mac app
2. Uses workspaces locally
3. Keyboard shortcuts
4. Great diffs
5. GitHub integration
6. One click/shortcut actions (e.g. raise PR)
7. Can customise grouping of workspaces
8. Won't get bought by Meta

### How Pair answers

| Need                             | Pair today                                                                                                                                                                                                                                              | Planned                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI/UX                            | T3 Code's UI. Team features add only the Team shelf, names on messages, Assign, Follow and quiet presence: static avatars and a "Bob is typing" line.                                                                                                   | —                                                                                                                                                         |
| Full Claude Code / Codex harness | Pair runs the real provider CLIs as subprocesses (Claude Code, Codex, Cursor, OpenCode and more).                                                                                                                                                       | —                                                                                                                                                         |
| Bring your own subscriptions     | Admins manage shared team logins as provider instances, and each member can add their own Claude or ChatGPT account. Only its owner can pick it, and a new thread runs on its creator's account. See [Team](../user/team.md#your-own-provider-account). | —                                                                                                                                                         |
| Multiplayer, shared sessions     | Members and roles, attribution on messages and actions, personal sidebars, Assign, Follow, routed notifications, share links that survive sign-in, presence, no hijacking of a teammate's running turn, and timeline rows for who changed what.         | —                                                                                                                                                         |
| API access                       | The `/mcp` endpoint with OAuth and about 35 tools, the `t3 thread` CLI, and self-service member API tokens. Each acts as its member. See [Agents and automation](../user/outside-agents.md).                                                            | —                                                                                                                                                         |
| Agent-to-agent                   | An agent can launch, message, wait on and read other threads, across providers, and hand a worktree to another thread.                                                                                                                                  | —                                                                                                                                                         |
| Custom proxy                     | Each provider instance takes its own environment variables, such as `ANTHROPIC_BASE_URL`. See the OpenRouter and Claude Code Router setups in the [Claude guide](../user/providers-claude.md).                                                          | —                                                                                                                                                         |
| Pool of subscriptions            | Not built, on purpose.                                                                                                                                                                                                                                  | Non-goal. Consumer plans are per person, and rotating several people's plans risks provider terms. Use member-owned accounts, or API keys behind a proxy. |
| A provisioned VM per workspace   | One server per team. Each thread gets its own git worktree on that server, and a client can connect to several servers.                                                                                                                                 | Not planned yet. Candidate: provision a server per workspace, or spread threads across several connected servers.                                         |
| iOS app                          | T3 Code's mobile app, with the team features: names, the Team shelf, Follow and Assign, queue-by-default, presence, your own accounts, and per-member push.                                                                                             | Pair can't ship under T3's bundle ids, so push needs the team's own build. The phone screens still need a device pass.                                    |
| Mac app                          | T3 Code's desktop app runs Pair, on its own or connected to the team server.                                                                                                                                                                            | A Pair-branded Mac build still needs its icon generated on a Mac and its own signing.                                                                     |
| Workspaces on your machine       | The desktop app bundles the server, so threads run in git worktrees on your own machine. A team shares one server instead.                                                                                                                              | —                                                                                                                                                         |
| Keyboard shortcuts               | More than 60 rebindable commands, including Assign and Follow. See [Keybindings](../user/keybindings.md).                                                                                                                                               | —                                                                                                                                                         |
| Diffs                            | A diff for every turn, find in a diff, and pull request review with line comments and a guided tour.                                                                                                                                                    | —                                                                                                                                                         |
| GitHub integration               | Create repositories and pull requests, review, request reviewers and merge. Members connect their own GitHub, and pull requests open as them. See [Source control](../user/source-control.md).                                                          | —                                                                                                                                                         |
| One click/shortcut actions       | **Commit, push & create PR** is one click in a thread's Git actions, with generated commit messages and descriptions.                                                                                                                                   | No keyboard shortcut for the Git actions yet.                                                                                                             |
| Custom grouping of workspaces    | Sections (pinned, active, working, snoozed, settled) you arrange by dragging, and a group-by-project mode in Labs. See [Working with threads](../user/thread-sidebar.md).                                                                               | No groups of your own yet.                                                                                                                                |
| Won't get bought                 | MIT-licensed. Your team runs the server and keeps the data, and the fork stays yours.                                                                                                                                                                   | —                                                                                                                                                         |

### What it means for Pair

- **Throughput is the ceiling.** Conductor cloud's jump from 5 to 90+ PRs a day came from many agents
  running in parallel in isolated environments. One shared VM caps that at its CPU and RAM. With the
  team features landed, look next at a per-server concurrency cap and at spreading work across
  several servers or per-workspace VMs.
- **UI/UX is judged first.** Keep team features quiet and fast, and keep T3 Code's feel.
- **Most of the "replacement" bar is T3 Code's own.** Pair meets most of Fred's list. The gaps are
  small: a keyboard shortcut for the Git actions, sidebar groups you define yourself, and a
  Pair-branded Mac build.
- **Independence is the answer to the acquisition worry.** Open source and self-hosted means no one
  can take the tool away from the team.
