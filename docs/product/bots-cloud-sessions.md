# Bots: cloud sessions

Status: plan, 2026-11-19. Builds on [Bots](./bots.md) and the linked-environment plumbing that
`delegate_task` and `t3 thread start --cloud` already use.

## Why

A bot runs your work as sessions. Today every session runs on the machine the bot lives on. That
breaks down in the cases where a bot is most useful:

- **Work that outlives the laptop.** You give the bot three jobs and close the lid. Local sessions
  stop. Cloud sessions keep going, and the bot keeps steering them.
- **Parallel work that does not fit one machine.** Five worktrees running builds and tests at once
  can pin a laptop. A cloud machine per session doesn't.
- **A clean checkout.** A cloud session starts from the pushed branch on the remote, not from
  whatever is half-edited locally.

Users can already start cloud sessions by hand (`t3 thread start --cloud main`). When a bot does
that, the session isn't linked to its job. The bot never hears that it finished, asked a question
or went quiet, and it can't message it. The feature closes that gap: **a cloud session is a
bot session that happens to run elsewhere.** The bot starts it, sees it, is woken by it and steers
it exactly as it does a local one.

### Should we build it?

Yes, with one limit. The value is real and the pieces exist: links, forwarded MCP calls, cloud
launches and a remote follower (`RemoteDelegation`). What does not hold up is "show _every_
project on the cloud in `bot_brief`" as a separate concept. A bot already picks a project per job.
A cloud session runs in **the same project's repository on the cloud**, matched by repository the
way `delegate_task` does. So the bot does not need a second project list to choose from. It needs
to know which of its projects can run in the cloud. The plan narrows the brief change to that.

## Alternatives considered

1. **Tell the bot to use `t3_thread_launch` with an `environmentId`, then adopt the thread into the
   job.** This needs no new launch code, but it adds an "adopt" tool, and the bot has two ways to
   start work that can drift apart. Rejected: one tool, one path.
2. **Have the cloud push events back** (a webhook from the Pair Cloud server to this one). The
   wake-ups would be faster, but the cloud cannot reach a laptop behind NAT or asleep. It also
   needs a new authenticated inbound route on every server. Rejected: the coordinator pulls.
3. **Make it a `delegate_task` subagent of the bot's home thread.** That reuses `RemoteDelegation`
   whole. But a delegated task wakes its parent only when it ends: no asked, quiet or taken-over
   wakes. Its result also lands inside the home thread's turn, which breaks "the chat never waits
   on the bot". Rejected. The _follow loop_ pattern is reused; the subagent record is not.
4. **Chosen: `bot_start_session` takes `cloud`, and a small follower polls the session through
   the link.** It turns what changed into the same wakes the local watcher sends.

## Patterns we follow

- **Coordinator pulls from remote workers.** CI runners such as GitHub Actions self-hosted runners,
  GitLab Runner and Buildkite agents talk to their coordinator by outbound long-poll, so workers
  behind NAT need no inbound route. The roles are swapped here: the cloud is always reachable and
  the laptop is not. So the coordinator (the bot's server) does the outbound polling, with plain
  reads over the link every 15 s. We considered the link's `t3_thread_wait` long-poll for faster
  finish wakes. It only ends on a finished run, though, not on a question or a takeover, so the
  periodic read was needed anyway, and one mechanism is simpler than two.
- **Level-triggered reconciliation** (Kubernetes controllers). Each poll reads the remote thread's
  current state, compares it with the last state we recorded on the session, and acts only on the
  difference. A missed poll, a dropped connection or a server restart cannot lose a wake or send
  one twice, because the last-seen state is persisted. Stopping works the same way: a stopped job
  whose cloud session is still running gets a stop sent there.
- **Lost-contact state instead of silence.** A GitHub Actions runner that stops reporting shows
  "lost communication with the server" instead of "running" forever. A cloud session we can't
  reach shows _Can't reach_, and the bot is told once.
- **Bounded retry cost** for an unreachable peer. One failed call ends that cloud's turn in the
  sweep, so a dead cloud costs one request per 15 s per bot, not one per session.
- **Idempotent remote launch.** The launch carries a `clientRequestId`, so a retry after a lost
  reply finds the same thread (`PeerForwarding` scopes the key per caller).

## Shape

### When the bot uses the cloud (consent)

A cloud machine costs money, and "Anything that spends money" is one of the bot's
check-with-me limits (on by default). So the bot starts a cloud session only when:

- the user asked for it in this request ("run it in the cloud"), or
- the user's Instructions or a saved note say when to ("big test runs go to the cloud"), or
- `spend-money` is not in the bot's limits.

Otherwise it runs the session here, or `bot_ask`s first ("Run this on Pair Cloud? It keeps going
when your laptop sleeps."). This rule lives in the persona and the `bot_start_session` description.
Like every bot limit in v1 it is not enforced by the server ("harness-enforced limits" are out of
scope in [Bots](./bots.md#not-in-v1)). There is no machine-size knob in v1: the cloud uses its
default size, so the bot can never pick an expensive machine on its own.

The persona also tells the bot two things a cloud session changes:

- The reply names where it runs: "On it, on Pair Cloud from `main`: <link>."
- The session starts from the pushed branch, so unpushed local edits are not there. If the user's
  request depends on local changes, run the session here.

### API (MCP, bot home thread only)

`bot_start_session` gains one optional argument:

```ts
cloud?: {
  environmentId?: EnvironmentId; // only when more than one Pair Cloud is linked
  baseRef?: string;              // branch/tag/commit on the remote; default: the project's default branch
  branch?: string;               // new branch name for the checkout
}
```

- **Where it runs** is resolved as `t3 thread start --cloud` does: on this server if it runs cloud
  machines itself, otherwise on its one linked Pair Cloud. If more than one is linked, the bot must
  pass `cloud.environmentId`.
- **The project there** is the one with the same repository as the job's project
  (`PeerForwarding.resolveProject`, the `delegate_task` path). If no project there has that
  repository, or several do, the bot gets the same actionable error `delegate_task` gives.
- **Not in the cloud:** jobs with no project (scratch work on _this_ machine) and projects with no
  git remote. The error says why.
- The result gains `environmentId` and `where` ("this machine" or the cloud's label). `link` is
  formatted for that environment.

Errors are written for the bot to relay:

| Case                                 | Message (to the bot)                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cloud on this server, none linked | "This Pair server doesn't run cloud machines and no Pair Cloud is linked. Tell the user to link one in Settings → Connections, or start the session here without `cloud`." |
| Several clouds linked, none named    | "More than one Pair Cloud is linked: A (id), B (id). Pass cloud.environmentId."                                                                                            |
| Link expired or revoked              | The link's own message ("…link it again"), mapped as `capability_denied`.                                                                                                  |
| Cloud unreachable at launch          | "Could not reach <label>: <reason>. Start it here instead, or try again."                                                                                                  |
| No matching repository there         | `resolveProject`'s message (clone and create it there).                                                                                                                    |
| Machine fails to start               | Arrives later as a **failed** wake with the cloud's error, like any failed run.                                                                                            |

`bot_session_message` and `bot_session_respond` are unchanged for the bot. For a cloud session the
server forwards them through the link: `t3_thread_send` with mode `auto`, and `t3_pending_request`
`respond`. One gap: the link can answer a session's _question_ but not approve a _permission_
request, because `t3_pending_request` refuses approvals. Bot sessions run in full access, so these
are rare. When one does come, the wake tells the bot to `bot_ask` the user to approve it in the
session, and `bot_session_respond` with a `decision` returns that same instruction.

`bot_brief`:

- Each job session gains `where` ("this machine" or the cloud's label), `environmentId`, and
  `reachable`. A cloud session's live state comes from the follower's **last-known state** on the
  session (`status`, `pendingRequest`). The brief makes **no network call per session**, so a down
  cloud never stalls the bot's turn ("the chat never waits"). `lastAssistantText` is null for cloud
  sessions. The finished wake tells the bot to read the session with `t3_thread_read` and the
  session's `environmentId`, which it already does for local sessions.
- A new top-level `cloud` entry: `{ environmentId, label, reachable }` for the cloud
  `bot_start_session` would use, or `{ unavailable: "<reason>" }`. It is read from the stored link
  (no network call). The brief does **not** list the cloud's
  projects (see "Should we build it?"). A bot's project is valid in the cloud when its repository
  is there, and the start error says when it isn't.

### Persisted state

`BotSession` (stored as JSON, so no migration) gains an optional `cloud`:

```ts
cloud?: {
  environmentId: EnvironmentId;
  label: string;                 // the link's label when started
  state: "working" | "waiting" | "done" | "failed" | "stopped" | "unreachable";
  pendingRequest: { requestId, kind, text } | null; // for bot_brief
  lastOutputAt: IsoDateTime;     // the remote thread's updatedAt, as the local quiet check uses the shell's
  reportedRunId: RunId | null;   // the run whose end the bot already heard about
  reportedRequestIds: RuntimeRequestId[]; // open requests the bot already heard about; answered ones drop out
  position: number;              // timeline cursor for takeover detection
  stoppedThere?: true;           // a stopped job's stop reached the cloud
}
```

`projectId` keeps meaning "the project the session runs in", which for a cloud session is the
project _there_. A local session has no `cloud` and behaves exactly as today.

### Watcher

A new `BotCloudSessions` follower beside `BotWatcher` (`apps/server/src/bots/`). It is one sweep
every 15 s over every bot's cloud sessions, reading a working or waiting session each sweep and a
settled one every 60 s, so it catches a new run there (the user's own message, a hand-back). It
holds no per-session fibers: a restart or a reopened job is just the next sweep. For each session
due, it:

1. **Reads** `t3_thread_read` (`view: messages`, after the stored `position`, a small page), plus
   `t3_pending_request list` while `pendingRequestCount > 0`.
2. **Diffs** against the stored state and calls the same `BotService.addEvent` / `publishWake` as
   the local watcher, with the same reasons and wording:
   - run ended → finished / failed (with the cloud's error text) / usage limit / stopped
   - new pending request → asked (question text from `t3_pending_request read`)
   - a `user_message` item whose `createdBy` is `"user"` → taken over (`setSessionTakenOver`).
     The bot's own messages can't trip this. A forwarded `t3_thread_send` is recorded there as
     `createdBy: "agent"`, `creationSource: "mcp"` (`OrchestratorMcpService.sendToThread`), and so
     is the launch's first message. A test pins this rule.
   - PR links on the thread → folded into the job, as `syncPullRequests` does today
3. **Writes** the new state back only when it changed, so clients see no churn.

Quiet detection is the existing `quiet()` sweep. For a cloud session it reads `cloud.lastOutputAt`
and `cloud.state` in place of the local shell, so "went quiet" has one implementation.

Wake text for a cloud session names where it runs and how to read it: `Session "X" (thread T, on
Pair Cloud: pass environmentId E to t3_thread_read) finished…`. The fold label the user sees is
unchanged ("X finished"). Session titles already tell the user which work it is, and a location
suffix would only lengthen every label.

**Reachability is tracked per cloud, not per session.** Each sweep records every call's outcome
in one map keyed by bot and `environmentId`, and a failed call ends that cloud's turn in the sweep. A cloud turns unreachable after 3 minutes of
continuous failure across all its sessions, and the bot and the user each hear about it once per
outage, not once per session.

### Failure cases

- **The user hears about it directly, not only through the bot.** The bot may be paused, or its
  own model may be cut off by the same outage. So when a cloud turns unreachable, the server
  itself opens one **Ask** on the bot, using the existing `createAsk`. It then lands in the Inbox
  ("needs you"), sends the existing Ask notification, and counts in the bot's needs-you badge,
  with no new Inbox kind on any client:

  > **Can't reach Pair Cloud.** 2 sessions there can't be followed: Sidebar flicker, Rate limit.
  > They may still be running. _Why:_ the link expired. Link it again in Settings → Connections.
  > Option: "Stop following them"

  When the cloud answers again, the server resolves that Ask itself ("Pair Cloud is reachable
  again") and reconciles. Recovery needs no button. The server, not the bot, acts on "Stop
  following them": the follower sees the Ask resolved with that answer, marks the sessions
  `stopped` here, and wakes the bot once as for any stopped session. This is the way out, so the
  user is never stuck with sessions that are unreachable forever. A stop already owed to a stopped
  job is **kept** and still sent when the cloud answers. The Ask's copy says they "may keep running
  on <label>; open them there to stop them", with each session's link. The Ask has no home-thread
  turn, so the Inbox opens the bot's chat at the bottom. The alert is per bot per cloud. Bots are
  single-user and a user rarely has two, so two bots on one broken cloud means two Asks. We accept
  that in v1.

- **Cloud unlinked, or link expired or revoked** (`capability_denied`, or the link is gone): the
  cloud turns unreachable at once, with no 3-minute grace, because waiting won't fix it. The bot
  gets one wake ("Can't reach <label>: <reason>. The user has been asked to link it again; don't
  start cloud sessions until it's back."), and the Ask above opens. The follower keeps trying each
  sweep, so a renewed link resumes on its own.
- **Network cut or cloud asleep:** retried quietly on the next sweep. Only after **3 minutes** of
  continuous failure does the cloud turn unreachable (one wake, one Ask). When it comes back, the
  server records an info event, resolves the Ask and reconciles. Anything that happened while we
  were cut off (finished, asked) wakes the bot then, once.
- **Machine fails to provision:** the cloud fails the run. The bot gets a failed wake with the
  cloud's error ("Could not start the machine: …") and, as for local failures, is told to nudge
  once or start a replacement.
- **Thread deleted there** (`thread_not_found`): the session is marked `stopped` with an event,
  and the follower no longer reads it. The cloud answered, so this is not an outage.
- **User takes over a cloud session:** detected from the user's own message in the timeline, the
  same rule as locally. The bot is told to step back. `bot_session_message`/`respond` refuse until
  the user hands it back in the bot's chat and the bot calls `bot_session_reclaim`.
- **User stops the job:** `stopJob` already tries a local stop, which does nothing for a cloud
  thread. The follower sees the job stopped while the session is still working there and sends
  `t3_thread_interrupt { stop: true }` through the link (idempotent by key). It records
  `stoppedThere` and ends. When the cloud is reachable this takes seconds, the same as a local
  stop. An unreachable cloud keeps the stop owed until it answers, as `RemoteDelegation` does.
  Meanwhile the row shows _Can't reach_, and the open Ask says the sessions "may still be
  running", so nothing claims a stop that hasn't happened.
- **Launch reply lost:** the launch's `clientRequestId` is derived from the bot's current home-thread
  run and the session title. A retry in the same turn finds the same thread rather than booting a
  second machine. A replacement session started in a later turn (the advice after a failure) gets
  a new machine.
- **Bot deleted:** its sessions become ordinary threads. Cloud threads keep running there, as local
  ones do. The Delete confirmation gains one line when any of them is working on a cloud: "2
  sessions keep running on Pair Cloud." Those keep costing money, and the user should know before
  confirming. Pause needs no change, because its copy already says sessions keep running.
- **Approvals on a cloud session** (rare in full access): the bot can't approve them through the
  link, so it asks the user to approve it in the session. That needs a client connected to that
  cloud, which is how cloud threads are opened today anyway. The wake tells the bot to `bot_ask`
  the user to open the session and approve it there.
- **Questions on a cloud session** also show up right away in the cloud environment's own Inbox,
  for a client connected to it, with that environment's own notification. The cloud doesn't know
  a bot owns the thread, so it can't hold the question back for 10 minutes the way the bot's
  server does. So for a cloud session the user is told **at once** rather than after 10 minutes,
  and that holds while the bot is paused too ("questions come to your Inbox"). The bot's server
  sends no second notification, and records no 10-minute escalation event for it. We accept the
  earlier notice in v1: it errs toward telling the user.

### UI (web, desktop, mobile)

Clients stay dumb. They read the session's `cloud` field from the bot snapshot they already
receive.

- **Where it runs.** A cloud session's sidebar row (web, desktop) shows a small cloud icon titled
  "Runs on <label>". Its Bots-tab row (mobile) shows the label as text, because phones have no
  tooltips. Both open the thread in the cloud's environment. Local rows are unchanged.
- **Live state.** When the client holds the cloud thread's shell (it is connected to that
  environment), state derives from the shell as today. Otherwise it uses `cloud.state`, so the row
  never shows a stuck spinner.
- **Can't reach.** A new, distinct "offline" glyph (a cloud with a slash), not a muted failed
  glyph, because the session may well be fine. Its label is **"Can't reach <label>"**, which mobile
  shows as the row's text.
- **Header status line** (web bot header and mobile header) counts unreachable sessions: "2
  sessions working · 1 can't be reached". **Sort order:** an unreachable session sorts with the
  working ones, since it isn't finished.
- **Thread link chips** in the bot's chat resolve a cloud session's thread when the client is
  connected to that cloud, and then show its live glyph. When it isn't, the chip stays
  "unavailable", as any link this client can't open does, with the tooltip "Runs on <label>" or
  "Can't reach <label>" in place of the generic one.
- Opening a cloud session uses its `t3-thread://` link for that environment. A client that isn't
  connected to that environment gets the existing "connect this environment" path. We add nothing
  new there.
- **The cloud thread's own screen** does not show "Message this session (<bot> steps back)" in v1.
  The placeholder reads the bot snapshot of the thread's own environment, and the cloud's snapshot
  has no record of this bot. Takeover still works there. Sending a message takes the session over,
  and the bot posts once in its chat, so the user finds out right after their first message
  instead of before it. Showing it beforehand would mean every client joining bot snapshots across
  environments, which is out of scope for this change.

Product copy a user sees (to confirm with the maintainer): "<label>" on mobile rows, the "Runs on
<label>" tooltip, "Can't reach <label>", "… · 1 can't be reached", the server-opened Ask above, and the
Delete line "N sessions keep running on <label>".

## Not in this change

- A per-bot default to "always use the cloud". The bot decides per session, and a playbook note
  ("run big jobs in the cloud") steers it.
- Listing the cloud's own projects that have no local counterpart.
- Approving permission requests through the link.
- Choosing a machine size (the cloud's default only).
- The bot placeholder on the cloud thread's own screen.
- Push delivery from the cloud. Polling stays within one long-poll per working cloud session and
  one read per 30 s per idle one.

## Model-facing text

The `bot_start_session` description and the persona change: when to use the cloud, the reply
wording, and the unpushed-edits warning. No eval covers the bot persona today (`evals/` has
`mcp-tool-use`, `thread-titles`, `test-signal` and `space-agent`). Adding a bot eval and running
it calls paid models, so per the request's "ask before spending money", we ask the maintainer
before building or running one. Unit tests pin the tool schema and the persona lines.

## Tests

- `BotSessions.test.ts`: starting with `cloud` resolves the target the way the CLI does: here,
  the one linked cloud, an error for none or several, and an error for scratch jobs. It launches
  through the link with a cloud strategy, and records `cloud` on the session.
- A new `BotCloudSessions.test.ts`, with a fake `PeerForwarding`:
  - finished, failed, asked, taken-over and PR wakes from a sequence of remote reads
  - no duplicate wake after a restart (persisted `reportedRunId` / `reportedRequestIds`)
  - a cloud turns unreachable after sustained failure across its sessions, with one wake and one
    server-opened Ask per outage, and the Ask resolves itself on recovery
  - "Stop following them" marks the sessions stopped
  - a bot's own forwarded message never counts as a takeover
  - an expired link
  - a stopped job sends the stop there
- `BotWatcher.test.ts`: the quiet sweep covers cloud sessions (extend the existing table).
- `handlers.test.ts`: `bot_session_message` and `respond` forward for cloud sessions, and the
  brief's `where` and `reachable` fields.
- Web `bots.logic.test.ts` and mobile `botsModel.test.ts`: the `cloud.state` fallback and the
  unreachable state (extend existing rows).
