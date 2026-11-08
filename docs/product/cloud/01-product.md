# Pair Cloud: product

Status: M0 and M1 landed; the rest is a proposal, rewritten 2026-11-08 for local-first Pair Cloud.
This page says who Pair Cloud is for, what they can do at each milestone, which product rules
change, and how it compares. It follows the shared decisions, milestones and words in the
[plan](./README.md). The research behind it is in
[Conductor Cloud and Pair's path to parity](../conductor-cloud.md).

Engineers work locally in the Pair Mac app, whose bundled local server is unchanged and never
depends on anything remote. When they want to share a session, they start a cloud session on the
team's Pair Cloud server: one always-on Pair server in cloud-only mode, which runs each cloud
session on its own machine (a Docker container from M2, an EC2 instance in the customer's AWS
account from M5) and never runs an agent itself. Teammates join the session from web, desktop or
mobile, watch it and prompt it. The Pair app connects to both servers and routes each launch; the
servers never sync threads or state.

## 1. Problem and timing

### Why teams want cloud agents

| Need                       | What breaks today                                                                                                                                                                                                             | What a cloud session changes                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Sharing a session          | A thread on a member's Mac lives in that Mac's local server. A teammate sees it only by connecting to that Mac, and it stops when the lid closes. A shared team server avoids that by putting everyone's agents in one shell. | The session lives on Pair Cloud, where every member sees it and can prompt it. The member's Mac stays their own. |
| Parallelism                | A laptop slows after a few agents with test suites and dev servers. On a shared team server every thread shares one machine's CPU, RAM and disk; ten people running three agents each saturate it.                            | Each cloud session gets its own machine. Pair Cloud only coordinates.                                            |
| Isolation                  | On a shared team server every agent runs as the server's user, shares ports, and can read every other checkout and the database.                                                                                              | An agent sees only its own machine. Pair Cloud runs no agent on its own host.                                    |
| Laptop-closed work         | Closing the lid stops the Mac's local threads.                                                                                                                                                                                | Cloud sessions run on machines driven by the always-on Pair Cloud server.                                        |
| Phone-driven work          | Already works when the phone can reach the Mac over LAN, Tailscale or T3 Connect ([Remote access](../../user/remote-access.md)).                                                                                              | Unchanged for local work, plus starting, watching and waking cloud sessions on Pair Cloud from the phone.        |
| Clean, repeatable machines | Every laptop, and any shared server, accumulates whatever its users installed.                                                                                                                                                | Every cloud session boots from the same image plus the project's setup script, and from the team image from M4.  |

Sharing is why Pair Cloud has this shape: local work stays on the Mac, and a session becomes the
team's when its owner starts it on Pair Cloud. Parallelism is the need teams lead with in public.
Pulkit Gupta's team went from about 5 to 90+ PRs a day when Conductor launched cloud, because many
agents ran at once in isolated VMs, and Pair's own reading of that already pointed at spreading
work across servers or per-workspace VMs ([market signals](../market-signals.md)).

Clients already connect to several environments at once, and **Auto balance** spreads new threads
across them ([Remote access](../../user/remote-access.md#balance-new-threads-across-machines)).
Pair Cloud builds on that rather than replacing it: the Mac app keeps its local server and adds the
team's Pair Cloud server as one more environment. Each server keeps its own members and state.

### Why now

What is confirmed and what is not:

| Claim                                                                                  | Status                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conductor is joining Meta.                                                             | Announced by Charlie Holtz on 2026-11-04, per [market signals](../market-signals.md). Our web search on 2026-11-06 found no independent press coverage yet. |
| Conductor Cloud sign-ups closed 2026-11-04, read-only 2026-11-13, shutdown 2026-11-20. | Secondary reports only. No Conductor source confirms the dates ([conductor-cloud](../conductor-cloud.md)).                                                  |
| Teams are looking for a Conductor Cloud replacement.                                   | Public posts by Pulkit Gupta, Fletcher Richman and Fred Rivett, quoted in [market signals](../market-signals.md).                                           |
| Conductor never shipped bring-your-own-cloud.                                          | Its FAQ answered "Not yet" ([conductor-cloud](../conductor-cloud.md)).                                                                                      |

The honest timing: if the shutdown dates hold, Conductor Cloud is gone before Pair ships its first
release (M2). The refugees who matter are the ones who move to a stopgap now and keep looking for
something they won't lose again. "Won't get bought by Meta" is on Fred Rivett's list. Being open
source and self-hosted is the answer, and BYOC turns it into something Conductor could not offer.

## 2. Who it's for

Pair's users are teams of about 8–10 ([pair-features](../pair-features.md)). In this plan each
member works on their own Mac, and the team shares one Pair Cloud server.

| Persona               | Who they are                                                                                                                    | What they want from cloud                                                                                                              | What worries them                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**             | The person who installs and runs the team's Pair Cloud server and holds `t3 member` on its host. Often a tech lead.             | Install it once, add the GitHub App, keep machines and the team image working, know what it costs.                                     | Surprise bills, a broken image blocking everyone, an upgrade that interrupts running agents, being on call for it.                            |
| **IC**                | A member who works locally in the Pair Mac app and starts five to fifteen threads a day across a few repos.                     | Put a session where teammates can see it and where it outlives the laptop, run more agents at once, review diffs anywhere.             | Waiting for a machine, losing work when a machine sleeps, a cloud session that behaves differently from local, having to push before sharing. |
| **Phone-first**       | Any member away from a desk: commuting, in meetings, on call.                                                                   | Start a cloud session, approve a request and read a diff from the phone with the laptop closed, and still drive local work on the Mac. | A push that says nothing, a session that silently stalled.                                                                                    |
| **Automation owner**  | A member whose scheduled tasks, webhooks, CI jobs or outside agents launch threads on Pair Cloud through `/mcp` or `t3 thread`. | Fan out many unattended sessions that don't fight for one box, each with a clean machine.                                              | Runaway cost, tasks stuck behind a cap, no way to tell why a run failed.                                                                      |
| **Security reviewer** | The person at a security-conscious company who must approve where code and credentials live.                                    | Pair Cloud, its machines and its credentials in the company's own cloud account, behind its network rules.                             | Any third party holding code or long-lived secrets, agents with shell on a shared server, a public endpoint.                                  |

A Conductor refugee is an admin and a few ICs who judge Pair on UI/UX first.

## 3. User journeys

Each journey lists the surfaces involved and what the UI shows. Status words follow the sandbox
states in the [plan](./README.md) (decision 6). The UI shows them as follows, everywhere: the thread
header, the sidebar row (an icon only), the mobile thread screen, and `t3 thread` output.

| Sandbox state                 | Runner       | What the UI says                                                   | What the composer does                                  |
| ----------------------------- | ------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `provisioning`                | any          | "Starting machine" with the step: creating, cloning, running setup | Accepts a message and queues it until ready.            |
| (no sandbox yet, cap reached) | n/a          | "Waiting for a machine: team limit reached"                        | Accepts a message and queues it.                        |
| `ready`                       | connected    | Nothing. A cloud icon marks the thread mode.                       | Normal.                                                 |
| `ready`                       | disconnected | A quiet dot, then "Reconnecting to machine" after 2 s              | Queues.                                                 |
| `sleeping`                    | n/a          | "Asleep" with a **Wake** action                                    | Sending wakes it and queues the message.                |
| `waking`                      | any          | "Waking machine"                                                   | Queues.                                                 |
| `failed`                      | n/a          | The error in one line, with **Retry** and **Discard**              | Disabled until Retry.                                   |
| `destroyed`                   | n/a          | "Machine discarded". Transcript and diffs still readable.          | **Start a new machine** focuses it; sending provisions. |

No state animates continuously. A static icon and a line of text change when the state changes, per
the "no continuously repainting animations" rule in [AGENTS.md](../../../AGENTS.md).

### J1. An admin installs Pair Cloud, and members connect

Surfaces: the install guide, Pair Cloud's web app, `t3 member` on its host, then Settings →
Environments in each member's Mac app and phone. Milestone: M2.

1. The admin installs a versioned Pair Cloud release on an always-on VM the team runs (Pair's own
   dogfood runs on a GCE VM), in cloud-only mode. Members reach it over HTTPS on the team's own
   domain. Its web app is its own origin, not app.t3.codes. The install guide recommends hourly
   snapshots of the server's data volume: a restore loses at most an hour of session history, and
   code is safer, since it also lives on machines, in the mirror and on GitHub.
2. In **Settings → Cloud** on Pair Cloud (see [section 6](#6-settings-and-information-architecture))
   they add the Docker driver: Docker on the same VM, or on another host through `DOCKER_HOST` with
   a runner URL its machines can reach. Plain runc is not a security boundary, so the page
   recommends rootless Docker or gVisor and says when neither is in use. A separate Docker host
   keeps agents off Pair Cloud's own host (section 5).
3. **Test** boots one machine from Pair's published base image (`t3-sandbox:<version>`; a
   `sandbox.baseImage` setting points at a mirror), connects the runner, runs git, then discards
   it. The result shows each step's time.
4. They set up the team's GitHub App: its client ID, so members can connect their GitHub, and its
   App ID and private key in **Settings → Source control**, so machines clone and push with a
   one-hour installation token for one repo. Where the App isn't installed, a session uses its
   owner's own GitHub (section 5). Pushing works only with github.com.
5. They add the team's repos as Pair Cloud projects. Pair Cloud checks that the member adding one
   can access the repo, then clones a read-only checkout and a bare mirror with the App token. No
   agent works in that checkout; it serves reads and is the base for machines. Any member can add
   more later.
6. Caps: a team cap that defaults to `floor(host vCPUs / 4)` on Docker and that the admin can set
   beside the machine size, 10 starts a minute, and no member cap (D5). A member cap and usage are
   Later ([04](./04-sandbox-lifecycle.md#4-caps-quotas-and-usage)).
7. They invite the team from **Settings → Team**: the team only, at today's trust level (section 5).
   Each member pastes their invite link into **Add environment** in the Mac app, so Pair Cloud sits
   next to their local server, and adds their phone with **Add a device**. On their own row on Pair
   Cloud they connect a Claude or Codex account and GitHub. The Mac's own Claude login doesn't reach
   Pair Cloud.
8. From then on, a local project whose origin matches a Pair Cloud project offers **Cloud** in the
   composer next to Current checkout and New worktree.

A solo developer can install Pair Cloud too, as its only admin. A desktop or laptop server never
offers Cloud.

### J2. A member starts a cloud session from a local project

Surfaces: the Mac app, web, command palette, keybinding. Milestone: M2.

1. The member is working on a local project in the Mac app and has pushed the branch. In the
   composer's workspace menu they pick **Cloud**, or run **New cloud thread** from the command
   palette or its keybinding (`chat.newCloud`). A resolver in `packages/client-runtime` finds the
   Pair Cloud project with the same origin repo and sends the launch to Pair Cloud, not to the local
   server. Cloud shows only when Pair Cloud reports that it takes cloud launches (a capability flag
   such as `capabilities.cloudLaunch`), which also keeps a self-hosted Pair Cloud and an
   auto-updating Mac app in step. If no Pair Cloud project matches, the menu says the repo isn't on
   Pair Cloud yet and links to adding it.
2. They pick a base branch that exists on `origin`. Pair refuses a branch that isn't pushed, and says
   so. Carrying unpushed work over is M3 ([J9](#j9-bringing-a-cloud-thread-local-and-sending-a-local-thread-to-cloud)).
3. The model picker defaults to the member's own Claude or Codex account on Pair Cloud: a setup
   token, an API key, or a ChatGPT account. A company account (an instance in Settings → Providers on
   Pair Cloud) is the other choice. With no usable account on Pair Cloud, the picker says what to
   add in Settings → Team there, or offers a company account. Cursor and Muse show as "Not supported
   in cloud".
4. They send. The thread appears in the sidebar right away with a cloud icon, next to the local
   project's threads, because the sidebar already groups projects across environments by repository.
   Pair Cloud's launch gate picks the driver and machine size. The header shows "Starting machine:
   cloning" then "running setup". The message waits as queued.
5. When the runner connects, the turn starts. Streaming, approvals, terminals, diffs, Git actions and
   **Commit, push & create PR** work as in a worktree thread. The pull request opens as the member
   through their GitHub connection; if GitHub refuses, Pair Cloud's own account opens it with
   "Requested by `<name>` via Pair". At a cap, the thread waits visibly. With no credential, the
   thread says "Connect GitHub to push", or "Connect GitHub to clone private repos" when it can't
   clone, and links to the owner's row.
6. A side chat or fork of the session shares its machine, as it shares a worktree today. The machine
   is discarded only when no thread uses it.

The local worktree and threads are untouched. Any client connected to Pair Cloud, including its own
web app, can also start a cloud session on a Pair Cloud project directly.

### J3. A member starts a cloud session from the phone

Surfaces: mobile. Milestone: M2.

1. The phone keeps its connection to the member's Mac over LAN, Tailscale or T3 Connect, exactly as
   today, so local work stays drivable from the phone. It is also paired with Pair Cloud (J1). Both
   show under **Settings → Environments**.
2. In the new-task screen the member picks a project and **Cloud**: a Pair Cloud project directly,
   or a local project seen through the Mac, where the same client-runtime resolver routes the launch
   to the matching Pair Cloud project. Anyone on the team can start one this way.
3. **Cloud** shows only when one of the phone's environments offers it (its `cloudLaunch` flag), so
   a phone with no Pair Cloud sees nothing new. A member adds Pair Cloud like any other environment.
   Routing a cloud launch through the Mac's local server waits for the M3 agent link.
4. They send. The thread screen shows the same status line as the web.
5. They can lock the phone. A push comes only for what concerns them: an approval, input, completion
   or failure ([decisions](../decisions.md#presence-and-notifications)). Pair publishes one mobile
   build that any Pair Cloud server can push to, so a team no longer builds its own.

### J4. A teammate joins and prompts a cloud session

Surfaces: all. Milestone: M2.

Everyone on Pair Cloud sees every project and thread
([decisions](../decisions.md#members-and-roles)), so nothing about multiplayer changes. The
teammate opens the session from the Team shelf, sees the owner's avatar and presence, and sends. If
the owner's turn is running, the message queues, and **Steer now** stays the deliberate interrupt.
The turn runs on the thread's provider account, by default the owner's own subscription, so a
teammate who prompts spends it; usage shows per sender. If the machine is asleep, sending wakes it,
the header says "Waking machine", and the message queues. The teammate can open the session's
terminal, which runs on the machine. Nobody needs to reach the owner's Mac.

### J5. Walking away and approving from the phone

Surfaces: the Mac app, then mobile push. Milestone: M2.

An IC starts three cloud sessions from the Mac app and closes the laptop. The agents keep working,
because they run on machines Pair Cloud drives and the Mac was only a client for them. One needs
approval, so the prompter and owner get "Approval needed" with the thread title only. The IC opens
the push, reads the request and the diff so far, and approves. The card records who answered. The
Mac's local threads stop with the Mac, as today.

This works because Pair Cloud is always on. A desktop server no longer offers Cloud (section 5),
so there is no cloud session that stops when a laptop closes.

### J6. A session sleeps and wakes

Surfaces: all. Milestone: M2.

1. After the idle period with no running turn, terminal activity or viewer, the machine sleeps.
   Before it stops, Pair Cloud snapshots the working tree into the mirror. Files survive. Running
   processes, such as a dev server, do not.
2. The sidebar row and header show "Asleep", with no timeline row and no push. Anyone can still read
   the transcript, review diffs, and browse and search files as of the snapshot, because checkpoints
   and the snapshot are mirrored (plan decision 11).
3. Opening the thread wakes it, and so do sending a message, **Wake**, typing in a terminal,
   restoring a checkpoint, a scheduled task, and an MCP or CLI call that needs the machine. The
   sidebar, push, search, diffs from the mirror, git status and pull request discovery never wake
   it ([04](./04-sandbox-lifecycle.md#2-idle-policy-and-wake-triggers)).
4. "Waking machine" shows until the runner reconnects. Then the queued message sends.
5. If the machine's disk is gone, waking starts a new machine, restores the branch and snapshot from
   the mirror, and reruns the setup script.
6. If waking fails, the header shows the error with **Retry** and **Discard**. The prompter and owner
   get a "Machine failed" push.

### J7. A scheduled task or webhook launches a cloud session

Surfaces: Settings → Scheduled tasks and project webhook automations on Pair Cloud, MCP,
`t3 thread`. Milestone: M2, and M3 for agents in local threads.

1. The automation owner creates or edits a task on Pair Cloud. Pair Cloud has no local threads, so
   one launch gate turns every launch into a cloud launch, whichever path it takes: the UI, MCP,
   `t3 thread`, scheduled tasks, webhooks or `delegate_task`. The task editor there says its runs
   are cloud sessions instead of offering local workspaces. Today a task's workspace choice is
   `root`, `existing_worktree` or `worktree` (`OrchestrationV2ThreadLaunchWorkspaceStrategy` in
   [orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts), used by
   [scheduledTask.ts](../../../packages/contracts/src/scheduledTask.ts)). Tasks gain no `cloud`
   value: on Pair Cloud the gate turns whichever one they carry into a cloud launch.
2. A webhook arrives. The task creates a cloud session owned by the task's owner, on the owner's
   provider account. Pair Cloud, not the task, picks the driver and size.
3. The run counts against the team cap. At the cap it waits, and the task's run history says
   "Waiting for a machine" rather than failing.
4. When the turn ends, the machine follows the normal idle policy. The task can set "discard the
   machine when the run settles" for fire-and-forget work.
5. An agent, in a Pair Cloud thread or outside with an API token, does the same through the `/mcp`
   launch tools or `t3 thread` (the flag is owned by [08](./08-clients-and-contracts.md)). Fan-out to
   many cloud sessions works as it does for worktrees. At the cap the launch succeeds and the child
   waits, so an agent never gets a confusing failure from a busy team.
6. An agent in a local thread on the Mac reaches Pair Cloud in M3, through one member-scoped agent
   link from the Mac's local server: MCP, the CLI and `delegate_task`, laptop to cloud only. Until
   then a local agent starts local threads only.

### J8. An admin updates the team image and rolls back a bad build

Surfaces: Pair Cloud's web app or a desktop client connected to it, Settings → Cloud → Team image,
and an image thread. Milestone: M4.

1. The admin edits the install script, for example to add a Postgres client, and presses **Build**.
2. The build runs on a machine. Its log streams on the page. The admin can leave. When it finishes,
   that admin gets "Build 14 succeeded" or "Build 14 failed". A build an admin starts activates when
   it succeeds, and new cloud sessions boot from it. Existing ones keep their build.
3. The next morning, ICs report that `pnpm` is missing in new sessions. The admin opens **History**,
   picks build 13 and presses **Activate**. New sessions use 13 at once. No rebuild is needed.
4. To fix it, the admin presses **Edit with an agent**, which opens an image thread, and asks:
   "Build 14 dropped pnpm, fix the install script and build." The agent can edit and build only
   while every human who wrote the current run is an active admin, checked on every call. A
   teammate's queued message or **Steer now** takes that authority away
   ([05](./05-team-images.md#7-the-admin-agent)).
5. The agent's build 15 ends as Ready, not active. The admin reviews the script diff and presses
   **Activate**. No agent can activate or delete a build, or read a secret.

Any other cloud session's agent can only propose an install script change, which admins accept or
dismiss on the page.

### J9. Bringing a cloud thread local, and sending a local thread to cloud

Surfaces: the thread menu and command palette in the Mac app. Milestone: M3.

Both directions show only when Pair Cloud reports it supports them (a capability flag such as
`capabilities.cloudImport`). Both are blocked while a turn is running, and the menu says why.

**Send to cloud.** From a local thread's menu or the command palette, **Continue in cloud** moves
the session to Pair Cloud, whether or not its branch was pushed. The Mac's local server bundles the
branch against its origin merge-base, plus a snapshot commit of uncommitted and untracked files,
and shows a preview with an exclusion list before anything uploads. Pair Cloud imports it into the
project's mirror and starts a cloud session on that branch. The conversation moves as a
[portable handoff](../../user/portable-handoffs.md), with the full transcript, size-capped, as
read-only history on the new thread, so teammates can scroll back. The local thread shows
"Continued in cloud" with a link, and its worktree stays.

Ignored files (the setup script recreates them), earlier checkpoints, terminals, running processes
and the native provider session don't move.

**Bring it local.** From a cloud session's menu, **Continue locally** creates a worktree and a new
local thread on the member's Mac at the machine's current state, starting from a handoff that links
back. If the machine is asleep, Pair uses the snapshot taken before sleep and does not wake it.
When the owner brings it back, the cloud session settles and its machine sleeps. When anyone else
does, they get a copy, and the cloud session stays live for the team.

Open in editor and SSH into a machine are Later.

### J10. A security-minded team evaluates BYOC

Surfaces: docs, the AWS deployment kit, Settings → Cloud, managed policy. Milestone: M5, with
cloud-only mode from M2.

1. The security reviewer reads one page: what runs where, what leaves the account, and which
   credentials a machine holds (owned by [06](./06-credentials-and-security.md) and
   [09](./09-byoc.md)).
2. They see three properties that do not depend on trusting Pair as a company: the code is open,
   Pair Cloud runs in their own account, and the runner dials out, so machines take no inbound
   connections (plan decision 4).
3. They run the deployment kit in their own AWS account (GCP follows). It sets up the VPC, a Pair
   Cloud release, an internal load balancer, the aws-ec2 driver, hourly disk snapshots and KMS keys.
   Machines are EC2 instances in private subnets. Their image is built in the account: at driver
   setup the driver boots stock Ubuntu, runs `provision.sh` and saves an AMI. Pair's CI runs
   `provision.sh` on every release, so a broken script never reaches a customer.
4. Members reach Pair Cloud over the company's VPN or Tailscale by default. An optional public HTTPS
   listener serves only client routes, never `/runner/*`, which only machine networks can reach.
   T3 Connect is off.
5. Pair Cloud is already cloud-only, and the aws-ec2 driver refuses to run on a server that isn't.
   They lock that in with a [managed policy](../../user/managed-policy.md): a new `limits.cloud` key
   that allows only their driver and forces cloud-only, a contract change owned by
   [08](./08-clients-and-contracts.md).
6. What still leaves the account: model calls to the provider, git traffic to GitHub, and push
   titles through Expo and Apple or Google ([Team push notifications](../../operations/team-push.md)).
   Product usage events go to T3 Code unless disabled, and the kit disables them. No Pair company
   service stores their code, transcripts or credentials.

### J11. A Conductor Cloud refugee migrates

Surfaces: install docs, the Mac app, Settings → Team and Settings → Cloud on Pair Cloud. Milestone:
M2 for the replacement, M4 for the Cloud Computer equivalent.

| Conductor                               | Pair                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac app with local and cloud workspaces | The Pair Mac app for local work, connected to Pair Cloud for cloud sessions.                                                                                   |
| Organization, members                   | A Pair Cloud server and invite links, [Team](../../user/team.md).                                                                                              |
| Workspace in cloud                      | A cloud session. Several Conductor chats in one workspace map to several threads for now.                                                                      |
| Cloud Computer and builds               | The team image and builds (M4). Until then, Pair's base image plus each project's setup script.                                                                |
| Repo setup script                       | The project's setup script, which already runs on new worktrees ([ProjectSetupScriptRunner.ts](../../../apps/server/src/project/ProjectSetupScriptRunner.ts)). |
| Personal agent keys                     | Each member's own provider account on Pair Cloud ([Team](../../user/team.md#your-own-provider-account)).                                                       |
| Org shared keys                         | Company accounts: admin-managed provider instances. Pair keeps its explicit-account rule: a company account never silently overrides a member's own.           |
| API and routines                        | `/mcp`, member API tokens, `t3 thread`, and scheduled tasks with webhooks on Pair Cloud ([Agents and automation](../../user/outside-agents.md)).               |

The admin installs Pair Cloud on an always-on VM, adds the Docker driver and the GitHub App, and
invites the team. Members install the Mac app, connect it to Pair Cloud, and add their own provider
accounts there. The Conductor install script goes into the team image (M4), or the project's setup
script before that. There is no transcript import: Conductor stored chats on its servers, and
nothing plans on an export.

## 4. What each milestone lets a user do

| Milestone                               | What a user can do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Journeys unlocked                       | Who notices                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| M0 Seam (landed)                        | Nothing new. Local and worktree threads behave and perform exactly as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None                                    | Nobody, by design.                                                |
| M1 Cloud threads on Docker (landed)     | Nothing released. Built on a team server: the Docker driver, runner, lifecycle, mirror, credentials, and Claude and Codex on machines. Its machinery carries over unchanged into Pair Cloud.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | None released                           | Pair's own integrated passes.                                     |
| M2 Pair Cloud on Docker (first release) | A team installs one always-on, cloud-only Pair Cloud server with Docker machines and the GitHub App. Members keep working locally in the Mac app, connect it and their phone to Pair Cloud, and start a cloud session from a pushed branch on a local project, on their own Claude or Codex or a company account. Teammates join and prompt from web, desktop and mobile, and anyone can start one from the phone. Machines sleep when idle and wake on demand. Scheduled tasks, webhooks, MCP and `t3 thread` on Pair Cloud launch cloud sessions. A team cap the admin sets on the driver, with no member cap. Pushing only to github.com. Desktop servers stop offering Cloud. | J1, J2, J3, J4, J5, J6, J7, most of J11 | The first milestone a Conductor refugee would call a replacement. |
| M3 Continue in cloud                    | Move a local session (unpushed commits, uncommitted files, conversation) to Pair Cloud, bring a cloud session back to a Mac (a non-owner gets a copy), and let local agents start or delegate cloud sessions through the agent link.                                                                                                                                                                                                                                                                                                                                                                                                                                              | J9, J7 for local agents                 | ICs who start locally and share later, without pushing first.     |
| M4 Team images                          | Admins build, version and roll back the machine image, with logs and an admin agent whose builds wait for **Activate**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | J8, rest of J11                         | Admins stop hand-tuning setup scripts.                            |
| M5 BYOC on AWS                          | The aws-ec2 driver and an AWS deployment kit run Pair Cloud and its machines in the customer's account, reached over VPN or Tailscale, with an optional public client listener. GCP follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | J10                                     | Security-conscious companies.                                     |
| Later, by demand                        | Unscheduled: a hosted vendor driver, previews, the opt-in model proxy, cap editing and a member cap, machine hours in usage, choosing a machine size at launch, OpenCode, Grok and Kiro in cloud, the git proxy and other git hosts, SSH and open in editor, Claude through Bedrock.                                                                                                                                                                                                                                                                                                                                                                                              | None                                    | Whoever asks.                                                     |

Cursor (through `@cursor/sdk`) and Muse run inside the server process, so they are "not supported in
cloud" at any milestone (plan decision 2).

## 5. Changes to Pair's product rules

These are proposed amendments to [Product decisions](../decisions.md). They take effect when the
milestone named in each one lands, not before. Pair Cloud is cloud-only from its first release, so
most land at M2.

### "Membership is the trust boundary" (amend at M2)

Today a member who can run agents or terminals has a shell as the server's user. The invite dialog
says "Members can run commands as this server's user" ([InviteMemberDialog.tsx](../../../apps/web/src/components/team/InviteMemberDialog.tsx)).
On a member's own Mac that stays true, and the Mac is theirs. On Pair Cloud no agent runs on the
server's host, so the shell moves to the session's machine. Members are still trusted.

Proposed text:

> **Membership is the trust boundary.** A member who can run agents or terminals can read everything
> the machine running them can read. On a server with local threads, that is the server's user,
> including credentials and the database. On Pair Cloud, which is cloud-only, it is the thread's
> machine, including the thread's provider credential and its git credential, which can be the
> owner's own GitHub token. Anyone can prompt any thread, so any member can reach both. Roles
> prevent accidents, not malice.

What follows from it:

- **Cloud-only mode is real isolation for the server,** provided machines don't share its host
  without a real boundary: Docker on another host through `DOCKER_HOST`, Docker under gVisor, or
  EC2 in M5. No agent or terminal runs on the server, so a member can no longer read the database,
  other members' GitHub tokens or the server's secrets. The simplest M2 install runs plain Docker on
  the same VM, so the install guide says this, and Settings → Cloud's isolation warning covers it.
  The invite dialog on Pair Cloud says "Members can run agents on your team's cloud machines and use
  the provider accounts those threads run on."
- **Invite the team, not the company.** Pair Cloud keeps today's trust level, where everyone sees
  everything, so it is for the people who would share a server today, not the whole engineering
  org.
- **It is not isolation between members.** A member can prompt a teammate's session and ask its
  agent to print the credential it was started with. Plan decision 10 already notes that an agent
  can leak anything its process can read. Private threads stay a non-goal.
- **A Viewer role becomes possible on Pair Cloud, and only there.** A viewer reads threads, diffs
  and usage, and cannot prompt, approve, open terminals or start threads. On a server with local
  threads it stays a non-goal, because reading the filesystem reads credentials. Recommend building
  it only when a team asks.

### "Solo stays T3 Code" (amend at M2)

Proposed text:

> **Solo stays T3 Code.** A server with one member and no compute driver looks and behaves exactly
> like T3 Code, down to the wire. Only a server in cloud-only mode, a Pair Cloud server, offers
> Cloud. A desktop or laptop server never does, and nothing about Cloud reaches its wire.

Team behavior still turns on only with a second active member. A solo developer can run Pair Cloud
for themselves and gets cloud sessions and none of the team UI.

This drops Docker on a laptop. A desktop or other non-cloud-only server that already has cloud
threads keeps their history readable, and refuses new cloud launches with a message pointing at
Pair Cloud. The Docker driver code stays, because Pair Cloud uses it.

### Provider accounts in cloud (add at M2)

Unchanged: a turn runs on the thread's provider account, whoever prompts it. Never switch per
prompter, and never silently. Only the owner picks their own account. Pair does not pool or rotate
personal subscriptions.

Add:

> - Members connect their provider accounts on Pair Cloud, in Settings → Team, separately from
>   their Mac. The Mac's own Claude login, in the keychain or a terminal, cannot serve a cloud
>   machine.
> - A cloud session runs on its owner's own Claude or Codex subscription by default: a setup token,
>   an API key, or a ChatGPT account through the existing broker. A company account (an instance in
>   Settings → Providers) is an option the owner picks, never a silent fallback.
> - When a member picks Cloud with no usable account on Pair Cloud, the client says what to add or
>   offers a company account.
> - A cloud thread's machine receives only its own thread's account credential, in memory, from an
>   allowlisted environment when the provider process starts. It never receives another member's.
>   Pair writes no credential to a machine's disk or image, and sleep keeps no memory. A stopped disk
>   or snapshot still holds code and transcripts, so it is encrypted and deleted with the machine.
> - A Claude setup token (`CLAUDE_CODE_OAUTH_TOKEN`, from the copyable `claude setup-token`
>   command, as Conductor offered) is valid for a year and the agent can read it; Settings says
>   both. Teammates who prompt a shared session spend the owner's subscription, and usage shows per
>   sender.
> - Cloud threads from scheduled tasks and webhooks run on the task owner's account, as other task
>   threads do.
> - Assigning a cloud thread does not move it off the previous owner's account, as today.
> - In a cloud thread the model picker shows Cursor and Muse as "Not supported in cloud".

The setup-token and shared-spend points are accepted risks, already in the user docs
([Cloud threads](../../user/cloud.md#what-agents-in-a-machine-can-read),
[Team](../../user/team.md#your-own-provider-account)). The providers' terms were read as allowing a
member's subscription on their team's own server; [06](./06-credentials-and-security.md) says a
Pair-hosted service would need API keys only. A model proxy for company API keys is a later, opt-in
item, and subscription tokens are never proxied.

### Git credentials in cloud (amend at M2)

This reverses "agents' `gh` never gets the owner's GitHub token" for cloud threads, following Claude
Code's cloud, which accepts a member's own GitHub credential. Members connect GitHub on Pair Cloud,
separately from their Mac. A cloud thread's git gets, for its project remote (and fork, for pull
requests) only, the first of:

1. The GitHub App's one-hour installation token for that repo, when the App is installed on it.
   This stays the recommended setup.
2. The owner's own GitHub: their connected account, or a token from **Use a token instead** on their
   row in Settings → Team (a fine-grained token or `gh auth token`). Pushes go out as the owner,
   whoever prompts. Settings says plainly that the agent can read this token while the owner's cloud
   threads run.
3. Nothing: the thread says "Connect GitHub to push", or "Connect GitHub to clone private repos" when
   a private repo can't be cloned.

Pull requests stay as today. Pair's PR button opens the PR as the member who pressed it, through
their GitHub connection made with the team's App; if GitHub refuses, Pair Cloud's own account opens
it with "Requested by `<name>` via Pair". A PR the agent opens itself with `gh` on the machine uses
the machine's git credential: the installation token, so the App's bot is its author, or without the
App the owner's own token, so the owner is the author and no footer is added.

The git proxy that would keep the owner's token on the server, and other git hosts, are Later. Local
threads keep today's rule.

### Sandbox events and notifications (add at M2 and M4)

Notifications keep going only to the people a thread concerns
([threadNotificationRouting.ts](../../../packages/shared/src/threadNotificationRouting.ts)). A push
still carries the thread title and nothing else. From M2, Pair publishes one mobile build that any
Pair Cloud server can push to, instead of each team building its own as
[Team push notifications](../../operations/team-push.md) describes today.

| Event                                                | Who hears                                      | Push title        | Milestone                   |
| ---------------------------------------------------- | ---------------------------------------------- | ----------------- | --------------------------- |
| Machine failed to start or wake                      | The prompter and the owner, like a failed turn | "Machine failed"  | M1                          |
| Machine started, slept or woke                       | Nobody                                         | none              | M1, M2                      |
| Waiting for a machine at a cap                       | Nobody. The status line says it.               | none              | M1                          |
| Machine discarded after retention                    | Nobody                                         | none              | M2                          |
| Team image build an admin started finished or failed | That admin                                     | "Build 14 failed" | M4                          |
| Agent build ready to activate                        | The admins who wrote the image thread's run    | "Build 15 ready"  | M4                          |
| Turn cut short by a vendor's lifetime limit          | The prompter and the owner, as a failed turn   | "Thread failed"   | Later, with a hosted vendor |

"Machine failed" is a `ThreadNotificationKind` (M1) routed exactly like `failed`. The build push is
the first one not tied to a thread, so it needs its own routing rule. Both are owned by
[08](./08-clients-and-contracts.md).

Timeline rows, team mode only as today: "Machine started from build 14" (M4), "Machine failed:
<reason>", "Machine discarded", and "Continued in cloud" and "Continued locally" (M3). Sleep and wake
get no row; they would fill timelines with noise.

### Rules that stay unchanged

- Everyone on Pair Cloud sees every project and thread
  ([decisions](../decisions.md#members-and-roles)). "Private until shared" cloud sessions would
  contradict that, so they are not offered.
- Anyone can prompt any thread, never hijacking a turn. Queued messages and approvals work as today.
- One owner per thread. Only the owner or an admin deletes it, and only they can **Sleep now** or
  **Discard** its machine (from failed, asleep, or ready with no run). Any member can wake or retry.
- Personal and shared state split as today. A thread's mode and sandbox are shared state.
- Git authorship holds on machines. Only the token rule changes, and only for cloud threads.
- Presence stays in memory and quiet. An open cloud session renews a viewer lease, which only keeps
  its machine awake.
- Usage shows turns and tokens without dollars to members. Machine hours join them when that view
  lands (Later).
- API tokens stay on `/mcp` only. The sandbox token is a different credential and never reaches a
  member or a client.

## 6. Settings and information architecture

Cloud settings live on Pair Cloud, the only server that runs machines. Recommend a top-level
**Settings → Cloud** there, not a subsection of Team: it is about machines rather than people, and
builds and logs need room. The Team page is already dense, and non-admins see it only once the
server has a second member ([team.ts](../../../apps/web/src/state/team.ts),
`useTeamSettingsVisible`). The nav lives in
[SettingsSidebarNav.tsx](../../../apps/web/src/components/settings/SettingsSidebarNav.tsx). A desktop
or other non-cloud-only server shows no Cloud settings beyond a pointer to Pair Cloud.

On Pair Cloud:

| Place                         | What it holds                                                                                                                                                                                     | Admin         | Member                                                                        | Milestone  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- | ---------- |
| Settings → Cloud → Overview   | Cloud-only status, driver status, running and sleeping machines, the active build, the team cap.                                                                                                  | Sees          | Sees, read only                                                               | M1, M2     |
| Settings → Cloud → Compute    | Driver instances (Docker host) with the isolation warning, machine size, base image and machine env vars (M1). Idle and retention periods, and the team cap (M2). Region and the EC2 driver (M5). | Changes       | Hidden, and driver config is redacted from what the server sends members (M2) | M1, M2, M5 |
| Settings → Cloud → Team image | Install script, env and secret references, builds, history, activate, logs.                                                                                                                       | Changes       | Sees the active build and its log                                             | M4         |
| Settings → Projects           | Add a project by repo (checkout and mirror, after the access check), the setup script and project env vars.                                                                                       | Changes       | Adds repos they can access; sees the rest                                     | M2         |
| Settings → Source control     | The GitHub App's App ID and private key.                                                                                                                                                          | Changes       | Hidden                                                                        | M1         |
| Settings → Team, your row     | Your provider accounts, and **Connect GitHub** or **Use a token instead**, with the warnings.                                                                                                     | Own           | Own                                                                           | M1         |
| Settings → Providers          | Company accounts a member can pick for a cloud session.                                                                                                                                           | Changes       | Picks them in the model picker                                                | M1         |
| Settings → Scheduled tasks    | Tasks whose runs are cloud sessions.                                                                                                                                                              | Own tasks     | Own tasks                                                                     | M2         |
| Managed policy                | `limits.cloud`: allowed drivers, forced cloud-only.                                                                                                                                               | Machine owner | n/a                                                                           | M5         |

In the Mac app and on the phone:

| Place                                                   | What it shows                                                                                                                                                                                     | Milestone |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Settings → Environments (Mac app and phone)             | Pair Cloud as its own environment next to the Mac's local server, added with the member's invite link or **Add a device**, with its routes and permissions.                                       | M2        |
| Sidebar (Mac app and web)                               | Cloud sessions next to local threads of the same repo, marked with a cloud icon. Grouping across environments by repository already ships (`SidebarProjectGroupingMode`, default `"repository"`). | M2        |
| Composer, command palette, keybinding (Mac app and web) | **Cloud** on a local project whose origin matches a Pair Cloud project, once Pair Cloud reports it takes cloud launches.                                                                          | M2        |
| New-task screen (phone)                                 | **Cloud** on a Pair Cloud project, or on a local project through the Mac, once the phone is paired with Pair Cloud.                                                                               | M2        |
| Thread menu and command palette (Mac app)               | **Continue in cloud** on a local thread and **Continue locally** on a cloud session, once Pair Cloud reports it supports them.                                                                    | M3        |

Members will see machine hours, not dollars, once the usage view lands (Later), and every member
sees the whole team, because the point is noticing whose work uses the capacity
([TeamUsage.ts](../../../apps/server/src/team/TeamUsage.ts) serves today's numbers). Admins also see
an estimate from the per-driver, per-size rate they enter
([04](./04-sandbox-lifecycle.md#4-caps-quotas-and-usage)); the bill itself stays with the cloud
provider.

Mobile shows cloud status, starts cloud sessions, wakes and retries, and has the read-only
**Settings → Machines** screen ([08](./08-clients-and-contracts.md)). It does not configure drivers,
caps or images, as members already manage accounts on the web.

## 7. Competitive landscape

As of 2026-11-06. Third-party pricing is inconsistent, so treat prices as indicative and see the
[Sources](#sources).

| Product                         | Where compute runs                                                                                                                                            | BYOC or self-host                                                                                                                 | Multiplayer                                                                                | Mobile                                                           | Providers                                                                                               | Pricing model                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Conductor Cloud**             | One Vercel Sandbox microVM per workspace, us-east-1                                                                                                           | No; "Not yet", Enterprise talk only                                                                                               | Yes, on the invite-only Team plan                                                          | iOS app announced, not released                                  | Claude Code, Codex, Cursor, OpenCode                                                                    | Pro, Team, Enterprise plans; no extra cloud fee at launch. Shutting down per reports.                    |
| **OpenAI Codex cloud**          | OpenAI-hosted workspace per task, from a saved environment                                                                                                    | None found                                                                                                                        | Environments shared with the org or private; no shared live sessions found                 | ChatGPT mobile app                                               | Codex only                                                                                              | Draws on the ChatGPT plan's usage allowance; token-based credits since 2026 (third-party)                |
| **Claude Code on the web**      | Anthropic-hosted, or self-hosted runners (public beta, 2026-08-06)                                                                                            | Self-hosted runners in the customer's network for Team and Enterprise; prompts still go to Anthropic for inference                | Shared runner infrastructure; live session sharing not verified                            | Claude app, Code tab                                             | Claude only                                                                                             | Counts against the Claude plan                                                                           |
| **Cursor cloud agents**         | Cursor-hosted VMs, or self-hosted workers (2026-03-25) and self-hosted machine pools (2026-09, unverified)                                                    | Workers dial out over HTTPS; the agent loop and inference stay in Cursor's cloud                                                  | Team plans; shared live sessions not verified                                              | Not verified                                                     | Cursor's harness, many models                                                                           | Model usage billed per request; compute pricing unclear (third-party)                                    |
| **GitHub Copilot coding agent** | GitHub Actions runners                                                                                                                                        | Self-hosted runners through ARC only, Ubuntu x64, native firewall off                                                             | Asynchronous, through issues and PRs                                                       | GitHub Mobile (inferred)                                         | Copilot's harness                                                                                       | One premium request per session plus Actions minutes                                                     |
| **Devin**                       | Cognition-hosted                                                                                                                                              | VPC deployment on Enterprise                                                                                                      | Team plans, Slack-driven (inferred)                                                        | Not verified                                                     | Devin only                                                                                              | ACU-based; published rates conflict                                                                      |
| **Ona (formerly Gitpod)**       | Ona Cloud, or runners in the customer's AWS (ECS and EC2) or GCP (Compute Engine)                                                                             | Customer-VPC runners on Enterprise; code and credentials stay in the account                                                      | Not verified                                                                               | Not verified                                                     | Ona's agent; a connected ChatGPT account for Codex                                                      | OCUs on Core (a 4 vCPU / 16 GB machine is 1 OCU an hour); credits on Enterprise                          |
| **Coder**                       | The customer's own infrastructure                                                                                                                             | Fully self-hosted, open source core; air-gapped possible                                                                          | Workspace-based; not verified for agents                                                   | No                                                               | Coder Tasks runs third-party agents such as Claude Code; Coder Agents (beta, 2026-05) is model-agnostic | Open source plus paid Premium                                                                            |
| **Pair Cloud (planned)**        | Local work on each member's Mac; cloud sessions on Docker machines driven by the team's Pair Cloud server (M2), then EC2 in the customer's AWS (M5), then GCP | Yes: Pair Cloud, the control plane, runs in an account the team controls, and its machines move into the customer's account at M5 | Yes: shared live threads, attribution, queue-by-default, approvals by any member, presence | iOS and Android, one Pair build any Pair Cloud server can notify | Claude and Codex; not Cursor or Muse; others later                                                      | Free and open source; the team pays for its Pair Cloud VM, its machines and its model providers directly |

Fletcher Richman also names Paradev, Amp, replicas.dev and Typed as true Conductor Cloud
replacements ([market signals](../market-signals.md)). We have not researched them.

### Where Pair wins

- **Nobody else self-hosts the control plane and offers multiplayer.** Claude Code, Cursor, Copilot
  and Ona let the compute run in the customer's network, but the sessions, transcripts and agent
  loop stay in the vendor's cloud. Coder self-hosts everything but is a dev-environment platform, not
  a multiplayer agent UI.
- **Several providers in one thread list.** First-party products run their own model. Pair runs the
  real Claude Code and Codex CLIs, on each member's own subscription, side by side.
- **Real multiplayer.** Shared live threads with queueing, Steer now, attribution and routed push are
  shipped, not planned ([pair-features](../pair-features.md)).
- **Local first, cloud when you share.** The Mac app keeps local work local and shows cloud sessions
  next to it, and sessions move between the two at M3. MIT-licensed, too.
- **Compute choice.** Docker on a box you have, or VMs in your own AWS account, behind one driver
  interface. Vendor risk is a driver swap, not a migration.

### Where Pair is weaker

- **Someone has to run Pair Cloud.** There is no sign-up-and-go, and a Pair-hosted control plane is
  not planned (sections 8 and 10).
- **A cloud session needs a pushed branch until M3.** Moving unpushed work and a conversation to the
  cloud comes with Continue in cloud.
- **No polished first-party machine.** OpenAI's environments and Conductor's admin agent set up a
  repo for you. Pair's image tooling arrives at M4.
- **Durability is the team's job.** Hourly snapshots of Pair Cloud's data volume mean a restore can
  lose up to an hour of session history.
- **No SLA, SSO or central billing.** SSO and billing are standing non-goals.
- **Agents can read their credentials.** The provider credential and a member's own git token reach
  the machine in memory. The model proxy and git proxy that would close that are Later.
- **Linux only,** and pushing only to github.com.

## 8. Packaging and cost

Pair is open source and self-hosted. Pair Cloud runs in an account the team controls, so the bill is
the team's: one always-on VM for Pair Cloud, plus its machines. With BYOC both are in the team's own
AWS account. Model spend goes to the providers directly.

| Option                             | What the team gets                                                                                           | What we take on                                                               | Fit                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Free and self-hosted**        | Everything in this plan. The team pays for its Pair Cloud VM, its machines and its model providers directly. | Nothing beyond the open-source project.                                       | Matches "open at the core" and the "won't get bought" ask.                                                                                                                                                                                  |
| **B. Pair-hosted Pair Cloud**      | We run a Pair Cloud server per team.                                                                         | Uptime, data custody, on-call, billing, abuse handling. It becomes a company. | Not planned. Pair Cloud runs in an account the team controls, a multi-tenant Pair-hosted control plane is rejected, and a Pair-hosted service could use API keys only, not members' subscriptions ([06](./06-credentials-and-security.md)). |
| **C. Support and deployment help** | A, plus help deploying BYOC, a response-time promise and priority fixes.                                     | People time.                                                                  | Security-conscious companies at M5.                                                                                                                                                                                                         |

Recommendation: ship A, offer C informally to the first BYOC teams, and don't build B. This is a
business decision for maintainers, not a technical one.

### What a team should expect to pay

From the usage model in [04](./04-sandbox-lifecycle.md): a team of 10 starts 20 cloud sessions a
day over 22 working days, at 8 vCPU and 16 GB each, each busy 1.5 hours and idle 1 hour before it
sleeps.

| Piece             | M2, Docker                                                                                                                                   | M5, BYOC on AWS                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Pair Cloud server | One always-on VM the team runs. It holds orchestration, provider adapters, the event store and the mirrors, not agents.                      | One instance in the team's account, plus an internal load balancer and hourly snapshots.                                   |
| Machines          | A Docker host. Idle machines cost only memory on it. For this model, one 48-core server, roughly $250 to $400 a month rented (inferred, 04). | EC2 instances, billed by AWS while they run; a sleeping machine costs only its disk ([09](./09-byoc.md)). No estimate yet. |
| Models            | Each member's own subscription, or the company's accounts.                                                                                   | Same.                                                                                                                      |

On Docker, the idle timeout and the machine size decide how many sessions fit on the box. On EC2
they decide the bill. Sleep keeps these numbers honest: M1 stops a Docker machine only once all its
threads are settled or archived, and M2 adds idle sleep. The hosted vendor figures in 04 (Vercel
Sandbox about $620 and E2B about $740 a month for this model) stay as reference for a Later hosted
driver.

## 9. Success metrics

Targets are recommendations to revisit after the first month of dogfooding. "Time to first token"
is from the member pressing Send to the first streamed agent output.

| Milestone | Metric                                                                          | Target                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Local turn and terminal latency vs. main                                        | No regression beyond noise in the existing perf checks ([performance-regressions](../../internals/performance-regressions.md)).                                 |
| M2        | Local git p50, `feat/pair` head vs. main                                        | Within noise, or the measured gap of about 15% explained, before M2 ships.                                                                                      |
| M2        | Time to first token, ready cloud session vs. a local worktree thread            | Within 300 ms at p50.                                                                                                                                           |
| M2        | Docker machine from Send to runner connected, image cached, before setup script | p50 under 5 s.                                                                                                                                                  |
| M2        | Concurrent machines one Pair Cloud server drives                                | 30, proven by a load test (N loopback runners, one saturating PTY, one concurrent bundle) before M2 ships, with no rise in p95 event latency for other threads. |
| M2        | Time to first token from asleep                                                 | p50 under 20 s, p95 under 45 s.                                                                                                                                 |
| M2        | Cloud sessions that fail to start                                               | Under 2%, each with a readable reason.                                                                                                                          |
| M2        | Share of machine hours spent idle and awake                                     | Under 25%.                                                                                                                                                      |
| M2        | Adoption on the dogfood team                                                    | 30% of new threads are cloud sessions within two weeks.                                                                                                         |
| M2        | Outside teams running Pair Cloud                                                | 1.                                                                                                                                                              |
| M3        | Moves between local and cloud completing without manual git                     | 95%.                                                                                                                                                            |
| M4        | New cloud sessions whose setup script fails                                     | Under 5%.                                                                                                                                                       |
| M5        | Time for a new team to deploy BYOC with the kit                                 | Under 2 hours.                                                                                                                                                  |
| M5        | BYOC teams in production                                                        | 2.                                                                                                                                                              |

Cost is tracked as machine hours per member per week, and idle share, from the usage intervals the
server already records. There is no dollar target; teams set budgets with caps, size and the idle
timeout.

## 10. Non-goals

- **Pooling or rotating teammates' subscriptions.** Unchanged from
  [decisions](../decisions.md#non-goals).
- **One-way file sync to a laptop.** Conductor had it. Bringing a session back to the Mac (M3)
  covers the need with less machinery.
- **Windows and macOS machines.** Machines are Linux. Device work keeps using device hosts
  ([DeviceHost.ts](../../../apps/server/src/device/DeviceHost.ts)).
- **GPU machines, and Pair-run compute.** We never resell machines.
- **A full T3 server inside each machine** (plan decision 2), and **live migration of a running
  turn**.
- **A multi-tenant, Pair-hosted control plane.** Pair Cloud runs in an account the team controls.
- **Mixed-mode servers.** A server runs local agents (the Mac's local server) or cloud machines
  (Pair Cloud), never both. The local server never orchestrates cloud machines.
- **Syncing threads between servers.** The local server and Pair Cloud each keep their own threads.
  Moving a session (M3) copies its code and conversation; nothing stays in sync.
- **Private threads, per-project permissions and several teams on one server.** Unchanged, including
  on Pair Cloud.

## Open questions

1. **Should members see the cost estimate?** Recommend no. Members see hours, matching the token
   usage rule; admins see the estimate. Decide when the usage view lands.
2. **Who hears that an agent build is ready?** Recommend only the admins who wrote that image
   thread's run. Other admins see it under History, with no push.
3. **Viewer role on Pair Cloud?** Recommend not building it until a team asks. Keep the design so it
   stays possible.
4. **Should the GitHub App's installation token serve PR list and panel reads where the App is
   installed?** Today `GitHubRequestPolicy` needs Pair Cloud's own GitHub sign-in, so a team with
   only the App sees "GitHub has no working credential for this host" in the PR panel.
5. **Do BYOC customers want their own Bedrock or Vertex model access?** Claude through Bedrock is
   Later until one asks.
6. **Other git hosts.** Only github.com is supported, so GitHub Enterprise Server and in-VPC GitLab
   customers are blocked.
7. **Offboarding.** Removing someone from Pair Cloud stays manual until a GitHub org-membership check
   lands.
8. **Fork workflows.** Matching projects by origin key can fail a launch with `base-ref-missing` when
   it doesn't name the branch's remote.
9. **Upgrades.** Every Pair Cloud upgrade still interrupts running agents, because adapters run on
   the server. Draining before an upgrade limits the damage, not the interruption.

## Challenges to the plan

1. **"No agent runs on Pair Cloud's host" holds only when machines don't share it.** The simplest M2
   install runs plain Docker on the same VM, where an agent can reach the host's kernel and Docker
   network. Section 5 states the condition. Recommend the install guide default to gVisor or a
   separate Docker host.

Settled during the rewrite: a cloud-only server is never an Auto balance or machine-picker candidate
for local modes and is reached only through **Cloud**
([08](./08-clients-and-contracts.md)); `defaultsToCloud` has no reader once only cloud-only servers
offer Cloud, so M2 stops offering it, and defaulting a local project to Cloud is Later; the phone
shows **Cloud** from the `cloudLaunch` flag instead of prompting.

Cloud-only mode protects the server's machine, not members from each other (section 5). That point
stays in this doc's text rather than the plan.

## Sources

Pair and Conductor: see [Conductor Cloud and Pair's path to parity](../conductor-cloud.md#sources)
and [market signals](../market-signals.md). Checked 2026-11-06 unless dated.

Competitors:

- [Codex cloud docs, OpenAI](https://learn.chatgpt.com/docs/cloud)
- [Codex pricing 2026, uibakery.io](https://uibakery.io/blog/openai-codex-pricing) (third-party)
- [Run Claude Code sessions on your own compute, Anthropic, 2026-08-06](https://claude.com/resources/articles/run-claude-code-sessions-on-your-own-compute)
- [Claude Code on mobile, Anthropic docs](https://code.claude.com/docs/en/mobile)
- [Self-hosted cloud agents, Cursor, 2026-03-25](https://cursor.com/blog/self-hosted-cloud-agents)
- [Cursor self-hosted coding agents, The New Stack](https://thenewstack.io/cursor-self-hosted-coding-agents/) (third-party)
- [Cursor self-hosted machines, 2026-09-02, vpsranking.com](https://vpsranking.com/news/ai/ai-2026-09-02-cursor-self-hosted-machines/) (third-party, unverified)
- [Cursor pricing explained, jetadmin.io](https://www.jetadmin.io/blog/cursor-pricing-explained-plans-credit-system-and-real-costs-in-2026/) (third-party)
- [Copilot coding agent supports self-hosted runners, GitHub changelog, 2025-10-28](https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-supports-self-hosted-runners)
- [Customizing the coding agent's environment, GitHub docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment)
- [About billing for GitHub Copilot, GitHub docs](https://docs.github.com/en/enterprise-cloud@latest/billing/managing-billing-for-github-copilot/about-billing-for-github-copilot)
- [Devin pricing and rate limits, usagebar.com](https://usagebar.com/blog/devin-pricing-and-rate-limits) (third-party, conflicting)
- [Ona runners overview](https://ona.com/docs/ona/runners/overview.md)
- [Ona GCP runners](https://ona.com/docs/ona/runners/gcp/overview)
- [Ona usage and OCUs](https://ona.com/docs/ona/billing/usage)
- [Coder Tasks docs](https://coder.com/docs/@v2.36.3/ai-coder/tasks)
- [Introducing Coder Agents, 2026-05-06](https://coder.com/blog/introducing-coder-agents)
