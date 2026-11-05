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

### How Pair answers

| Need                             | Pair today                                                                                                                                                                                     | Planned                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI/UX                            | T3 Code's UI. Team features add only the Team shelf, names on messages, Assign and Follow.                                                                                                     | Presence stays quiet: static avatars and a "Bob is typing" line, no animation.                                                                              |
| Full Claude Code / Codex harness | Pair runs the real provider CLIs as subprocesses (Claude Code, Codex, Cursor, OpenCode and more).                                                                                              | —                                                                                                                                                           |
| Bring your own subscriptions     | Admins manage shared team logins as provider instances.                                                                                                                                        | Member-owned accounts: each member signs in to their own Claude or ChatGPT, and a new thread runs on its creator's account.                                 |
| Multiplayer, shared sessions     | Members and roles, attribution on messages and actions, personal sidebars, Assign, Follow, routed notifications, share links that survive sign-in.                                             | No hijacking of a teammate's running turn; lifecycle rows in the timeline; presence.                                                                        |
| API access                       | The `/mcp` endpoint with OAuth and about 35 tools, and the `t3 thread` CLI. In team mode an MCP client acts as the member who approved it. See [Outside agents](../user/outside-agents.md).    | Self-service member API tokens and one "Automate Pair" guide.                                                                                               |
| Agent-to-agent                   | An agent can launch, message, wait on and read other threads, across providers, and hand a worktree to another thread.                                                                         | —                                                                                                                                                           |
| Custom proxy                     | Each provider instance takes its own environment variables, such as `ANTHROPIC_BASE_URL`. See the OpenRouter and Claude Code Router setups in the [Claude guide](../user/providers-claude.md). | Covered in the "Automate Pair" guide.                                                                                                                       |
| Pool of subscriptions            | Not built, on purpose.                                                                                                                                                                         | Non-goal. Consumer plans are per person, and rotating several people's plans risks provider terms. Use member-owned accounts, or API keys behind a proxy.   |
| A provisioned VM per workspace   | One server per team. Each thread gets its own git worktree on that server, and a client can connect to several servers.                                                                        | Not planned yet. Candidate after the current work: provision a server per workspace, or spread threads across several connected servers.                    |
| iOS app                          | T3 Code's mobile app connects to any server.                                                                                                                                                   | Mobile parity for team features. Pair can't ship to the App Store under T3's bundle ids, so a Pair mobile app needs its own ids or stays an internal build. |

### What it means for Pair

- **Throughput is the ceiling.** Conductor cloud's jump from 5 to 90+ PRs a day came from many agents
  running in parallel in isolated environments. One shared VM caps that at its CPU and RAM. Once the
  team features land, look at a per-server concurrency cap and at spreading work across several
  servers or per-workspace VMs.
- **UI/UX is judged first.** Keep team features quiet and fast, and keep T3 Code's feel.
