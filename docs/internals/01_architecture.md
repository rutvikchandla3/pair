# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

- **Server (`apps/server`).** Owns provider processes, terminals, Git, checkpoints, durable state,
  and project files.
- **Client runtime (`packages/client-runtime`).** Owns shared connection management and domain
  state across web, desktop, and mobile so reconnect and multi-environment behavior do not diverge.
  Clients supply platform services and UI. See [connection runtime](./09_connection-runtime.md) and
  [remote environments](./05_remote.md).
- **Contracts (`packages/contracts`).** The typed wire boundary between independently versioned
  clients and servers. Subscriptions send only the state a client needs. Authentication of a socket
  does not authorize every method on it; see [environment auth](./04_environment-auth.md).
- **Providers (`packages/provider-*`).** Provider-specific protocols and quirks stay behind an
  adapter. Orchestration and clients read capabilities, never provider names. See
  [providers](./03_providers.md).

Presence (who is online, viewing or typing) lives in server memory per connection and is never
event-sourced or persisted. It stays silent while nobody else is around: clients subscribe in team
mode but send reports only while another member is connected, and the server resets a lone
member's connections so stale state never reaches the next arrival. Keep both halves of that
handshake when changing either side. See [presence](../../apps/server/src/team/Presence.ts).

## Pair Cloud and workspace hosts

A Pair team runs two kinds of server: each member's local server, and the team's Pair Cloud, a
server started with `--cloud-only`. Only a cloud-only server reports
`ExecutionEnvironmentCapabilities.cloudLaunch`, and the server's own decisions refuse anything that
creates a machine elsewhere (`decideSandboxCommand`, reason `not-cloud-only`), so one gate covers
UI, MCP, scheduled tasks and older clients alike. A cloud-only server refuses work on its own host
instead. Clients never launch Cloud on a local server: `resolveCloudTarget` in
[client-runtime](../../packages/client-runtime/src/state/cloudTarget.ts) routes a Cloud pick on a
local project to the connected Pair Cloud project with the same github.com origin.

The two never sync. A move between them is a new thread on the other server, always started by the
local server over its member-scoped link (Pair Cloud never calls a laptop): the code travels as a
git bundle staged in Pair Cloud's mirror, and the conversation as a context export.
`OrchestrationV2ContextTransfer.sourceThreadId` names a thread in the same event store, so a move
between servers cannot use a context transfer. The sending server builds an
`OrchestrationV2ContextExport` that carries its own provenance (environment, thread, title) and the
thread's messages, size-capped. The receiving server imports them as read-only history
(`historyOrigin: "context_export"`) and builds a `manual_context` handoff in
`prepareLegacyImport`'s shape, so the handoff's omitted-history references resolve on the new
thread. Keep exports self-describing: a reference back to the other server's store can't be
followed.

Thread-scoped code reaches a thread's files, processes and terminals through its
[WorkspaceHost](../../apps/server/src/workspaceHost/WorkspaceHost.ts), local or a sandbox, and the
`t3code/workspace-host-boundary` lint rule keeps it there. Paths under the reserved `/t3-sandbox/`
root route to their machine and fail closed: they never fall back to the server's disk. Such code
reads platform, home and environment from `host.info` per use, not from the server's process, and
the host owns the base environment every process it starts inherits.

## Workspace projects

A project with `roots` is a workspace of other projects' repositories. Its own folder, under the T3
home's `workspaces` folder, stays empty and is never a git repository. The code lives in each
thread's folder, one worktree per root. Code keyed on the project folder's git state (status,
branches, checkpoints, cleanup, setup scripts, pull requests) must use the thread's repositories
instead (`threadRepositories` in
[client-runtime](../../packages/client-runtime/src/state/workspaces.ts), or the thread's `roots` on
the server), or refuse. A workspace thread's checkpoint scope records its root names, and
`CheckpointStore` alone fans each checkpoint operation out over them, so checkpoint and diff paths
read `<root>/<path in repo>`. On Pair Cloud each repository syncs into its own root project's
mirror under the thread's ref names, so mirror reads, sleep snapshots, rebuilds and head records
work per repository; a repository missing from the folder is rebuilt alone, and a sleep with one
repository unsnapshotted records no snapshot, so reads fall back to checkpoints. A thread's `roots`
are copied at launch and don't follow later edits to the workspace, so read the thread's copy, not
the project's. A project with `roots` never has
tracked folders: the server refuses to add them to a workspace. "Workspace" here is unrelated to
"workspace root" and to the workspace host above.

## Pair Builder host mode

Pair Builder runs one sandbox per task and embeds a workspace in its own UI. With
`PAIR_BUILDER_INGRESS_TOKEN` set ([config](../../apps/server/src/cli/config.ts)) the server is
that workspace: the Builder's page serves the web client and reaches this server only through
its proxy, which drops `Set-Cookie`, so a browser here never holds a credential of its own (see
[environment auth](./04_environment-auth.md#pair-builders-proxy-vouches-for-its-users)). The
server bootstraps one project for the Builder's workspace root instead of a starter thread,
and a Builder session is a top-level thread in it.
[PairBuilderHost](../../apps/server/src/pairBuilder/PairBuilderHost.ts) starts those threads
for `POST /api/host/sessions`, and the
[snapshot publisher](../../apps/server/src/pairBuilder/SessionsSnapshotPublisher.ts) posts the
whole list back, which the Builder uses for its chat list and for parking idle sandboxes. That
push is best effort: it runs beside orchestration, reads projections after they commit, and a
Builder that is down only delays the next snapshot. Without the token none of this exists.

## Settings ownership

Client preferences live in the current client; environment defaults and project overrides live on
their owning server. An unavailable settings target must never fall back to another environment.
**All environments** is an explicit bulk edit of currently connected servers, not a durable global
default or sync promise.

## Durable intent and side effects

Orchestration state is decided as events, and persisted projections are the source of truth once
applied. The [orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes
commands and decides events without doing I/O.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted
projections, command receipts, and outbox effects in one database transaction, then notifies
subscribers.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) runs side effects after
commit and feeds results back as commands. A command acknowledgement therefore means intent
committed, not that provider, checkpoint, or follow-up work finished. Never put external I/O in
command decisions or the database transaction. Effects tied to a lost provider process are retired
on recovery rather than replayed.

The event log retains only a bounded replay window, so projections cannot be rebuilt from scratch
from the log. Retained events must remain decodable across upgrades: schema changes affect stored
history at startup, not just live RPC traffic.

## Turn completion and checkpoints

A provider turn ending and follow-up work settling (checkpoints, diffs, PR sync) are separate
milestones. Late finalization must not keep the client showing provider work as active or extend
recorded provider duration.

Checkpoints use hidden Git refs so workspace snapshots never add commits to the user's branch.
Reverting a checkpoint must coordinate workspace state with the provider conversation: if the
provider cannot roll back its conversation, reject the revert before touching the filesystem.

Thread settlement is server-owned. Clients render persisted settlement state rather than deriving it
from local clocks or PR caches.

## Desktop process isolation

Native modules never load on the Electron main process startup path. Native capabilities that can
crash or stall (such as accessibility or window-capture helpers) run in isolated child processes or
workers with deadlines, never as top-level imports in main.

See the [glossary](./00_glossary.md) for shared terms and the
[development runbook](../operations/00_development.md) for setup and checks.
