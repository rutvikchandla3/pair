# Pair Cloud: plan

Status: proposal, 2026-11-06. Nothing here is built. The research that led to it is in
[Conductor Cloud and Pair's path to parity](../conductor-cloud.md).

Pair Cloud runs a thread's agent, terminals and previews in a sandbox (a VM or container) instead
of on the team server. Each cloud thread gets its own machine, so a team can run many agents in
parallel without one box running out of CPU, and nobody's agent touches anyone else's checkout. The
team server keeps doing what it does today: members, threads, approvals, presence, provider
accounts, the API and scheduled tasks. Sandboxes can run in Docker (on the team server's machine or
another one), on a hosted sandbox vendor, or in the customer's own cloud account. That last one is
the bring-your-own-cloud (BYOC) option Conductor never shipped.

## Documents

| Doc | Question it answers |
| --- | ------------------- |
| [01 Product](./01-product.md) | Who is this for, what can they do at each milestone, and how does it compare? |
| [02 Workspace host](./02-workspace-host.md) | How does the server stop assuming a thread's files and processes are local? |
| [03 Runner](./03-runner.md) | What runs inside the sandbox, and what does it say to the server? |
| [04 Sandbox lifecycle](./04-sandbox-lifecycle.md) | How are sandboxes created, slept, woken, capped and paid for, and on which vendors? |
| [05 Team images](./05-team-images.md) | How does a team define and build the machine its cloud threads boot from? |
| [06 Credentials and security](./06-credentials-and-security.md) | How do provider and git credentials reach a sandbox, and what can a sandbox reach? |
| [07 Access and data](./07-access-and-data.md) | How do checkpoints, diffs, terminals, previews, SSH and moving threads work? |
| [08 Clients and contracts](./08-clients-and-contracts.md) | What changes on the wire, and in web, desktop, mobile, MCP and the CLI? |
| [09 BYOC](./09-byoc.md) | How does a customer run sandboxes in their own cloud? |
| [10 Delivery plan](./10-delivery-plan.md) | In what order do we build it, in which pull requests, and how do we know it works? |

## Decisions everything else builds on

The documents follow these. The first draft of this list was challenged by the deep dives, and
the changes are folded in below; [what the deep dive changed](#what-the-deep-dive-changed) lists
them.

1. **The team server stays the control plane.** The orchestrator, event store, projections, auth,
   members, provider accounts, MCP, scheduled tasks, push and presence stay where they are. Only
   execution moves. Clients never connect to a sandbox. Because provider adapters stay on the
   server (decision 2), cloud turns need an always-on team server: closing the laptop that hosts a
   desktop server stops them.
2. **A thin runner; adapters stay on the server.** The sandbox runs a small process that exposes
   processes with stdio, PTYs, files, file watches and TCP ports. Provider adapters, checkpointing
   and git logic keep running on the team server and reach the sandbox through the workspace host.
   Rejected: a full T3 server inside each sandbox, linked as a peer. That splits one thread's state
   across two event stores, and a sleeping sandbox would take its thread's history offline.
   **Coarse operations** are a fixed, typed list that runs existing server code inside the runner,
   never a second implementation. The search index, port listing, the terminal process table and
   checkpoint capture are on the list from M1; anything else joins only after a measurement.
   Adapters that run inside the server process (Cursor through `@cursor/sdk`, and Muse) can't move
   behind this seam and are "not supported in cloud".
3. **`WorkspaceHost` is the one seam.** Every process, PTY, file, watch, port and disk check (such
   as `realPath` or `exists` on a thread's path) that belongs to a thread's machine goes through
   that thread's workspace host. So do reads of the host's platform, home directory and
   environment. The host also decides the base environment of every process it starts, so the
   server's own `process.env` never leaks into a sandbox. A thread finds its host from its checkout
   path ([02](./02-workspace-host.md)). `LocalWorkspaceHost` is today's behavior, bit for bit, and
   M0 ships the seam with no behavior change.
4. **The runner dials out.** One authenticated WebSocket from the runner to the team server,
   multiplexed into channels. The sandbox needs no inbound port, so it works in a private VPC or
   behind NAT, but the team server must be reachable from the sandbox's network. A server reachable
   only over Tailscale works with Docker and with BYOC in a routed network, not with hosted
   vendors. The server mints a sandbox token that reaches only that sandbox's channel. Calls back
   to the server go through named forwards on the same socket: MCP, the Codex token broker and the
   git credential helper. (Hooks already travel over the provider's stdio.) The runner protocol's
   schemas live in `packages/contracts`.
5. **Same build, served by the team server.** The runner is a slim entry point of the server's own
   build, identified by a build hash. The team server serves that bundle to its sandboxes, and
   images cache it by hash. After an upgrade, fetching it at boot is the normal path. It never
   comes from npm, because the `t3` package there is upstream T3 Code. There is still no
   runner-versus-server compatibility matrix.
6. **A sandbox is an event-sourced record.** It lives on its owning thread's event stream, with
   its own projection. It has an id, a project, an owning member, a driver, an image build and a
   state: `provisioning`, `ready`, `sleeping`, `waking`, `failed` or `destroyed`. Each transition
   is a command, then events, then an outbox effect that calls the compute driver. A driver call
   returns "accepted". The sandbox becomes `ready` when its runner says hello, which arrives as its
   own command, so no effect waits on a boot. Each sandbox effect also gets a time bound in the
   effect worker, which today bounds only one effect type, so a stuck driver call can't block its
   thread's queue. Runner connection status lives in memory; only
   "attached" and "lost" are events. Idle sleep, deadlines and recycles come from a worker on the
   existing scheduler that dispatches guarded commands, not from delayed outbox effects. Side chats
   and forks of a cloud thread share its sandbox from M1, as they share a worktree today: they
   reference the sandbox, lifecycle commands go to the owning thread's stream, and the sandbox is
   destroyed only when no thread uses it. Starting an unrelated thread in an existing sandbox is
   out of scope.
7. **Cloud is a third way to start a thread, added without breaking old clients.** A thread is a
   cloud thread when it has a `sandboxId`. `cloud` is a new value only in the thread launch input.
   It never goes into the persisted fields that older clients decode strictly: run records still
   say `worktree`, projects get a sibling `defaultsToCloud` flag, and the committed project file
   never offers it ([08](./08-clients-and-contracts.md) lists each hazard). Solo stays T3 Code: the
   option appears only after an admin configures a compute driver, and with none configured
   nothing changes on the wire or in the UI. Cloud works on solo and team servers. The UI says
   "Cloud" for the mode and "machine" for a sandbox. Code, folders, routes and git refs say
   `sandbox`, because `cloud` already names T3 Connect code such as `apps/server/src/cloud/`.
8. **Compute drivers are pluggable, in this order.**
   - **M1, Docker:** on the team server's machine or another host through `DOCKER_HOST`. Plain
     runc is not a security boundary, so Settings recommends rootless Docker or gVisor and says so
     when neither is in use.
   - **M2, one hosted vendor:** Vercel Sandbox is recommended, with E2B as the runner-up. The
     choice is the maintainers'.
   - **M5, the customer's cloud:** a plain-VM driver on EC2, then GCE. Kubernetes waits until a
     customer asks for it.

   A server can hold several configured driver instances, with one default per project. The driver
   interface stays small: create from an image, start, stop with the disk kept, snapshot, destroy,
   status, list and delete an image. An optional `buildImage` covers backends that can't snapshot a
   running machine. Drivers declare capabilities (persistent disk, snapshots, egress rules, maximum
   lifetime, image build strategy). Caps on running sandboxes per team and per member are policy,
   enforced by the server before it calls a driver.
9. **The team image is Pair's Cloud Computer.** An admin-owned recipe, in Pair's own format,
   produces numbered builds with an active build, history, rollback and logs. A build an admin
   starts activates when it succeeds; a build an agent starts waits for an admin to activate it.
   An agent's authority to edit or build comes from the humans who wrote the current run, checked
   on every call, never from whose thread it is. Each project's setup script still runs on every
   new cloud thread, with its paths (such as `T3CODE_PROJECT_ROOT`) pointing into the sandbox. A
   build belongs to no thread, but outbox rows are keyed by thread today. So M3 makes one additive
   change to orchestration: outbox rows gain an aggregate key, and thread effects behave as before.
10. **Credentials arrive in memory, never on disk.** A turn runs on the thread's provider account,
    whoever prompts it, as today. Credentials reach a process from an allowlisted environment when
    it starts. Pair writes no credential to a sandbox's disk or image, and sleep never keeps memory.
    A stopped disk or snapshot still holds code, transcripts and whatever scripts wrote, so it is
    treated as sensitive: encrypted, and deleted when the sandbox is destroyed. Git answers only
    for the thread's project remote, with the first of: a one-hour GitHub App token for that repo
    (once an admin adds the App's private key), or the thread owner's own GitHub credential, either
    their connected account or a token they bring (as Claude Code's `/web-setup` does). With neither,
    the thread can't push. Until a server-side git proxy lands in M3 and keeps the owner's token out
    of the sandbox, pushing from a sandbox works only with GitHub. An opt-in model proxy (M2) keeps API keys on the server; subscription tokens are
    never proxied.
11. **Checkpoints are mirrored to the server.** The server pulls each turn's checkpoint refs from
    the sandbox as a git bundle over the runner into one bare repo per project. Diffs of cloud
    threads always read the mirror, so they work while the sandbox sleeps. A snapshot of the
    working tree taken before sleep backs read-only browsing. Restoring a checkpoint wakes the
    sandbox.
12. **Every surface.** Contracts change once in `packages/contracts`, and web, desktop, mobile, the
    MCP tools, the `t3 thread` CLI and scheduled tasks all get cloud threads. Claude and Codex come
    first. Every other provider adapter gets an explicit decision, and "not supported in cloud yet"
    is an acceptable one.
13. **Reverse states.** A thread can move from local to cloud and back, a sleeping sandbox can be
    woken, a failed one can be retried or discarded, and an agent's build can be activated or
    rolled back.
14. **Fork hygiene.** Pair is a fork of T3 Code. New code goes in new `sandbox` folders, and edits
    to upstream files stay small and mechanical so upstream merges stay cheap. The `WorkspaceHost`
    seam is a pure refactor that could be offered upstream.
15. **Pair needs release artifacts.** Pair publishes a base sandbox image for M1. For M5 it needs a
    team server release that a deployment kit can install, because today teams run Pair from a
    checkout.

## Milestones

Every document assigns its work to these.

| Milestone | What a user can do when it lands |
| --------- | -------------------------------- |
| M0 Seam | Nothing new. Every machine access goes through `LocalWorkspaceHost`, including platform reads and disk checks, with no behavior or performance change. |
| M1 Cloud threads on Docker | An admin enables the Docker driver, locally or on another Docker host. Members push with their own GitHub, or an admin adds the GitHub App key. Anyone starts a cloud thread on web, desktop, mobile, MCP or the CLI. Claude and Codex turns, terminals, side chats, forks, git, diffs and GitHub pull requests work. |
| M2 Lifecycle and a hosted driver | Sandboxes sleep when idle and wake on demand, caps and usage show in Settings, previews work, the first hosted vendor driver ships, and the opt-in model proxy lands. Scheduled tasks can launch cloud threads. |
| M3 Team images | Admins build, version and roll back the team image, and an admin agent can help. Other git hosts push through the server's git proxy, and OpenCode, Grok and Kiro work in cloud. |
| M4 Access and trust | SSH and open-in-editor, moving threads between local and cloud, and a cloud-only server mode where no agent runs on the team server's machine. |
| M5 BYOC | A plain-VM driver and a deployment kit for running the team server and sandboxes in the customer's own AWS, then GCP, account. |

## Decided for M1

Settled on 2026-11-06 by following Conductor Cloud, and Claude Code or Codex cloud where Conductor
is silent:

| # | Decision | Precedent |
| - | -------- | --------- |
| D1 | Cloud threads push without the App key: the thread owner's connected GitHub or their own token ("Use a token instead" in Settings → Team). An installation token wins when the App key is set. No server-login fallback. | Claude Code's `/web-setup` and GitHub proxy; Conductor offers no own token |
| D2 | Claude setup tokens are allowed in sandboxes, with a warning that the agent can read them. | Conductor's copyable `claude setup-token` |
| D3 | The runner runs as root; agents run as `t3` with passwordless `sudo`. | Conductor gives users `sudo`; Claude Code's setup scripts run as root |
| D4 | New threads stay local by default. Cloud is an explicit pick, or a project's `defaultsToCloud`. | Claude's Local or Cloud selector and `--cloud`; Codex's per-thread picker |
| D5 | No member cap by default. The team cap (Docker `floor(vCPUs / 4)`, hosted 20) and 10 starts a minute stay as capacity and spend guards. | None of the three publish a per-user cap |
| D6 | Pair's release CI publishes `t3-sandbox:<version>` to the GHCR of the repo that runs it, so forks publish their own. `sandbox.baseImage` overrides it. | Conductor and Anthropic each maintain their base image |

The rest are in [10 §7](./10-delivery-plan.md#7-decisions-maintainers-must-make), each with a
recommendation. Offering the seam upstream comes before M0. The hosted vendor (Vercel Sandbox
recommended over E2B) is due at the start of M2.

## What the deep dive changed

| First draft | Now | Raised by |
| ----------- | --- | --------- |
| Coarse runner operations only after a measurement. | Search, ports, the process table and checkpoint capture are coarse from M1. | [02](./02-workspace-host.md), [07](./07-access-and-data.md) |
| The runner comes from the `t3` npm package. | The team server serves its own build's runner. | [03](./03-runner.md), [09](./09-byoc.md) |
| A driver's result marks the sandbox ready, and timers are outbox effects. | The runner's hello marks it ready, and timers run on the scheduler. | [04](./04-sandbox-lifecycle.md) |
| One sandbox per thread, with sharing later. | Side chats and forks share from M1. | [07](./07-access-and-data.md) |
| No long-lived secret in an image or snapshot. | No credential on disk, and disks are treated as sensitive. | [06](./06-credentials-and-security.md) |
| The runner pushes checkpoints to the mirror. | The server pulls them. | [07](./07-access-and-data.md) |
| Hooks call back to the server. | MCP, the Codex token broker and git credentials do; hooks use stdio. | [03](./03-runner.md) |
| Docker on the server's own machine. | Docker anywhere through `DOCKER_HOST`, with an isolation warning. | [01](./01-product.md), [06](./06-credentials-and-security.md) |
| Admin agent as an ordinary thread, and builds that auto-activate. | Authority comes from the run's human authors, and agent builds wait for an admin. | [05](./05-team-images.md) |
| BYOC on Kubernetes or Firecracker. | A plain-VM driver first. | [09](./09-byoc.md) |
| Builds use the outbox like everything else. | The outbox gains an aggregate key in M3, because a build has no thread. | Code review of [05](./05-team-images.md) |
| `ThreadEnvMode` gains `cloud`. | `cloud` exists only in the launch input. Persisted fields that old clients decode strictly never carry it. | [08](./08-clients-and-contracts.md) |
| Driver effects are bounded by the effect worker's timeout. | Only one effect type has a timeout today, so sandbox effects add theirs. | Code review of [04](./04-sandbox-lifecycle.md) |
| No push without the App key, and never member tokens. | The thread owner's own GitHub works when there is no App key (D1). | Maintainers, after Claude Code's `/web-setup` |
| A member cap of 5. | No member cap by default (D5). | Maintainers, after Conductor and Claude Code |

## Words

- **Cloud thread:** a thread with a `sandboxId`, started with the `cloud` launch option.
- **Sandbox:** the VM or container a cloud thread runs in. The UI calls it a machine.
- **Runner:** the process inside a sandbox that connects back to the team server, started as
  `t3 runner` from the bundle the server serves.
- **Workspace host:** the server-side service through which a thread reaches its machine, local or
  sandbox.
- **Coarse operation:** one of a fixed list of runner calls that run existing server code inside
  the sandbox instead of many primitive calls.
- **Compute driver:** the server-side adapter for one sandbox backend (Docker, a vendor, a cloud).
- **Team image:** the admin's recipe for the machine cloud threads boot from. A **build** is one
  numbered version of it.
- **Sandbox token:** the credential the runner uses, scoped to one sandbox.
- **Mirror:** the bare git repo per project on the team server that holds cloud threads'
  checkpoints and branches.

"Environment" already means one running T3 server, and "workspace" names existing code, so neither
names anything new here.
