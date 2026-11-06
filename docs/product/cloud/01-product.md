# Pair Cloud: product

Status: proposal, 2026-11-06. Nothing here is built. This page says who Pair Cloud is for, what they
can do at each milestone, which product rules change, and how it compares. It follows the shared
decisions, milestones and words in the [plan](./README.md). The research behind it is in
[Conductor Cloud and Pair's path to parity](../conductor-cloud.md).

## 1. Problem and timing

### Why teams want cloud agents

| Need | What breaks today | What a cloud thread changes |
| ---- | ----------------- | --------------------------- |
| Parallelism | Every thread on a team server shares one machine's CPU, RAM and disk. Ten people running three agents each, with test suites and dev servers, saturate it. | Each cloud thread gets its own machine. The team server only coordinates. |
| Isolation | Worktrees keep checkouts apart, but every agent runs as the server's user, shares ports, and can read every other checkout and the database. | An agent sees only its own sandbox. A runaway `rm -rf` or a port clash stays in one thread. |
| Laptop-closed work | On a desktop-hosted server, closing the lid stops the agents. | Agents run on sandboxes driven by an always-on team server. |
| Phone-driven work | Already works when the team server is reachable (see [pair-features](../pair-features.md)). | Unchanged, plus starting and waking cloud threads from the phone. |
| Clean, repeatable machines | The team server accumulates whatever anyone installed on it. | Every cloud thread boots from the same team image build. |

The first row is the one teams lead with. Pulkit Gupta's team went from about 5 to 90+ PRs a day
when Conductor launched cloud, because many agents ran at once in isolated VMs
([market signals](../market-signals.md)). Pair's own follow-ups already list "a concurrency cap or
spreading work across servers" ([decisions](../decisions.md#open-follow-ups)).

Linked environments and **Auto balance** already spread new threads across several connected
servers ([Remote access](../../user/remote-access.md#balance-new-threads-across-machines)), but each
server has its own members and state, so that is not one team server with many machines behind it.

### Why now

What is confirmed and what is not:

| Claim | Status |
| ----- | ------ |
| Conductor is joining Meta. | Announced by Charlie Holtz on 2026-11-04, per [market signals](../market-signals.md). Our web search on 2026-11-06 found no independent press coverage yet. |
| Conductor Cloud sign-ups closed 2026-11-04, read-only 2026-11-13, shutdown 2026-11-20. | Secondary reports only. No Conductor source confirms the dates ([conductor-cloud](../conductor-cloud.md)). |
| Teams are looking for a Conductor Cloud replacement. | Public posts by Pulkit Gupta, Fletcher Richman and Fred Rivett, quoted in [market signals](../market-signals.md). |
| Conductor never shipped bring-your-own-cloud. | Its FAQ answered "Not yet" ([conductor-cloud](../conductor-cloud.md)). |

The honest timing: if the shutdown dates hold, Conductor Cloud is gone before Pair can ship M1. The
refugees who matter are the ones who move to a stopgap now and keep looking for something they
won't lose again. "Won't get bought by Meta" is on Fred Rivett's list. Being open source and
self-hosted is the answer, and BYOC turns it into something Conductor could not offer.

## 2. Who it's for

Pair's users are teams of about 8–10 sharing one server ([pair-features](../pair-features.md)).

| Persona | Who they are | What they want from cloud | What worries them |
| ------- | ------------ | ------------------------- | ----------------- |
| **Admin** | The person who runs the team server and holds `t3 member` on the host. Often a tech lead. | Turn cloud on once, set caps, keep the team image working, know what it costs. | Surprise bills, a broken image blocking everyone, being on call for it. |
| **IC** | A member who starts five to fifteen threads a day across a few repos. | More agents at once without slowing teammates, a dev server per thread, review diffs anywhere. | Waiting for a machine, losing work when a sandbox sleeps, a cloud thread that behaves differently from local. |
| **Phone-first** | Any member away from a desk: commuting, in meetings, on call. | Start a thread, approve a request and read a diff from the phone, with the laptop closed. | A push that says nothing, a thread that silently stalled. |
| **Automation owner** | A member whose scheduled tasks, webhooks, CI jobs or outside agents launch threads through `/mcp` or `t3 thread`. | Fan out many unattended threads that don't fight for one box, each with a clean machine. | Runaway cost, tasks stuck behind a cap, no way to tell why a run failed. |
| **Security reviewer** | The person at a security-conscious company who must approve where code and credentials live. | Code, credentials and agent processes in the company's own cloud account, behind its network rules. | Any third party holding code or long-lived secrets, agents with shell on a shared server. |

A Conductor refugee is an admin and a few ICs who judge Pair on UI/UX first.

## 3. User journeys

Each journey lists the surfaces involved and what the UI shows. Status words follow the sandbox
states in the [plan](./README.md) (decision 6). The UI shows them as follows, everywhere: the thread
header, the sidebar row (an icon only), the mobile thread screen, and `t3 thread` output.

| Sandbox state | Runner | What the UI says | What the composer does |
| ------------- | ------ | ---------------- | ---------------------- |
| `provisioning` | any | "Starting machine" with the step: creating, cloning, running setup | Accepts a message and queues it until ready. |
| (no sandbox yet, cap reached) | n/a | "Waiting for a machine: 3 of 3 running" | Accepts a message and queues it. |
| `ready` | connected | Nothing. A cloud icon marks the thread mode. | Normal. |
| `ready` | disconnected | A quiet dot, then "Reconnecting to machine" after 2 s | Queues. |
| `sleeping` | n/a | "Asleep" with a **Wake** action | Sending wakes it and queues the message. |
| `waking` | any | "Waking machine" | Queues. |
| `failed` | n/a | The error in one line, with **Retry** and **Discard** | Disabled until Retry. |
| `destroyed` | n/a | "Machine discarded". Transcript and diffs still readable. | **Start a new machine** focuses it; sending provisions. |

No state animates continuously. A static icon and a line of text change when the state changes, per
the "no continuously repainting animations" rule in [AGENTS.md](../../../AGENTS.md).

### J1. An admin enables cloud for the first time

Surfaces: web or desktop. CLI for headless servers. Milestone: M1 (Docker, on macOS and Linux team
servers), M2 (hosted vendor).

1. The admin opens **Settings → Cloud** (see [section 6](#6-settings-and-information-architecture)).
   It says what cloud does and that nothing changes until a driver is set.
2. They add a compute driver. A server can hold several, with one default per project. M1 offers
   Docker on this machine or on another host through `DOCKER_HOST`, after checking that the server can reach it. Plain runc is not a security boundary,
   so the page recommends rootless Docker or gVisor and says when neither is in use. M2 adds the
   hosted vendor (Vercel Sandbox is recommended), which asks for an API key and a region. A hosted
   vendor needs a team server its sandboxes can reach. One reachable only over Tailscale works with
   Docker and with BYOC in a routed network, and the page says so before offering a vendor.
3. Optionally, and recommended for teams, they add the GitHub App private key in **Settings →
   Source Control**. Cloud threads then push with one-hour tokens for a single repo, and agent pull
   requests show as the app's bot. Without it, each thread pushes with its owner's own GitHub
   (section 5). Until M3, pushing from a cloud thread works only with GitHub.
4. They set a machine size and which projects may use cloud. Caps come from server config and show
   read only until M2: a team cap of `floor(host vCPUs / 4)` on Docker or 20 on a hosted vendor, 10
   starts a minute, and no member cap. In M2 admins can raise them and add a member cap
   ([04](./04-sandbox-lifecycle.md#4-caps-quotas-and-usage)).
5. **Test** boots one sandbox from Pair's published base image (`t3-sandbox:<version>`; a
   `sandbox.baseImage` setting points at a mirror), connects the runner, runs `git --version`
   and the project's setup script, then discards it. The result shows each step's time.
6. On save, members' composers offer **Cloud** next to Current checkout and New worktree.

On a solo server the same page works. The owner is the admin.

### J2. A member starts a cloud thread on web or desktop

Surfaces: web, desktop, command palette, keybinding. Milestone: M1.

1. In the composer's mode picker the member picks **Cloud**, or uses the command palette's "New cloud
   thread" or its keybinding. A project can default to Cloud (`defaultsToCloud`).
2. They type the prompt and send. The thread appears in the sidebar right away with a cloud icon.
3. The header shows "Starting machine: cloning" then "running setup". The message waits as queued.
4. When the runner connects, the turn starts. Streaming, approvals, terminals, diffs, Git actions and
   **Commit, push & create PR** work as in a worktree thread. At a cap, the thread waits visibly. If
   no push credential exists, the thread says "Connect GitHub to push" and links to the owner's row.
5. A side chat or fork of the thread shares its machine, as it shares a worktree today. The machine
   is discarded only when no thread uses it.

### J3. A member starts a cloud thread from the phone

Surfaces: mobile. Milestone: M1.

1. In the new-task screen the member picks the project and **Cloud** as the mode. Mobile shows Cloud
   only when the server has a driver, so older clients and servers without one see nothing new.
2. They send. The thread screen shows the same status line as the web.
3. They can lock the phone. A push comes only for what concerns them: an approval, input, completion
   or failure ([decisions](../decisions.md#presence-and-notifications)).

### J4. A teammate joins and prompts a cloud thread

Surfaces: all. Milestone: M1.

Nothing about multiplayer changes. The teammate opens the thread from the Team shelf, sees the
owner's avatar and presence, and sends. If the owner's turn is running, the message queues, and
**Steer now** stays the deliberate interrupt. The turn runs on the thread's provider account, as
today. If the sandbox is asleep, sending wakes it, the header says "Waking machine", and the message
queues. The teammate can open the thread's terminal, which runs in the sandbox.

### J5. Walking away and approving from the phone

Surfaces: desktop, then mobile push. Milestone: M1, given an always-on team server.

An IC starts three cloud threads at their desk and closes the laptop. The agents keep working,
because the laptop was only a client. One thread needs approval, so the prompter and owner get
"Approval needed" with the thread title only. The IC opens the push, reads the request and the diff
so far, and approves. The card records who answered.

This journey depends on the team server being always on (plan decision 1). On a desktop-bundled
server the provider adapters run inside the desktop app, so closing the laptop stops cloud turns too.
The cloud settings page says this when the server is the desktop app's own.

### J6. A thread sleeps and wakes

Surfaces: all. Milestone: M2.

1. After the idle period with no running turn, terminal activity or viewer, the sandbox sleeps. Files
   survive. Running processes, such as a dev server, do not.
2. The sidebar row and header show "Asleep", with no timeline row and no push. Anyone can still
   read the transcript and review diffs, because checkpoints are mirrored (plan decision 11).
3. Opening the thread wakes it, and so do sending a message, **Wake**, typing in a terminal, opening
   a preview, restoring a checkpoint, and an API call that needs the machine. The sidebar, push, search
   diffs from the mirror and viewing a terminal never wake it ([04](./04-sandbox-lifecycle.md#2-idle-policy-and-wake-triggers)).
4. "Waking machine" shows until the runner reconnects. Then the queued message sends. A preview that
   was running shows "Stopped while asleep" with a **Restart** action.
5. If waking fails, the header shows the error with **Retry** and **Discard**. The prompter and owner
   get a "Machine failed" push.

### J7. A scheduled task or webhook launches a cloud thread

Surfaces: Settings → Scheduled tasks, project webhook automations, MCP, `t3 thread`. Milestone: M2
for scheduled tasks and webhooks. M1 for MCP and the CLI.

1. The automation owner edits a task and picks **Cloud** as its workspace choice. Today that choice
   is `root`, `existing_worktree` or `worktree` (`OrchestrationV2ThreadLaunchWorkspaceStrategy` in
   [orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts), used by
   [scheduledTask.ts](../../../packages/contracts/src/scheduledTask.ts)). Cloud is a fourth.
2. A webhook arrives. The task creates a cloud thread owned by the task's owner, on the owner's
   provider account.
3. The run counts against the team cap. At the cap it waits, and the task's run history says
   "waiting for a machine" rather than failing.
4. When the turn ends, the sandbox follows the normal idle policy. The task can set "discard the
   machine when the run settles" for fire-and-forget work.
5. An agent, in a Pair thread or outside with an API token, does the same through the `/mcp` launch
   tools or `t3 thread` (the flag is owned by [08](./08-clients-and-contracts.md)). Fan-out to many
   cloud threads works as it does for worktrees. At the cap the launch succeeds and the child waits,
   so an agent never gets a confusing failure from a busy team. This part ships in M1.

### J8. An admin updates the team image and rolls back a bad build

Surfaces: web or desktop, Settings → Cloud → Team image, and an image thread. Milestone: M3.

1. The admin edits the install script, for example to add a Postgres client, and presses **Build**.
2. The build runs in a sandbox. Its log streams on the page. The admin can leave. When it finishes,
   that admin gets "Build 14 succeeded" or "Build 14 failed". A build an admin starts activates when
   it succeeds, and new cloud threads boot from it. Existing ones keep their build.
3. The next morning, ICs report that `pnpm` is missing in new threads. The admin opens **History**,
   picks build 13 and presses **Activate**. New threads use 13 at once. No rebuild is needed.
4. To fix it, the admin presses **Edit with an agent**, which opens an image thread, and asks:
   "Build 14 dropped pnpm, fix the install script and build." The agent can edit and build only
   while every human who wrote the current run is an active admin, checked on every call. A
   teammate's queued message or **Steer now** takes that authority away
   ([05](./05-team-images.md#7-the-admin-agent)).
5. The agent's build 15 ends as Ready, not active. The admin reviews the script diff and presses
   **Activate**. No agent can activate or delete a build, or read a secret.

Any other cloud thread's agent can only propose an install script change, which admins accept or
dismiss on the page.

### J9. Bringing a cloud thread local, and sending a local thread to cloud

Surfaces: thread menu, command palette, desktop. Milestone: M4.

**Bring it local.** From a cloud thread's menu, **Continue locally** creates a worktree on the team
server, or on the member's own desktop server when they pick it, at the sandbox's current state. The
thread switches mode and keeps its history. The sandbox sleeps and is discarded after the retention
period. If the sandbox is asleep, Pair uses the mirrored checkpoint and does not wake it.

**Send to cloud.** From a local or worktree thread's menu, **Continue in cloud** starts a sandbox on
the thread's branch with its uncommitted changes carried over. The provider session continues if
the provider can resume it on another machine, otherwise through a
[portable handoff](../../user/portable-handoffs.md). Both directions are blocked while a turn is
running, and the menu says why.

**Open in editor and SSH.** From the same menu, **Open in editor** opens the sandbox over SSH in
the member's editor, through the team server. Clients never connect to a sandbox directly (plan
decision 1).

### J10. A security-minded team evaluates BYOC

Surfaces: docs, the deployment kit, Settings → Cloud, managed policy. Milestone: M5, with parts at
M1 and M4.

1. The security reviewer reads one page: what runs where, what leaves the account, and which
   credentials a sandbox holds (owned by [06](./06-credentials-and-security.md) and
   [09](./09-byoc.md)).
2. They see three properties that do not depend on trusting Pair as a company: the code is open,
   the team server runs where they choose, and the runner dials out, so sandboxes need no inbound
   port in their VPC (plan decision 4).
3. They run the deployment kit in their own AWS account (GCP follows). It installs a team server
   release and a plain-VM compute driver on EC2, so both the control plane and the sandboxes live in
   the account. A team server reachable only over Tailscale works here when the sandboxes' network
   routes to it, but could never use a hosted vendor.
4. They turn on cloud-only mode (M4), so no agent or terminal runs on the team server's machine.
5. They lock it in with a [managed policy](../../user/managed-policy.md): a new `limits.cloud` key
   that allows only their driver and forces cloud-only, a contract change owned by
   [08](./08-clients-and-contracts.md).
6. What still leaves the account: model calls to the provider and git traffic to the git host. No
   Pair company service is in the path.

### J11. A Conductor Cloud refugee migrates

Surfaces: install docs, Settings → Team, Settings → Cloud. Milestone: M1 for the basics, M2 for the
full experience, M3 for the Cloud Computer equivalent.

| Conductor | Pair |
| --------- | ---- |
| Organization, members | A team server and invite links, [Team](../../user/team.md). |
| Workspace in cloud | A cloud thread. Several Conductor chats in one workspace map to several threads for now. |
| Cloud Computer and builds | The team image and builds (M3). Until then, the default image plus each project's setup script. |
| Repo setup script | The project's setup script, which already runs on new worktrees ([ProjectSetupScriptRunner.ts](../../../apps/server/src/project/ProjectSetupScriptRunner.ts)). |
| Personal agent keys | Each member's own provider account ([Team](../../user/team.md#your-own-provider-account)). |
| Org shared keys | Admin-managed provider instances. Pair keeps its explicit-account rule: a shared key never silently overrides a member's account. |
| API and routines | `/mcp`, member API tokens, `t3 thread`, and scheduled tasks with webhooks ([Agents and automation](../../user/outside-agents.md)). |

The admin installs a team server on an always-on machine, invites the team and turns on cloud.
The Conductor install script goes into the team image (M3), or the project's setup script before
that. Members add their own provider accounts on the web. There is no transcript import: Conductor
stored chats on its servers, and nothing plans on an export.

## 4. What each milestone lets a user do

| Milestone | What a user can do | Journeys unlocked | Who notices |
| --------- | ------------------ | ----------------- | ----------- |
| M0 Seam | Nothing new. Local and worktree threads behave and perform exactly as before. | None | Nobody, by design. |
| M1 Cloud threads on Docker | An admin enables Docker, here or on another host through `DOCKER_HOST`. Members push with their connected GitHub or their own token; the GitHub App key in Settings → Source Control is optional. Default caps apply, shown read only, with no member cap. Anyone starts a cloud thread on web, desktop, mobile, MCP or the CLI. Claude and Codex turns, terminals, side chats and forks on the same machine, git, diffs and GitHub pull requests work. Pushing works only with GitHub. | J1 (Docker), J2, J3, J4, J5, J7 via MCP and CLI | ICs get isolation and caps; a second Docker host gives parallelism beyond the team server. |
| M2 Lifecycle and a hosted driver | Sandboxes sleep and wake. Previews work. Caps become editable and usage shows in Settings. The hosted vendor ships (Vercel Sandbox recommended, E2B runner-up; the maintainers choose), with an opt-in model proxy. Scheduled tasks and webhooks launch cloud threads. | J1 (hosted), J6, J7, most of J11 | The first milestone a Conductor refugee would call a replacement. |
| M3 Team images | Admins build, version and roll back the image, with logs and an admin agent whose builds wait for **Activate**. Other git hosts push through the server's git proxy. OpenCode, Grok and Kiro work in cloud. | J8, rest of J11 | Admins stop hand-tuning setup scripts; non-GitHub teams can push. |
| M4 Access and trust | SSH and open-in-editor, moving threads between local and cloud, and a cloud-only server mode. | J9, J10 in part | Power users, and security reviewers for the first time. |
| M5 BYOC | A plain-VM driver and a deployment kit for the team server and sandboxes in the customer's own AWS, then GCP, account. | J10 | Security-conscious companies. |

Cursor (through `@cursor/sdk`) and Muse run inside the server process, so they are "not supported in
cloud" at any milestone (plan decision 2).

## 5. Changes to Pair's product rules

These are proposed amendments to [Product decisions](../decisions.md). They take effect when the
milestone named in each one lands, not before.

### "Membership is the trust boundary" (amend at M4)

Today a member who can run agents or terminals has a shell as the server's user. The invite dialog
says "Members can run commands as this server's user" ([InviteMemberDialog.tsx](../../../apps/web/src/components/team/InviteMemberDialog.tsx)).
Cloud changes where that shell is, not whether members are trusted.

Proposed text:

> **Membership is the trust boundary.** A member who can run agents or terminals can read everything
> the machine running them can read. On a server with local threads, that is the server's user,
> including credentials and the database. On a cloud-only server, it is the thread's sandbox,
> including the thread's provider credential and its git credential, which can be the owner's own
> GitHub token until M3. Anyone can prompt any thread, so any member can reach both. Roles prevent accidents, not
> malice.

What follows from it:

- **Cloud-only mode is real isolation for the server,** provided no driver runs sandboxes on the
  server's own machine. No agent or terminal runs there, so a member can no longer read the
  database, other members' GitHub tokens or the server's secrets. The invite dialog on a cloud-only server says "Members can run agents on
  your team's cloud machines and use the provider accounts those threads run on."
- **It is not isolation between members.** A member can prompt a teammate's thread and ask its
  agent to print the credential it was started with. Plan decision 10 already notes that an agent can
  leak anything its process can read. Private threads stay a non-goal.
- **A Viewer role becomes possible on a cloud-only server, and only there.** A viewer reads threads,
  diffs and usage, and cannot prompt, approve, open terminals or start threads. On a server with
  local threads it stays a non-goal, because reading the filesystem reads credentials. Recommend
  building it only when a team asks.

### "Solo stays T3 Code" (clarify at M1)

Proposed text:

> **Solo stays T3 Code.** A server with one member and no compute driver looks and behaves exactly
> like T3 Code, down to the wire. Cloud is not a team feature: it turns on when an admin configures
> a compute driver, on solo and team servers alike, and changes nothing on the wire until then.

Team behavior still turns on only with a second active member. A solo owner with cloud gets cloud
threads and none of the team UI.

### Provider accounts in cloud (add at M1)

Unchanged: a turn runs on the thread's provider account, whoever prompts it. Never switch per
prompter, and never silently. Only the owner picks their own account. Pair does not pool or rotate
personal subscriptions.

Add:

> - A cloud thread's sandbox receives only its own thread's account credential, in memory, from an
>   allowlisted environment when the provider process starts. It never receives another member's.
>   Pair writes no credential to a sandbox's disk or image, and sleep keeps no memory. A stopped disk
>   or snapshot still holds code and transcripts, so it is encrypted and deleted with the sandbox.
> - A member's own Claude account works in cloud with a setup token (`CLAUDE_CODE_OAUTH_TOKEN`, from
>   the copyable `claude setup-token` command in Settings, as Conductor offered) or an API key.
>   Settings says a setup token is valid for a year and the agent can read it; the opt-in model
>   proxy (M2) covers API keys only, never subscription tokens (06 §4). An account with neither
>   shows as "Local only".
> - Cloud threads from scheduled tasks and webhooks run on the task owner's account, as other task
>   threads do.
> - Assigning a cloud thread does not move it off the previous owner's account, as today.
> - In a cloud thread the model picker shows Cursor and Muse as "Not supported in cloud".

### Git credentials in cloud (amend at M1)

This reverses "agents' `gh` never gets the owner's GitHub token" for cloud threads, following Claude
Code's cloud, which accepts a member's own GitHub credential. A cloud thread's git gets, for its
project remote (and fork, for pull requests) only, the first of:

1. An installation token, if an admin added the App's private key. This stays the recommended setup.
2. The owner's own GitHub: their connected account, or a token from **Use a token instead** on their
   row in Settings → Team (a fine-grained token or `gh auth token`). Pushes and pull requests go out
   as the owner, with "via Pair" in the body, whoever prompts. Settings says plainly that the agent
   can read this token while the owner's cloud threads run.
3. Nothing: the thread says "Connect GitHub to push".

In M3 the git proxy keeps the real token on the server, substitutes it for a placeholder, and
refuses branch deletions and tag pushes. Local threads keep today's rule.

### Sandbox events and notifications (add at M1 and M2)

Notifications keep going only to the people a thread concerns
([threadNotificationRouting.ts](../../../packages/shared/src/threadNotificationRouting.ts)). A push
still carries the thread title and nothing else.

| Event | Who hears | Push title | Milestone |
| ----- | --------- | ---------- | --------- |
| Machine failed to start or wake | The prompter and the owner, like a failed turn | "Machine failed" | M1 |
| Machine started, slept or woke | Nobody | none | M1, M2 |
| Waiting for a machine at a cap | Nobody. The status line says it. | none | M1 |
| Turn cut short by the vendor's lifetime limit | The prompter and the owner, as a failed turn | "Thread failed" | M2 |
| Team image build an admin started finished or failed | That admin | "Build 14 failed" | M3 |
| Agent build ready to activate | The admins who wrote the image thread's run | "Build 15 ready" | M3 |
| Machine discarded after retention | Nobody | none | M2 |

"Machine failed" is a new `ThreadNotificationKind` routed exactly like `failed`; the build push is
the first one not tied to a thread, so it needs its own routing rule. Both are owned by
[08](./08-clients-and-contracts.md).

Timeline rows, team mode only as today: "Machine started from build 14", "Machine failed: <reason>",
"Machine discarded", "Continued locally" and "Continued in cloud". Sleep and wake get no row; they
would fill timelines with noise.

### Rules that stay unchanged

- Anyone can prompt any thread, never hijacking a turn. Queued messages and approvals work as today.
- One owner per thread. Only the owner or an admin deletes it, and only they can **Sleep now** or
  **Discard** its machine (from failed, asleep, or ready with no run). Any member can wake or retry.
- Personal and shared state split as today. A thread's mode and sandbox are shared state.
- Git authorship holds in sandboxes. Only the token rule changes, and only for cloud threads.
- Presence stays in memory and quiet. An open cloud thread renews a viewer lease, which only keeps
  its machine awake.
- Usage shows turns and tokens without dollars to members. Sandbox hours join them (section 6).
- API tokens stay on `/mcp` only. The sandbox token is a different credential and never reaches a
  member or a client.

## 6. Settings and information architecture

Recommend a new top-level **Settings → Cloud**, not a subsection of Team. Cloud works on solo
servers, it is about machines rather than people, and builds and logs need room. The Team page is
already dense, and non-admins see it only once the server has a second member
([team.ts](../../../apps/web/src/state/team.ts), `useTeamSettingsVisible`). The nav lives in
[SettingsSidebarNav.tsx](../../../apps/web/src/components/settings/SettingsSidebarNav.tsx).

| Place | What it holds | Admin | Member | Milestone |
| ----- | ------------- | ----- | ------ | --------- |
| Settings → Cloud → Overview | Status of the driver, running and sleeping machines, the active build, the team cap. | Sees and changes | Sees, read only | M1 |
| Settings → Cloud → Compute | Driver instances (Docker host, vendor) with the isolation warning, machine size and allowed projects (M1). Caps (read only in M1), region, idle and retention periods, hourly rates (M2). | Changes | Hidden | M1, M2 |
| Settings → Cloud → Team image | Install script, env and secret references, builds, history, activate, logs. | Changes | Sees the active build and its log | M3 |
| Settings → Cloud → Usage | Sandbox hours per member and per thread for the last 7 days. | Hours and an estimated cost | Hours for everyone, like token usage | M2 |
| Settings → Cloud → Access | SSH keys for open-in-editor, cloud-only mode. | Cloud-only mode | Own SSH keys | M4 |
| Settings → Projects | Setup script, whether cloud is allowed, `defaultsToCloud`, default driver. | Changes | Sees | M1 |
| Settings → Source Control | The GitHub App private key, optional and recommended. | Changes | Hidden | M1 |
| Settings → Team, your row | **Connect GitHub** or **Use a token instead**, with the warning. | Own | Own | M1 |
| Settings → Scheduled tasks | Cloud as the task's workspace choice. | Own tasks | Own tasks | M2 |
| Managed policy | `limits.cloud`: allowed drivers, forced cloud-only. | Machine owner | n/a | M4, M5 |

Members see hours, not dollars, and every member sees the whole team, because the point is
noticing whose work uses the capacity ([TeamUsage.ts](../../../apps/server/src/team/TeamUsage.ts)
serves today's numbers). Admins also see an estimate from the per-driver, per-size rate they enter
([04](./04-sandbox-lifecycle.md#4-caps-quotas-and-usage)); the bill itself stays on the vendor's dashboard.

Mobile shows cloud status, starts cloud threads, wakes and retries, and gets a new read-only machines
screen ([08](./08-clients-and-contracts.md)). It does not configure drivers, caps or images, as
members already manage accounts on the web.

## 7. Competitive landscape

As of 2026-11-06. Third-party pricing is inconsistent, so treat prices as indicative and see the
[Sources](#sources).

| Product | Where compute runs | BYOC or self-host | Multiplayer | Mobile | Providers | Pricing model |
| ------- | ------------------ | ----------------- | ----------- | ------ | --------- | ------------- |
| **Conductor Cloud** | One Vercel Sandbox microVM per workspace, us-east-1 | No; "Not yet", Enterprise talk only | Yes, on the invite-only Team plan | iOS app announced, not released | Claude Code, Codex, Cursor, OpenCode | Pro, Team, Enterprise plans; no extra cloud fee at launch. Shutting down per reports. |
| **OpenAI Codex cloud** | OpenAI-hosted workspace per task, from a saved environment | None found | Environments shared with the org or private; no shared live sessions found | ChatGPT mobile app | Codex only | Draws on the ChatGPT plan's usage allowance; token-based credits since 2026 (third-party) |
| **Claude Code on the web** | Anthropic-hosted, or self-hosted runners (public beta, 2026-08-06) | Self-hosted runners in the customer's network for Team and Enterprise; prompts still go to Anthropic for inference | Shared runner infrastructure; live session sharing not verified | Claude app, Code tab | Claude only | Counts against the Claude plan |
| **Cursor cloud agents** | Cursor-hosted VMs, or self-hosted workers (2026-03-25) and self-hosted machine pools (2026-09, unverified) | Workers dial out over HTTPS; the agent loop and inference stay in Cursor's cloud | Team plans; shared live sessions not verified | Not verified | Cursor's harness, many models | Model usage billed per request; compute pricing unclear (third-party) |
| **GitHub Copilot coding agent** | GitHub Actions runners | Self-hosted runners through ARC only, Ubuntu x64, native firewall off | Asynchronous, through issues and PRs | GitHub Mobile (inferred) | Copilot's harness | One premium request per session plus Actions minutes |
| **Devin** | Cognition-hosted | VPC deployment on Enterprise | Team plans, Slack-driven (inferred) | Not verified | Devin only | ACU-based; published rates conflict |
| **Ona (formerly Gitpod)** | Ona Cloud, or runners in the customer's AWS (ECS and EC2) or GCP (Compute Engine) | Customer-VPC runners on Enterprise; code and credentials stay in the account | Not verified | Not verified | Ona's agent; a connected ChatGPT account for Codex | OCUs on Core (a 4 vCPU / 16 GB machine is 1 OCU an hour); credits on Enterprise |
| **Coder** | The customer's own infrastructure | Fully self-hosted, open source core; air-gapped possible | Workspace-based; not verified for agents | No | Coder Tasks runs third-party agents such as Claude Code; Coder Agents (beta, 2026-05) is model-agnostic | Open source plus paid Premium |
| **Pair Cloud (planned)** | Docker on any host, Vercel Sandbox (recommended), or VMs in the customer's AWS, then GCP | Yes: the whole control plane is self-hosted, and BYOC at M5 | Yes: shared live threads, attribution, queue-by-default, approvals by any member, presence | iOS and Android, team's own build | Claude and Codex first; OpenCode, Grok, Kiro at M3; not Cursor or Muse | Free and open source; the team pays its compute vendor and model providers directly |

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
- **Local and cloud in one place,** with threads that move between them (M4). MIT-licensed, too.
- **Compute choice.** Docker on a box you have, a hosted vendor, or your own cloud, behind one
  driver interface. Vendor risk is a driver swap, not a migration.

### Where Pair is weaker

- **Someone has to run a server.** There is no sign-up-and-go. A managed control plane would fix
  this, at the cost of a business (section 8).
- **No polished first-party machine.** OpenAI's environments and Conductor's admin agent set up a
  repo for you. Pair's image tooling arrives at M3.
- **Mobile needs the team's own build.** Pair can't ship to the stores under T3's ids
  ([decisions](../decisions.md#identifiers-and-builds)).
- **No SLA, SSO or central billing.** SSO and billing are standing non-goals.
- **Agents can read their credentials.** The provider credential and, until M3, a member's own git
  token reach the sandbox in memory. The model proxy (M2) and the git proxy (M3) close that.
- **Linux only,** and pushing only to GitHub until M3.

## 8. Packaging and cost

Pair is open source and self-hosted. The team server is the team's, so the compute bill is the
team's too.

| Option | What the team gets | What we take on | Fit |
| ------ | ------------------ | --------------- | --- |
| **A. Free and self-hosted** | Everything in this plan. The team pays its compute vendor and model providers directly. | Nothing beyond the open-source project. | Matches "open at the core" and the "won't get bought" ask. |
| **B. Managed control plane** | We host the team server. Compute stays on any driver, including their cloud. | Uptime, data custody, on-call, billing, abuse handling. It becomes a company. | Teams that refuse to run a server. Conflicts with "no one holds your data". |
| **C. Support and deployment help** | A, plus help deploying BYOC, a response-time promise and priority fixes. | People time. | Security-conscious companies at M5. |

Recommendation: ship A, offer C informally to the first BYOC teams, and defer B. This is a business
decision for maintainers, not a technical one; the architecture supports all three because the
team server is the control plane wherever it runs.

### What a team should expect to pay

From the cost model in [04](./04-sandbox-lifecycle.md#8-vendor-recommendation-for-m2), at 8 vCPU (16 GB, Conductor's
size, except E2B's 8 GiB ceiling): a team of 10 starts 20 cloud threads a day over 22 working days, each busy 1.5
hours and idle 1 hour before it sleeps.

| Backend | Busy thread-hour | Idle thread-hour | Month |
| ------- | ---------------- | ---------------- | ----- |
| Docker on a host the team rents | $0 marginal | $0 marginal | One 48-core server, roughly $250 to $400 rented (inferred) |
| Vercel Sandbox (recommended) | $0.60 | $0.35 | about $620, including storage and the Pro plan |
| E2B (runner-up, 8 GiB) | $0.53 | $0.53 | about $740, including the Pro plan |
| boat.dev large | $0.072 | $0.072 | about $100, inside the plan credit |

If every member starts 20 threads a day, multiply by 10: Vercel about $5,500, E2B about $6,000,
boat about $800. Two
settings matter more than the vendor: the idle timeout (a quarter of the Vercel bill above) and the
machine size (a 4 vCPU size halves Vercel and E2B). Vercel's pricing charges CPU only while
it is used, which suits agents that mostly wait on the model. Model spend is separate and goes to
the providers.

Sleep keeps these numbers honest. M1 only stops a Docker machine once all its threads are settled or
archived, so it ships only Docker, where idle machines cost only the box.

## 9. Success metrics

Targets are recommendations to revisit after the first month of dogfooding. "Time to first token"
is from the member pressing Send to the first streamed agent output.

| Milestone | Metric | Target |
| --------- | ------ | ------ |
| M0 | Local turn and terminal latency vs. main | No regression beyond noise in the existing perf checks ([performance-regressions](../../internals/performance-regressions.md)). |
| M1 | Time to first token, ready cloud thread vs. a worktree thread | Within 300 ms at p50. |
| M1 | Docker sandbox from Send to runner connected, image cached, before setup script | p50 under 5 s. |
| M1 | Adoption on the dogfood team | 30% of new threads are cloud threads within two weeks. |
| M1 | Cloud threads that fail to start | Under 2%, each with a readable reason. |
| M2 | Time to first token from asleep | p50 under 20 s, p95 under 45 s on the hosted vendor. |
| M2 | Time to first token, new cloud thread on the hosted vendor, before setup script | p50 under 30 s. |
| M2 | Concurrent cloud threads one team server drives | 30, above the default cap of 20, with no rise in p95 event latency for other threads. |
| M2 | Share of sandbox hours spent idle and awake | Under 25%. |
| M3 | New cloud threads whose setup script fails | Under 5%. |
| M4 | Moves between local and cloud completing without manual git | 95%. |
| M4 | Teams running cloud-only | 1 outside team. |
| M5 | Time for a new team to deploy BYOC with the kit | Under 2 hours. |
| M5 | BYOC teams in production | 2. |

Cost is tracked as sandbox hours per member per week, and idle share, from Settings → Cloud → Usage.
There is no dollar target; teams set budgets with caps, size and the idle timeout.

## 10. Non-goals

- **Pooling or rotating teammates' subscriptions.** Unchanged from
  [decisions](../decisions.md#non-goals).
- **One-way file sync to a laptop.** Conductor had it. Open-in-editor over SSH and bring-it-local
  cover the need with less machinery.
- **Windows and macOS sandboxes.** Sandboxes are Linux. Device work keeps using device hosts
  ([DeviceHost.ts](../../../apps/server/src/device/DeviceHost.ts)).
- **GPU sandboxes, and Pair-run compute.** We never resell machines.
- **A full T3 server inside each sandbox** (plan decision 2), and **live migration of a running turn**.
- **Private threads, per-project permissions and several teams on one server.** Unchanged, including
  on cloud-only servers.

## Open questions

1. **Should members see the cost estimate?** Recommend no. Members see hours, matching the token
   usage rule; admins see the estimate. Revisit if a team asks.
2. **Who hears that an agent build is ready?** Recommend only the admins who wrote that image
   thread's run. Other admins see it under History, with no push.
3. **Viewer role on cloud-only servers?** Recommend not building it until a team asks. Keep the
   design so it stays possible.

## Challenges to the plan

None.

One point stays in this doc's text rather than the plan: cloud-only mode protects the server's
machine, not members from each other (section 5).

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
