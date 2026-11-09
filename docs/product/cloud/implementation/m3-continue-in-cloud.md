# M3 Continue in cloud: implementation specs

Status: implementation plan, 2026-11-09. Nothing here is built. Read [README](./README.md) first
for the shared names and traps, and [M2](./m2-pair-cloud-docker.md) for what this milestone builds
on. The design is in docs [01](../01-product.md)–[09](../09-byoc.md), mostly
[07 §8](../07-access-and-data.md#8-moving-sessions-between-a-members-mac-and-pair-cloud-m3),
[08 §2](../08-clients-and-contracts.md#moving-sessions-m3) and
[08 §6](../08-clients-and-contracts.md#the-agent-link-m3); the PR list is
[10 §2](../10-delivery-plan.md#m3-continue-in-cloud), and
[m2-m5](./m2-m5.md#m3-continue-in-cloud) has each row's scope as first sharpened.

Each PR follows one template: what it makes true, Needs and Unblocks, Files, Types and services,
Commands and events, Migrations, Tests, Verify, Reviewer checks. Line numbers are from `feat/pair`
at `18e9d6579` (2026-11-09); re-read the symbol before editing. Where a spec says **proposed**, it
fills a gap the design docs left open; a reviewer can overrule it in that PR, and the spec names
what else would change.

M3's PRs merge after G2, which closed on 2026-11-09 with its set-aside items in
[progress](./progress.md). M3 is done when [G3](../10-delivery-plan.md#g3-end-of-m3) passes; the
[last section](#m3-integrated-pass) turns G3 into steps.

Two engineering calls the plan asked for before 3.19 and 3.23
([08 open questions](../08-clients-and-contracts.md#open-questions) 1 and 6):

- **The tool for an agent's move** is a thread-toolkit tool on the laptop,
  `t3_thread_continue_in_cloud`, which calls the same service method as the menu (3.23). Not
  `t3_thread_transfer`, which forks and merges context between threads on one server. Continue
  locally stays a desktop action in M3.
- **A laptop agent sends unpushed work** only through that tool and its seed. `t3_thread_launch`,
  `delegate_task` and `t3 thread` through the link keep M2's rule: the branch must be on origin.

## Build order

Waves respect every Needs below; rows in one wave can be built in parallel, and two rows in one
wave that touch the same file land one after the other.

| Wave | PRs                                                                     |
| ---- | ----------------------------------------------------------------------- |
| 1    | 3.19 agent link, 3.20 staged seeds                                      |
| 2    | 3.21 seed checkout, 3.22 context export                                 |
| 3    | 3.25 continue locally                                                   |
| 4    | 3.23 continue in cloud                                                  |
| 5    | 3.24 mobile, 3.26 docs, then the [integrated pass](#m3-integrated-pass) |

The critical path is 3.20 → 3.22 → 3.25 → 3.23 → 3.24 → 3.26 → G3, with 3.19 joining at 3.25 and
3.21 at 3.23. G3 also needs a release with M3 (the maintainer approves each release).

| PR   | Needs (final)                |
| ---- | ---------------------------- |
| 3.19 | M2                           |
| 3.20 | M2 (2.26)                    |
| 3.21 | 3.20; 2.13, 2.31             |
| 3.22 | 2.32, 3.20                   |
| 3.23 | 3.19, 3.20, 3.21, 3.22, 3.25 |
| 3.24 | 3.23                         |
| 3.25 | 3.19, 3.20, 3.22             |
| 3.26 | 3.19, 3.22, 3.23, 3.24, 3.25 |

## What the code changed in 10 §2

Drafting each PR against the code changed the plan in these ways. The [track notes](#track-notes)
give the evidence.

- **Order.** 3.20 needs nothing from 3.19 in code: a peer link's `mcp-client` session already
  authenticates as the member who approved its pairing code, so 3.20 moves to wave 1. 3.22 needs
  3.20, whose upload route, table and sweep carry the export too. 3.25 needs 3.20 and 3.22 as well
  as 3.19, so it moves from wave 2 to wave 3. 3.23 needs 3.25, whose `CloudMoves` service, route
  client and move row it extends.
- **Larger than the rows said.**
  - 3.19: the link's session is member-bound, but the `/mcp` scope drops `memberId` for peer links
    (McpOAuth.ts 625). Today a link's launches belong to the server owner: the wrong provider
    account, no member GitHub token, no attribution. The fix is one line and applies to every peer
    link. 3.19 also:
    - takes agent links out of the Linked environments beta, with a stored `cloud_launch` marker
      (migration 092);
    - lets members mint a pairing code from the client (clients asked `access:write`, the server
      needs `access:read`);
    - runs the setup script in a link's cloud sessions;
    - gives the eval runner per-environment mocks.

    Its title gains contracts, client-runtime, web and mobile.

  - 3.22 adds a turn item type, which breaks three exhaustive switches on mobile, and renders the
    `move` row on web. Its title gains client-runtime, web and mobile.
  - 3.23 grows a Pair Cloud half: `POST /api/cloud-moves/check`, so an agent's move gets the
    account check before anything uploads, and the launch route. Its title drops `desktop`, since
    nothing in `apps/desktop` changes, and gains contracts, shared and client-runtime.
  - 3.21 fixes 2.13's skip of cloud threads launched without a message, which are never rebuilt
    after a lost disk (proposed, two lines).

- **Smaller than the rows said.**
  - 3.21 needs no contract change. `seedRef` and `contextExportRef` live on the server's launch
    input, not on `OrchestrationV2ThreadLaunchCloudStrategy`, which is the client `thread.launch`
    and the model-facing `t3_thread_launch` schema.
  - A seed is 2.13's mirror case at a new path, so `checkoutInSandbox` keeps three sources (disk,
    mirror, origin), not four.
  - 07 §10 #21's tests move to 3.20, which owns `stage` and `claim`.
  - 3.25's title drops `desktop` for 3.23's reason.
- **Where the code and the design differ.**
  - A seed is keyed by the move's staging key, which the laptop derives the same way on every
    retry, and is sent with `PUT`. The launch's command id is derived from the key.
  - "Ask the local server for full history" is a typed `409 missing-prerequisite`, since Pair
    Cloud never calls the laptop. For Continue locally, the laptop says what it has (`?have=`)
    rather than asking for `?full=1`.
  - A snapshot goes into a working tree with 2.13's `read-tree --reset -u` and `reset`, not
    `restoreCheckpoint`, which would stage everything.
  - The handoff is built at the new thread's first run, as a V1 import's is, not at import: a
    handoff names a target run. Imported history is written by an internal command,
    `thread.history.import`.
  - `git bundle create` drops a ref that a prerequisite reaches. A branch with no commits past its
    base therefore uses the merge-base's parents as prerequisites.
  - The mobile entry point is the header's **Cloud** menu and the row menu: the thread sheet is
    the model picker.
  - Delegation to Pair Cloud names `cloud`, and `t3 thread` keeps `--cloud`: 2.22 refuses every
    non-cloud launch on Pair Cloud. 3.26 corrects 08 §6 and 01 J7.
  - "Continued on `<name>`'s Mac" reads "Continued locally on `<environment label>`": the local
    server knows its own label, not that it runs on a Mac.
  - An agent may move its own thread mid-turn. "Blocked while a run is active" applies to every
    other run.
- **Migrations.** Two, each taking the next free id at merge (P8): `092_PeerLinkCloudLaunch`
  (3.19, the laptop's link table) and `093_StagedCloudImports` (3.20).
- **Found outside M3.**
  - Runless notices (lifecycle notices, 2.13's rebuild notice) sort above run 1. This needs a fix
    PR of its own.
  - The transcript endpoint's item array is strict, so the server leaves `move` rows out of
    transcripts.

Open questions for a maintainer, each with a proposed answer in its spec. **Answered 2026-11-09:**
every proposal below is accepted except the row wording, which is "Continued locally on
`<environment label>`" and "`<member>` copied this thread to `<environment label>`". Only the
evals key is still open.

- Agent links without the Labs beta (3.19). Proposed: no beta for them, on either side.
- Non-cloud MCP launches on Pair Cloud (3.19). Proposed: still refused in M3. Agents and the CLI
  name `cloud`.
- The account a link launch gets with no model, and teammates' accounts in
  `orchestrator_capabilities` (3.19). Proposed: a follow-up after G3 if agents pick a teammate's.
- The link fence follows the session, so a renewed link can't steer earlier work over MCP (3.19).
  Proposed: fence by link client later, if G3 or dogfooding hits it.
- How long an unclaimed seed waits (3.20). Proposed: 24 h; claimed rows stay, which keeps replays
  idempotent. Node's 300 s request timeout stays (a full 512 MiB seed needs about 1.7 MB/s).
- What an export carries (3.22). Proposed: user and assistant text only, capped at 2 MiB, 1,000
  messages and 64 KiB a message.
- Continue locally on an asleep machine with no usable snapshot (3.25). Proposed: refused, with
  "Wake the machine first".
- The row wording (3.22, 3.25). Proposed: "Continued on `<environment label>`", and
  "`<member>` continued a copy on `<environment label>`". Answered: "Continued locally on
  `<environment label>`" and "`<member>` copied this thread to `<environment label>`", each row
  repeating its action's name as "Continued in cloud on `<label>`" does.
- Continue locally in `npx t3`'s web as well as the desktop (3.25). Proposed: yes. It shows
  wherever the client's primary environment is the member's own server.
- Which model the cloud thread uses (3.23). Proposed: the member's own instance of the same driver
  and model on Pair Cloud, then a team one, then any usable one.
- "Connect GitHub on Pair Cloud" before a move (3.23). Proposed: a warning, as M2's banner is; a
  public repo moves without it.
- A keybinding for Continue in cloud (3.23). Proposed: none, as for the machine actions.
- The 1.42 and M3 evals need an `ANTHROPIC_API_KEY` in the repo's `.env` (still open from G1).

## Shared names

The names below cross PRs. Each is defined by the PR in brackets; later PRs use it as written.

- **Agent link.**
  - An agent link is an ordinary `PeerLink` from a member's local server to an environment
    reporting `cloudLaunch`, needing no Labs beta (3.19).
  - On Pair Cloud it is an `mcp-client` session with `peerLink: true`, bound to the member who
    approved its pairing code, whose `memberId` now reaches `/mcp` (3.19).
  - Added by 3.19: `ResolvedPeerLink.capabilities`, `PeerLinks.agentLinks`,
    `PeerMcpClient.peerLinkFailure`, `OrchestratorMcpEnvironmentLink.cloud`, client-runtime
    `offersAgentLink` and `LinkableMachine.cloud`, web `useLinkMachine`, and
    `t3 thread --environment`.
- **Staging (3.20).**
  - In `packages/contracts/src/cloudMove.ts`: `CloudStagingKey` (`mv_` plus 32 lowercase hex),
    `CLOUD_MOVE_ROUTE_PREFIX` (`/api/cloud-moves`), `CLOUD_SEED_MAX_BYTES` (512 MiB),
    `cloudSeedRefs(key)` (`refs/t3/staged/<key>/branch` and `…/snapshot`),
    `CloudMoveFailureReason`, and `CloudMoveFailure` (every route's error body, its reason
    forward-compatible).
  - `ExecutionEnvironmentCapabilities.cloudImport`.
  - `apps/server/src/cloudMove/` (never `cloud/`, which is T3 Connect): `StagedCloudImports`
    (`stage`, `check`, `claim`, `sweep`, kinds `seed` and, from 3.22, `context-export`),
    `StagedCloudImportError`, and `CloudMoveHttp` (`authenticateLinkMember`, which returns
    `memberId`, `sessionId`, `label` and `access`, and `layer`, where every cloud-move route
    goes, behind one byte budget).
  - `CheckpointMirror.importBundle`'s `exactRefs`, and `CheckpointMirror.commitParents`.
- **Routes.** All under `/api/cloud-moves`, on cloud-only servers only:
  - `PUT staged/<key>/seed?projectId=` (3.20);
  - `PUT staged/<key>/context-export?projectId=` (3.22);
  - `GET threads/<threadId>/context-export`, `GET threads/<threadId>/seed?have=<oid>…` and
    `POST threads/<threadId>/continued` (3.25);
  - `POST check` and `POST staged/<key>/launch` (3.23).
- **Seed checkout (3.21).** `seedRef` on the server's `ThreadLaunchWorkspaceStrategy` (no
  contract field); `checkoutInSandbox`'s `seeded` input and `restoredFrom: "seed"`;
  `CloudLaunchError` reasons `seed-on-base` and `seed-unavailable`.
- **Context export (3.22).**
  - Contracts: `OrchestrationV2ContextExport` (`source: { environmentId, environmentLabel,
    threadId, title }`, the messages, `omittedMessageCount`), `OrchestrationV2ContextExportMessage`,
    `CONTEXT_EXPORT_MAX_BYTES`, `CONTEXT_EXPORT_MAX_MESSAGES`, `CONTEXT_EXPORT_MAX_MESSAGE_CHARS`;
    `historyOrigin` `"context_export"`; the `move` turn item (`direction: "to" | "from"`,
    `thread`, `copy?`, `message`, `actorId?`).
  - Server: `contextExportRef` and `contextExport` on the server's `ThreadLaunchInput`;
    `ContextExports` (`build`, `import`), `ContextExportError`, `capContextExport`,
    `threadHasImportedHistory`; the internal commands `thread.history.import` and
    `thread.move.record`; `CloudLaunchError` `export-unavailable`.
- **Moves.**
  - On the laptop: `CloudMoves` (`continueLocally` from 3.25, `preview` and `continueInCloud`
    from 3.23) and `CloudMoveClient` (3.25, extended by 3.23).
  - On Pair Cloud: `CloudMoveSource` (3.25) and `CloudMoveLaunch` (`check`, `launch`; 3.23).
  - `MirrorSync.bundleThread` (3.25, and `restore` calls it).
  - RPCs `threadMove.toLocal` (3.25), `threadMove.preview` and `threadMove.toCloud` (3.23).
  - In `cloudMove.ts`: `ThreadMove*`, `CloudMove*` and `CLOUD_MOVE_DEFAULT_MESSAGE`.
  - `VcsCaptureCheckpointInput.excludePaths`, and in `@t3tools/shared` `usableCloudProviders` and
    `pickCloudMoveModel` (3.23).
  - client-runtime `createThreadMoveAtoms` and `resolveContinueLocally` (3.25), and
    `continueInCloudOffer` (3.23).
  - The agent tool `t3_thread_continue_in_cloud` (3.23).

## Track notes

Each track's rows were drafted together; these notes keep the reasoning behind the changes above.

### Agent link (3.19)

These notes keep the reasoning behind the places where 3.19 departs from m2-m5, 10 §2, 08 §6 and 06.

#### PR list and scope

- **3.19's scope is wider than its title.** It touches contracts (`OrchestratorMcpEnvironmentLink.cloud`),
  client-runtime (`offersAgentLink`, `LinkableMachine.cloud`), web (Connections, the link card,
  the Labs copy), mobile (the link card, the list of links) and the eval runner. The title becomes
  `feat(contracts,server,client-runtime,web,mobile): …`, as 2.52 and 2.56 did. The server half
  stands alone if a reviewer wants it split: with the beta on, or with `t3 environment link`, a
  member can make the link without the UI changes. The UI half must then land before 3.23, which
  offers the link.
- **A migration M3's plan didn't have.** `092_PeerLinkCloudLaunch` adds `cloud_launch` to
  `peer_environment_links`, written like `071_PeerLinkFence`. 3.20 takes 093 in the same wave;
  whichever lands second renumbers if the order changes (P8).
- **Delegation to Pair Cloud names `cloud`, and the CLI keeps `--cloud`.** 08 §6 says "on Pair Cloud
  every launch is a cloud launch … an agent there needs no flag", and that `t3 thread` pointed at
  Pair Cloud needs no `--cloud`. The code doesn't do that.
  - 2.22 made `ThreadLaunchService.launch` refuse every non-cloud strategy with `"local-launch"`
    (ThreadLaunchService.ts 1133–1143). It places only scheduled runs (`cloudPlacement`, 423).
  - The local `delegate_task` path on a cloud-only server demands `isolation: "cloud"`
    (OrchestratorMcpService.ts 2403–2408).
  - So 3.19 sends `{ type: "cloud", baseRef }` from `RemoteDelegation`, refuses other isolation on a
    cloud-only target, and has `t3 thread --environment` ask for `--cloud`.
  - 3.26 should correct 08 §6 and 01 J7 step 5, or a later row could place MCP launches on Pair
    Cloud as 2.18 places scheduled ones. That is a product call, not 3.19's.
- **Setup scripts for a link's cloud sessions.** `ProjectSetupScriptRunner.runForThread` skips
  every thread from a link paired below full access (369–372). A member can't pair full access
  (`mcpClientScopes("full-access")` needs `settings:write`, team.ts 136–148). So without a change,
  every cloud session an agent link starts would boot without the project's setup script. The fence
  exists to keep a link's agent from running the user's code on the user's machine. A cloud session
  runs it in its own machine, so 3.19 skips only when the thread has no `sandboxId`.
- **Members couldn't mint a code from the client.** The web dialog and both link cards check
  `access:write` before minting (LinkedEnvironmentsSettings.tsx 190, web LinkRequestCard.tsx 238,
  mobile LinkRequestCard.tsx 259). The `pairingCredential` route asks only `access:read`
  (auth/http.ts 480, `requireAccessManagement` 233), and "Any member can add a device for
  themselves". A member therefore had to paste a code from Pair Cloud. 3.19 aligns the client with
  the server.
- **No separate "Link this Mac" button** (proposed). With minting fixed, the Connections **Link**
  dialog shows without the beta when the client knows a Pair Cloud, preselects it, and takes two
  clicks. 3.23's move dialog offers the same flow inline through `useLinkMachine` when no link
  exists. A Settings → Cloud row could call the same hook if a reviewer wants one.
- **The eval runner gains per-environment mocks.** `mocks` is keyed by bare tool name (run.ts
  1571), so a case can't give the laptop `cloudThreads: false` and Pair Cloud `cloudThreads: true`.
  `"<tool>@<environmentId>"` keys fix that, with a unit test in run.test.ts. 3.23's cases can reuse
  them.

#### Evidence for the member binding

Is the link session already member-bound, and what is missing? The session
is. The scope is not.

- **Bound:** `McpOAuth.approve` (461) → `consumeMcpApprovalCode` → `grant.memberId ?? ownerId`
  (EnvironmentAuth.ts 1499) → `mintCode(…, approverMemberId)` → `exchangeCode` →
  `issueMcpClientSession({ memberId })` (McpOAuth.ts 553–558) → `authenticateMcpClient` returns
  `memberId` (EnvironmentAuth.ts 1417–1442). Member removal revokes at the same point.
- **Dropped:** `layerMcpClientAuthenticator` spreads `{ hostedAppUrl, memberId }` only for non-link
  clients (McpOAuth.ts 625). `git log -S` shows the team-members commit (ac73be2af) added `memberId`
  to a spread that existed only to keep `hostedAppUrl` off peer links. Nothing in the code reads a
  missing `memberId` as "this is a link". Every reader (`viewerOf`, `sendActorId`, `t3_thread_launch`
  ownerId, `t3_thread_organize` actorId, `t3_project_clone` member, `scheduleTask` owner) wants the
  member.
- **Consequences on Pair Cloud today:**
  - the thread's `ownerId` is null, so its holder is the server owner;
  - the member's own provider account is refused as someone else's (ThreadManagementService.ts 831);
  - the machine gets no member GitHub token (GitCredentialService.ts 130–132, 311);
  - the sandbox's `ownerMemberId` is null (Orchestrator.ts 10984);
  - sends carry no author (threadAccess.ts 76).
- **The fix applies to every peer link, not only Pair Cloud.** On a solo server the member is the
  owner, so nothing visible changes. On a team server, a link's sends and launches are now
  attributed to the member who approved it, which is what the team-members PR set out to do.

#### The Labs beta (proposed: not for agent links, on either side)

Today the beta gates five places.

- **Pair Cloud side:** `McpOAuth.register` refuses a peer-link registration (348–355), and the
  `/mcp` middleware answers 403 to a linked client (McpHttpServer.ts 236).
- **Laptop side:**
  - `PeerLinks.link` refuses up front (412);
  - `PeerForwarding.call` and `links` refuse (214–218), and `McpToolAccess.routed` refuses early
    (402);
  - `hiddenWhileLinksOff` hides the three link tools;
  - `PeerLinkRequests.request` refuses (207–212);
  - on the client, `offersLinkedEnvironments` hides Connections' section and the composer's machine
    names.

Why exempt agent links:

- Pair Cloud is a team feature with its own startup mode (10 §5: "There is no separate feature
  flag").
- Continue in cloud and continue locally both need the link.
- On Pair Cloud a peer link is just an MCP client session bound to a member, no broader than the
  API token that member can already create.

The exemption is narrow:

- inbound, only on a cloud-only server;
- outbound, only to a peer reporting `cloudLaunch`, and only from a server that isn't cloud-only
  itself (D14: laptop to cloud). Inbound links to a laptop keep needing its beta;
- while the beta is off, an environment's agents start work only over its agent links.

The gates run per MCP request, including tool visibility, so they can't probe peers. Hence the
stored `cloud_launch` marker.

- It is read from SQLite through the reader on each check while the beta is off. It is not cached
  in memory, because `t3 environment link` writes the table from another process (cli/environment.ts
  27).
- `resolve` and `list` correct it from the descriptor they already fetch.
- A stale marker lets one forwarded call through before `resolve` corrects it. The peer still
  enforces its own rules, so that is accepted.

If a maintainer keeps the beta on the laptop, drop the migration, `agentLinks`, the
forwarding and middleware changes and `offersAgentLink`. Keep the Pair Cloud half and the member
fix. 3.23's link offer then also turns the beta on.

One gap stays. While the beta is off, an agent can't ask for the _first_ agent link, because the
link tools stay hidden until one exists. Showing them to every install would grow every agent's
tool list. The member makes the first link from Connections or from 3.23's move, and an agent asked
for cloud without one says cloud isn't available, as `cloud-unavailable-no-cloud` checks.

#### What the fence means for cloud sessions started through the link

`mcp/linkOrigin.ts` fences only MCP callers: the link's session and agents inside threads it
started. Clients are never fenced. WebSocket dispatch never reads `linkOrigin`, and
`withCreationProvenance` strips it from client commands (ThreadManagementService.ts 99–101). So:

- Teammates and the member's own desktop and phone open and prompt these sessions like any other
  (D15). "From Pair · <Mac>" marks them (ChatHeader.tsx 438, mobile ThreadRouteScreen.tsx 549).
- Agents inside these sessions can change only threads the same link session started. They can't
  touch projects, settings or scheduled tasks, or use Pair Cloud's own links. With 3.19 they still
  get their setup script.
- Another link's agents can read these sessions but not change them over MCP.

Not fixed: renewal is a new session. Links last 30 days, and linking again issues a new session id.
Work the old session started stays fenced to the old id, so after a renewal the Mac's agents can
read and wait on it but can't send to it, interrupt it or stop it over MCP. A remote task's cancel
or a parent's Stop then fails `capability_denied`. `RemoteDelegation.isFinal` treats that as final,
so the task fails "may change only threads that link started". This already happens for every peer
link, and agent links renew more visibly. A fix would fence by link client (the member and the
linking environment) rather than by session. That is a later row if G3 or dogfooding hits it.

#### Smaller findings left as they are

- **The token on the Mac.** It sits in the local server's secret store, which every local agent can
  read (06 §1). A hijacked agent can copy it and act as the member on Pair Cloud's `/mcp` (and, from
  3.20, its staging routes) at the link's access until it is revoked or expires. A member API token
  on that Mac has the same exposure. 06's "Hijacked local agent → Pair Cloud" residual should say
  so (3.26).
- **The model a link launch gets.** A `t3_thread_launch` through the link with no `modelSelection`
  takes Pair Cloud's project default. `delegate_task` inherits the Mac's instance id, which may name
  another account or none on Pair Cloud. Either way Pair Cloud refuses a teammate's account
  ("belongs to …"), and `orchestrator_capabilities` with `environmentId` lists teammates' accounts
  without marking them.
- **`projectId` through the link.** Pair Cloud sees a client caller with no thread to inherit from
  (threadAccess.ts 182–188), so the laptop resolves it before forwarding: `PeerForwarding.resolveProject`
  matches the calling thread's repository against `t3_project_list` there, for `delegate_task` and for
  a `t3_thread_launch` that names neither `projectId` nor `scratch` (live evals found agents omit it,
  as the tool's description says). An agent may still pass one.
- **The access picker** offers full access to a member who can't mint it. Minting then fails with
  "Your session there cannot create sign-in codes", which is wrong about why.

### Seeds (3.20, 3.21)

These two rows get unpushed work from a member's Mac onto a machine. 3.20 is the door: an
authenticated upload over the agent link that stages a git bundle in the project's mirror under
`refs/t3/staged/<key>/`, strictly checked, and swept if no launch takes it. 3.21 is the use: a
launch claims the seed for its new thread, and the machine's checkout comes out of the mirror.

The design turns on one choice: **the claim moves the seed into the thread's own mirror refs**
(`sandboxBranchRef(thread)`, `sandboxSnapshotRef(thread)`). After that a seeded thread is, to the
mirror, a thread whose disk was lost before it ever ran. 2.13's `MirrorSync.restore` brings it
back; `checkoutInSandbox` only has to run that case for a thread with no recorded worktree. So
there is no second restore path, no seed key on the frozen run union, and a retry, a re-armed
run after a restart and a later rebuild of a lost disk all work without knowing a seed existed.
Rebuild after a lost disk was checked: once synced, the mirror holds the thread's own branch and
snapshot, and the recorded worktree comes back as `restoredFrom: "mirror"` exactly as for any
thread. Before the first sync or sleep, it comes back as the seed was.

#### PR list and order

- **3.20 needs M2 only, not 3.19.** Peer-link `mcp-client` sessions already exist and already
  belong to the member who approved the pairing code (`McpOAuth.ts` 554–559 issues with
  `pending.approverMemberId`; `EnvironmentAuth.authenticateMcpClient` 1418 returns `memberId`,
  `access` and `peerLink`). The route needs nothing 3.19 adds, and its tests mock the session. It
  merges in wave 1 beside 3.19; only reaching it from a laptop waits for 3.19.
  10 §2's Needs for 3.20 becomes "M2 (2.26)".
- **07 §10 #21's tests move to 3.20.** "An unpushed commit and an untracked file arrive" and "a
  retried upload doesn't duplicate" exercise `stage`, `claim` and 2.13's `restore`, all of which
  exist after 3.20. They go in `StagedCloudImports.test.ts`; 3.21 tests its launch wiring and the
  `checkoutInSandbox` change. (AGENTS: test at the lowest layer that fails on `main`.)
- **3.21 has no entry point of its own.** `seedRef` is sent only by 3.23's launch route, so 3.21's
  runtime transcript runs with 3.23 (G3 step 1).
- **3.21 widens slightly.** `restoreInBackground` (ThreadLaunchService.ts 1501–1504) skips any
  thread with no run that recorded a `worktree` preparation, so a cloud thread launched without a
  message is never rebuilt after a lost disk (pre-existing since 2.13, also true of idle MCP
  cloud launches). A seeded launch may be one, so 3.21 makes it fall back to the thread's branch
  as `baseRef` (**proposed**; two lines). Dropped, 3.23 must always launch with a message.
- **10 §2 title text for 3.20.** "keyed by command id" becomes "keyed by the move's staging key".

#### Where the code and the design differ (code wins on facts)

- **Keyed by `CloudStagingKey`, sent with `PUT`.** 07 §8 step 4 and 08 §2 say the upload is a
  POST keyed by the launch's command id. The key is the move's id, which the local server derives
  once per move (3.23); `PUT` because a retry replaces what is staged. 3.23 derives the launch's
  command id from the key, so a resent launch replays.
- **"Asks the local server for full history" is a typed `409`.** Pair Cloud never calls the laptop
  (08 §6). After one `fetchCheckout` and one retry, the upload answers `409` with
  `CloudMoveFailure.reason: "missing-prerequisite"`; the local server re-bundles with no
  prerequisite under the same key.
- **The snapshot is not restored with `restoreCheckpoint`.** 07 §8 step 6 and the row's scope say
  `restoreCheckpoint`. 2.13 chose `read-tree --reset -u` then `reset` (MirrorSync.ts 451–454)
  because `restoreCheckpoint` runs `git restore --worktree --staged` (GitVcsDriver.ts 1374–1381)
  and would stage everything. Seeds reuse 2.13's path, so edits arrive unstaged and untracked
  files untracked, as they were on the laptop.
- **The snapshot must sit on the branch tip.** `MirrorSync.restore` keeps a snapshot only when its
  single parent is the branch tip (MirrorSync.ts 399) and otherwise silently restores the branch
  alone. `captureCheckpoint` commits with `-p HEAD` (GitVcsDriver.ts 1309–1316), so a seed built
  as 07 §8 describes passes; 3.20 checks it at upload and refuses anything else, so uncommitted
  files are never dropped without a word.
- **`seedRef` is not a contract field.** The row's scope puts it on the cloud strategy,
  `OrchestrationV2ThreadLaunchCloudStrategy`. That struct is in the union the client
  `thread.launch` RPC decodes and that `t3_thread_launch` uses as its schema unchanged
  (mcp/toolkits/project/tools.ts 145), so the field would reach every client and the
  model-facing schema (and `agentContextBudget.json`). It stays out of the tool: the only sender
  is 3.23's server-side launch route, which builds `ThreadLaunchInput`
  itself. So `seedRef` lives on the server's `ThreadLaunchWorkspaceStrategy`
  (ThreadLaunchService.ts 84–90). If a reviewer wants it on the wire, the tool needs its own
  strategy schema without it.
- **`checkoutInSandbox` keeps three sources.** Disk, mirror, origin. A seed is the mirror case at a
  new path; `restoredFrom: "seed"` labels it in logs and keeps a seed from being called a rebuild.
- **The mirror case asks the mirror for every new cloud thread.** One `for-each-ref` in the local
  mirror per cloud checkout (MirrorSync.ts 367–371), which returns before touching the machine.
  That is what makes retries and re-arms find the seed without a flag.
- **2.31 does not fire for seeds.** `existingBranch` is ignored when `seedRef` is set: the launch
  check (ThreadLaunchService.ts 1194) doesn't run, and the in-sandbox `branch-not-pushed`
  (CloudPreparation.ts 319) is never reached because the mirror case returns first. A seed whose
  mirror copy is gone fails `seed-unavailable` instead of falling back to the base.
- **A seed can't be on the base or the default branch.** The machine's clone has origin's default
  branch checked out, and `restore` fetches into `refs/heads/<branch>`, which git refuses for a
  checked-out branch. 3.21 refuses `branch === baseRef` or the Pair Cloud checkout's current
  branch with `seed-on-base`; 3.23 picks a new branch name for such work (2.31 made the same call
  for `existingBranch`).
- **Byte budgets (2.40).** The upload doesn't touch the runner socket, so the per-sandbox ingress
  budget doesn't apply. It goes through one `makeByteBudget` shared by every cloud-move route
  (32 MiB/s, 16 MiB burst, 2.59's numbers), because 2.59 found that any large transfer beside a
  busy PTY costs other machines' latency. The mirror-to-machine write is 2.13's: 128 KiB frames,
  each awaited (SandboxWorkspaceHost.ts 46, 477–491). Node's default 300 s `requestTimeout`
  (server.ts 386 sets none) means a full 512 MiB seed needs about 1.7 MB/s.
- **environment-auth.md's rule changes.** It says only `/mcp` accepts `mcp-client` sessions
  (125). The cloud-move routes accept a linked environment's session with operate access on a
  cloud-only server. 3.20 rewrites that sentence.

#### Smaller proposals

- `CloudStagingKey` is `mv_` plus 32 lowercase hex: safe in a ref name and a path.
- The bundle's two refs carry their final names (`cloudSeedRefs(key)`), so the server checks
  names and count and writes nothing else. The local server makes those refs as temporary refs
  before `git bundle create`.
- A failed upload drops any earlier seed under its key; a claimed key can't be restaged.
- Unclaimed seeds live 24 h; claimed rows stay as one small row per move, which keeps a replayed
  claim idempotent. Deleted refs free disk at the next maintenance prune, as for deleted threads.
- No per-member quota or upload concurrency limit: the per-project write lock serializes imports,
  the shared budget serializes bandwidth, and membership is the trust boundary.

### Context export and Continue locally (3.22, 3.25)

3.22 makes a conversation portable: an export with its own provenance, imported on another
server as runless history on a new thread, with the handoff V1 imports already get. It also
defines the `move` row that links the two threads. 3.25 is the first move to use it: Continue
locally pulls a cloud session's branch, snapshot and export down to the member's computer over
the agent link, and the cloud side records the move and, for the holder, settles.

The design turns on two code facts. **V1's import path already does almost everything.** A thread
with `historyOrigin: "v1_import"` and runless messages gets a `manual_context` handoff on its first
run (`shouldPrepareLegacyImportHandoff`, Orchestrator.ts 1130–1138), built from those runless
items, whose omitted-item pointers name the thread itself. So an export is imported as exactly
that, under a new `historyOrigin`, and every `=== "v1_import"` reader becomes
`threadHasImportedHistory`. **2.13's restore already bundles a thread out of the mirror.** Its
mirror half becomes `MirrorSync.bundleThread`, which 3.25's download serves and 3.21's seed restore
keeps using.

#### PR list and order

- **3.22 needs 3.20.** The export is staged in 3.20's table and routes (`StagedCloudImportKind`
  `context-export`, `CloudMoveHttp.layer`), and `contextExportRef` is a `CloudStagingKey`, so
  3.22 goes in wave 2. 10 §2's Needs for 3.22 becomes "2.32, 3.20".
- **3.25 needs 3.19, 3.20 and 3.22.** Its Pair Cloud routes live in 3.20's `CloudMoveHttp.layer`
  with its auth helper, byte budget and `cloudImport`; the laptop resolves the link with 3.19's
  `capabilities`. 10 §2 lists 3.19 and 3.22. It moves to wave 3.
- **3.25 changes 3.21's file.** `MirrorSync.restore` is refactored onto `bundleThread`. 3.21 lands
  a wave earlier and keeps calling `restore`, so nothing in 3.21 changes; 3.25's reviewer checks
  that `restore` behaves as before.
- **3.22 touches mobile.** Adding a turn item type breaks three exhaustive switches in
  `apps/mobile/src/lib/threadActivity.ts` (492, 579, 652), so the title's scope is really
  `contracts,server,web,mobile`. The mobile change is a sentence row only.

#### Where the code and the design differ (code wins on facts)

- **The handoff is built at the first run, not at import.** 07 §8 says the receiving server
  "builds the handoff". A handoff names its target run and provider thread
  (ContextHandoffService.ts 49–56), which don't exist at import. The V1 path builds it lazily on
  the first run; exports reuse it, with only the summary header changed.
- **Imported history is written by an internal command, not by `EventSink.write`.** V1's importer
  and AgentSessionImporter write events directly (LegacyV1ThreadImporter.ts 602–643;
  AgentSessionImporter.ts 346–433) because nothing else touches those threads. An export lands on
  a thread a client can already see, so `thread.history.import` takes the thread's lock and
  leaves a receipt; it refuses a thread with any message or run.
- **The "Continued …" row on the source side rides the newest run.** The turn item position store
  puts every runless item at positions 1–999,999 and run `n`'s at `n` × 1,000,000 and up
  (TurnItemPositionStore.ts 61–80, applied to every write by `EventSink.normalizeEvents`
  332–353), and the projection orders by position. A runless row recorded after runs would show
  above run 1. So `thread.move.record` sets `runId` to the newest run that isn't rolled back or
  cancelled.
- **Finding, outside M3: runless notices already land above run 1.** By the same rule,
  `emitLifecycleNotice`'s rows ("Bob archived this thread", Orchestrator.ts 1521–1567) and 2.13's
  rebuild notice (`thread.notice.record`, 4975–5019) sort before the thread's first run. Nothing
  tests their placement. Worth a quick check in a real client and a fix PR of its own (pass the
  newest run's ordinal into `normalize`, or the same newest-run rule).
- **The transcript endpoint is strict.** `OrchestrationV2ThreadTranscript.items` (orchestrationV2.ts
  2229–2235) is a plain `Schema.Array`, unlike every other turn-item array. An M2 web client
  attaching a moved thread as context would fail on the `move` row, so the server leaves `move`
  rows out of transcripts. Making the transcript forward-compatible is the general fix, for M3
  clients onward; it doesn't help M2 clients.
- **2.32 covers M2 clients for `historyOrigin`, both fields.** The app thread (520) and the shell
  (2296) use `ForwardCompatibleOptional`; the JSON variants spread those fields (2494, 2957), and
  `thread.created`/`thread.metadata-updated` carry the app thread, so streams are covered too. An
  M2 client reads `context_export` as absent and shows the imported messages as V1 imports look on
  every client. The `move` row is skipped by `ForwardCompatibleUnion`/`ForwardCompatibleUnionArray`
  everywhere but the transcript (above) and `getTurnItem` (asked only for ids a client has).
- **Snapshots go in with 2.13's `read-tree --reset -u` and `reset`, not `restoreCheckpoint`.**
  `restoreCheckpoint` runs `git restore --worktree --staged` (GitVcsDriver.ts 1374–1381) and would
  stage everything. Same call as 3.20/3.21.
- **`?have=` replaces `?full=1`.** The mirror refetches origin on every sync, so its default-branch
  tip is usually newer than the laptop's; using it as the prerequisite would make most downloads
  full. The laptop sends what it has (its `origin/HEAD` and up to 31 recent branch tips); a commit
  the mirror lacks falls back to full history inside `bundleThread`.
- **The context-export upload takes `?projectId=`.** 3.20's row requires a project, as the seed's
  upload does.
- **Settling uses `thread.settle`; sleeping is 2.1's settle rule.** `sandbox.sleep` would stop a
  machine a teammate's fork still uses. `decideAutoSleep` (SandboxDecisions.ts 155–168) sleeps the
  machine once every attached thread is settled, on drivers with `sleepOnSettle` (Docker).
- **"Continued on `<name>`'s Mac" reads "Continued locally on `<environment label>`".** The local server
  knows its own label ("Kim's MacBook Pro"), not that it's a Mac; the desktop runs on Windows and
  Linux too. G3's pass checks this row; its wording in pass.md should follow.
- **Owner means the thread's holder**, `ownerId ?? the server owner` (`holderOf`,
  MemberThreadState.ts 74–79), decided on Pair Cloud.

#### Smaller proposals

- Export content: user and assistant text only, without attachments, composer context or authors
  (all name things on the source server). Caps 2 MiB, 1,000 messages, 64 KiB per message; the
  first user message is always kept and the gap is right after it, as AgentSessionScanner does.
- The `move` row carries the server-written sentence (`message`), so MCP reads and every client
  show the same words; clients add an Open link when connected to the other environment.
- An asleep machine without a usable snapshot is refused ("Wake the machine, then try again", the
  menu's **Wake machine**) rather than moved without its uncommitted files; a destroyed disk moves
  what the mirror has.
- Branches: a move keeps the session's branch, else `<branch>-<n>`; a copy is `<branch>-copy[-n]`,
  created from an oid so it tracks nothing.
- The local report to Pair Cloud is retried twice; then the local thread records a notice and the
  move still succeeds.
- The client picks the new local thread's model as a new draft in that project does; the server
  takes it as input.
- Continue locally shows wherever the client's primary environment is the member's own server
  (desktop, or `npx t3`'s web), not only in Electron. On app.t3.codes there is no primary
  environment, so it never shows.

### Continue in cloud, mobile and docs (3.23, 3.24, 3.26)

These rows make the move to Pair Cloud a user action. 3.23 is the whole path on web and desktop:
the menu and palette entry, the preview, the local server's seed and export, the launch on Pair
Cloud, and the laptop agents' tool. 3.24 gives the phone the same action, driving the Mac's local
server. 3.26 documents the moves both ways and the agent link. Every byte goes laptop to Pair Cloud
over the member's link; Pair Cloud never calls the laptop.

The design turns on one choice: **one service method on the local server does the whole move**
(`CloudMoves.continueInCloud`), and the RPC handler and the MCP tool each call it. Pair Cloud gets
two thin routes, a check before any upload and the launch, and builds the launch input itself, so
`seedRef` and `contextExportRef` never reach a wire or model-facing schema.

#### PR list and order

- **3.23's title drops `desktop`.** Desktop wraps web and already talks to its own
  local server over its WebSocket (08 §4); nothing in `apps/desktop` changes. 2.24 made the same
  call.
- **3.23 needs 3.25 as well as 3.21 and 3.22.** It extends 3.25's `CloudMoves`, route client,
  `ThreadMoveError` and client-runtime move atoms, and relies on 3.25's presentation of the move
  row. 3.25 is wave 3 and 3.23 wave 4.
- **3.23 grows a Pair Cloud half.** Two routes in 3.20's `CloudMoveHttp.layer`, `POST
  /api/cloud-moves/check` (new) and `POST /api/cloud-moves/staged/<key>/launch`, and a small
  `CloudMoveLaunch` service. The check exists because 2.30's `cloudAccountNotice` is client-runtime
  code: an agent's move has no client to run it, and "the account check runs before anything
  uploads" must hold for agents too. The "usable account" rule moves to
  `@t3tools/shared/sandboxCredentials` (`usableCloudProviders`) so both sides share one copy.
- **3.24's entry point isn't the thread sheet.** `ThreadSettingsSheet.tsx` is the model picker
  (941). 1.41 put thread actions in the header's Machine and Team menus and the row's long-press
  menu, so Continue in cloud goes in a header **Cloud** menu (the Machine menu's slot, free on a Mac
  thread) and the row menu. The integrated pass uses that menu.
- **3.26 touches more files than the row lists:** `remote-access.md` (one pointer), `pair-cloud.md`
  (invite and offboard), `pair-features.md` (10 §5's M3 row) and, proposed, one sentence in
  `internals/overview.md`. The agent link's section goes in `outside-agents.md` as the row says;
  3.19 leaves it there.

#### Where the code and the design differ (code wins on facts)

- **`git bundle create` drops a ref its prerequisite reaches.** Checked with git 2.43 in a scratch
  repo: with the branch tip equal to the merge-base (an edit on a branch with no commits past the
  base, a common case), `git bundle create … refs/…/branch refs/…/snapshot ^<merge-base>` exits 0
  and lists only the snapshot. 3.20 refuses a bundle without both refs. So when the tip is the
  merge-base, 3.23 uses the merge-base's parents as prerequisites (`^<mb>^@`, checked: both refs,
  and it verifies in a clone of origin). Otherwise the merge-base itself.
- **No bundle or merge-base helper exists.** `GitWorkflowService` has neither; `MirrorSync` has a
  private bundle writer for sandbox hosts. 3.23 runs `merge-base`, `update-ref` and `bundle create`
  through `GitVcsDriver.execute`, as `PullRequestReviewGuideService` (433) does, and writes the
  bundle to a file rather than `-` because `execute` collects stdout as text.
- **The snapshot needs a variant of the capture, not `captureSnapshot`.** `CheckpointServiceV2
  .captureSnapshot` answers `missing` for any local path (CheckpointService.ts 521–543: sandbox
  hosts only). `captureCheckpoint` already commits from a private temp index started from HEAD, so
  the variant is one input, `excludePaths`, passed as exclude pathspecs to its `add`. No workspace
  lock is needed: each capture has its own index file and writes only its own ref.
- **The branch ref is the snapshot's parent.** The laptop sets `cloudSeedRefs(key).branch` to
  `<snapshot>^` rather than reading the branch again, so a commit made between the two can't break
  3.20's parent check.
- **A seed on the base branch is renamed.** 3.21 refuses a seed whose branch is the base or the
  checkout's default (`seed-on-base`). The laptop names such a cloud branch `t3/<8 hex of the key>`
  (shared/git.ts 103's shape), stable across retries.
- **Every move sends a first message** (proposed). The dialog and the sheet prefill
  `CLOUD_MOVE_DEFAULT_MESSAGE`; the tool defaults to it. It also covers 2.13's skip of message-less
  cloud threads on rebuild if 3.21's fix is dropped.
- **Pair Cloud picks the model.** The Mac's provider instance ids don't exist on Pair Cloud (08 §4),
  and the tool has no client to pick one. The laptop sends the thread's driver and model; Pair Cloud
  takes the member's own matching instance, then a team one, then any usable one.
- **The move outlives the request.** A phone locked mid-upload would interrupt an RPC fiber. The
  service forks the move into its own scope and a second call for the thread joins it, so the
  phone, a reload and a double click all see one move.
- **The staging key is derived.** 3.23 derives `mv_` + 32 hex from
  the environment, the thread and its count of moves. It meets the format and "once per move,
  reused on every retry" with nothing stored, so a restart between a successful launch and the
  local record still recovers through `409 claimed` and the launch's replay.
- **No Labs state in the preview.** 3.19 drops the Linked environments beta for agent links, so the
  preview's link status is `linked`, `missing` or `expired`, and the tool's `hiddenWhileLinksOff`
  shows it once an agent link exists.
- **An agent can move its own thread mid-turn.** "Blocked while a run is active" would block every
  agent from moving its own thread, since its own run is active. The tool passes the caller's run
  as allowed; another thread's run still blocks.
- **No keybinding.** 08 §4's table says none, as for Wake, Sleep now, Retry and Discard (1.39). The
  code's bindable thread commands (`thread.assign`, `thread.follow`) are frequent; this is rare and
  confirms in a dialog.
- **Measurement goes on the span.** 01 §9's 95% and M3's "seed size and upload time" read
  `CloudMoves.continueInCloud`'s span attributes in `<stateDir>/logs/server.trace.ndjson`, one line
  per move, plus one `Effect.logInfo("cloud move", …)` with the same fields.

#### Smaller proposals

- `CloudMoveFailureReason` gains `refused` and `branch-not-pushed`; a seedless launch whose branch
  origin lost falls back to a seed once.
- The dialog's **Link** uses 3.19's `useLinkMachine` inline; the phone only says where to link.
- Mobile thread rows read a per-thread offer atom with equality, so the list doesn't re-render for
  other threads' offers.
- No `t3 thread` command for moves; a terminal agent uses the MCP tool.

## PR specs

### 3.19 `feat(contracts,server,client-runtime,web,mobile): link a member's local server to Pair Cloud`

After this PR a member links their Mac's local server to Pair Cloud once (the agent link), and
agents on the Mac start cloud sessions there that belong to that member: `t3_thread_launch` with
`environmentId`, `delegate_task` with `target.environmentId` and `isolation: "cloud"`, and `t3 thread
… --environment`. Most of the machinery exists. An agent link is an ordinary `PeerLink`, and Pair
Cloud already issues the link's MCP session to the member whose pairing code approved it. The code
misses five things. The member falls out of the MCP scope for peer links, so launches belong to no
one and run as the server owner. Delegation refuses `cloud`, and the launch it forwards names no
workspace, which 2.22 refuses on Pair Cloud. The Linked environments Labs beta gates both sides. A
below-full-access link's threads skip their setup script even on a machine. And members can't mint a
pairing code from the client. It is its own PR because 3.20, 3.23 and 3.25 authenticate every seed and export transfer
with this link and read Pair Cloud's capabilities from `PeerLinks.resolve`, and because it changes
model-facing text that needs its own evals.

- **Needs:** M2 (2.22 cloud-only mode, 2.23 launch gate, 2.24 `capabilities.cloudLaunch`, 2.30
  member accounts, 2.31 `existingBranch`, 2.45 admin-only `t3_environment_link`). **Unblocks:** 3.20,
  3.23, 3.25 (all reach Pair Cloud through `PeerLinks.resolve`), 3.26.

**What the code already does, and what is missing** (each checked; line numbers on `feat/pair`
18e9d6579):

- **The session is member-bound already.** `McpOAuth.approve` (auth/McpOAuth.ts 461) takes
  `approverMemberId` from `consumeMcpApprovalCode`, which is the pairing grant's member
  (EnvironmentAuth.ts 1499). `exchangeCode` issues the session to it (McpOAuth.ts 553–558, through
  `issueMcpClientSession`, EnvironmentAuth.ts 1446–1451). `authenticateMcpClient` returns the
  resolved `memberId` (EnvironmentAuth.ts 1417–1442), and a removed member's sessions fail there.
- **Missing: the member never reaches tool calls.** `layerMcpClientAuthenticator` builds the scope
  with `...(client.peerLink ? {} : { hostedAppUrl, memberId: client.memberId })` (McpOAuth.ts 625).
  So on Pair Cloud a link's `t3_thread_launch` gets `ownerId` undefined (project/handlers.ts 240–241),
  and `thread.create` records `ownerId: null` (Orchestrator.ts 3233). That breaks four things.
  - Provider accounts: the ownership check runs as the server owner, `holderOf(target, ownerId)`
    (ThreadManagementService.ts 831), so the member's own account is refused as "belongs to …".
  - GitHub: the machine gets no member credential (GitCredentialService.ts 130–132, 311). A private
    repo without the App ends in `repo-unreadable`.
  - Attribution: the sandbox's `ownerMemberId` is null (Orchestrator.ts 10984), and `sendActorId`
    (threadAccess.ts 76) stamps no author on sends.
  - Other member reads: `checkExistingBranch`'s `memberId` (ThreadLaunchService.ts 1199) and
    `t3_project_clone`'s member (project/handlers.ts 418) are empty.
- **Nothing is missing for the gate and the cap.** Every `t3_thread_launch` on Pair Cloud goes
  through `ThreadLaunchService.launch`. That runs `checkCloudLaunch` → `resolveCloudLaunch`
  (CloudPreparation.ts 121), which refuses local-only and unsupported accounts (2.30), then
  `sandbox.provision`, behind 2.23's gate and the team's admission cap. The cap is per driver, not
  per member (D5).
- **Missing: a launch there must name `cloud`.** `launch` refuses any other strategy with
  `CloudLaunchError "local-launch"` (ThreadLaunchService.ts 1133–1143). Only scheduled runs are placed
  (`cloudPlacement`, 423). `RemoteDelegation` forwards a launch with no strategy (RemoteDelegation.ts
  261–280), so a delegation to Pair Cloud is refused there today. It also refuses `cloud` itself
  (216–221).
- **Missing: the setup script.** `ProjectSetupScriptRunner.runForThread` skips every
  below-full-access link thread (ProjectSetupScriptRunner.ts 369–372). A member's link is at most
  `auto`, because `mcpClientScopes("full-access")` needs `settings:write`, which `MEMBER_SCOPES` lacks
  (team.ts 136–148). So every cloud session started through it would boot without its setup script.

**What the link fence means for these sessions.** Work a below-full-access link starts carries
`linkOrigin` (`startsThreads … "stamped"`, project/handlers.ts 310), and `mcp/linkOrigin.ts` fences
only MCP callers: the link's own session and agents inside threads it started. Those may change only
threads the same link session started. They can't change projects, settings or scheduled tasks, and
they can't use Pair Cloud's own links, so a laptop agent can't make Pair Cloud link back. Clients are
not fenced. WebSocket dispatch never reads `linkOrigin`, and a client's `thread.create` can't carry
one (ThreadManagementService.ts 99–101). So teammates and the member's own desktop and phone open
and prompt the session as they would any other. Teammates' own MCP clients (API tokens, agents in
their own cloud sessions) are not fenced either. Only another link's agents can't change it over MCP:
the same member's other Mac, or this Mac once it links again, since a renewal is a new session. They
can still read it. The session shows "From Pair · <Mac name>" (web ChatHeader.tsx 438, mobile
ThreadRouteScreen.tsx 549).

- **Files:**
  - `apps/server/src/auth/McpOAuth.ts`:
    - `layerMcpClientAuthenticator` (625) passes `memberId: client.memberId` for every client:
      `memberId: client.memberId, ...(client.peerLink ? {} : { hostedAppUrl })`. Peer links keep
      `t3-thread://` links.
    - `make` (261) reads `ServerConfig.cloudOnly`.
    - `register` (348–355) refuses a peer-link registration only when `!linksEnabled && !cloudOnly`.
  - `apps/server/src/mcp/McpHttpServer.ts` `makeMcpAuthMiddleware` (196–245):
    - read `ServerConfig.cloudOnly` and `Effect.serviceOption(PeerLinks.PeerLinks)`;
    - keep `linksEnabled` (201–204) as `labs`;
    - the inbound refusal (236) becomes `limited.client?.linked === true && !labs && !cloudOnly`;
    - the scope's `linkedEnvironments` (240) becomes `labs || (yield* agentLinks).size > 0`, reading
      `PeerLinks.agentLinks` only while `labs` is false.
  - `apps/server/src/mcp/McpInvocationContext.ts`: the `linkedEnvironments` doc (135–136) becomes
    "False while no link here may start work: the Linked environments beta is off and this
    environment holds no agent link."
  - `apps/server/src/peer/PeerLinks.ts`:
    - `ResolvedPeerLink` (54–59) gains `capabilities` (shape below);
    - the service (70–102) gains `agentLinks`;
    - `PeerLinkRow` (104–115) gains `cloud_launch: number`;
    - `make` (170) reads `ServerConfig.cloudOnly`.
    - `link` (411–489): drop the Labs check at 412. After `answeringAt`/`answeringAs` (418–425),
      refuse with `reason: "disabled"` (`LINKED_ENVIRONMENTS_OFF`) unless
      `(yield* enabled) || (!cloudOnly && peer.capabilities.cloudLaunch === true)`. The INSERT and
      its `ON CONFLICT` (461–480) write `cloud_launch` from the same descriptor.
    - `withLabel` (499–505) becomes `withPeer(link, stored, descriptor)`. It updates `label` and
      `cloud_launch` in one `UPDATE` only when either differs from the stored row.
    - `list` (528–534) keeps each row's `cloud_launch` for `statusOf` (507–526), which calls
      `withPeer` with the descriptor it already fetched.
    - `resolve` (559–616) keeps the answering descriptor next to `fenced` and `label` (586–595),
      calls `withPeer`, and returns `capabilities`.
  - `apps/server/src/peer/PeerForwarding.ts`:
    - a new constant `onlyAgentLinks = new OrchestratorMcpFailure({ code: "capability_denied",
      message: "Linked environments is off on this machine; only its Pair Cloud link works without
      it. The user can turn it on in Settings → Labs." })`;
    - `requireEnabled` (214–218) becomes `requireUsable(environmentId)`: passes when
      `links.enabled` or `agentLinks.has(environmentId)`; fails `linkedEnvironmentsOff` when there are
      no agent links, else `onlyAgentLinks`;
    - `call` (220–232) uses it;
    - `listLinks` (241–264) passes when `enabled || agentLinks.size > 0`, lists only agent links
      while Labs is off, and adds `cloud: true` to each agent link.
  - `apps/server/src/peer/PeerMcpClient.ts`: export `fromLinkError` (69–78) as `peerLinkFailure`
    for RemoteDelegation.
  - `apps/server/src/peer/PeerLinkRequests.ts` (207–212): refuse with `LINKED_ENVIRONMENTS_OFF` only
    when `!enabled && agentLinks.size === 0`. The answer goes through `PeerLinks.link`, which applies
    the per-peer rule.
  - `apps/server/src/peer/RemoteDelegation.ts` `delegate` (187–356). `make` (116) also yields
    `GitWorkflowService`. The refusal at 212–221 becomes:
    - `worktree`: unchanged.
    - Then `const there = yield* links.resolve(target.environmentId).pipe(Effect.mapError(PeerMcpClient.peerLinkFailure))`
      and `const cloud = there.capabilities.cloudLaunch === true`.
    - `isolation === "cloud" && !cloud`: same code `invalid_request`, message `` `${there.link.label}
      does not run cloud machines, so isolation "cloud" is not supported there. Omit isolation to run
      in that project's checkout.` ``
    - `cloud && isolation !== "cloud"`: `invalid_request`, `` `${there.link.label} runs every task on
      a cloud machine of its own. Pass isolation "cloud".` ``
    - `cloud`: the base is `parent.thread.branch`, or for a thread in the project's own checkout
      (no recorded branch) `git.currentBranch(cwd)`. With neither (detached HEAD) it refuses
      "A cloud task starts from a pushed branch; this thread's checkout isn't on a branch. Check out
      a branch and push it." Otherwise
      `git.remoteHasBranch({ cwd: parent.thread.worktreePath ?? project.workspaceRoot, remoteName:
      "origin", refName: branch })`. False refuses `` `${branch} is not on origin. Push it first: a
      cloud task starts from the pushed branch.` `` A `GitCommandError` is logged and the launch goes
      on, as 2.31's check does. Pair Cloud's in-machine `base-ref-missing` still decides.
    - The forwarded launch (261–280) adds `workspaceStrategy: { type: "cloud", baseRef: branch }`
      when `cloud`, the same base the local cloud path uses (OrchestratorMcpService.ts 2510).
  - `apps/server/src/project/ProjectSetupScriptRunner.ts` (369–372): skip for a fenced link only when
    `thread.sandboxId === undefined`. Rewrite the doc above `ProjectSetupScriptRunnerResultSkippedForLink`
    (49–56): "…started does not run this project's setup script on this server's machine…".
  - `apps/server/src/persistence/Migrations/092_PeerLinkCloudLaunch.ts` (new) and
    `persistence/Migrations.ts` (import after 97, entry after 191).
  - `apps/server/src/cli/thread.ts`:
    - new `environmentFlag` (`--environment`, optional) on `list` (706), `start` (754), `send` (842)
      and `show` (877). Description: "A linked environment's id or name, such as Pair Cloud. Runs
      there through this machine's link."
    - `withThreadTools` (273) gets it. With `--url` or `T3CODE_URL` set it is a `ThreadUsageError`:
      "--environment goes through this machine's server. Drop --url or unset T3CODE_URL."
    - After the local session opens, call `t3_environment_links` and match `environmentId` exactly,
      else the label case-insensitively. No match: "No linked environment matches '<value>'. Link
      it in Settings → Environments, or with t3 environment link." Two labels match: "More than
      one linked environment is named '<value>'. Pass its id instead." (the wording of the CLI's
      "More than one project is titled …").
    - New `inEnvironment(tools, environmentId)` returns `{ call, here }`. `call` adds
      `environmentId` to every tool's arguments; `here` is the unwrapped tools. `ThreadTools` (230)
      gains `here?: ThreadTools`.
    - `ThreadConnection` (232) gains `environmentId?: EnvironmentId`. With `--environment` the
      connection is `{ remote: true, environmentId }`.
    - `ProjectListResult` (173–178) decodes `repositoryIdentity:
      Schema.optional(Schema.NullOr(Schema.Struct({ canonicalKey: Schema.String })))`.
    - `resolveProject` (363): with `environmentId`, after the remote id, folder and title rules,
      resolve the identifier locally through `tools.here` and take the one project there with the
      same `repositoryIdentity.canonicalKey`, the rule `RemoteDelegation.resolveRemoteProject` uses.
      None: `ThreadProjectNotFoundError { remote: true }`. Several: "More than one project there has
      this repository: … Pass its id instead."
    - `start` with `--environment` on a link listed `cloud: true`, without `--cloud` or
      `--worktree`: "<label> runs every thread on a cloud machine. Pass --cloud <base-ref>."
  - `packages/contracts/src/orchestratorMcp.ts`:
    - `OrchestratorMcpEnvironmentLink` (612–621) gains `cloud: Schema.optional(Schema.Literal(true))
      .annotate({ description: "Pair Cloud: each thread there runs on a cloud machine of its own." })`;
    - the `isolation` description (174–179) ends: "'cloud': own machine from the parent's pushed
      branch, if `features.cloudThreads` or `target.environmentId` is a `cloud` link."
  - `apps/server/src/mcp/toolkits/project/tools.ts` `t3_thread_launch` `workspaceStrategy`
    description (144–149): replace "Only when `orchestrator_capabilities` reports
    `features.cloudThreads`." with "Only where `orchestrator_capabilities` reports
    `features.cloudThreads`, or with the `environmentId` of a `cloud` link from
    `t3_environment_links`." These three texts are where the evals start. Change them until the
    cases pass, and keep them no longer.
  - `apps/server/src/provider/agentContextBudget.json`: re-measure `mcpToolListJsonBytes` (47990
    today). The other two keys don't change.
  - `packages/client-runtime/src/linkRequest.ts`:
    - new `offersAgentLink(config, environments)`, next to `offersLinkedEnvironments` (19–23):
      `config?.environment.capabilities.peerLinks === true &&
      config.environment.capabilities.cloudLaunch !== true &&
      environments.some((e) => e.serverConfig?.environment.capabilities.cloudLaunch === true)`;
    - `LinkableMachine` (57–73) gains `readonly cloud: boolean`. `linkableMachines` (79–143) sets it
      from `serverConfig` for saved machines and from the Connect descriptor for Connect-only ones.
  - `apps/web/src/state/peerLinks.ts`:
    - `usePeerLinkHosts` (54–62) keeps a connected environment that `offersLinkedEnvironments` **or**
      `offersAgentLink(config, environments)`. Settings search (`useAvailableSettingsSearchItems.ts` 56) follows.
    - New `useLinkMachine(hostEnvironmentId)`, lifted from `resolvePairingCode` and `submit`
      (LinkedEnvironmentsSettings.tsx 209–246), returns `(machine, access) => Promise<Result<PeerLink,
      unknown>>`. It mints on the machine when it can and links with its URLs and
      `expectedEnvironmentId`. 3.23 offers the link with it.
  - `apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx`:
    - while `offersLinkedEnvironmentsAtom(environmentId)` (state/peerLinks.ts 23) is false, the
      dialog lists only `cloud` machines and preselects one when it is the only one (`selected`,
      184);
    - the empty state (76–78) then reads "Link Pair Cloud so you can move threads there and back,
      and agents here can start cloud threads there as you." (the UI's noun is "cloud thread");
    - `mayMint` (190) checks `AuthAccessReadScope`, which is what the `pairingCredential` route
      requires (auth/http.ts 480, `requireAccessManagement` 233).
  - `apps/web/src/components/chat/LinkRequestCard.tsx` (238) and
    `apps/mobile/src/features/threads/LinkRequestCard.tsx` (259): `mayMint` checks
    `AuthAccessReadScope`.
  - `apps/web/src/components/settings/LabsSettingsPanel.tsx` `LinkedEnvironmentsRow` (135–163):
    its last sentence, "While it is off, nothing new starts over a link; tasks already running
    finish.", becomes "While it is off, only a link to Pair Cloud starts anything new; tasks
    already running finish." Appending a sentence would contradict the one before it.
  - `apps/mobile/src/features/connection/LinkedEnvironmentsSection.tsx` (21–22): `supported` also
    holds when `offersAgentLink(config, <connected environments>)`, so the phone lists the Mac's
    agent link.
  - `evals/mcp-tool-use/run.ts` (1571): look up `` `${name}@${environmentId}` `` before the bare
    name, where `environmentId` is the call's `environmentId`, or `target.environmentId` for
    `delegate_task`. Add a line under "Add a case" in `evals/mcp-tool-use/README.md`.
  - `evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`: the cases under **Tests**.
  - `docs/internals/remote.md`: rewrite the beta bullet (79–85). "Gates both sides" gains "except a
    link to a cloud-only server (an agent link), which neither side gates; while the beta is off, an
    environment's agents start work only over its agent links". Rewrite the setup-script bullet
    (117–120): "skipped unless the thread runs on a machine of its own".
    `docs/user/remote-access.md` (329–333) gains one sentence: "A link to your team's Pair Cloud
    doesn't need the beta on either machine." 3.26 writes the agent link's own section.
- **Types and services:**
  - `ResolvedPeerLink` (the shared name, fixed here for 3.20, 3.23 and 3.25):

    ```ts
    export interface ResolvedPeerLink {
      readonly link: PeerLink;
      /** The first address that answered as this peer. */
      readonly url: string;
      readonly token: string;
      /** What that address reported just now, from the same descriptor probe that picked `url`. */
      readonly capabilities: ExecutionEnvironmentCapabilities;
    }
    ```

    - Fresh on every call: `resolve` probes `/.well-known/t3/environment` each time and caches
      nothing.
    - Every key is `optionalKey(Boolean)`, so check `capabilities.cloudLaunch === true` or
      `capabilities.cloudImport === true` (3.20). An older peer omits them.
    - `resolve` fails with `PeerLinkError` reason `unknown_link` (no row, or the token is gone),
      `expired`, `unreachable`, `incompatible` (the peer can't fence) or `storage`.
    - It never checks the Labs beta. Callers that start MCP work go through `PeerForwarding`, which
      does. 3.20's HTTP routes, 3.23 and 3.25 need no check, because a peer that reports
      `cloudImport` is cloud-only, so its link is an agent link.

  - `PeerLinks.agentLinks: Effect.Effect<ReadonlySet<EnvironmentId>>`: the links whose row has
    `cloud_launch = 1`, expired ones included. It reads through `NodeSqliteClient.readOnly` on each
    call, not from a cache, because `t3 environment link` writes the table from another process. A
    storage failure is logged and reads as the empty set.
  - `PeerLinks.enabled` is unchanged: whether the beta is on.
  - `PeerMcpClient.peerLinkFailure: (error: PeerLinkError) => OrchestratorMcpFailure`.
  - `offersAgentLink`, `LinkableMachine.cloud` and `useLinkMachine`, as above.
- **Commands and events:** none.
- **Migrations:** `092_PeerLinkCloudLaunch`, written like `071_PeerLinkFence`:
  `ALTER TABLE peer_environment_links ADD COLUMN cloud_launch INTEGER NOT NULL DEFAULT 0`. The
  comment reads: "Whether the peer reported `cloudLaunch` when last reached. Such a link needs no
  Linked environments beta." It takes the next free id at merge (P8); 3.20 lands beside it in
  wave 1 with 093, and whichever lands second renumbers if the order changes. A link made before it reads 0
  until its next `resolve` or `list`, which corrects it.
- **Proposed gap answers.**
  - **No Labs on either side for an agent link** (proposed).
    - Pair Cloud is a team feature behind its own startup mode (10 §5: "There is no separate feature
      flag"). Continue in cloud (3.23) and continue locally (3.25) both need the link, so a beta
      switch must not gate M3's headline.
    - Pair Cloud accepts peer links because it is cloud-only. A peer link there is an MCP client
      session like the API token a member can already create (`createApiToken`, auth/http.ts
      510–535), bounded by the member's scopes.
    - The laptop exempts only a link to a server reporting `cloudLaunch`, and only when the laptop
      itself isn't cloud-only (D14: laptop to cloud, not cloud to cloud). Inbound links to a laptop
      still need its beta.
    - The marker needs a column, because the gates run on every MCP request (tool visibility in
      `hiddenWhileLinksOff`) and can't probe peers.
    - Overruled (Labs stays on the laptop): drop the migration, `agentLinks`, the forwarding and
      middleware changes and `offersAgentLink`. Keep the Pair Cloud half. 3.23's link offer must then
      also turn on the beta, and the Labs copy changes the other way.
  - **Delegation to Pair Cloud needs `isolation: "cloud"`** and is refused otherwise, as a local
    delegation on a cloud-only server is (2.22, OrchestratorMcpService.ts 2403–2408). It starts from
    the parent's pushed branch with a new branch, as a local cloud delegation does, not with
    `existingBranch`. The laptop's `ls-remote` refusal is an early answer that saves a machine boot.
    Without it, Pair Cloud's in-machine `base-ref-missing` fails the task after the machine starts.
  - **Where the member makes the link** (proposed): Settings → Connections, the existing **Link**
    dialog. It shows without the beta when the client knows a Pair Cloud, with Pair Cloud
    preselected, and the member's session mints the code. There is no separate "Link this Mac"
    button. With minting fixed, the dialog is two clicks, and 3.23's move offers the same
    `useLinkMachine` inline when no link exists. Agents can't ask for the first agent link while
    the beta is off, because `t3_environment_link` stays hidden until one exists. Overruled: add a
    row to Settings → Cloud that calls `useLinkMachine` for the local server.
  - **Setup scripts run for a link's thread on a machine.** The fence exists because a link may not
    run the user's code on the user's machine (ProjectSetupScriptRunner.ts 49–56). A cloud session's
    script runs in its own machine, as for any member's cloud launch.
  - **`t3 thread --environment` keeps `--cloud` required on Pair Cloud.** 08 §6 says `--cloud` is
    optional there, but 2.22 refuses a non-cloud launch from MCP and the CLI. The CLI says so before
    calling.
  - **The eval cases use pushed branches only.** By the decision on 08 open question 6,
    unpushed work goes through 3.23's tool, whose evals own that case.

**Tests.**

- `apps/server/src/peer/PeerForwarding.test.ts`:
  - extend "launches in a linked environment with the caller's modes, retry-safe" (492): the
    launch the box recorded carries `ownerId` equal to the link session's `memberId` from
    `b.linkedSessions`. This fails on main (undefined) and covers McpOAuth.ts 625 through a real
    session.
  - extend "an agent here works on a linked environment's threads within its own modes" (370): with
    a second, cloud-only box linked, `t3_environment_links` lists it with `cloud: true` and the box
    without the key.
- `apps/server/src/peer/PeerLinks.testkit.ts`: `servePeer` (64) gains `options?: { readonly
  cloudOnly?: boolean }`, which sets `ServerConfig.cloudOnly` in its auth context.
  `layerLinkingEnvironment` (158) gains the same option.
- `apps/server/src/peer/PeerLinks.test.ts`, new `it` "a link to a cloud-only server needs no Linked
  environments beta on either side". No existing case fits, since 204 asserts the gate this exempts.
  B is served cloud-only, as `descriptorOf("environment-cloud", "Pair Cloud", { cloudLaunch: true })`.
  1. With the beta off on A and on B, `link` succeeds and `agentLinks` holds B.
  2. `resolve` returns `capabilities.cloudLaunch === true`, and `probe` answers (no 403).
  3. `UPDATE peer_environment_links SET cloud_launch = 0`, then `resolve`, puts it back.
  4. A non-cloud box with A's beta off is refused `disabled`, with no bearer sent.
  5. A served cloud-only (A's option) linking to B with its beta off is refused `disabled`.
  6. `unlink` empties `agentLinks`.
- `apps/server/src/mcp/McpHttpServer.test.ts`, extend "hides tools for links and refuses another
  environment while the beta is off" (1064). Provide `Layer.mock(PeerLinks.PeerLinks)({ agentLinks:
  Effect.succeed(new Set([elsewhere])) })` and `ServerConfig.layerTest`. With the beta off, `listed()`
  then includes `"links"`, and `ranIn(elsewhere)` reaches the forwarding ("cannot reach linked
  environments") instead of "Linked environments is off".
- `apps/server/src/peer/RemoteDelegation.test.ts`:
  - `serveBox` (207) takes `{ cloud?: true }`, serving `descriptorOf("environment-box", "Box", {
    cloudLaunch: true })` cloud-only. `seedParent` (666) takes `branch` (default `null`).
    `LaunchedWith` (86) gains `workspaceStrategy`, and the box's `launch` mock (427) records it. The
    laptop's `RemoteDelegation.layer` (584–604) gets `Layer.mock(GitWorkflowService)({
    remoteHasBranch: () => Ref.get(pushed) })`. The assertion at 1121 adds `workspaceStrategy: {
    type: "root" }`.
  - "refuses %s isolation for a task there before launching anything" (1139) becomes a table, each
    row asserting `thread.launched` stays null:
    - worktree on Box (message unchanged);
    - cloud on Box ("does not run cloud machines");
    - shared and omitted isolation on a cloud box ("Pass isolation \"cloud\"");
    - cloud on a cloud box from a parent with no branch;
    - cloud on a cloud box when `remoteHasBranch` is false ("is not on origin").
  - New `it` "a cloud task goes to Pair Cloud as a cloud launch from the parent's pushed branch":
    cloud box, parent on `fix/flaky`, A's beta off. `launchedWith.workspaceStrategy` is `{ type:
    "cloud", baseRef: "fix/flaky" }`, `linkOrigin` and `delegatedFrom` are set, and the task
    completes when the box thread does. This is the G3 step 4 shape.
  - The Labs-off case (1055) is unchanged: Box isn't cloud-only, so its refusal stands.
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts`: `makeHarness` (40) takes `thread`
  (default `null`) for `getThreadShell`. New `it.effect.each`: "a link's thread below full access
  runs its setup script only on a machine of its own". The `{ linkOrigin: { sessionId: "s", label:
  "Pair · Mac", access: "auto" } }` row returns `skipped-for-link`. The same with `sandboxId` starts.
  No test covers the skip today.
- `apps/server/src/cli/thread.test.ts`:
  - New `it.effect` "--environment sends every call there and finds this checkout's project there by
    repository". `scriptedTools` wrapped in `inEnvironment`: `calls` show `environmentId` on every
    remote call. `resolveProject(tools, ".", { remote: true, environmentId })` matches by
    `canonicalKey`; zero matches give `ThreadProjectNotFoundError`, two give `ThreadUsageError`.
  - Extend "--url needs T3CODE_TOKEN" (375): `--url` with `--environment` is a `ThreadUsageError`.
- `packages/client-runtime/src/linkRequest.test.ts`:
  - extend "lists the other machines with reported addresses before saved ones, once each" (188)
    with a `cloudLaunch` machine (`cloud: true`) and one without;
  - new `it` for `offersAgentLink`. It is true for a links-capable server with a Pair Cloud in the
    list, and false for Pair Cloud itself, a server without `peerLinks`, and a list with no Pair
    Cloud.
- `evals/mcp-tool-use/run.test.ts`: new `it.effect` "answers a call that names a linked environment
  with that environment's mock", using `answerToolCall` like the secret cases (640). The same call
  without the environment gets the bare mock.
- `evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`, four cases next to the cloud cases (24–26).
  - Setup for all four:
    - `role: "top"`, `linkedEnvironments: true`;
    - `context`: "Repository: /home/user/app (acme/app). This is the user's laptop.";
    - `orchestrator_capabilities`: the `cloud-unavailable-no-cloud` mock, so the laptop has no cloud;
    - `orchestrator_capabilities@environment-pair-cloud`: the `cloud-laptop-can-sleep` mock;
    - `t3_environment_links`: `environment-pair-cloud` "Acme Pair Cloud", `access: "auto"`, `cloud:
      true`, and `environment-vps` "Hetzner VPS" without `cloud`;
    - `t3_project_list@environment-pair-cloud`: one project `project-cloud-app` with
      `repositoryIdentity.canonicalKey: "github.com/acme/app"`.
  - Source for all four: 08 §6 "The agent link (M3)", 10 §4 M3 tests and G3 step 4, PR "Pair Cloud
    3.19".
  - Run each on main's text first. A case that already passes there is a `guard`, and no text
    changes for it.

  | id                            | kind    | prompt                                                                                                                                                                                                         | expect                                                                                                                                                                                                                                                                                                                                |
  | ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `agent-link-laptop-can-sleep` | bad     | "Start a thread to migrate the billing tests and run this where my laptop can sleep."                                                                                                                          | `calls`: `t3_thread_launch` `{ environmentId: "environment-pair-cloud", "workspaceStrategy.type": "cloud", message: "~billing" }`. `callsMustNot`: `t3_thread_launch` `{ "workspaceStrategy.type": "cloud", environmentId: null }` and `{ environmentId: "environment-vps" }`. `notCalls`: `Agent`, `create_threads`, `delegate_task` |
  | `agent-link-delegate-cloud`   | bad     | World branch `fix/flaky`, context adds "fix/flaky is pushed to origin." "Have a child agent fix the flaky invoice test on Pair Cloud so it keeps going after I close my laptop, then tell me what it changed." | `calls`: `delegate_task` `{ "target.environmentId": "environment-pair-cloud", isolation: "cloud", task: "~invoice" }`. `callsMustNot`: `delegate_task` `{ isolation: "cloud", "target.environmentId": null }`. `notCalls`: `Agent`                                                                                                    |
  | `agent-link-vps-stays-vps`    | guard   | "Run the billing migration in a new thread on the Hetzner VPS."                                                                                                                                                | `calls`: `t3_thread_launch` `{ environmentId: "environment-vps" }`. `callsMustNot`: `t3_thread_launch` `{ "workspaceStrategy.type": "cloud" }`                                                                                                                                                                                        |
  | `agent-link-local-worktree`   | control | "Start a thread on a new worktree from main to fix the cache."                                                                                                                                                 | `calls`: `t3_thread_launch` `{ "workspaceStrategy.type": "worktree", environmentId: null }`. `callsMustNot`: `t3_thread_launch` `{ environmentId: "environment-pair-cloud" }`                                                                                                                                                         |

**Verify.**

- `vp test run apps/server/src/peer/PeerLinks.test.ts apps/server/src/peer/PeerForwarding.test.ts
  apps/server/src/peer/RemoteDelegation.test.ts apps/server/src/mcp/McpHttpServer.test.ts
  apps/server/src/project/ProjectSetupScriptRunner.test.ts apps/server/src/cli/thread.test.ts
  apps/server/src/auth/McpOAuth.test.ts apps/server/src/provider/AgentContextBudget.test.ts
  packages/client-runtime/src/linkRequest.test.ts evals/mcp-tool-use/run.test.ts`.
- `vp run typecheck` for contracts, server, client-runtime, web, mobile and evals; then
  `vp run check:changed`.
- Evals (evals/README.md), from `evals/`:
  - `pnpm mcp-tool-use --case <id> --dry-run` for each new case;
  - the four cases at 3 samples on main's text, then on the new text:
    `pnpm mcp-tool-use --cases mcp-tool-use/cases/threads-vs-tasks.ndjson --case
    agent-link-laptop-can-sleep,agent-link-delegate-cloud,agent-link-vps-stays-vps,agent-link-local-worktree
    --samples 3 --out runs/agent-link`;
  - one full `threads-vs-tasks` and `orchestration` run per model (Sonnet, Opus, a Codex model)
    with `--baseline` against main.
- The PR needs the `agent-context-increase` label.
- Runtime transcript, which the primary agent runs once against the `pair-cloud-pass` server with the beta off
  on both machines:
  1. `t3 environment link https://<pair cloud> --pairing-code <a member's code> --access auto`.
  2. `t3 thread start . "Run the invoice test" --environment "<label>" --cloud main --wait`.
  3. `t3 thread show <id> --environment "<label>"` shows the machine line.
  4. Pair Cloud's Sharing & access lists the "Pair · <Mac>" session under that member, not the
     owner, and the session's thread owner is that member.
- One `test-t3-app` pass on desktop with the beta off, connected to both servers. Settings →
  Environments shows Linked environments with Pair Cloud preselected. A member account links it
  without pasting a code. A local agent's `delegate_task` to it starts a cloud session marked "From
  Pair · <Mac>", which the member can open and prompt from Pair Cloud. Capture the dialog and the
  session.

**Reviewer checks.**

- A peer-link scope carries `memberId` and still no `hostedAppUrl`.
- The inbound exemption reads `ServerConfig.cloudOnly`, the startup mode, not a setting.
- The outbound exemption needs both `!cloudOnly` here and `cloudLaunch` there.
- Follow-ups (`readThread`, `waitForThread`, `interruptThread`) stay ungated, as today.
- `agentLinks` is read only while the beta is off, through the reader, and fails closed.
- `withPeer` writes only on a change. A plain `resolve` costs no write.
- `RemoteDelegation` probes once more (its `resolve`) only for a delegation, never for other
  forwarded calls.
- Nothing lets Pair Cloud start work on the laptop: no inbound exemption on a non-cloud-only server,
  and `t3_environment_link` on Pair Cloud is unchanged (admin only, 2.45; refused for linked
  callers).
- The setup-script change skips nothing new and runs nothing on the server's own machine.
- The three model-facing texts and the `cloud` annotation are no longer than the evals needed.
- The hijacked-agent pair in 06 §1. A local agent can do on Pair Cloud only what the member can,
  bounded by:
  - the link's access (a member's link tops out at `auto`) and the calling agent's modes
    (`T3-Mode-Limit`);
  - the fence: no teammates' threads, projects, settings, scheduled tasks or onward links over MCP;
  - the team cap;
  - revocation on either side, member removal and 30-day expiry.
  - Residual risk: the token sits in the laptop's secret store, which any local agent can read
    (06 §1), so a hijacked agent can take it and use it elsewhere until revoked or expired. A
    member's API token on that Mac has the same exposure. 06's table should say so (3.26).
- Surfaces:
  - Entry points:
    - Settings → Connections **Link** dialog (web, desktop);
    - the agent's link card, web and mobile (minting fixed);
    - `t3 environment link`;
    - 3.23's move offer, later.
    - None in the palette or keybindings, since linking has none today.
  - Clients: web and desktop (desktop needs no IPC: the dialog runs against the local server and
    mints on Pair Cloud over the existing connection). Mobile: the card's minting and the list of
    links. The composer's machine mentions (`useComposerMenuItems.ts` 118) stay behind the beta.
  - Providers: no per-adapter change. Cloud support per provider is 2.30's and M1's.
  - Agents:
    - `t3_thread_launch` through `routed`, `t3_environment_links` through `PeerForwarding.links`;
    - `delegate_task` through `RemoteDelegation`;
    - `t3 thread --environment`.
    - A laptop's scheduled run reaches the same tools. Scheduling on Pair Cloud through the link
      stays refused (`startsThreads … refused`).
  - Contracts: `OrchestratorMcpEnvironmentLink.cloud` (optional, so old servers and old clients
    agree). `PeerLink` and `PeerLinkSummary` are unchanged.
  - Reverse states: **Forget** (Connections, `t3 environment unlink`, `t3_environment_unlink`).
    Revoke "Pair · <Mac>" in Pair Cloud's Sharing & access. Expiry and renewal by
    linking again. Seen in Connections (web, mobile) and "From Pair · <Mac>" on each session.
  - Connection modes: the link goes from the laptop's server to Pair Cloud's https or Tailscale
    origin. Plain http is refused elsewhere (`peerOrigin`, PeerLinks.ts 141), and relay routes are
    never offered (`linkableMachines`). T3 Connect is off for Pair Cloud (D10).
  - Docs: `internals/remote.md` and one sentence in `user/remote-access.md` here. The agent link's
    guide is 3.26's (`outside-agents.md`, the cloud guide), which also corrects 08 §6's "`--cloud` is
    optional".

### 3.20 `feat(server): accept staged seeds and import them into the mirror`

Pair Cloud accepts a seed from a member's local server over the agent link: `PUT
/api/cloud-moves/staged/<key>/seed?projectId=<id>` with a git bundle body. The bundle must carry
exactly two refs, `refs/t3/staged/<key>/branch` and `refs/t3/staged/<key>/snapshot`, and pass the
mirror's strict import (`cat-file --batch-check`, `index-pack --strict`, `update-ref`). A retry
with the same key replaces the seed. A missing prerequisite gets one fetch of the Pair Cloud
checkout and one retry, then a typed `409 missing-prerequisite` that tells the local server to
send full history. `capabilities.cloudImport` announces the route, and a sweep deletes seeds no
launch claimed within a day. It is its own PR because it is the only new way bytes from a laptop
enter the team server's mirror, so its auth guard, size cap and ref checks get one focused review.
Nothing rides the WebSocket.

- **Needs:** M2 only in code: peer-link `mcp-client` sessions and their approving member
  (`McpOAuth` 554–559, `EnvironmentAuth.authenticateMcpClient` 1418), 2.26's
  `PairCloudProjects.fetchCheckout`, 1.30/1.31's mirror. 3.19 is needed only to reach the route
  from a laptop, so this PR can merge in wave 1 beside 3.19 (see track notes).
  **Unblocks:** 3.21 (`check`, `claim`), 3.22 (the auth helper, the table, the sweep), 3.23 (the
  upload and the `409` it reads).
- **Files:**
  - New `packages/contracts/src/cloudMove.ts`, exported from `index.ts` (beside `sandbox.ts`, 45):
    ```ts
    /** One move's id, chosen by the local server and reused on every retry; safe in a ref and a path. */
    export const CloudStagingKey = TrimmedNonEmptyString.check(
      Schema.isPattern(/^mv_[0-9a-f]{32}$/),
    ).pipe(Schema.brand("CloudStagingKey"));
    export const CLOUD_MOVE_ROUTE_PREFIX = "/api/cloud-moves";
    export const CLOUD_SEED_MAX_BYTES = 512 * 1024 * 1024;
    /** A seed bundle carries exactly these refs; the mirror keeps them under the same names. */
    export const cloudSeedRefs = (key: CloudStagingKey) =>
      ({
        branch: `refs/t3/staged/${key}/branch`,
        snapshot: `refs/t3/staged/${key}/snapshot`,
      }) as const;
    export const CloudMoveFailureReason = Schema.Literals([
      "unauthenticated",
      "forbidden",
      "bad-request",
      "unknown-project",
      "too-large",
      "invalid-seed",
      "missing-prerequisite",
      "claimed",
      "key-in-use",
      "internal",
    ]);
    /** Every cloud-move route's error body. A newer server's reason reads as null. */
    export const CloudMoveFailure = Schema.Struct({
      reason: ForwardCompatibleNullable(CloudMoveFailureReason),
      message: Schema.String,
    });
    ```
    Every non-schema export has a server importer in this PR (knip). The local server derives a
    key per move, the same on every retry (3.23).
  - `packages/contracts/src/environment.ts`: `ExecutionEnvironmentCapabilities` gains, after
    `cloudLaunch` (172), `cloudImport: Schema.optionalKey(Schema.Boolean)` with "True only on a
    cloud-only server: it takes seeds and context exports over `/api/cloud-moves` (M3)."
  - `apps/server/src/environment/ServerEnvironment.ts` 271: `...(serverConfig.cloudOnly ? {
    cloudLaunch: true, cloudImport: true } : {})`.
  - `apps/server/src/sandbox/mirror/CheckpointMirror.ts`:
    - `importBundle` (input 64–68, body 349–415) takes `exactRefs?: true`. With it, after the
      header parse (357), a bundle whose `header.refs` is not exactly the requested sources (count
      and names; `HEAD` counts) fails `invalid-objects` ("The bundle must carry exactly …") before
      the lock, the prerequisite check or `index-pack`. Update the doc comment at 63 ("Others in
      the bundle are ignored, or refused with `exactRefs`").
    - New `commitParents(projectId, oid) => Effect<ReadonlyArray<string> | null,
      CheckpointMirrorError>`: `rev-list --parents --max-count=1 <oid>^{commit}` through
      `runInMirror` with `allowNonZeroExit`; null when it is not a commit. Reads take no lock, as
      `tips` (306) doesn't.
  - Migration `apps/server/src/persistence/Migrations/093_StagedCloudImports.ts` (the next free
    id at merge, P8; 3.19 takes 092 in the same wave), registered in `Migrations.ts` after 97 and 191, and added to both lists in
    `reconcileV2PreviewMigration.test.ts` (73, 187):
    ```sql
    CREATE TABLE IF NOT EXISTS staged_cloud_imports (
      staging_key TEXT NOT NULL,
      kind TEXT NOT NULL,              -- "seed"; 3.22 adds "context-export"
      project_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_thread_id TEXT,
      PRIMARY KEY (staging_key, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_staged_cloud_imports_unclaimed
      ON staged_cloud_imports (created_at) WHERE claimed_thread_id IS NULL;
    ```
    No `CHECK` on `kind`, so 3.22 adds its value without a migration.
  - New `apps/server/src/cloudMove/StagedCloudImports.ts` (the folder is `cloudMove/`, never
    `cloud/`, which is T3 Connect). SQL as in `RunnerGrants.ts` (`SqlClient`, `SqlSchema`,
    `PersistenceSqlError`). One in-process `KeyedLock<CloudStagingKey>` serializes `stage`,
    `claim` and the sweep per key. Methods below.
  - New `apps/server/src/cloudMove/CloudMoveHttp.ts`, the transport for every cloud-move route:
    - `authenticateLinkMember(request)`: `EnvironmentAuth.authenticateMcpClient` (a missing or
      bad bearer, and any non-`mcp-client` session such as a browser cookie, is `401
      unauthenticated`); then `peerLink === true` (else `403 forbidden`: API tokens are issued
      with `peerLink: false`, auth/http.ts 525) and `access !== "read-only"` (else `403
      forbidden`). Returns `{ memberId, sessionId, label, access }`; the member is the one who
      approved the link's pairing code, and 3.23's launch caps the thread's mode at `access` and
      stamps `linkOrigin` from `sessionId` and `label`. `isServerAuthInternalError` is `500 internal`, logged.
    - `layer`: `Layer.unwrap` that builds one `makeByteBudget` (runnerHub/ByteBudget.ts 14) at 32
      MiB/s with a 16 MiB burst, shared by every route in the layer (RunnerRoute's numbers, 16–18),
      and returns `Layer.mergeAll(seedUpload)`. 3.22, 3.23 and 3.25 add their routes to that
      `mergeAll`.
    - `seedUpload`: `HttpRouter.add("PUT", `${CLOUD_MOVE_ROUTE_PREFIX}/staged/:key/seed`, …)`:
      1. `ServerConfig.cloudOnly` false: `404`, empty, before reading anything (RunnerRoute 73).
      2. `authenticateLinkMember`.
      3. Decode `:key` (`HttpRouter.params`) as `CloudStagingKey` and `projectId` from
         `requestUrl(request)` (requestUrl.ts 9) as `ProjectId`; either fails `400 bad-request`.
      4. A `content-length` that is not an integer or is over `CLOUD_SEED_MAX_BYTES`: `413
         too-large`, before reading the body.
      5. Keep the body in the route scope with `Stream.toPull(request.stream)` as
         `layerAttachmentUploadRoute` does (http.ts 495–496), tap each chunk through
         `budget.take(chunk.length)`, and call `staged.stage({ key, kind: "seed", projectId,
         memberId, body })`. Success is `204`.
      6. Map `StagedCloudImportError` reasons to a `CloudMoveFailure` body:
         `unknown-project` 404, `too-large` 413, `invalid-seed` 422, `missing-prerequisite`,
         `claimed` and `key-in-use` 409, `upload-failed` 400 (`bad-request`), `failed` 500
         (`internal`, logged with its cause). Never echo the bearer or a git stderr.
  - `apps/server/src/server.ts`:
    - `layerMakeRoutes` (907): add `CloudMoveHttp.layer` beside `ServerHttp.layerAttachmentUploadRoute`
      (922).
    - `layerOrchestrationV2Runtime` (653): `Layer.provideMerge(StagedCloudImports.layer.pipe(
      Layer.provide(Scheduler.layer)))` before `Layer.provideMerge(layerPairCloudProjects)` (655),
      so the service gets `PairCloudProjects`, `ThreadLaunchService` can read it (3.21), and the
      routes see it. `Scheduler.layer` memoizes by reference with runtimeLayer.ts 460's.
      `CheckpointMirror`, `ProjectStoreV2` and `SqlClient` come from the layers below (787).
      Re-read the composition: it moves with upstream merges.
  - `docs/internals/environment-auth.md` 125: "Only `/mcp` accepts these sessions" becomes
    "Only `/mcp` accepts these sessions, and on a cloud-only server the cloud-move routes accept
    a linked environment's session with operate access
    (`[CloudMoveHttp.ts](../../apps/server/src/cloudMove/CloudMoveHttp.ts)`); they take bytes, not
    commands." Nothing else in docs changes here; 3.26 writes the user guide.
- **Types and services:**
  - `StagedCloudImportKind = "seed"` (a TS union 3.22 widens).
  - `StagedCloudImportError` (`Schema.TaggedError`): `key: CloudStagingKey`, `reason:
    "unknown-project" | "too-large" | "invalid-seed" | "missing-prerequisite" | "claimed" |
    "key-in-use" | "not-found" | "upload-failed" | "failed"`, `cause?: Defect`.
  - `StagedCloudImports` (`t3/cloudMove/StagedCloudImports`):
    - `stage({ key, kind, projectId, memberId, body: Stream<Uint8Array, unknown> }) =>
      Effect<void, StagedCloudImportError>`. For `seed`, under the key's lock:
      1. The project row (`ProjectStoreV2.get`) must exist with `deletedAt === null`, else
         `unknown-project`.
      2. Any row of this key (any kind) with another member or project: `key-in-use`. The `(key,
         seed)` row already claimed: `claimed` (a launch took it; the local server re-sends the
         launch, which replays).
      3. `mirror.deleteRefs(projectId, [branch, snapshot])` (a no-op before the mirror exists):
         from here on, any failure leaves no seed for the key, so a failed retry never leaves an
         older seed behind. Steps 1 and 2 refuse without touching it.
      4. Stream the body to `<stateDir>/sandbox/tmp/<uuid>.bundle` (dir mode 0700, as MirrorSync.ts
         131, 330–337), counting bytes; past `maxSeedBytes` it stops with `too-large`; a body
         stream failure is `upload-failed`. A finalizer removes the file.
      5. Upsert the row (`ON CONFLICT (staging_key, kind) DO UPDATE SET created_at`), then
         invalidate the sweep's due hint, then `mirror.ensure(projectId)`. The row is written
         before any import, so a crash leaves a row the sweep finds.
      6. `mirror.importBundle({ projectId, bundlePath, refs: [branch→branch, snapshot→snapshot],
         exactRefs: true })`. On `missing-prerequisite`: `PairCloudProjects.fetchCheckout({
         projectId, workspaceRoot, memberId })` (never fails), `ensure` again (it refetches the
         checkout's `refs/remotes/origin/*`, CheckpointMirror 265–279), and one more
         `importBundle`; a second `missing-prerequisite` fails with that reason. Mirror reasons
         map: `too-large`→`too-large`, `invalid-objects`→`invalid-seed`,
         `missing-project`→`unknown-project`, `git`→`failed`.
      7. `commitParents(snapshotOid)` must be exactly `[branchOid]`, else `deleteRefs` both and
         `invalid-seed` ("The snapshot must be a commit on the branch tip."). `MirrorSync.restore`
         keeps a snapshot only when its parent is the branch tip (MirrorSync.ts 399), so this
         check is what keeps uncommitted files from being dropped without a word.
    - `check({ key, kind, projectId, memberId }) => Effect<void, StagedCloudImportError>`:
      read-only, for a launch to refuse before it creates anything. No row: `not-found`; another
      member or project: `key-in-use`; claimed: `claimed`; for `seed`, either staged ref missing
      from `mirror.tips`: `not-found`.
    - `claim({ key, kind, projectId, memberId, threadId }) => Effect<void,
      StagedCloudImportError>`, under the key's lock: no row `not-found`; another member or
      project `key-in-use`; claimed by another thread `claimed`; claimed by this thread succeeds
      at once (a replayed launch). For `seed`: both staged refs from `tips` (else `not-found`),
      `mirror.updateRefs(projectId, { sandboxBranchRef(threadId): branchOid,
      sandboxSnapshotRef(threadId): snapshotOid })` (CheckpointMirror 106, 109, 417), then
      `UPDATE … SET claimed_thread_id = threadId WHERE … AND claimed_thread_id IS NULL`, then
      `deleteRefs` the staged pair (a failure is logged; the thread's refs keep the objects). The
      ref copy comes first, so a crash before the `UPDATE` is redone by the replay.
    - `sweep: Effect<number, StagedCloudImportError>`: if the due hint is idle, nothing. Else, for
      each unclaimed row with `created_at` at least `unclaimedTtl` (24 h) old, under its key's
      lock: discard by kind (`seed`: `deleteRefs` the pair; no-op when the mirror is gone), then
      `DELETE … WHERE … AND claimed_thread_id IS NULL`. Records the next due time as the oldest
      unclaimed row plus the TTL (`DueHint`, as SandboxLifecycleWorker.ts 116, 370–371, 446).
      Returns the count. Claimed rows stay: one small row per move, and it is what makes a
      replayed claim idempotent.
  - `make({ maxSeedBytes = CLOUD_SEED_MAX_BYTES, unclaimedTtl = Duration.hours(24) } = {})`
    (tests pass small values, as `MirrorSync.make({ maxBundleBytes })`), and `layer`, which also
    registers `sweep` with the `Scheduler` as `"staged-cloud-imports"` on a cloud-only server
    (SandboxLifecycleWorker.ts 450–455).
  - `CheckpointMirror.importBundle`'s `exactRefs`, `CheckpointMirror.commitParents`.
- **Commands and events:** none. Staging writes the mirror and one table, and no thread sees it
  until 3.21's claim.
- **Migrations:** `093_StagedCloudImports`.
- **Proposed gap answers.**
  - Against 07 §8 (track notes): the move's key, not the launch's command id, names the seed
    (3.23 may derive the launch's command id from it); `PUT`, since a retry replaces; and the
    `409` is "asks the local server for full history", because Pair Cloud never calls the laptop.
  - The bundle's two refs carry their final names, so the local server makes temporary refs with
    those names before `git bundle create` (3.23).
  - Byte budget: an upload doesn't touch the runner socket, so 2.40's per-sandbox ingress budget
    doesn't apply. The upload shares one 32 MiB/s bucket with every cloud-move transfer (2.59's
    rate), so a 512 MiB seed can't take the event loop from running machines' PTYs. A typical seed
    fits in the 16 MiB burst and never waits.
  - Node's default `requestTimeout` (300 s; `NodeHttp.createServer()` in server.ts 386 sets none)
    bounds an upload, so a 512 MiB seed needs about 1.7 MB/s. Kept: it also ends a stuck client.
  - Unclaimed seeds live 24 h. Deleted refs free disk only at the next maintenance prune (07 §9),
    as for deleted threads. No per-member quota: membership is the trust boundary (01 §5).
  - One import per project at a time (the mirror's write lock): a large seed can push that
    project's `MirrorSync.sync` past 15 s, and the retry worker picks it up.
  - If a reviewer overrules the 24 h TTL, only the constant changes. If one wants claimed rows
    swept too, `claim` must accept a missing row when the thread's mirror refs exist.

**Tests.**

- New `packages/contracts/src/cloudMove.test.ts`, one table: `CloudStagingKey` takes
  `mv_` + 32 lowercase hex and refuses uppercase, 31 or 33 digits, `mv_../x`, a slash and an
  inner space (it lands in a ref name and a path); `CloudMoveFailure` decodes `reason: "from-a-newer-server"`
  as `null` and keeps `"missing-prerequisite"`.
- `apps/server/src/environment/ServerEnvironment.test.ts`, extend "offers the server browser
  unless cloud-only: %s" (127): `assert.equal(capabilities.cloudImport, cloudOnly ? true :
  undefined)`.
- `apps/server/src/sandbox/mirror/CheckpointMirror.test.ts`, extend "imports only the requested
  refs from a bundle whose prerequisite it has" (150): the same two-ref bundle with `exactRefs:
  true` and one requested ref fails `invalid-objects` and writes no ref; with both refs requested
  it imports.
- New `apps/server/src/persistence/Migrations/093_StagedCloudImports.test.ts` (as 089's test): a
  second `(key, kind)` insert fails, the same key with another kind inserts, and the migration
  reruns cleanly.
- `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts` 73, 187: the new row.
- New `apps/server/src/cloudMove/StagedCloudImports.test.ts`, `it.effect` with real git: a real
  `CheckpointMirror` over a project checkout with `refs/remotes/origin/main`, `SqlitePersistence.layerMemory`,
  `ServerConfig.layerTest`, a `Layer.mock(PairCloudProjects)` whose `fetchCheckout` is a `vi.fn`,
  and `make({ maxSeedBytes: 64 * 1024 })`. Seeds are built as 3.23 will: a branch with an unpushed
  commit, an edit and an untracked file captured with `VcsDriver.checkpoints.captureCheckpoint`
  onto `cloudSeedRefs(key).snapshot`, the branch tip copied to `cloudSeedRefs(key).branch`, then
  `git bundle create` against `^origin/main`. Cases:
  - "stages a seed under its key and replaces it on a retry": both refs in the mirror at the
    bundle's oids, one row; a second seed with another snapshot under the same key moves both
    refs and keeps one row (07 §10 #20, #21 "doesn't duplicate").
  - Table "refuses $name and leaves no seed": a third ref; a ref under another key; `HEAD` in the
    bundle; a snapshot whose parent isn't the branch tip; a body over the cap (`too-large`); a
    `.git` tree entry (`invalid-seed`). Each row first stages a good seed under the key, then
    asserts the failed retry left neither staged ref.
  - "fetches the checkout once on a missing prerequisite, then asks for full history": the
    bundle's prerequisite is a commit only the checkout's origin will have. Row 1:
    `fetchCheckout` advances the checkout's `refs/remotes/origin/main` to it; the import succeeds
    and `fetchCheckout` ran once. Row 2: `fetchCheckout` does nothing; `missing-prerequisite`,
    `fetchCheckout` ran once, no staged ref.
  - "refuses another member's or project's key and a deleted project": `key-in-use`,
    `key-in-use`, `unknown-project`; the first member's seed is untouched.
  - "claims a seed for one thread, which then restores it in a machine": `check` and `claim` by
    another member fail `key-in-use`; `claim` for thread A points
    `sandboxBranchRef(A)`/`sandboxSnapshotRef(A)` at the seed, drops the staged refs and marks the
    row; `claim` again for A succeeds and changes nothing; for thread B it fails `claimed`;
    `stage` under the key fails `claimed`. Then `MirrorSync.make().restore({ threadId: A, …,
    worktreePath: <new path> })` into a fresh clone on a `WorkspaceHostLoopback.layerLoopback`
    host (MirrorSync.test.ts 40–48): HEAD is the unpushed commit, the edited file and the untracked
    file are in the working tree, and `git diff --cached` is empty (07 §10 #21).
  - "sweeps unclaimed seeds after a day and keeps claimed ones": stage two keys, claim one,
    `TestClock.adjust("25 hours")`, `sweep` returns 1; the unclaimed key's refs and row are gone;
    the claimed row and thread refs remain; a second `sweep` reads no rows while its hint is idle.
- New `apps/server/src/cloudMove/CloudMoveHttp.test.ts`, `it.live` with `HttpRouter.serve(
  CloudMoveHttp.layer)` on `NodeHttpServer.layerTest` (RunnerRoute.test.ts 63–70), a
  `Layer.mock(EnvironmentAuth)` whose `authenticateMcpClient` reads the bearer, and a
  `Layer.mock(StagedCloudImports)` whose `stage` collects the body. One table, "answers $name":
  no bearer 401; a browser-style credential (the mock fails `ServerAuthInvalidCredentialError`)
  401; an API token (`peerLink: false`) 403; a read-only link 403; a bad key 400; a missing
  `projectId` 400; `content-length` over the cap 413; a server that isn't cloud-only 404 with an
  empty body. In every one of these `stage` was never called. Then a link with operate access
  gets 204 and `stage` saw its `memberId`, the key, the project and the exact bytes; `stage`
  failing `missing-prerequisite`, `invalid-seed` and `claimed` gives 409, 422 and 409 with a body
  that decodes as `CloudMoveFailure`.

**Verify.** `vp test run packages/contracts/src/cloudMove.test.ts
apps/server/src/environment/ServerEnvironment.test.ts
apps/server/src/sandbox/mirror/CheckpointMirror.test.ts
apps/server/src/persistence/Migrations/093_StagedCloudImports.test.ts
apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
apps/server/src/cloudMove/StagedCloudImports.test.ts apps/server/src/cloudMove/CloudMoveHttp.test.ts`;
`vp run typecheck` for contracts, server, client-runtime, web, mobile (the descriptor schema
changed); `vp run check:changed`. Runtime transcript on the G2 VM, with a link token in an env
var and never printed: `curl -X PUT --data-binary @seed.bundle` to
`/api/cloud-moves/staged/<key>/seed?projectId=<id>` answers 204 and `git --git-dir=<mirror>
for-each-ref refs/t3/staged/` lists two refs; a bundle with a third ref answers 422; the same
request with an API token answers 403; the descriptor shows `cloudImport: true`.

**Reviewer checks.**

- The route answers 404 before auth on a server that isn't cloud-only, and refuses before it
  reads the body: auth, key, project and `content-length` all come first.
- Only a peer-link `mcp-client` session with operate access gets through; the member comes from
  the session, never from the request.
- The server names every ref it writes: the bundle's refs must be exactly `cloudSeedRefs(key)`,
  by name and count, and nothing outside `refs/t3/staged/<key>/` and, on claim, the thread's own
  namespace is written.
- Objects enter only through `index-pack --strict`; the bundle file lives under
  `<stateDir>/sandbox/tmp` and is removed on every exit; the cap is enforced while streaming and
  again in `importBundle`.
- A failed retry leaves no seed for its key; a claimed key can't be restaged or claimed by another
  thread.
- The sweep never deletes a claimed row or a thread's refs, and takes the key's lock.
- Surfaces: contracts (`cloudMove.ts`, `capabilities.cloudImport`, optional; old clients ignore
  it). Server only; no client, provider or MCP change (laptop agents reach moves through 3.23's
  tool). Reverse states: the sweep removes an unclaimed seed; a claimed seed becomes the thread's
  refs, which `sandbox.mirror.forget-thread` deletes with the thread. Connection modes: the route
  sits on the member listener, so it answers on whatever address the link resolves (LAN, tailnet,
  public URL). Docs: environment-auth.md's "only `/mcp`" rule; the user guide is 3.26.

### 3.21 `feat(server): check out a seed in machines`

A cloud launch can name a staged seed. The launch claims it for the new thread, which turns the
seed's two staged refs into the thread's own mirror branch and snapshot refs. From then on the
machine's checkout is 2.13's mirror case: `checkoutInSandbox` clones or fetches GitHub as in M2,
`MirrorSync.restore` bundles the thread's refs from the mirror, writes the bundle into the machine
over the runner's file channel, fetches the branch, adds the worktree and puts the snapshot in
the working tree; then the setup script runs. The one change to `checkoutInSandbox` is that the
mirror case now also runs for a thread with no recorded worktree, at a new path, and reports
`restoredFrom: "seed"`. Because the seed lives in the thread's own refs, a retry, a re-armed run
after a restart and a later rebuild of a lost disk all take the same path with no seed key to
carry. It is its own PR because it changes the one function that decides where a machine's code
comes from, and the launch's claim, on the critical path.

- **Needs:** 3.20 (`StagedCloudImports.check` and `claim`, `CloudStagingKey`); 2.13 and 2.31
  (landed). **Unblocks:** 3.23 (its launch route passes `seedRef`).
- **Files:**
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`:
    - The cloud member of `ThreadLaunchWorkspaceStrategy` (84–90) gains `readonly seedRef?:
      CloudStagingKey | undefined`, with "A staged seed this launch claims; its branch need not be
      on origin." `PreparationInput` (139–151) gains `readonly seeded?: true`.
    - `make` (276): `const stagedImports = yield*
      Effect.serviceOption(StagedCloudImports.StagedCloudImports)`, beside `pairCloudProjects`
      (303).
    - `launch` (1130), after the `existingBranch` block (1180–1200), when `strategy.type ===
      "cloud" && strategy.seedRef !== undefined`, before any thread, each refusal mapped with
      `mapError(input, "resolve-project")` like `checkExistingBranch` (1195):
      1. No `branch`: `CloudLaunchError` `no-branch` (2.31's reason).
      2. `branch` equal to `baseRef`, or to `git.currentBranch(project.workspaceRoot)` (the Pair
         Cloud checkout's, which is origin's default branch; a git failure counts as no match):
         new reason `seed-on-base`. `MirrorSync.restore` fetches into `refs/heads/<branch>` of the
         machine's clone, and git refuses to fetch into the branch a clone has checked out.
      3. Only without a launch receipt (`Option.isNone(launchReceipt)`): `stagedImports.check({
         key: seedRef, kind: "seed", projectId, memberId })`, where `memberId = input.actorId ??
         input.ownerId`. No member, no service, or any `StagedCloudImportError` but `failed` is
         new reason `seed-unavailable`; `failed` stays a `ThreadLaunchError` with its cause.
    - `existingBranch` (1180) becomes `strategy.type === "cloud" && strategy.existingBranch ===
      true && strategy.seedRef === undefined`. A seed carries the branch, so neither 2.31 check
      runs for it: not `checkExistingBranch` at launch (1194) and not the in-sandbox
      `branch-not-pushed` (the mirror case returns first, below).
    - After `threadId` is known (1322) and before `provisionCloud` (1331), on every call
      including replays: `stagedImports.claim({ key: seedRef, kind: "seed", projectId, memberId,
      threadId })`, mapped with `mapError(input, "create-thread", threadId)` to the same
      `seed-unavailable`. A replay gets the receipt's thread id, so the claim is idempotent.
      Claiming before the machine means a refused claim starts no machine.
    - The `schedulePreparation` call (1435–1442) adds `...(seeded ? { seeded: true as const } :
      {})`; `prepareInBackground`'s `checkoutInSandbox` call (638–646) passes `seeded:
      input.seeded === true`.
    - `restoreInBackground` (1487): `firstCheckout` (1501–1504) only says whether the thread was
      checked out as a worktree, and `baseRef` only matters when the mirror lacks the branch. A
      cloud thread launched without a message has no run, so today it is never rebuilt
      (**proposed** fix here, since a seeded launch may be one): return only when
      `firstCheckout !== undefined && firstCheckout.type !== "worktree"`, and pass `baseRef:
      firstCheckout?.baseRef ?? branch` (1516).
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`:
    - `CloudLaunchError` (42) reasons gain `"seed-on-base"` (`` `${this.branch} is Pair Cloud's
      base branch. Create a new branch for this work, then try again.` ``, with `branch` set; the
      dialog has no branch picker, so the fix is on the Mac) and `"seed-unavailable"` ("The work
      uploaded for this move is no longer on Pair Cloud. Continue in cloud again."; "staged"
      reads as git's staging area). Only `message` reaches clients (ws.ts 2433, `failureDetail`
      265), so new reasons are safe.
    - `checkoutInSandbox` (247): input gains `seeded: boolean`; the doc comment (242–246) names
      the seed. A local `worktreePathFor(root, branch)` = `` `${root}/worktrees/${branch.replaceAll("/", "-")}` ``
      replaces the inline path at 339 and serves the seed. The mirror case (295–315) becomes:
      ```ts
      if (Option.isSome(mirror)) {
        const rebuilt = input.existingWorktreePath !== null;
        const worktreePath = input.existingWorktreePath ?? worktreePathFor(root, input.branch);
        // An attempt that failed after `worktree add` left this path; start it again.
        if (!rebuilt && (yield* isCheckout(worktreePath))) {
          yield* git.removeWorktree({ cwd: clonePath, path: worktreePath, force: true });
        }
        const restored = yield* mirror.value.restore({ …, worktreePath, branch: input.branch });
        if (restored !== null) {
          return {
            clonePath, worktreePath, branch: input.branch,
            // A rebuild never deletes the work it brought back; a failed first checkout is undone.
            created: !rebuilt,
            restoredFrom: rebuilt ? ("mirror" as const) : ("seed" as const),
            snapshotAt: restored.snapshotAt,
          };
        }
      }
      if (input.seeded) {
        return yield* new CloudLaunchError({ projectId: input.projectId, reason: "seed-unavailable" });
      }
      ```
      `restoredFrom` becomes `"disk" | "mirror" | "seed" | "origin"`. For a thread the mirror has
      never seen, `restore` returns null after one `for-each-ref` in the mirror (MirrorSync.ts
      367–371), before it touches the machine. `seeded` is set only on the launch's own
      preparation; a retry or re-arm finds the seed in the thread's refs without it.
  - No contract change: `seedRef` is server-side. The only sender is 3.23's `POST
    /api/cloud-moves/staged/<key>/launch`, which builds `ThreadLaunchInput` itself, so it never
    enters `OrchestrationV2ThreadLaunchCloudStrategy` (orchestrationV2.ts 763), the client
    `thread.launch` RPC or `t3_thread_launch`'s schema (mcp/toolkits/project/tools.ts 145, which
    uses that union as is).
- **Types and services:** `ThreadLaunchWorkspaceStrategy` cloud `seedRef`; `PreparationInput.seeded`;
  `checkoutInSandbox` input `seeded`, result `restoredFrom` `"seed"`; `CloudLaunchError` reasons
  `seed-on-base`, `seed-unavailable`. No new service.
- **Commands and events:** none. The thread is created with the seed's branch name
  (`thread.create`'s `branch`, 1299), the run records `{ type: "worktree", baseRef, branch }` as
  any cloud run, and the worktree path lands through the existing `thread.metadata.update`
  (751). No rebuild notice: `recordRebuild` runs only when a worktree was recorded (652), and
  3.23 records the move's own turn item.
- **Migrations:** none.
- **Proposed gap answers.**
  - The claim copies refs at launch rather than carrying `seedRef` on the run, so the frozen run
    union stays strict and 2.31's open gap (a retry loses `existingBranch`) does not apply to
    seeds.
  - The snapshot goes into the working tree with 2.13's `read-tree --reset -u` and `reset`
    (MirrorSync.ts 451–454), not `restoreCheckpoint` as 07 §8 says: `restoreCheckpoint` would
    stage it (GitVcsDriver.ts 1374–1381, `restore --worktree --staged`). Untracked files arrive
    untracked and edits unstaged, as on the laptop.
  - Bytes into the machine: `restore` holds the bundle in memory (≤ 512 MiB, as 2.13) and writes
    it with `host.fileSystem.writeFile`, which streams 128 KiB frames one at a time, each awaited
    (SandboxWorkspaceHost.ts 46, 477–491). That is server-to-runner, so 2.40's ingress budget
    doesn't apply, and one awaited frame at a time bounds its share of the socket. The bundle
    from the mirror uses the machine clone's `origin/HEAD` as its prerequisite when the clone has
    it (MirrorSync.ts 411–425), so it is usually small.
  - A seed on the base or default branch is refused; 3.23 moves such work to a new branch name
    before it uploads.
  - If a reviewer drops the `restoreInBackground` fix, 3.23 must launch with an initial message,
    or a seeded thread whose disk is lost before its first message comes back empty.

**Tests.**

- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`:
  - "checks a cloud thread out again from $name" (2693): the table gains `recorded: boolean`
    (default true) and `seeded` (default false) columns, and the call passes
    `existingWorktreePath: recorded ? recordedPath : null` and `seeded`. New rows: "a new thread
    whose mirror holds its seed" (`recorded: false, mirrored: true` → `restoredFrom: "seed"`,
    `worktreePath: ${root}/worktrees/feature-login`, `created: true`, no `createWorktree`): this
    is also the retry and re-arm case, which passes no `seeded`. "A seeded launch the mirror has
    no copy of" (`recorded: false, seeded: true, mirrored: false` → fails `seed-unavailable`, no
    `createWorktree`). Assert `restore` saw the new path for the seed row.
  - "rebuilds a cloud thread's lost checkout when its machine comes back, and says so" (2747):
    `mirrorRestore` answers null on its first call, the launch's own checkout of a new thread,
    which now asks the mirror too.
  - "refuses a cloud launch for $name before any thread or machine" (3026): `makeHarness` gains a
    `stagedImports?: Partial<StagedCloudImports["Service"]>` option (a `Layer.mock`, like
    `mirrorRestore` at 274). New rows with `seedRef: "mv_" + "0".repeat(32)`, `actorId`, and
    `currentBranch` answering `"main"`: "a seed with no branch" (`no-branch`); "a seed on its
    base branch" (`branch: "main"`, `seed-on-base`); "a seed on the checkout's default branch"
    (`baseRef: "develop"`, `branch: "main"`, `seed-on-base`); "a seed staged by someone else"
    (`check` fails `key-in-use`, `seed-unavailable`). Each asserts no thread and that `claim`
    never ran.
  - New `it.effect` "launches a seeded cloud thread from its claimed seed and never asks origin",
    on `cloudHarness` with `mirrorRestore` and `stagedImports` `vi.fn`s: the workspace is `{
    type: "cloud", baseRef: "main", branch: "feature/login", seedRef, existingBranch: true }` with
    `remoteHasBranch` failing the test if called and `currentBranch` answering `"main"` (the
    harness's `Layer.mock` has no default for it). Assert `check` and then `claim` ran with the
    link member and the launched thread id; after `sandbox.runner.attached`, `runReaching(…,
    "starting")`: `mirrorRestore` got `worktreePath: ${root}/worktrees/feature-login` and `branch:
    "feature/login"`, `createWorktree` never ran, setup ran on that path, and the thread's
    `worktreePath` is it. Launch again with the same command id: `check` did not run again,
    `claim` ran again with the same thread id.
  - New row or case in the 2747 test's style for the `restoreInBackground` fix: a cloud thread
    launched without a message, then `restoreCheckout`, calls `mirrorRestore` at the recorded
    path.

**Verify.** `vp test run apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`;
`vp run typecheck` for server; `vp run check:changed`. No entry point sends `seedRef` until 3.23,
so the runtime transcript runs with 3.23 (G3 step 1): on Docker, a seed with an unpushed commit, an
edit and an untracked file launches; inside the machine `git log -1`, `git status --porcelain`
and the untracked file match the laptop; the server log shows `restoredFrom: "seed"`; then
`docker rm -f` and Retry rebuild it with `restoredFrom: "mirror"` (the 2.13 path).

**Reviewer checks.**

- A seeded launch never falls back to `origin/<base>`: no `createWorktree` call when `seeded`,
  and `seed-unavailable` instead.
- Neither `branch-not-pushed` check can fire for a seed; a launch without `seedRef` behaves as on
  `main` (the three existing rows of 2693 and 2.31's rows pass unchanged).
- The claim runs before `provisionCloud`, uses the receipt's thread id on a replay, and takes its
  member from the launch input, never from the seed.
- Bytes flow mirror to machine only, through `MirrorSync.restore`; there is no second restore
  path.
- A rebuilt disk (recorded worktree) still reports `"mirror"`, `created: false`, and records the
  notice; a seed reports `"seed"`, `created: true`, and records none.
- Surfaces: server only. Contracts: none (the key type is 3.20's). Clients: none; the "seed"
  value appears in logs only. Agents and MCP: none; `t3_thread_launch`, `delegate_task` and `t3
  thread` keep M2's rule that the branch is on origin (the decision on 08 open question
  6). Reverse states: the seeded thread's refs are deleted with the thread, as any thread's.
  Docs: none here; 3.26.

### 3.22 `feat(contracts,server,client-runtime,web,mobile): import a context export as read-only history`

A thread's conversation can leave its server as a context export and land on a new thread on
another server as read-only history. The export carries its own provenance (`environmentId`,
`threadId`, `title`, and the exporting server's label), because `OrchestrationV2ContextTransfer`
names threads in one event store (orchestrationV2.ts 245–271). It holds the visible user and
assistant messages, capped at 2 MiB. The receiving server writes them as runless messages on a
thread marked `historyOrigin: "context_export"`, with a notice where messages were left out and a
`move` row linking back. The first run there gets the same `manual_context` handoff V1 imports get,
from the same lazy path, so its "omitted history" pointers name items on the new thread. On Pair
Cloud an uploaded export is staged under the move's key in 3.20's table, and a cloud launch claims
it through `contextExportRef`. The row also defines the `move` turn item that 3.23 and 3.25 record.
It is its own PR because it is the one contract both directions share, and the
forward-compatibility hazards (a new `historyOrigin`, a new turn item, the strict transcript) get
one review.

- **Needs:** 2.32 (landed: `historyOrigin` is `ForwardCompatibleOptional` on the app thread, 520,
  and the shell, 2296); 3.20 (`StagedCloudImports`, `CloudMoveHttp`, `CloudStagingKey`,
  `CloudMoveFailure`). **Unblocks:** 3.23 (`ContextExports.build` on the laptop,
  `contextExportRef`, `thread.move.record`), 3.25 (`ContextExports.build` on Pair Cloud,
  `ThreadLaunchInput.contextExport`, the `move` item).
- **Files:**
  - `packages/contracts/src/orchestrationV2.ts`:
    - 114: `OrchestrationV2ThreadHistoryOrigin` becomes `Schema.Literals(["native", "v1_import",
      "context_export"])`. Below it:
      ```ts
      /** Runless conversation items on such a thread are history that came from elsewhere. */
      export const threadHasImportedHistory = (
        origin: OrchestrationV2ThreadHistoryOrigin | undefined,
      ) => origin === "v1_import" || origin === "context_export";
      ```
    - After `OrchestrationV2ContextTransfer` (271): the export (shape under **Types**).
    - Beside `OrchestrationV2LinkRequestFields` (1699): `OrchestrationV2MoveFields` (under
      **Types**). The member `Schema.Struct({ ...OrchestrationV2TurnItemBaseFields,
      ...OrchestrationV2MoveFields })` goes after the link-request member in
      `OrchestrationV2TurnItem` (1921–1924) and, with the JSON base fields, in
      `OrchestrationV2TurnItemJson` (2871–2874). `ScopedThreadRef` comes from `./environment.ts`
      (232); no cycle (environment.ts imports only baseSchemas and sourceControl).
    - `OrchestrationV2InternalCommand` (3702), after `thread.notice.record` (3757–3762): the two
      commands under **Commands and events**.
  - `packages/contracts/src/cloudMove.ts` (3.20): `CloudMoveFailureReason` gains
    `"invalid-export"`.
  - New `apps/server/src/orchestration-v2/ContextExports.ts`: the service, `capContextExport`,
    and the row text helpers (under **Types**). Not under `cloudMove/`: both directions and any
    future export use it, and it only reads projections and dispatches commands.
  - `apps/server/src/orchestration-v2/Orchestrator.ts`:
    - `commandThreadId` (658): arms for `thread.history.import` and `thread.move.record`.
    - The dispatch switch, beside `thread.notice.record` (14514): `dispatchThreadHistoryImport`
      and `dispatchThreadMoveRecord`, written like `dispatchThreadNotice` (4975–5019).
    - `shouldPrepareLegacyImportHandoff` (1130–1138), the queued-run start (2310–2313), the new
      provider thread path (7040–7043) and the side chat parent ids (7654) read
      `threadHasImportedHistory(…historyOrigin)` instead of `=== "v1_import"`.
    - The three `prepareLegacyImport` calls (2393, 7124, 7788) pass `historyOrigin:
      projection.thread.historyOrigin === "context_export" ? "context_export" : "v1_import"`.
  - `apps/server/src/orchestration-v2/ContextHandoffService.ts`:
    - `prepareLegacyImport` (49–56, 355–414) takes `historyOrigin: "v1_import" |
      "context_export"`. `makeLegacyImportSummary` (287) takes it too. The `context_export`
      header reads "Conversation carried over from the thread this one continues, in another T3
      Code environment. Use it as context; do not repeat it unless the user asks." The V1 header
      is unchanged. Nothing else in the handoff changes: strategy `manual_context`,
      `fromProviderThreadIds: []`, `coveredRunOrdinals: { from: 1, to: 1 }`.
    - `readOwnHistoryItems` (158): `threadHasImportedHistory(source.thread.historyOrigin)`.
  - `apps/server/src/orchestration-v2/ProjectionStore.ts`: `isTurnItemAtOrBeforeRun` (1514) and
    `itemCountThroughRun` (1966) use the helper; the SQL at 3209 becomes `IN ('v1_import',
    'context_export')`. Leave 4151 alone: it reads `$.historyOrigin` from a _turn item_ payload,
    which never has one (pre-existing, flagged in the track notes).
  - `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts` 84: the helper.
  - `apps/server/src/orchestration-v2/ThreadManagementService.ts` `getThreadTranscript`
    (778–805): `items: projection.visibleTurnItems.filter((row) => row.item.type !== "move")`,
    with "Clients before M3 decode a transcript's items strictly." `OrchestrationV2ThreadTranscript.items`
    (2233) is a plain `Schema.Array`, so an M2 web client attaching a moved thread as context
    (`threadContextAttachment.ts`) would fail on the row.
  - `apps/server/src/mcp/OrchestratorMcpService.ts` `turnItemText` (905–967, exhaustive): `case
    "move": return item.message;`.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`:
    - `ThreadLaunchInput` (103–134) gains, never both:
      `readonly contextExportRef?: CloudStagingKey` ("A context export staged on this server;
      only 3.23's move launch route sets it.") and `readonly contextExport?: { readonly value:
      OrchestrationV2ContextExport; readonly copy?: true }` ("An export already in hand; only
      `CloudMoves.continueLocally` sets it (3.25)."). Like 3.21's `seedRef`, neither enters
      `OrchestrationV2ThreadLaunchInput`, the client `launchThread` RPC or `t3_thread_launch`.
    - `ThreadLaunchError.operation` (167–182) gains `"import-history"`.
    - `make` (276): `const stagedImports = yield*
      Effect.serviceOption(StagedCloudImports.StagedCloudImports)`. 3.21 (wave 3) needs the same
      line; this row lands first and adds it.
    - `launch` (1130):
      1. Before any thread, only without a launch receipt, when `contextExportRef` is set:
         `stagedImports.check({ key, kind: "context-export", projectId, memberId })` with 3.21's
         `memberId = input.actorId ?? input.ownerId`. No member, no service, or any
         `StagedCloudImportError` but `failed`: `CloudLaunchError` reason `export-unavailable`,
         mapped with `mapError(input, "resolve-project")` like `checkExistingBranch`.
      2. After `threadId` is known (1326) (and after 3.21's seed claim once that lands), before
         `provisionCloud` (1331),
         on every call including replays: with a ref, `stagedImports.claim({ key, kind:
         "context-export", projectId, memberId, threadId })` (refusal as in step 1, mapped to
         `create-thread`). Then, unless `reuseExistingThread`, read the shell
         (`threads.getThreadShell`); when its `historyOrigin` is already `context_export` (a
         replay), skip. Otherwise take `input.contextExport.value`, or
         `stagedImports.readContextExport({ key })`, and call `contextExports.import({
         commandId: CommandId.make(`${input.commandId}:history`), threadId, contextExport, copy,
         actorId })`, mapped to `import-history`. With a ref, then
         `stagedImports.dropContextExport({ key })` (a failure is logged).
         The import runs before `provisionCloud`, so a refused import starts no machine, and before
         the initial message (1342), so the history sits before run 1 and the run's handoff sees it.
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts` `CloudLaunchError` (42): reason
    `"export-unavailable"`, "The conversation uploaded for this move is no longer on Pair Cloud.
    Continue in cloud again." Only `message` reaches clients (3.21's note on ws.ts 2433).
  - `apps/server/src/cloudMove/StagedCloudImports.ts` (3.20):
    - `StagedCloudImportKind = "seed" | "context-export"`; `StagedCloudImportError.reason` gains
      `"invalid-export"`.
    - `stage` for `context-export`, under the key's lock: the project and key checks exactly as
      for `seed` (steps 1–2); remove `<stateDir>/cloud-moves/<key>/` first, so a failed retry
      leaves no older export; stream the body to `context-export.json.part` in that directory
      (mode 0700), counting bytes, past `CONTEXT_EXPORT_MAX_BYTES` `too-large`; decode with
      `Schema.fromJsonString(OrchestrationV2ContextExport)`, else `invalid-export`; rename to
      `context-export.json`; upsert the row.
    - `check`: the row checks, then the file must exist (else `not-found`).
    - `claim`: the row checks and the `UPDATE`, as for `seed`, with no ref copy.
    - New `readContextExport({ key }) => Effect<OrchestrationV2ContextExport,
      StagedCloudImportError>` (missing file `not-found`) and `dropContextExport({ key }) =>
      Effect<void>` (removes the directory, logs a failure).
    - The sweep's discard for `context-export` removes the directory.
  - `apps/server/src/cloudMove/CloudMoveHttp.ts` (3.20): `contextExportUpload`, `PUT
    ${CLOUD_MOVE_ROUTE_PREFIX}/staged/:key/context-export?projectId=<id>`, added to `layer`'s
    `mergeAll`. Same steps as `seedUpload` (404 before auth off cloud-only,
    `authenticateLinkMember`, key and project 400, `content-length` over
    `CONTEXT_EXPORT_MAX_BYTES` 413, the body through the shared budget into `stage({ kind:
    "context-export" })`, 204). `invalid-export` maps to 422.
  - `apps/server/src/orchestration-v2/runtimeLayer.ts`: `layerContextExportsProvided =
    ContextExports.layer.pipe(Layer.provide(layerThreadManagementProvided))` (275), merged into
    `layerThreadLaunchProvided`'s `mergeAll` (293–305). `ServerEnvironment` comes from the runtime.
    Re-read the composition.
  - `packages/client-runtime/src/state/threadWorkflows.ts` 102: the helper.
  - `apps/web/src/session-logic.ts`: `"move"` joins `STANDALONE_V2_ITEM_TYPES` (297–305), so it
    becomes an event row (733), not work.
  - `apps/web/src/components/chat/V2LifecycleRow.tsx`: before the subagent branch (212), `if
    (item.type === "move") return <MoveDivider item={item} />`. `MoveDivider` renders
    `TimelineSystemDivider` (TimelineSystemDivider.tsx 7–17) with `label={item.message}`,
    `ArrowRightLeftIcon` (already imported), and, when `useEnvironment(item.thread.environmentId)`
    is not null, `actionLabel` "Open new thread" for `to` and "Open original thread" for `from`
    (the tooltip, as the fork row's "Open fork" and "Open source conversation"), navigating to
    `/$environmentId/$threadId` with
    `buildThreadRouteParams(scopeThreadRef(item.thread.environmentId, item.thread.threadId))`, as
    `SubagentTimelineLink` opens a linked environment's thread (487–501).
  - `apps/mobile/src/lib/threadActivity.ts`, whose switches are exhaustive: `itemIsProminent`
    (435) includes `move`; `itemIcon` (492) `"zap"`, as handoff and fork; `itemSummary` (579)
    `item.message`; `itemPreview` (652) `null`. No tap action in this row (3.24 owns mobile moves).
- **Types and services:**
  - The export, in orchestrationV2.ts:

    ```ts
    export const CONTEXT_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
    export const CONTEXT_EXPORT_MAX_MESSAGES = 1_000;
    export const CONTEXT_EXPORT_MAX_MESSAGE_CHARS = 64 * 1024;

    export const OrchestrationV2ContextExportMessage = Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String.check(Schema.isMaxLength(CONTEXT_EXPORT_MAX_MESSAGE_CHARS)),
      createdAt: Schema.DateTimeUtcFromString,
    });

    /** A thread's conversation for another server, which cannot name the thread by id alone. */
    export const OrchestrationV2ContextExport = Schema.Struct({
      version: Schema.Literal(1),
      source: Schema.Struct({
        environmentId: EnvironmentId,
        threadId: ThreadId,
        title: TrimmedNonEmptyString,
        /** The exporting server's label, for the row that links back. */
        environmentLabel: TrimmedNonEmptyString,
      }),
      exportedAt: Schema.DateTimeUtcFromString,
      /** The first user message, then the newest that fit, oldest first. */
      messages: Schema.Array(OrchestrationV2ContextExportMessage).check(
        Schema.isMaxLength(CONTEXT_EXPORT_MAX_MESSAGES),
      ),
      /** Messages left out to fit: the oldest after the first user message. */
      omittedMessageCount: NonNegativeInt,
    });
    ```

    It is JSON on purpose: it crosses servers over HTTP and is never in a client snapshot. The
    byte cap is checked by `build`, the upload route and `import`.

  - The move item:
    ```ts
    /** `to`: this thread continued as `thread`. `from`: this thread continues `thread`. */
    const OrchestrationV2MoveFields = {
      type: Schema.Literal("move"),
      direction: Schema.Literals(["to", "from"]),
      thread: ScopedThreadRef,
      /** A non-holder's bring-back: the other thread is a copy, and the cloud one stays live. */
      copy: Schema.optional(Schema.Literal(true)),
      /** Written by the recording server, so MCP reads and every client show the same words. */
      message: TrimmedNonEmptyString,
      actorId: Schema.optional(MemberId),
    } as const;
    ```
  - `ContextExports` (`t3/orchestration-v2/ContextExports`), needing `ThreadManagementService`
    and `ServerEnvironment`:
    - `build(threadId) => Effect<OrchestrationV2ContextExport, ContextExportError>`.
      `ThreadManagementService.getThreadSnapshot` (it hydrates a V1 transcript first, 734, 774–777),
      then `projection.visibleTurnItems` in order, inherited fork rows included: `user_message`
      and `assistant_message` items only, without `streaming` assistants and without a user
      message `isCompactionCommandMessage` accepts (orchestrationV2.ts 617). Text is the item's
      (projections are never deduped; dedup is wire-only, orchestrationV2DedupedBodies.ts 13–17),
      `createdAt` is `startedAt ?? updatedAt`. Then `capContextExport`. `source` is this server's
      descriptor (`getDescriptor`: id and label) and the thread's id and title. It does not refuse
      a running thread; its callers do.
    - `import({ commandId, threadId, contextExport, copy?, actorId? }) => Effect<void,
      ContextExportError>`: re-encodes the export and refuses over `CONTEXT_EXPORT_MAX_BYTES`
      with `too-large`, composes `fromMessage`, dispatches `thread.history.import`. A refused
      command (the thread has messages or runs) is `not-empty`; the thread missing is
      `not-found`.
    - `ContextExportError` (`Schema.TaggedError`): `threadId`, `reason: "not-found" |
      "too-large" | "not-empty" | "failed"`, `cause?`.
  - `capContextExport(messages) => { messages, omittedMessageCount }`, pure and exported:
    1. A message over `CONTEXT_EXPORT_MAX_MESSAGE_CHARS` keeps its first part (not splitting a
       surrogate pair, as `compactText` in ContextHandoffService.ts 107–115) plus "\n\n[Message
       shortened; the rest is on the original thread.]".
    2. Keep the first user message. Then walk from the newest backwards, adding while the
       encoded export stays under `CONTEXT_EXPORT_MAX_BYTES` and the count under
       `CONTEXT_EXPORT_MAX_MESSAGES`; stop at the first that doesn't fit, so there is one gap,
       right after the first user message. This is AgentSessionScanner's rule (keep the first
       user message and the newest, 606–620) with a byte budget.
  - Row text, in ContextExports.ts: the gap notice "`n` earlier messages stayed on the original
    thread on `label`." ("1 earlier message" for one); the `from` row "Continued from “`title`”
    on `label`", or for a copy "Copy of “`title`” from `label`". 3.23 and 3.25 compose their own
    `to` rows.

- **Commands and events:** two internal commands (clients can't send them;
  `OrchestrationV2InternalCommand` isn't in the client decode).
  - `thread.history.import { commandId, threadId, contextExport, fromMessage, copy?, actorId? }`.
    The decider refuses (`OrchestratorDispatchError`, a rejected receipt) when the thread is
    missing or deleted, or has any run or message (`getThreadRecords(threadId, ["runs"])`,
    `getMessageCount`, ProjectionStore.ts 507). Otherwise it emits, in this order:
    `thread.metadata-updated` with `historyOrigin: "context_export"`; for each message a
    `message.updated` and a `turn-item.updated` (`user_message` with `inputIntent: "turn_start"`
    or `assistant_message` with `streaming: false`; `runId`, `nodeId` and provider ids null;
    `status: "completed"`; `creationSource: "server"`; no attachments, no `context`, no
    `authorId`), with the gap notice (`system_notice`) right after the first message when
    `omittedMessageCount > 0`; last, the `move` item `direction: "from"`, `thread:
    contextExport.source`, `message: fromMessage`. Ids are the command id plus a suffix
    (`:m:<i>` messages, `:i:<i>` items, `:omitted`, `:from`), so a replay can't duplicate, as
    AgentSessionImporter's and V1's derived ids (LegacyV1ThreadImporter.ts 276, 314).
  - `thread.move.record { commandId, threadId, to: ScopedThreadRef, message, copy?, actorId? }`:
    one `turn-item.updated` `move` item, `direction: "to"`, id
    `idAllocator.derive.lifecycleNoticeTurnItem({ commandId })` as `dispatchThreadNotice`. Its
    `runId` is the newest run whose status isn't `rolled_back` or `cancelled`, or null when there
    is none. Nothing for a deleted thread.
  - **Why runs and positions.** `TurnItemPositionStore.allocate` (TurnItemPositionStore.ts
    61–80) puts every runless item in positions 1–999,999 and run `n`'s items at `n` × 1,000,000
    and up; `EventSink.normalizeEvents` (332–353) applies it to every write. So the import's
    runless rows sit before run 1, in emit order, which is what history needs. A runless `to` row
    recorded after runs would show above them, so it rides the newest run and lands after its
    last item.
  - **No handoff at import.** A handoff names a target run and provider thread, which don't exist
    yet. The first run builds it on the existing V1 path: `readHandoffItems(threadId, [null])`
    (Orchestrator.ts 1424) returns the runless items, `historicalMessage` keeps user and
    assistant text (handoffBudget.ts 140–175; the notice and the move row return null),
    `selectHistory` keeps the first user message and the newest within the token cap, and
    `handoffCoverage` points `t3_thread_read` at the new thread (253–266). `omittedItemIds` are
    the imported items' ids on the new thread, so they resolve there.
- **Migrations:** none. `staged_cloud_imports.kind` has no `CHECK` (3.20).
- **Proposed gap answers.**
  - What goes: user and assistant text only, as V1's import (LegacyV1ThreadImporter.ts 361) and
    the handoff summary (ContextHandoffService.ts 287–297). Tool output, reasoning, plans and
    file changes stay on the source thread; the source's checkpoints stay readable there (07 §8).
    Attachments and composer context chips are dropped: their files and ids live on the source
    server. Authors are dropped: member ids differ between servers. If a reviewer wants plans in,
    `OrchestrationV2ContextExportMessage` gains a `proposed_plan` role and `historicalMessage`
    already reads plans.
  - Caps: 2 MiB, 1,000 messages, 64 KiB per message. One import is one command, two events per
    message, in one transaction under the thread's lock; 1,000 messages keeps it short. The
    first run's handoff is capped separately (16k tokens), so the export cap only bounds
    scroll-back. Raising them changes only the constants.
  - Storage: events through an internal command, not direct `EventSink.write` as V1
    (LegacyV1ThreadImporter.ts 602–643) and AgentSessionImporter (346–433) do. The thread is live
    when it imports, so it needs the orchestrator's lock and a receipt; neither importer has a
    live thread. No explicit `orchestration_v2_turn_item_positions` rows: emit order gives the
    order. Overruled (direct writes): `import` writes with derived event ids and must recheck
    "no messages, no runs" itself, without the lock.
  - The `to` row rides the newest kept run (positions, above). Overruled (runless): it shows above
    run 1 until the position store learns to place runless rows after the newest run, which also
    moves today's lifecycle and rebuild notices (track notes).
  - The transcript leaves `move` rows out rather than becoming forward-compatible: that would not
    help M2 clients, which already ship the strict schema.
  - Read-only needs no client change: imported items have no run, so there is no fork
    (TimelineAssistantRows.tsx 103), no revert (revert counts come from runs and checkpoints,
    session-logic.ts 1062–1100), no queued-message edit, and no checkpoint. The `from` row after
    the history is the boundary a reader sees. V1 imports look the same today.
  - `contextExportRef` is server-side for `seedRef`'s reason (seed track notes): the launch union
    is the client RPC's and `t3_thread_launch`'s schema. The upload takes `?projectId=` like the
    seed's, because 3.20's row requires a project.

**Tests.**

- `packages/contracts/src/orchestrationV2.test.ts`:
  - Extend "reads a machine state, admission reason or history origin from a newer server as
    unknown" (809): `historyOrigin: "context_export"` now decodes as itself on the shell and the
    app thread; `"cloud_import"` stays the unknown sample.
  - Extend "skips turn item types from a newer server in snapshots and turn-item events" (161):
    a `move` item with `thread: { environmentId, threadId }` decodes as a known event and stays
    in the snapshot's `turnItems` and `visibleTurnItems`; a `move` item without `thread` throws
    (a known type must decode in full).
  - New table "refuses an export it can't take: $name": `version: 2`, a `system` role, a message
    over `CONTEXT_EXPORT_MAX_MESSAGE_CHARS`, 1,001 messages.
- New `apps/server/src/orchestration-v2/ContextExports.test.ts`:
  - `capContextExport` table: under the cap keeps all; over it keeps the first user message and
    the newest, with one gap and the right `omittedMessageCount`; a conversation opening with an
    assistant message keeps the first _user_ message; an oversized message is cut on a surrogate
    pair boundary with the marker.
  - On the orchestrator harness `Orchestrator.attribution.test.ts` uses (in-memory SQLite, a Codex
    adapter from `ProviderReplayHarness`): "builds an export from the visible conversation" (a
    `/compact` message, a rolled-back run's reply and tool items are left out; a fork's inherited
    rows come first; `source` names this environment and its label). "imports an export as
    runless history the first run hands off": `import`, then the projection has `historyOrigin:
    "context_export"`, every item runless, in the order first message, notice, the rest, `from`
    row; then `message.dispatch` with `start_immediately`: `contextHandoffs[0]` is
    `manual_context` with `fromProviderThreadIds: []`, its summary starts with the export header,
    and every `history.omittedItemIds` resolves with `getTurnItem` on the new thread (10 §4:
    "the handoff's omitted history references resolve"). "replays an import and refuses a used
    thread": the same command id writes nothing new; another id fails `not-empty`; an export
    over 2 MiB fails `too-large`. "records a move row after the newest kept run": a completed run
    then a rolled-back one: the row's `runId` is the completed run's and its ordinal is above
    every item; on a thread with no runs it is runless.
- `apps/server/src/orchestration-v2/ContextHandoffService.test.ts`: "prepares imported history
  for the first native v2 turn" (75) becomes an `it.effect.each` over `historyOrigin`, asserting
  each header.
- `apps/server/src/orchestration-v2/Orchestrator.migration.test.ts`: "reissues imported context
  until a V2 run completes" gains a `context_export` row.
- `apps/server/src/orchestration-v2/http.test.ts`: extend "exports full history with size,
  scope, and missing-thread checks" (169): a `move` row is left out of the transcript.
- `apps/server/src/cloudMove/StagedCloudImports.test.ts` (3.20): new case "stages a context
  export, claims it once and sweeps it": staged file present; invalid JSON is `invalid-export`
  with no file left; over the cap is `too-large`; a failed retry removes the earlier export;
  `claim` for A twice succeeds, for B is `claimed`; `readContextExport` returns it;
  `dropContextExport` removes it; an unclaimed one is gone after `TestClock.adjust("25 hours")`
  and `sweep`.
- `apps/server/src/cloudMove/CloudMoveHttp.test.ts` (3.20): the "answers $name" table runs for
  the context-export route too (`it.each` over the two `PUT`s), plus `content-length` over 2 MiB
  is 413 and `invalid-export` is 422.
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`: "refuses a cloud launch for
  $name before any thread or machine" (3073) gains "a context export staged by someone else"
  (`check` fails `key-in-use`: `export-unavailable`, no thread, no `claim`). New `it.effect`
  "imports a staged context export before the first message, once": a cloud launch with
  `contextExportRef` and an initial message; the imported items precede run 1's;
  `dropContextExport` ran; the same command id again claims again but writes no history. A
  local launch with `contextExport: { value, copy: true }` gets the "Copy of" row.

**Verify.** `vp test run packages/contracts/src/orchestrationV2.test.ts
apps/server/src/orchestration-v2/ContextExports.test.ts
apps/server/src/orchestration-v2/ContextHandoffService.test.ts
apps/server/src/orchestration-v2/Orchestrator.migration.test.ts
apps/server/src/orchestration-v2/http.test.ts apps/server/src/cloudMove/StagedCloudImports.test.ts
apps/server/src/cloudMove/CloudMoveHttp.test.ts
apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`; `vp run typecheck` for contracts,
server, client-runtime, web, mobile (the turn item union and the history origin changed); `vp run
check:changed`. Runtime transcript on a cloud-only dev server, link token in an env var: `curl -X
PUT --data-binary @export.json` to `/api/cloud-moves/staged/<key>/context-export?projectId=<id>`
answers 204 and `<stateDir>/cloud-moves/<key>/context-export.json` exists; a 3 MiB body answers
413; a body with `version: 2` answers 422. The import shows end to end only with a mover, so its
`test-t3-app` pass and captures (the history, the gap notice, the `from` and `to` rows on web and
desktop) run with 3.25's.

**Reviewer checks.**

- Every `=== "v1_import"` reader is either switched to `threadHasImportedHistory` or deliberately
  left (AgentSessionImporter.ts 302, which tests its own imports; AgentAwarenessRelay.ts 84, which
  reads `thread.created`, where an export's origin never appears).
- No handoff is made at import; the first run's is the V1 path's, with only the header changed.
- The import refuses a thread with any message or run, and its ids derive from the command id.
- A `to` row rides the newest kept run; a `from` row and the history are runless.
- The strict transcript never carries a `move` row; every other wire site that holds turn items
  is `ForwardCompatibleUnion` or `ForwardCompatibleUnionArray` (2211, 2220, 2923, 2932, 4264) or
  the stream's unknown-item skip (4286–4300). `getTurnItem` (4549) is only asked for ids a client
  already has.
- The staged export is decoded before it is kept, and the launch claims it before it reads it.
- Surfaces: contracts (`historyOrigin`, the turn item, the export, two internal commands), server,
  MCP (`t3_thread_read` shows the row's sentence), web and desktop (the row), mobile (the row as a
  sentence, exhaustive switches). Old clients: `historyOrigin` reads as absent (2.32) and the row
  is skipped; imported messages show as V1 imports do. Providers: none; the handoff is
  provider-neutral. Agents: no new tool. Reverse states: a moved thread is an ordinary thread
  (delete, archive); the row's link is the way back to the source. Connection modes: the row's
  Open shows only when the client is connected to the other environment. Docs: 3.26
  (`context-handoffs.md`: exports carry their own provenance).

### 3.23 `feat(contracts,shared,server,client-runtime,web): continue a local thread in cloud`

A member on their Mac picks **Continue in cloud** on a local thread, from the thread menu (header
and sidebar row) or the command palette. A dialog previews what goes: the commits ahead of
`origin/<base>` and the changed and untracked files that aren't ignored, with a checkbox per file
to leave it out, and the first message for the cloud thread. On confirm the Mac's local server
asks Pair Cloud whether it can take the move, snapshots the working tree with the checkpoint
capture code, bundles it against its merge-base with `origin/<base>`, uploads the seed and the
thread's context export over the agent link, and launches the thread on Pair Cloud as the member.
A pushed branch with nothing to upload launches as an M2 launch (`existingBranch`) plus the export.
The local thread records "Continued in cloud" and keeps its worktree and branch. Laptop agents
reach the same service method through `t3_thread_continue_in_cloud`. It is its own PR because it
joins the link (3.19), the staged seed (3.20), the seed checkout (3.21), the export (3.22) and the
laptop's move service (3.25) into the one action M3 is for.

Title: the row's `desktop` scope becomes `contracts`. Desktop wraps web and reaches its own local
server over the WebSocket it already has (08 §4), so nothing in `apps/desktop` changes; 2.24
dropped `desktop` for the same reason.

- **Needs:** 3.19 (`ResolvedPeerLink.capabilities`, `PeerLinks.agentLinks`, web `useLinkMachine`),
  3.20 (`cloudMove.ts`, `CloudStagingKey`, `cloudSeedRefs`, `CloudMoveFailure`, the seed `PUT`,
  `CloudMoveHttp.authenticateLinkMember` and `CloudMoveHttp.layer`), 3.21 (`seedRef` on the
  server's launch strategy, `seed-on-base`, `seed-unavailable`), 3.22 (`ContextExports.build`, the
  export `PUT`, `contextExportRef` on the server's launch input, the move turn item and its record
  command), 3.25 (`CloudMoves`, `CloudMoveClient`, `ThreadMoveError`, `createThreadMoveAtoms`,
  the move row's presentation). **Unblocks:** 3.24, 3.26; G3 steps 1 and 4 (the tool).
- **Files:**
  - `packages/contracts/src/cloudMove.ts` (3.20's):
    - RPC shapes `ThreadMovePreviewInput`, `ThreadMovePreview`, `ThreadMoveToCloudInput`,
      `ThreadMoveToCloudResult`; route bodies `CloudMoveCheckInput`, `CloudMoveCheckResult`,
      `CloudMoveLaunchInput`, `CloudMoveLaunchResult` (below);
      `CLOUD_MOVE_DEFAULT_MESSAGE = "Continue from where the conversation left off."`.
    - `CloudMoveFailureReason` gains `"refused"` (Pair Cloud won't take this launch; `message`
      says why) and `"branch-not-pushed"` (a seedless launch's branch is gone from origin). The
      field is `ForwardCompatibleNullable`, so older laptops read them as null.
    - 3.25's `ThreadMoveError` gains reasons `run-active`, `cloud-thread`, `no-repository`,
      `no-branch`, `no-base`, `not-on-github`, `link-failed`, `seed-too-large`, `seed-failed`,
      `upload-failed`, and reuses its `not-linked`, `unsupported` and `refused` where this page
      says `no-link`, `not-supported` and `launch-refused`. Clients show `message`
      and never branch on `reason`. `seed-failed` reads "Couldn't package this thread's changes
      for the move. Try again."; the others' text is given where they are raised.
  - `packages/contracts/src/rpc.ts`: `WS_METHODS` (439) gains `threadMovePreview:
    "threadMove.preview"` and `threadMoveToCloud: "threadMove.toCloud"` beside 3.25's
    `threadMoveToLocal`; two `Rpc.make`s next to `WsSandboxCheckDriverRpc` (1037) with error
    `Schema.Union([ThreadMoveError, EnvironmentAuthorizationError])`, added to `WsRpcGroup` (~2290).
  - `packages/contracts/src/clientRpcPermissions.ts`: `CLIENT_GUARDED_RPC_SCOPES` (19) gains
    `[WS_METHODS.threadMoveToCloud]: AuthOrchestrationOperateScope`, with "A move starts a thread
    on Pair Cloud through this server's link." Preview is a read and stays unguarded.
  - `apps/server/src/auth/RpcAuthorization.ts`: `RPC_REQUIRED_SCOPES` (41) gains
    `[WS_METHODS.threadMovePreview]: AuthOrchestrationReadScope`, next to `sandboxOverview` (91).
  - The temp-index variant of the capture:
    - `apps/server/src/vcs/VcsDriver.ts`: `VcsCaptureCheckpointInput` (14) gains `readonly
      excludePaths?: ReadonlyArray<string>`, "Left at HEAD's version: an excluded change or
      untracked file is not captured."
    - `apps/server/src/checkpointing/CheckpointStore.ts`: `CaptureCheckpointInput` (10) gains it;
      `captureCheckpoint` (94) passes it on.
    - `apps/server/src/vcs/GitVcsDriver.ts` `checkpoints.captureCheckpoint` (943): the first
      `stageFiles([])` (1233) becomes `stageFiles(excluded)`, each path as
      `:(top,literal,exclude)<path>` with a trailing `/` dropped; the nested-repository retry
      (1276) appends to `excluded` instead of replacing it. The capture already runs on a private
      temp index started from HEAD (`read-tree`), so an excluded tracked file keeps HEAD's version,
      an excluded untracked file is absent, and the user's index is untouched.
  - `apps/server/src/cloudMove/CloudMoves.ts` (3.25's): `preview` and `continueInCloud`
    (below). New dependencies: `GitVcsDriver`, `CheckpointStore`, `PeerLinks`, `ContextExports`,
    `ProjectService`, `ProviderRegistry`, `ServerEnvironment`, `ServerConfig`; add them where 3.25
    wires the layer in `server.ts` (re-read the symbol).
  - 3.25's `CloudMoveClient` (`apps/server/src/cloudMove/CloudMoveClient.ts`) gains `check`, `putSeed`,
    `putContextExport`, `launch`, each taking the `ResolvedPeerLink` and sending `Authorization:
    Bearer <token>` to `link.url`. `putSeed` sends the bundle with `HttpClientRequest.bodyFile`
    (`.repos/effect/packages/effect/src/http/HttpClientRequest.ts` 1064), which sets
    `content-length` (3.20 refuses a body without one). Every non-2xx body decodes as
    `CloudMoveFailure`. They take an object after the link (`putSeed(link, { key, projectId,
    file })`); `putContextExport` answers `{ outcome, bytes }` so the span can record
    `exportBytes`.
  - `apps/server/src/cloudMove/CloudMoveLaunch.ts` (new, Pair Cloud side): service
    `CloudMoveLaunch` with `check` and `launch`.
  - `apps/server/src/cloudMove/CloudMoveHttp.ts` (3.20's): two routes in `CloudMoveHttp.layer`'s
    `mergeAll`, `POST ${CLOUD_MOVE_ROUTE_PREFIX}/check` and `POST
    ${CLOUD_MOVE_ROUTE_PREFIX}/staged/:key/launch`. Each answers 404 off cloud-only, runs
    `authenticateLinkMember`, decodes the body (`400 bad-request`), calls one `CloudMoveLaunch`
    method, and maps a refusal to `409` with `CloudMoveFailure` (`refused`, `branch-not-pushed`,
    `unknown-project`). The layer reads `CloudMoveLaunch` when it is built, as its handlers'
    requirements would otherwise reach the top-level server context. `authenticateLinkMember` also returns the session's `label` and `access`,
    which `authenticateMcpClient` already reads; the launch needs both.
  - `packages/shared/src/sandboxCredentials.ts`: `usableCloudProviders(input)`, the "usable" rule
    `cloudAccountNotice` applies today (client-runtime `state/sandbox.ts` 167–175), moved here so
    the server can use it; and `pickCloudMoveModel(input)`.
  - `packages/client-runtime/src/state/sandbox.ts`: `cloudAccountNotice` (156) calls
    `usableCloudProviders`; no behavior change.
  - `apps/server/src/ws.ts`, beside `sandboxCheckDriver` (2913):
    `[WS_METHODS.threadMovePreview]: (input) => cloudMoves.preview(input)` and
    `[WS_METHODS.threadMoveToCloud]: (input) => cloudMoves.continueInCloud({ ...input, createdBy:
    "user", creationSource: input.creationSource ?? "web", actorId: currentSession.memberId })`.
  - `apps/server/src/mcp/toolkits/thread/tools.ts`: `ThreadContinueInCloudTool`, added to
    `ThreadToolkit` (240); `handlers.ts` (95): its handler.
  - `apps/server/src/provider/AgentContextBudget.test.ts`: `toolHandlerServices` (52) gains
    `Layer.mock(CloudMoves)({})`. `agentContextBudget.json`: `mcpToolListJsonBytes` (48110 once 3.19
    landed) set to the measured value, 48788; the PR needs the `agent-context-increase` label.
  - `evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`: two cases (Tests).
  - `packages/client-runtime/src/state/cloudTarget.ts`: `continueInCloudOffer`, and
    `isCloudImportEnvironment` beside `isCloudLaunchEnvironment` (38) (3.25's
    `resolveContinueLocally` reads the capability inline).
  - `packages/client-runtime/src/state/threadMove.ts` (3.25's `createThreadMoveAtoms`) gains
    `preview` (`createEnvironmentRpcQueryAtomFamily`, `staleTimeMs: 0`) and `toCloud`
    (`createEnvironmentRpcCommand`, `concurrency: { mode: "singleFlight", key: ({ environmentId,
    input }) => `${environmentId}:${input.threadId}` }`). Copy shared with mobile, so it names no
    control (web has checkboxes, mobile switches) and no "here" (the phone isn't the computer):
    `CONTINUE_IN_CLOUD_LABEL = "Continue in cloud"` (the dialog and sheet title and the confirm
    button; menu and palette items add "…", since they open the dialog);
    `CONTINUE_IN_CLOUD_BUSY_LABEL = "Continuing in cloud…"` (the confirm button while the move
    runs); `MOVE_STAYS_NOTE` ("Ignored files such as .env and node_modules, earlier turns' diffs,
    terminals and running processes stay behind. The project's setup script can recreate ignored
    files in the cloud."; a project may have no setup script); `MOVE_EXCLUDE_NOTE` ("A file you
    leave out goes as last committed, or not at all if it's new."); `moveNothingToUpload(branch)`
    ("Nothing to upload. The cloud thread starts from <branch> on origin."; it shows when files
    exist but are all left out, so "clean" would be wrong); `MOVE_IN_PROGRESS_NOTE` ("This thread
    is already moving to the cloud.", for `moving`).
  - `apps/web/src/state/sandbox.ts`: `readContinueInCloudOffer(threadRef)` (event time, for
    menus, as `readCloudTarget` 78) and `useContinueInCloudOffer(threadRef)` (the palette's active
    thread; a null ref subscribes to nothing, as `useCloudTarget` 66).
  - `apps/web/src/components/threadActionMenu.logic.ts`: `ThreadActionMenuId` (8) gains
    `"continue-in-cloud"`; `ThreadActionMenuState` (79) gains `readonly continueInCloud?: {
    readonly label: string | null }` (absent hides it). The item follows "Mark unread" (232),
    before the machine actions, `separatorBefore: true`, icon `cloud-upload`, labeled
    `${CONTINUE_IN_CLOUD_LABEL}…` (it opens a dialog), or `Continue in cloud (<label>)` and
    disabled when `label` is set (the offer's short `label`, never its sentence `reason`), as "Delete (owner or admin only)" does. It stays out of
    `threadActionRequiresOperate`'s exempt list (132), so a read-only connection sees it
    disabled.
  - `apps/web/src/hooks/useThreadActionMenu.ts` (147, 206) and `apps/web/src/components/Sidebar.tsx`
    `handleThreadContextMenu` (2730, 2787): pass `continueInCloud` from
    `readContinueInCloudOffer`; the action calls `openContinueInCloudDialog(threadRef)`.
  - `apps/web/src/components/CommandPalette.tsx`, the `activeThread !== null` block (1520): item
    `action:continue-in-cloud`, `${CONTINUE_IN_CLOUD_LABEL}…` (as "Assign thread to…"), search
    terms `["continue", "cloud", "move", "send", "pair cloud", "machine"]`, `CloudUploadIcon`,
    disabled with `description: reason` when the offer says why, absent when it is hidden.
  - `apps/web/src/components/sandbox/ContinueInCloudDialog.tsx` (new): `openContinueInCloudDialog`
    and `ContinueInCloudDialogHost` on a keep-alive atom, as `AssignThreadDialog.tsx` (25–44); the
    host mounts in `routes/__root.tsx` beside `<AssignThreadDialogHost />` (222).
- **Types and services:**
  - Contracts:
    ```ts
    ThreadMovePreviewInput = { threadId: ThreadId; cloudEnvironmentId: EnvironmentId }
    ThreadMovePreview = {
      branch: TrimmedNonEmptyString;                 // the checkout's branch
      baseRef: TrimmedNonEmptyString;                // without "origin/"
      pushed: boolean;                               // origin/<branch> is at the local tip
      commits: Array<{ sha: string; subject: string }>; commitsTruncated: boolean;
      files: Array<{ path: GitFilePath; insertions: NonNegativeInt; deletions: NonNegativeInt }>;
      filesTruncated: boolean;                       // past 2,000 entries
      link: { status: "linked" } | { status: "missing" | "expired"; message: string };
      moving: boolean;                               // this thread's move is running
    }
    ThreadMoveToCloudInput = { threadId; cloudEnvironmentId; cloudProjectId: ProjectId;
      excludePaths: Array<TrimmedNonEmptyString> (max 1,000);
      message: TrimmedNonEmptyString (max 120,000);
      creationSource: optionalKey(Literals(["web", "mobile"])) }
    ThreadMoveToCloudResult = { cloudThread: ScopedThreadRef; seeded: boolean }
    CloudMoveCheckInput = { projectId: optionalKey(ProjectId); originKey: TrimmedNonEmptyString;
      model: { driver: ProviderDriverKind; model: TrimmedNonEmptyString } }
    CloudMoveCheckResult = { projectId: ProjectId; modelSelection: ModelSelection }
    CloudMoveLaunchInput = { projectId; modelSelection; title; baseRef;
      branch: optionalKey; existingBranch: optionalKey(Literal(true)); seeded: boolean;
      runtimeMode; interactionMode; message: TrimmedNonEmptyString;
      createdBy: Literals(["user", "agent"]); creationSource: OrchestrationV2CreationSource }
    CloudMoveLaunchResult = { threadId: ThreadId }
    ```
  - `CloudMoves.preview(input)` on the local server: the shell
    (`ThreadManagementService.getThreadShell`) and `cwd = shell.worktreePath ??
    project.workspaceRoot`; `GitVcsDriver.statusDetailsLocal(cwd)` for `branch`, `upstreamRef`,
    `aheadCount` and `workingTree.files` (tracked changes with counts, an untracked directory
    once, as `build/`); the base (below); `GitVcsDriver.getReviewBranchCommits({ cwd, baseRef:
    "origin/<base>" })` for the commits (merge-base to HEAD, at most 100, `truncated`); the link
    from `PeerLinks.get(cloudEnvironmentId)` with no network: none is "Link <this environment's
    label> to <label> first." (any client may show it, so not "this machine", which Cloud uses
    for its machines), past `expiresAt` is "The link to <label> expired. Link it again." `pushed`
    is `upstreamRef === "origin/<branch>" && aheadCount === 0`. Fails `no-repository` ("This
    thread's folder isn't a Git repository."), `no-branch` ("This thread isn't on a branch. Check
    one out, then try again."), `no-base`. 3.19 drops the Labs gate for agent links, so there is
    no "off" state.
  - The base: `GitVcsDriver.readBranchBase(cwd, branch)` without `origin/` when
    `refs/remotes/origin/<it>` exists, else `resolveDefaultBranchName(cwd, "origin")`, else
    `no-base` ("Can't find origin's default branch on this computer. Fetch origin, then try
    again.").
  - `CloudMoves.continueInCloud(input: { threadId; cloudEnvironmentId?; cloudProjectId?;
    excludePaths; message; createdBy: "user" | "agent"; creationSource; allowRunId?: RunId }) =>
    Effect<ThreadMoveToCloudResult, ThreadMoveError>`, span `CloudMoves.continueInCloud`:
    1. **One move per thread.** A call for a thread whose move is running joins it
       (`SynchronizedRef<Map<ThreadId, Deferred>>`). The move is forked into the service's scope,
       so a client that disconnects (a phone sent to the background) doesn't stop it.
    2. **Refusals before any work.** Unknown or deleted thread; a cloud-only server or a shell
       with `sandboxId` (`cloud-thread`: "This thread already runs in the cloud."); `activeRunId
       !== null && activeRunId !== allowRunId` (`run-active`: "Wait for the turn to end, or stop
       it."); `no-repository`, `no-branch`, `no-base` as for `preview`; the project's
       `repositoryGroupingKeyOf(repositoryIdentity)` not under `github.com/` (`not-on-github`,
       with client-runtime's text: "Cloud needs this project's origin on github.com.").
    3. **The link.** `PeerLinks.resolve(cloudEnvironmentId)`; a `PeerLinkError` becomes `not-linked`
       (`unknown_link`, the preview's "Link … first." text) or `link-failed` with its message;
       `capabilities.cloudImport !== true` is `unsupported` ("<label> needs an update to move
       threads. Ask an admin."; a member can't update Pair Cloud). Without
       `cloudEnvironmentId` (the tool): `PeerLinks.agentLinks`, each resolved, those reporting
       `cloudImport`; one is used, none is `not-linked` ("No Pair Cloud is linked here. Link one in
       Settings → Environments."), several is `not-linked` naming them ("More than one Pair Cloud is
       linked here: <labels>. Pass cloudEnvironmentId.").
    4. **The key.** `n` = the thread's `move` items with `direction: "to"`
       (`getThreadRecords(threadId, ["turnItems"])`). The `CloudStagingKey` is `mv_` plus the
       first 32 hex digits of sha256(`<this environment id>\0<threadId>\0<n>`). A retry before the
       move is recorded, after a restart too, gets the same key; the next move a new one.
    5. **Check before any upload.** `client.check(link, { projectId: cloudProjectId, originKey,
       model })`; `model` is the shell's `modelSelection.model` and its instance's driver (the
       provider's `driver`, else the stored instance's, else the id, as `cloudModelDisabledReason`
       does). A refusal is `refused` with Pair Cloud's `message`. Nothing is written yet.
    6. **Seed or not.** Seedless when `pushed` and every changed file is in `excludePaths`.
       `defaultBranch = resolveDefaultBranchName(cwd, "origin")`. The launch's `branch`: none when
       seedless on the base (M2's fresh launch, as `routedCloudLaunch` does); the local branch
       when seedless elsewhere (`existingBranch: true`) or seeded on another branch; when seeded
       and the branch is the base or `defaultBranch`, `t3/<the key's first 8 hex>` (shared/git.ts
       103's shape), since 3.21 refuses a seed there (`seed-on-base`).
    7. **The seed**, on `cloudSeedRefs(key)` as temporary refs here:
       - `CheckpointStore.captureCheckpoint({ cwd, checkpointRef: cloudSeedRefs(key).snapshot,
         excludePaths })`; its commit's parent is HEAD (GitVcsDriver.ts 1316).
       - `update-ref cloudSeedRefs(key).branch <snapshot>^` through `GitVcsDriver.execute` (as
         PullRequestReviewGuideService.ts 433), so the branch ref is the snapshot's own parent
         even if HEAD moved, which is what 3.20 checks.
       - `mergeBase = git merge-base refs/remotes/origin/<base> <snapshot>^`; none means full
         history. When the branch tip is the merge-base (no commits past the base), the
         prerequisites are its parents (`<mergeBase>^@`; none for a root commit): `git bundle
         create` silently drops a ref whose tip a prerequisite reaches (checked with git 2.43),
         and 3.20 refuses a bundle without both refs.
       - `git bundle create <stateDir>/cloud-move-seeds/<key>.bundle <branch ref> <snapshot ref>
         ^<prerequisite>…` to a file, not `-`: `execute` collects stdout as text. Over
         `CLOUD_SEED_MAX_BYTES` is `seed-too-large` before any upload ("The upload would be <n> MB,
         over Pair Cloud's 512 MB limit. Leave out large untracked files, or push <branch>
         first.").
       - `client.putSeed(link, { key, projectId, file })`. `409 missing-prerequisite`: rebuild with no
         prerequisite, put again under the same key, once (`fullHistory`). `409 claimed`: a
         launch already took this key, so skip the export and go to the launch, which replays.
         `413`: `seed-too-large`. Other failures: `upload-failed` with the message. Upload time
         is `Clock` around each `putSeed`.
       - Both temp refs and the file are removed in `Effect.ensuring`; the layer clears
         `<stateDir>/cloud-move-seeds/` at start (not on a cloud-only server).
    8. **The export.** `ContextExports.build(threadId)`, then `client.putContextExport(link,
       { key, projectId, value })`; `409 claimed` goes to the launch as above.
    9. **Launch.** `client.launch(link, { key, body: { projectId, modelSelection (from the check), title:
       shell.title, baseRef: base, branch?, existingBranch?, seeded, runtimeMode,
       interactionMode (the shell's), message, createdBy, creationSource } })`. The export carries
       the provenance, so the launch names no source thread. A seedless launch refused `branch-not-pushed` (origin lost the branch) runs step 7
       once and launches seeded.
    10. **Record.** `threads.dispatch` of 3.22's `thread.move.record` with `commandId:
        cloud-move:<key>:local`, `to: { environmentId: cloudEnvironmentId, threadId }` and
        `message: "Continued in cloud on <Pair Cloud label>"`. A replayed key is a no-op through
        its receipt. The cloud thread's `from` row comes from 3.22's import of the export.
    11. **Measure.** The span gets `cloudMove.key`, `.outcome` (`launched`, or the failure
        reason), `.seeded`, `.fullHistory`, `.seedBytes`, `.exportBytes`, `.uploadMs`,
        `.totalMs`; the same fields go out once in `Effect.logInfo("cloud move", …)`. The span is
        one line in `<stateDir>/logs/server.trace.ndjson`. G3 reads it for seed size and upload
        time, and for 01 §9's 95%: moves whose last outcome is `launched`.
  - `CloudMoveLaunch.check({ memberId, input })` on Pair Cloud:
    - The project: `input.projectId` when its origin key matches `originKey` case-insensitively;
      else the oldest unarchived project with that key from `ProjectService.snapshot` (the rule
      of cloudTarget.ts 90–104); else `unknown-project` ("Add <owner/name> to Pair Cloud first.").
    - The model: `pickCloudMoveModel` over `ProviderRegistry.getProviders`; none is `refused`
      ("Add an account on Pair Cloud, on your row in Settings → Team.").
    - `ThreadLaunchService.checkCloudLaunch({ projectId, instanceId })`: a `CloudLaunchError` or
      `ProviderCloud*Error` is `refused` with its message.
  - `CloudMoveLaunch.launch({ key, session, input })` builds `ThreadLaunchInput` itself:
    ```ts
    {
      commandId: CommandId.make(`cloud-move:${key}`),   // a resent launch replays
      projectId, title, modelSelection, interactionMode,
      runtimeMode: atMost(input.runtimeMode, session.access),
      workspaceStrategy: { type: "cloud", baseRef, branch?, existingBranch?,
        ...(input.seeded ? { seedRef: key } : {}) },   // 3.21's server-side field
      contextExportRef: key,                            // 3.22's server-side field
      initialMessage: { text: input.message, attachments: [] },
      createdBy, creationSource,
      actorId: session.memberId, ownerId: session.memberId, // 3.21's claim checks the actor
      linkOrigin: { sessionId, label, access },          // as a launch through this session (3.19)
    }
    ```
    `ThreadLaunchService.launch` does the seed's `check` and `claim` (3.21) and the export's
    (3.22). A `CloudLaunchError` `branch-not-pushed` maps to `branch-not-pushed`; any other refusal
    (3.21's `seed-on-base`, `seed-unavailable`) to `refused` with `failureDetail`'s message.
    Returns `{ threadId }`. The route records nothing itself: the launch imports the export
    before the initial message (3.22), and that import writes the new thread's `from` row.
  - `pickCloudMoveModel({ settings, providers, memberId, preferred: { driver, model } })`: among
    `usableCloudProviders` (enabled, installed, the member's own or no one's, not "Local only"),
    the member's own before a team instance at each step: an instance of `driver` listing `model`
    (`models[].slug`); an instance of `driver` with its default model (`isDefault`, else the first
    non-legacy); any usable instance with its default; else null.
  - `continueInCloudOffer({ thread: { environmentId, sandboxId?, runActive, originKey }, cloud:
    CloudTarget, importsTo })` (a target in the thread's own environment means it runs on Pair
    Cloud; `originKey` names the repository in "Add <owner/name> …"):
    hidden for a cloud thread, a thread whose environment reports `cloudLaunch`, `cloud.kind ===
    "hidden"`, or no target that imports; disabled with a short `label` for the menu suffix and a
    sentence `reason` for the palette description and tooltip, as `resolveContinueLocally` has:
    `unavailable` ("Pair Cloud unavailable" / its message), a running turn ("a turn is running" /
    "A turn is running. Continue in cloud once it ends."), or no target that can take it ("not
    available" / the first target's `disabledReason`, or "Add <owner/name> to <label> first."); else `{ kind: "ready", targets }`,
    those with a project, no `disabledReason`, and `importsTo`.
  - **The dialog.** Titled `CONTINUE_IN_CLOUD_LABEL`. A Pair Cloud picker when there are several
    targets; "feature/login from main"; the commits ("and more" when truncated); the files, each
    checked ("and more" when `filesTruncated`); `MOVE_EXCLUDE_NOTE` and `MOVE_STAYS_NOTE`;
    `moveNothingToUpload` when `pushed` and every file is unchecked; a **First message** field
    prefilled with `CLOUD_MOVE_DEFAULT_MESSAGE`. Notices:
    - no link or an expired one: the message and **Link**, which runs 3.19's
      `useLinkMachine(threadRef.environmentId)` for the Pair Cloud machine with an access picker
      (`LinkAccessPicker`, default Supervised, with the note "Threads you move there start with
      at most this access, and agents here never get more."; the launch caps the cloud thread's
      mode at the link's access), then refetches the preview;
    - `cloudAccountNotice` of the target (`cloudAccountNoticeAtom`, web state/sandbox.ts 25) with
      **Open Settings** to Pair Cloud's Settings → Team, as `cloudAccountBanner.tsx` does;
    - a running turn: "A turn is running. Continue in cloud once it ends.";
    - `moving`: `MOVE_IN_PROGRESS_NOTE`.
      A link notice, a `provider` notice, a running turn or an empty message disable **Continue in
      cloud**; a `github` notice only warns, as in M2. While the move runs, and while `moving`, the
      button reads `CONTINUE_IN_CLOUD_BUSY_LABEL`; a move can take minutes, so the button is the
      visible state. Success: toast "Continued in cloud on <label>" (the local row's words),
      close, and navigate to `/$environmentId/$threadId` with `buildThreadRouteParams`
      (threadRoutes.ts 58). Failure: a toast "Could not continue in cloud" with the message (the
      phone's alert title, and the product's "Could not …" failure titles); the dialog stays, and
      a retry reuses the key.
  - **The tool.**
    ```ts
    Tool.make("t3_thread_continue_in_cloud", {
      ...commandTool,
      description:
        "Move a thread on this computer to Pair Cloud: a new cloud thread gets its branch, unpushed commits, uncommitted and untracked files (not ignored ones) and the conversation, and keeps running when this computer sleeps. Nothing is pushed to GitHub. Omit `threadId` for this thread, then end your turn without more edits. Not for another thread with a turn running. `message`: the cloud thread's first prompt.",
      parameters: Schema.Struct({
        threadId: Schema.optional(ThreadId),
        cloudEnvironmentId: Schema.optional(
          EnvironmentId.annotate({
            description: "The Pair Cloud, from t3_environment_links. Omit when one is linked.",
          }),
        ),
        excludePaths: Schema.optional(
          Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
        ),
        message: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120000))),
      }),
      success: Schema.Struct({
        threadId: ThreadId,
        environmentId: EnvironmentId,
        link: Schema.optional(Schema.String),
        seeded: Schema.Boolean,
      }),
      dependencies: [...commandTool.dependencies, CloudMoves.CloudMoves],
    })
      .annotate(Tool.Destructive, true)
      .annotate(Tool.OpenWorld, true)
      .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileLinksOff);
    ```
    No `environmentId`, so `takesLinkedEnvironment` (McpToolAccess.ts 363) keeps it here.
    `hiddenWhileLinksOff` shows it once an agent link exists (3.19 widens `linkedEnvironments`).
    The handler is `McpToolAccess.writesThreads((p) => [p.threadId], …)` (176), so the caller's
    mode limits cover the moved thread's modes, and first `assertNotLinked(caller, "move a thread
    to another environment")` (linkOrigin.ts). It calls `continueInCloud` with `createdBy:
    "agent"`, `creationSource: "mcp"`, `message ?? CLOUD_MOVE_DEFAULT_MESSAGE`, and `allowRunId` =
    the caller's active run when the target is its own thread; `link` is `threadLinkFor({
    environmentId: cloudEnvironmentId, client: scope.client }, threadId)`; `actorId` is the
    member the run acts for (`sendActorId`, as `t3_queue`). A `ThreadMoveError` is
    `OrchestratorMcpFailure` `orchestration_error` with its message.
- **Commands and events:** none new. Each side records 3.22's move item; Pair Cloud launches
  through `ThreadLaunchService.launch` (`thread.create`, the claims, `sandbox.provision`,
  `message.dispatch`).
- **Migrations:** none.
- **Proposed gap answers.**
  - **The key is derived, not random.** Deriving it from the
    environment, the thread and the count of its moves keeps it across a restart with nothing
    stored, which makes `409 claimed` and the launch replay recover a move whose local record
    failed. Overruled: random per move, kept in memory until the move is recorded; a restart then
    starts a new key and 3.20's sweep drops the old seed.
  - **No keybinding.** 08 §4 lists none, and 1.39 gave Wake, Sleep now, Retry and Discard none;
    the palette reaches it from the keyboard. Overruled: `thread.continueInCloud` in
    `THREAD_KEYBINDING_COMMANDS` (keybindings.ts 37) with no default, a label in
    KeybindingsSettings.logic.ts (378), a handler in useThreadLifecycle.tsx (695), `shortcutCommand`
    on the palette item, a line in keybindings.md.
  - **An agent may move its own thread mid-turn.** Its run is the one calling the tool, so the
    tree holds still while the snapshot is taken, and the description tells it to stop editing.
    Overruled: drop `allowRunId`; agents move only other, settled threads.
  - **Every move launches with a message** (proposed; it also covers 2.13's skip of
    message-less cloud threads if 3.21's fix is dropped). The dialog prefills one.
  - **Pair Cloud picks the model** from the local thread's driver and model, since the Mac's
    instance ids don't exist there (08 §4). The dialog has no model picker; the composer on the
    cloud thread changes it for the next turn.
  - **No CLI.** `t3 thread` stays launch-only; a terminal agent uses the MCP tool.

**Tests.**

- `apps/server/src/vcs/GitVcsDriver.test.ts`: new `it.effect` beside "checkpoint capture skips
  untracked nested repositories without a commit" (161), "checkpoint capture leaves excluded paths
  at HEAD's version": a modified tracked file, an untracked file, an untracked `dir/` and an unborn
  nested repository; exclude the first and `dir/`. The ref has HEAD's content for the first, no
  `dir/` entries, the other untracked file and no nested entry; the user's index bytes are
  unchanged.
- `apps/server/src/cloudMove/CloudMoves.test.ts` (3.25's harness: a bare origin and a clone, a
  fake route client recording calls, fake `PeerLinks` and `ContextExports`, a thread shell):
  - "previews commits ahead of origin's base and changed files, and leaves out ignored ones":
    `feature` two commits past `origin/main`, a modified file, an untracked file, `.env` ignored;
    both commits and both files, not `.env`; `pushed` false; the link `missing`, then `linked`.
  - "moves unpushed work as the two staged refs against the merge-base": calls go check →
    putSeed → putContextExport → launch; `git bundle list-heads` shows exactly
    `cloudSeedRefs(key)`; `git bundle verify` passes in a fresh clone of origin; fetched, the
    branch ref is the snapshot's parent and the local tip, and the snapshot's tree has the
    untracked file and not the excluded one; the launch body has `seeded: true`, `branch:
    "feature"`; one move item, `direction: "to"`; no `refs/t3/staged/` ref and no bundle file remain.
  - "a branch with no commits past the base keeps its branch ref": the branch at `origin/main`
    with an edit; both refs are in the bundle and it verifies in a clone of origin. Fails with
    `^<mergeBase>` alone.
  - "renames a seed on the base branch": dirty `main`; the launch's `branch` is `t3/<hex>` from
    the key; seedless on `main` sends no `branch`.
  - "launches a pushed, clean branch without a seed": no putSeed; `existingBranch: true`,
    `seeded: false`; with every changed file excluded, the same.
  - "resends full history on a missing prerequisite": the fake's first putSeed answers `409
    missing-prerequisite`; the second bundle `verify`s with no prerequisites; same key; the span
    has `fullHistory: true`.
  - "resends only the launch once a key is claimed": putSeed answers `409 claimed`; no export
    upload; the launch is sent and the move recorded.
  - "falls back to a seed when origin lost the branch": the fake refuses the seedless launch
    `branch-not-pushed`; one putSeed, then a seeded launch.
  - "asks Pair Cloud before uploading anything": the check is refused; no putSeed, no export, no
    launch, no temp ref.
  - "refuses a running thread, except the calling agent's own run".
  - "a retry reuses its key and the next move gets a new one".
  - "a second call joins the move in flight": two calls, one set of route calls (a `Deferred`
    holds the fake launch), one result.
  - "records seed size and upload time on the span": `seedBytes` is the file's size, `uploadMs`
    the `TestClock.adjust` inside the fake putSeed.
- `apps/server/src/cloudMove/CloudMoveLaunch.test.ts` (new): "launches a move as the link's
  member at most at the link's access" (a fake `ThreadLaunchService` gets `commandId:
  cloud-move:<key>`, `seedRef` and `contextExportRef` = key, actor and owner the member, the
  initial message, `full-access` capped at the session's `auto`; no record command is
  dispatched, since the import writes the `from` row); "maps branch-not-pushed and other refusals"; "check finds the project by origin key and
  refuses one Pair Cloud lacks".
- `apps/server/src/cloudMove/CloudMoveHttp.test.ts` (3.20's table "answers $name"): rows for the
  two routes: 404 off cloud-only, 401 without a bearer, 403 for an API token, 400 for a bad body,
  409 `refused` with a body that decodes as `CloudMoveFailure`, and 200 with the result.
- `packages/shared/src/sandboxCredentials.test.ts`: new `describe("pickCloudMoveModel")`
  `it.each`: same driver and model; the driver's default when the model is gone; own before team;
  another member's instance never; a Local-only instance never; nothing usable is null.
- `packages/client-runtime/src/state/cloudTarget.test.ts`: new `describe("continueInCloudOffer")`
  `it.each` with the file's fixtures (14–71): ready on a matching local project; hidden for a
  cloud thread, a thread on Pair Cloud, no Pair Cloud, a Pair Cloud that doesn't import; disabled
  for a running turn, offline, no matching project, a non-GitHub origin.
- `packages/client-runtime/src/state/sandbox.test.ts`: "says what to connect when $name" (233)
  stays as is and covers the moved `usableCloudProviders`.
- `packages/client-runtime/src/state/commandPermissions.test.ts`: `WS_METHODS.threadMoveToCloud`
  joins "uses the target grant for both availability and execution of %s" (186).
- `apps/server/src/auth/RpcAuthorization.test.ts`: extend "lets members read Cloud's overview and
  hold a viewer lease…" (110), renamed to name moves: members hold preview's read scope and
  `threadMoveToCloud`'s operate scope; `clientRpcRequiredScopes(threadMoveToCloud, {})` is
  `[AuthOrchestrationOperateScope]`.
- `apps/web/src/components/threadActionMenu.logic.test.ts`: extend "disables archive and turning
  into a project while the thread is running" (69) with `continueInCloud: { label: "a turn is
  running" }`: disabled, labeled "Continue in cloud (a turn is running)".
- Evals, `evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`, with `setup.linkedEnvironments: true`
  and `t3_environment_links` mocked with one Pair Cloud:
  - `cloud-move-unpushed-work` (`bad`; source 01 J9, 08 §6, Pair Cloud 3.23): on
    `feature/invoice-rounding` with two unpushed commits and an edit, "I'm closing my laptop.
    Move this thread to Pair Cloud so it keeps going." Expects `t3_thread_continue_in_cloud`
    without `threadId`; `shellMustNot` `git push`; `callsMustNot` `t3_thread_launch` with
    `workspaceStrategy.type: "cloud"`. Fails on main's text, which has no tool.
  - `cloud-move-new-task-control` (`control`): "Start a cloud thread that bumps lodash from main."
    `notCalls: ["t3_thread_continue_in_cloud"]`.

**Verify.** `vp test run apps/server/src/vcs/GitVcsDriver.test.ts
apps/server/src/cloudMove/CloudMoves.test.ts apps/server/src/cloudMove/CloudMoveLaunch.test.ts
apps/server/src/cloudMove/CloudMoveHttp.test.ts apps/server/src/auth/RpcAuthorization.test.ts
apps/server/src/provider/AgentContextBudget.test.ts packages/shared/src/sandboxCredentials.test.ts
packages/client-runtime/src/state/cloudTarget.test.ts packages/client-runtime/src/state/sandbox.test.ts
packages/client-runtime/src/state/commandPermissions.test.ts
apps/web/src/components/threadActionMenu.logic.test.ts`; `vp run typecheck` for contracts, shared,
client-runtime, server, web, mobile; `vp run check:changed`. Evals from `evals/`: `pnpm
mcp-tool-use --cases mcp-tool-use/cases/threads-vs-tasks.ndjson --case
cloud-move-unpushed-work,cloud-move-new-task-control --samples 3 --out runs/cloud-move` on main's
text and on this branch, Sonnet and Opus, then one full `threads-vs-tasks` run per model. The
primary agent's `test-t3-app` pass (the integrated pass's step 1): a desktop dev server linked to a cloud-only dev
server; the menu, the palette and the dialog on a thread with unpushed commits, an edit and an
untracked file; uncheck one; the cloud thread has the commits, the edit and not the unchecked
file, with read-only history; the local thread shows "Continued in cloud" linking to it; a running
turn disables the item with its reason; no link shows **Link**. Captures of the dialog and the
row.

**Reviewer checks.**

- Nothing reaches Pair Cloud before its check passes, and nothing is pushed to GitHub.
- The bundle carries exactly `cloudSeedRefs(key)`, the branch ref is the snapshot's parent, and
  both temp refs and the file go on every exit; the size is checked before the upload.
- A retry before the move is recorded reuses the key; the route calls and both record commands are
  idempotent under it.
- The cloud thread's modes never exceed the local thread's or the link session's access.
- The RPC handler, both routes and the tool each call one service method; `seedRef` and
  `contextExportRef` appear in no wire or model-facing schema.
- `excludePaths` reach git only as `:(top,literal,exclude)` pathspecs.
- Surfaces:
  - Entry points: header thread menu, sidebar row menu, command palette; no keybinding (above),
    no Settings entry.
  - Clients: web and desktop here; mobile in 3.24.
  - Providers: none; Pair Cloud picks the instance.
  - Agents: `t3_thread_continue_in_cloud`, with evals and budget.
  - Contracts: the RPCs, the route bodies, the new failure reasons.
  - Reverse states: Continue locally (3.25) on the cloud thread; the move row on both threads.
  - Connection modes: the client reaches its local server as usual; the local server reaches Pair
    Cloud over the link's address; Pair Cloud never calls the laptop. Two Pair Clouds give a
    picker.
  - Docs: 3.26.

### 3.24 `feat(mobile): continue a Mac thread in cloud`

On a phone paired with a member's Mac and with Pair Cloud, a thread on the Mac offers **Continue in
cloud**, and the preview opens as a sheet: the commits and files that go, a switch per file, the
first message, and the same notices as the desktop dialog. The Mac's local server does the git work
and the uploads, so the phone only drives 3.23's `threadMove.preview` and `threadMove.toCloud` on
the Mac's environment, then selects the new cloud thread. Continue locally stays desktop: a phone
has no local server. It is its own PR because mobile has its own navigation and entry points, and
the shared logic it needs landed with 3.23.

The row's scope names the thread sheet, `ThreadSettingsSheet.tsx`. That sheet is the model picker
(`ThreadSettingsMainContent`, ThreadSettingsSheet.tsx 941: providers, models, options, runtime
mode). 1.41 put a thread's actions in the header's **Machine** and **Team** menus
(ThreadRouteScreen.tsx 518–541, ThreadHeader.tsx 113) and in the thread row's menu
(thread-list-v2-items.tsx 955–978), so Continue in cloud goes there (**proposed**). Overruled (it
must be in the picker sheet): a row under its options item (`ThreadSettingsOptionsItem`, 841),
with the header and row entries dropped.

- **Needs:** 3.23 (the RPCs, `createThreadMoveAtoms`' `preview` and `toCloud`,
  `continueInCloudOffer`, `isCloudImportEnvironment`, the shared copy and
  `CLOUD_MOVE_DEFAULT_MESSAGE`). **Unblocks:** G3 step 5.
- **Files:**
  - `apps/mobile/src/state/sandbox.ts`:
    - `threadMoveEnvironment = createThreadMoveAtoms(connectionAtomRuntime)` beside
      `sandboxEnvironment` (35); 3.25 binds it on web only.
    - `continueInCloudOfferFamily`: an `Atom.family` by thread key over the thread's shell
      (`environmentThreadShells.quietThreadShellAtom`), `environmentProjects.projectsAtom` and
      `environmentPresentations.presentationsAtom` (the same atoms web reads), mapped through
      client-runtime's `resolveContinueInCloud`, with `Atom.withEquality(sameContinueInCloudOffer)`.
      A thread already on a machine returns before reading either, so a cloud row subscribes to
      nothing else. Thread rows each read it, so a row re-renders only when its own offer
      changes.
    - `useContinueInCloudOffer(threadRef)`, a null ref subscribing to nothing, as
      `useSandboxThreadMachine` (77) does.
  - `apps/mobile/src/features/threads/thread-machine-menu.ts`: `buildThreadCloudHeaderMenu(offer,
    open)` returns null for a hidden offer, else `{ title: "Cloud", icon: "icloud.and.arrow.up",
    items: [{ id: "continue-in-cloud", title: `${CONTINUE_IN_CLOUD_LABEL}…`, icon:
    "icloud.and.arrow.up", ...(reason ? { disabled: true, subtitle: reason } : {}), onPress: open
    }] }`, the shape `buildThreadMachineHeaderMenu` returns (disabled with a subtitle, as its
    owner-only items are).
  - `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`: beside `machineHeaderMenu` (531), a
    `cloudHeaderMenu` built when `threadMachine === null`; pass `machineMenu={machineHeaderMenu ??
    cloudHeaderMenu}` (1024). A Mac thread has no machine, so the slot is free, and
    `useThreadHeaderOptions` (61, 74) and `ThreadHeader` (113) render it on iOS and Android
    unchanged.
  - `apps/mobile/src/features/threads/thread-list-v2-items.tsx`: in `menuActions` (955), after
    the `new-thread-on-branch` entry, `{ id: "continue-in-cloud", title:
    CONTINUE_IN_CLOUD_LABEL + "…", image: "icloud.and.arrow.up", ...(reason ? { attributes: {
    disabled: true }, subtitle: reason } : {}) }` (the header menu's label) when the offer isn't
    hidden (the row reads
    `useContinueInCloudOffer`, beside `useSandboxThreadMachine` at 802, and joins the `useMemo`'s
    dependencies); `handleMenuAction` (1053) opens the sheet on `"continue-in-cloud"`.
  - `packages/client-runtime/src/state/cloudTarget.ts`: `resolveContinueInCloud` (a shell, the
    projects and the presentations to an offer, which web's `useContinueInCloudOffer` now calls
    too), `cloudTargetEnvironments` (presentations to `resolveCloudTarget`'s environments) and
    `sameContinueInCloudOffer`. They are here so the shell-to-offer mapping isn't written twice.
  - `apps/mobile/src/components/ui/AppSymbol.tsx`: `icloud.and.arrow.up` maps to Tabler's
    `IconCloudUpload` on Android.
  - `apps/mobile/src/features/threads/ContinueInCloudSheet.tsx` (new, under `features/threads`,
    never `features/cloud`, which is T3 Connect). Params `{ environmentId, threadId }`. It reads
    the thread from `useThreadSelection` (as `ThreadPullRequestsSheet` does), the offer, and the
    preview (`useEnvironmentQuery(threadMoveEnvironment.preview({ environmentId, input: { threadId,
    cloudEnvironmentId } }))`). Titled `CONTINUE_IN_CLOUD_LABEL`. Content, top to bottom:
    - a Pair Cloud row with a menu when the offer has several targets (the targets the offer
      last listed, as web's dialog keeps its snapshot, so a turn starting doesn't empty it);
    - "<branch> from <base>", the commits, then the files with a `Switch` each (on = goes);
    - `MOVE_EXCLUDE_NOTE`, `MOVE_STAYS_NOTE`, and `moveNothingToUpload(branch)` when `pushed`
      and every switch is off;
    - **First message**, a multiline input prefilled with `CLOUD_MOVE_DEFAULT_MESSAGE`;
    - notices: the link message, the phone's own since it can't make the Mac's link, naming the
      thread's environment by its label rather than "Mac" ("On <computer label>, link <label> in
      Settings → Environments."; expired: "The link to <label> expired. On <computer label>,
      link it again in Settings → Environments."), `useCloudAccountNotice(cloudEnvironmentId)`
      (state/sandbox.ts 50) with **Open Settings** → `openSettings(navigation, "SettingsTeam")` as
      NewTaskDraftScreen.tsx 1067 does, a running turn (web's text), and `moving`
      (`MOVE_IN_PROGRESS_NOTE`);
    - the confirm button, `CONTINUE_IN_CLOUD_LABEL`, `CONTINUE_IN_CLOUD_BUSY_LABEL` while the move
      runs or `moving`, disabled under web's rules except that a move already
      running on the Mac (`preview.moving`, after a reconnect) leaves it enabled: pressing it
      joins that move, so the phone can still reach the new thread. It runs
      `useAtomCommand(threadMoveEnvironment.toCloud)` with `creationSource: "mobile"` on the Mac's
      environment.
      Success: `useSelectWorkspaceDetail()` selects `{ name: "Thread", params: {
      environmentId: String(cloudThread.environmentId), threadId: String(cloudThread.threadId) } }`
      (as ReviewSheet.tsx 553–556), which replaces the sheet. Failure: `Dialog.alert("Could not
      continue in cloud", message)`; the sheet stays for a retry.
  - `apps/mobile/src/Stack.tsx`: a `ThreadContinueInCloud` route beside `ThreadPullRequests`
    (917), `screen: ContinueInCloudSheet`, `HORIZONTAL_FORM_SHEET_OPTIONS`, `sheetAllowedDetents:
    formSheetDetents(0.6, 0.95)`, `sheetGrabberVisible: true`; on iOS
    `SHEET_GLASS_HEADER_OPTIONS`, as `ThreadPullRequests`; no `linking` path (a sheet that
    needs a loaded thread and a live preview isn't a link target). The header menu and the row menu open it
    with `navigation.navigate("ThreadContinueInCloud", { environmentId, threadId })`: a sheet
    drilled into from the page, which mobile-navigation.md allows (`navigate` is refused only for
    `Thread` and `PullRequest`).
- **Types and services:** `threadMoveEnvironment`, `useContinueInCloudOffer`,
  `buildThreadCloudHeaderMenu`, the `ThreadContinueInCloud` route, and the three client-runtime
  helpers above. No server or contract change.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - **Where it lives**, above.
  - **The move survives the phone.** 3.23's service forks the move on the Mac and a second call
    joins it, so locking the phone mid-upload doesn't stop it. The sheet shows `moving` from the
    preview after a reconnect and its button then joins the running move.
  - **No inline link.** Linking writes the Mac's settings and mints a code on Pair Cloud; 3.19
    keeps that on the Mac's client.

**Tests.** Two cases in client-runtime `cloudTarget.test.ts`: `resolveContinueInCloud` (the
project lookup and the running turn) and `sameContinueInCloudOffer`, whose equality decides when a
row re-renders. The offer, the copy and the RPCs are tested where they live (3.23: `cloudTarget.test.ts`,
server `CloudMoves.test.ts`). The header and row menu builders map an offer to items with no logic
of their own (AGENTS: no tests for callback wiring).

**Verify.** `vp run typecheck` for mobile; `vp run check:changed`. The primary agent's
`test-t3-mobile` pass (the integrated pass's step 5) on iOS and Android, with the phone paired to the Mac's dev server and the
cloud-only dev server:

- a Mac thread with unpushed commits, an edit and an untracked file shows **Cloud → Continue in
  cloud…** in the header and in the row's long-press menu;
- the sheet lists the commits and files; turn one file off; confirm;
- the phone selects the new cloud thread, which has the commits and the edit, not that file, and
  read-only history; the Mac thread shows "Continued in cloud";
- a running turn disables the entry with its reason; a Mac with no link shows the link notice;
- a Pair Cloud thread and a phone paired only with the Mac show no entry.
  Captures of the sheet and the header menu on both platforms.

**Reviewer checks.**

- The phone calls only the Mac's environment for the move and only Pair Cloud's for the account
  notice; nothing on the phone talks to Pair Cloud's move routes.
- Thread rows don't re-render when another thread's offer or an unrelated environment changes.
- Opening the new thread is a select (`useSelectWorkspaceDetail`), never `navigate("Thread")`.
- Surfaces:
  - Entry points: the thread header's menu and the row menu; mobile has no palette or keybinding.
  - Clients: mobile only; web and desktop are 3.23's.
  - Providers, agents, contracts: none here.
  - Reverse states: Continue locally stays desktop (a phone has no local server); the move row
    shows on both threads, from 3.25's presentation.
  - Connection modes: the phone reaches the Mac over LAN, Tailscale or T3 Connect, and Pair Cloud
    over its own address; a phone paired only with the Mac sees no entry, since nothing tells it a
    Pair Cloud exists (08 conflict 5).
  - Docs: 3.26 (the cloud guide's Phone section).

### 3.25 (was 4.6) `feat(contracts,server,client-runtime,web): continue a cloud session on a member's Mac`

**Continue locally** on a cloud thread, from the desktop's thread menu or command palette, makes
a new thread on the member's own computer at the machine's current state, with no push to
GitHub. The client asks its local server (`threadMove.toLocal`). The local server asks Pair Cloud
over its agent link, so Pair Cloud never calls the laptop: first the context export, then a
bundle of the thread's branch and snapshot. An awake machine snapshots and syncs first; an asleep
one is bundled from the mirror without waking. The local server imports the bundle into the local
project whose origin matches: a new worktree, the snapshot in the working tree, and a new thread
whose history and `from` row come from the export. Then it reports back. The thread's holder
moves the session: the cloud thread records "Continued locally on …" and settles, and 2.1's settle rule
puts its machine to sleep. Anyone else gets a copy on a new branch, and the cloud session stays
live (D19). It is its own PR because it is the first move and lands before 3.23: it creates the
laptop's `CloudMoves` service and its route client, and Pair Cloud's mirror-to-laptop download,
which 3.23 and 3.21 reuse.

- **Needs:** 3.19 (`PeerLinks.resolve` returns `capabilities`; agent links need no Labs beta),
  3.20 (`CloudMoveHttp.layer`, `authenticateLinkMember`, the byte budget, `cloudImport`,
  `CloudStagingKey`, `CloudMoveFailure`), 3.22 (`ContextExports.build`,
  `ThreadLaunchInput.contextExport`, `thread.move.record`, the `move` row). **Unblocks:** 3.23
  (adds `preview` and `continueInCloud` to `CloudMoves`, uploads to `CloudMoveClient`), 3.26, G3
  steps 2–3. 3.21 lands a wave earlier and keeps calling `restore`, which this row moves onto
  `bundleThread` with no change in behavior.
- **Files:**
  - `packages/contracts/src/cloudMove.ts` (3.20):
    - `CloudMoveFailureReason` gains `"not-found"`, `"not-movable"`, `"run-active"`,
      `"snapshot-missing"`, `"snapshot-failed"` (an older reader gets null, 3.20).
    - New, shapes under **Types**: `CLOUD_MOVE_MAX_HAVES`, `CLOUD_MOVE_SEED_HEADERS` and
      `CloudMoveSeedHeaders`, `CloudMoveContinuedInput`, `CloudMoveContinuedResult`,
      `ThreadMoveToLocalInput`, `ThreadMoveToLocalResult`, `ThreadMoveError`.
  - `packages/contracts/src/rpc.ts`: `threadMoveToLocal: "threadMove.toLocal"` in `WS_METHODS`
    (beside `peerLinksList`, 544) and its `Rpc.make` beside `WsPeerLinksListRpc` (870), in the
    group.
  - `packages/contracts/src/clientRpcPermissions.ts`: `[WS_METHODS.threadMoveToLocal]:
    AuthOrchestrationOperateScope` ("Creates a worktree and a thread here").
  - `apps/server/src/auth/RpcAuthorization.ts` `RPC_REQUIRED_SCOPES` (~92): the same scope.
  - `apps/server/src/sandbox/mirror/MirrorSync.ts`:
    - New `bundleThread` (shape under **Types**), factored out of `restore` (357–426: the tips
      read, the snapshot-on-tip rule at 387–403, `writeBundle` on `hosts.local` with prerequisite
      tiers). `restore` calls it and keeps everything that touches the machine (428–455).
    - `MirrorSyncError.reason` (62–68) gains `"too-large"`; `writeBundle`'s cap (252–255) uses it,
      so the route can answer 413.
  - New `apps/server/src/cloudMove/CloudMoveSource.ts`: Pair Cloud's side of a move out.
  - `apps/server/src/cloudMove/CloudMoveHttp.ts` (3.20): three routes in `layer`'s `mergeAll`
    (under **Commands and events**).
  - New `apps/server/src/cloudMove/CloudMoveClient.ts`: the laptop's calls to Pair Cloud's
    cloud-move routes over the agent link. 3.23 adds its uploads and its launch here.
  - New `apps/server/src/cloudMove/CloudMoves.ts`: the laptop's moves; `continueLocally` here,
    `preview` and `continueInCloud` from 3.23.
  - `apps/server/src/ws.ts`: beside `peerLinksList` (2863), `[WS_METHODS.threadMoveToLocal]:
    (input) => cloudMoves.continueLocally({ ...input, actorId: currentSession.memberId })`, as
    `launchThread` passes the member (2395).
  - `apps/server/src/server.ts` / `orchestration-v2/runtimeLayer.ts`: `CloudMoveSource.layer`
    where 3.20 provides `StagedCloudImports` (`layerOrchestrationV2Runtime`, server.ts 653), and
    `CloudMoveClient.layer` and `CloudMoves.layer` beside `PeerLinks`. Re-read the composition.
  - `packages/client-runtime/src/state/cloudTarget.ts`: `resolveContinueLocally` (under
    **Types**), next to `resolveCloudTarget` (73), with the same origin match.
  - New `packages/client-runtime/src/state/threadMove.ts`: `createThreadMoveAtoms(runtime)` with
    `toLocal: createEnvironmentRpcCommand(runtime, { label: "environment-data:thread-move:to-local",
    tag: WS_METHODS.threadMoveToLocal, execute: moveThreadToLocal })`. `moveThreadToLocal` is a
    new executor in `operations/commands.ts` that fills `commandId` with the module's
    `allocateCommandId` (283), as `wakeSandbox` (468) does. 3.23 adds `preview` and `toCloud`.
  - New `apps/web/src/state/threadMove.ts`: `threadMoveEnvironment =
    createThreadMoveAtoms(connectionAtomRuntime)`.
  - New `apps/web/src/hooks/useContinueLocally.ts`: `{ offerFor(threadRef), run(threadRef) }`.
    `offerFor` feeds `resolveContinueLocally` with the thread shell (`readThreadShell`), the
    primary environment (`primaryEnvironmentIdAtom`, state/primaryEnvironment.ts 5–12: the
    desktop's local server, or the `npx t3` server the page came from), server configs, all
    projects, the permission atom of `toLocal` on the primary environment, and the primary
    environment's `peerLinkEnvironment.list` (state/peerLinks.ts 20). The list is queried only
    while a connected environment reports `cloudImport`, since listing probes each linked peer
    (client-runtime/state/peerLinks.ts 17). `run` resolves the new thread's model and modes:
    `resolveProjectSettings(…).settings.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(providers, settings, projectId)`
    (providerInstanceEntries.ts 202; useHandleNewThread.ts 146–161 does the same for a new
    draft), `defaultRuntimeMode`, `DEFAULT_PROVIDER_INTERACTION_MODE`; no model is a toast "Could
    not continue locally" with "Set up a provider on this computer first." Then `toLocal` on the
    primary environment, under a loading toast "Continuing locally…" (the item acts at once and a
    download can take minutes, so this is its visible state). On success the toast closes and it
    navigates to `/$environmentId/$threadId` for the new thread; a copy toasts "Continued a copy
    on `<branch>`" with "The cloud thread stays with its owner." (UI says "cloud thread", and
    "stays open" said nothing about whose it is); `reported: false` toasts a warning with the
    local notice's text. A failure turns the toast into "Could not continue locally" (the
    product's failure-title form) with the error's message.
  - `apps/web/src/components/threadActionMenu.logic.ts`: `ThreadActionMenuId` (8–39) gains
    `"continue-locally"`; `ThreadActionMenuState` (79–121) gains `continueLocally?: { readonly
    disabledLabel: string | null }`; the item `{ id: "continue-locally", label, icon: "laptop" }`
    goes right after the machine actions (233–245), `separatorBefore` when there are none, and
    disabled with its short reason in the label, as the "(owner or admin only)" items are.
  - `apps/web/src/hooks/useThreadActionMenu.ts`: `const continueLocally = useContinueLocally()`;
    in `openMenu` (147), `...(offer.kind === "hidden" ? {} : { continueLocally: … })` into
    `buildThreadActionMenuItems`; `case "continue-locally": await continueLocally.run(threadRef)`.
    Both thread menus use this hook (1.39's note), so both get the item.
  - `apps/web/src/components/CommandPalette.tsx`: after the machine actions (1521–1537), an
    `action:continue-locally` item for the active thread ("Continue locally", search terms
    continue, locally, local, move, computer, mac, bring back), `disabled` with the long reason as
    `description` like `SANDBOX_OWNER_ONLY_REASON` (1532).
- **Types and services:**
  - `cloudMove.ts`:

    ```ts
    export const CLOUD_MOVE_MAX_HAVES = 32;
    const GitOid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/));
    /** `GET …/threads/<id>/seed` answers with these; the bundle keeps the mirror's ref names. */
    export const CloudMoveSeedHeaders = Schema.Struct({
      "t3-move-mode": Schema.Literals(["move", "copy"]),
      "t3-move-branch": TrimmedNonEmptyString,
      "t3-move-base": Schema.optional(TrimmedNonEmptyString),
      "t3-move-origin": TrimmedNonEmptyString,
      "t3-move-head": GitOid,
      "t3-move-snapshot": Schema.optional(GitOid),
      "t3-move-snapshot-at": Schema.optional(Schema.DateTimeUtcFromString),
    });
    export const CloudMoveContinuedInput = Schema.Struct({
      moveId: CloudStagingKey,
      thread: ScopedThreadRef,
      environmentLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      copy: Schema.Boolean,
    });
    export const CloudMoveContinuedResult = Schema.Struct({ settled: Schema.Boolean });

    export const ThreadMoveToLocalInput = Schema.Struct({
      commandId: CommandId,
      /** A cloud thread on an environment this server links to. */
      source: ScopedThreadRef,
      /** The local project whose origin matches the cloud thread's. */
      projectId: ProjectId,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
    });
    export const ThreadMoveToLocalResult = Schema.Struct({
      threadId: ThreadId,
      branch: TrimmedNonEmptyString,
      copy: Schema.Boolean,
      /** False when Pair Cloud didn't hear about the move; the local thread says so. */
      reported: Schema.Boolean,
    });
    export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
      reason: Schema.Literals([
        "not-linked",
        "unsupported",
        "project-mismatch",
        "refused",
        "failed",
      ]),
      message: Schema.String,
    }) {}
    ```

    `CLOUD_MOVE_SEED_HEADERS` is the record of those header names, for both ends. `ThreadMoveError`
    reaches the desktop from its own local server, which ships in the same build (08 §4), so its
    strict reasons are safe.

  - `MirrorSync.bundleThread`:
    ```ts
    /** The thread's mirror branch and, when it sits on the tip, its snapshot, as a bundle file
        removed when the scope closes. Null when the mirror has no branch for the thread. */
    readonly bundleThread: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      /** Asked only once the branch exists; tried as prerequisites, then none. */
      readonly prerequisites: (seedTip: string | null) => Effect.Effect<ReadonlyArray<string>, MirrorSyncError>;
    }) => Effect.Effect<
      { readonly file: string | null; readonly head: string;
        readonly snapshot: { readonly oid: string; readonly takenAt: DateTime.Utc } | null } | null,
      MirrorSyncError, Scope.Scope>;
    ```
    `file` is null for an empty bundle (the receiver has every object). `restore` needs `head` for
    that case (`branch --force`, 446–449). Prerequisites are a function so `restore` keeps
    answering null before it touches the machine (3.21 relies on that): it passes `(seed) => seed
    === null ? [] : <the clone has it> ? [seed] : []` (411–420 today). Tiers are `[prerequisites,
    []]`, so a commit the mirror lacks ("bad object") falls back to full history.
  - `CloudMoveSource` (`t3/cloudMove/CloudMoveSource`), on Pair Cloud, needing
    `ProjectionStoreV2`, `ThreadManagementService`, `ContextExports`, `CheckpointServiceV2`,
    `MirrorSyncWorker`, `MirrorSync`, `ProjectService` and `TeamState` (`serviceOption`; no team
    means the member is the holder):
    - `contextExport({ threadId, memberId }) => Effect<OrchestrationV2ContextExport,
      CloudMoveSourceError>`: `movable(threadId)`, then `ContextExports.build`.
    - `seed({ threadId, memberId, haves }) => Effect<CloudMoveSeed, CloudMoveSourceError,
      Scope.Scope>`:
      1. `movable(threadId)`: the shell (`getThreadShell`, ProjectionStore.ts 581) exists and isn't
         deleted, else `not-found`; a side chat or subagent (`isListedThreadLineage`), or no
         `sandboxId`, `branch` or `worktreePath`, is `not-movable`; `threadHasUnfinishedWork`
         (Orchestrator.ts 605–618: unfinished or queued runs, open requests) on `getThreadRecords(
         threadId, ["runs", "runtimeRequests"])` is `run-active`.
      2. The machine: `getSandbox(sandboxId)` (610) and the namer of the thread's checkout,
         `snapshotNamers(record.ownerThreadId, [owner, ...listSandboxThreads(record.id)])`
         (CheckpointMirror.ts 116–127; a side chat's and a fork's shared checkout is named by
         its owner, as 2.7 names it).
      3. Awake (`state === "ready" && runnerLostAt === null`, SandboxProjection.ts 81):
         `captureSnapshot({ cwd: worktreePath, ref: sandboxSnapshotRef(namer) })` must be
         `ready` and `MirrorSyncWorker.syncRefs({ threadId: namer, cwd, checkpointRefs: [ref],
         recordHead: true })` true, bounded at 15 s like `snapshotBeforeSleep`
         (SandboxEffects.ts 246–300), else `snapshot-failed`. Not awake: nothing touches the
         machine. Unless `destroyed`, a null `sleepSnapshotAt` is `snapshot-missing` (the stop is
         still running, or its snapshot failed, 2.7).
      4. `bundleThread({ threadId: namer, projectId, prerequisites: () => haves })`. Null, or a
         machine that isn't destroyed with `snapshot === null`, is `snapshot-missing`: the
         uncommitted files would be lost without a word. A destroyed disk sends what the mirror
         holds. `too-large` passes through.
      5. Mode: `move` when `holderOf(thread, ownerId)` (MemberThreadState.ts 74–79) is the member,
         else `copy`. Base: the oldest run's `worktree` `baseRef`, as `gateCloudMessage` finds it
         (Orchestrator.ts 11227–11232), else absent. Origin: `repositoryGroupingKeyOf` of the
         project shell's `repositoryIdentity` (`ProjectService.getShell`, 162).
         `CloudMoveSeed = { file, head, snapshot, mode, branch, baseRef, origin }`.
    - `continued({ threadId, memberId, input: CloudMoveContinuedInput }) => Effect<{ settled:
      boolean }, CloudMoveSourceError>`: the shell must exist (`not-found`).
      `copy = input.copy || holder !== memberId`. Dispatch `thread.move.record` (3.22) with
      `commandId: cloud-move:<moveId>:record`, `to: input.thread`, `actorId: memberId` and
      `message` "Continued locally on `<environmentLabel>`", or for a copy "`<member name>` copied
      this thread to `<environmentLabel>`" (the active member's name, else "A teammate", as
      `emitLifecycleNotice` names members, Orchestrator.ts 1521–1535). Then, for a move with no
      unfinished work, `thread.settle` with `commandId: cloud-move:<moveId>:settle` and no
      `actorId` (no lifecycle notice beside the row); a previously rejected receipt reads as
      `settled: false`. A retried POST replays both receipts.
    - `CloudMoveSourceError`: `reason: "not-found" | "not-movable" | "run-active" |
      "snapshot-missing" | "snapshot-failed" | "too-large" | "failed"`, `message`, `cause?`. The
      messages are the user's words, read on the laptop, in the UI's nouns (cloud thread,
      machine, **Wake machine**; no bundle or session): "A turn is running or waiting for an
      answer. Continue locally once it ends." (`run-active` also covers open requests) /
      "Continue locally from the thread this one belongs to." / "This thread's machine hasn't
      cloned the repository yet." (true while it starts and after it fails) / "Pair Cloud has no
      saved copy of this thread's uncommitted changes. Wake the machine, then try again." (true
      while its stop is still running, too) / "Couldn't save the machine's uncommitted changes.
      Try again in a moment." / "The download would be over 512 MB. Fetch origin on this
      computer, then try again." (MB, as 3.23's upload limit)
  - `CloudMoveClient` (`t3/cloudMove/CloudMoveClient`), on the laptop, needing `PeerLinks`,
    `HttpClient`, `FileSystem`:
    - `contextExport({ environmentId, threadId })`, `downloadSeed({ environmentId, threadId,
      haves, file, check })` and `reportContinued({ environmentId, threadId, body })`.
    - Each resolves the link (`PeerLinks.resolve`): `unknown_link` and `expired` are `not-linked`
      ("Link this computer to `<label>` in Settings → Environments.", the page's name in the
      UI); other `PeerLinkError`s are `failed` with their message. `capabilities.cloudImport !==
      true` is `unsupported` ("`<label>` needs an update to move threads. Ask an admin.", 3.23's
      text). Requests carry `authorization: Bearer <token>`. 401 is `not-linked`
      ("`<label>` no longer accepts this computer's link. Link it again in Settings →
      Environments."); any other non-2xx decodes the body as `CloudMoveFailure` and is `refused`
      with its message; a transport error is `failed`. Outcomes go to `PeerLinks.recordOutcome`, as
      `PeerMcpClient` does.
    - `downloadSeed` decodes the headers with `CloudMoveSeedHeaders` and runs `check(headers)`
      before it reads the body. Then it streams the body to `file`, counting bytes; past
      `CLOUD_SEED_MAX_BYTES` it stops with `refused` and Pair Cloud's `too-large` text. 204 writes
      nothing (`written: false`).
  - `CloudMoves` (`t3/cloudMove/CloudMoves`), on the laptop. `continueLocally(input &
    { actorId?: MemberId }) => Effect<ThreadMoveToLocalResult, ThreadMoveError>`:
    1. A cloud-only server is `unsupported` ("Continue locally from Pair on your own computer.";
       `npx t3`'s web offers it too, so not "the desktop app"). The project must exist.
    2. `moveId = "mv_" + sha256(commandId).slice(0, 32)` hex: a `CloudStagingKey` stable across
       the method's own retries.
    3. `client.contextExport(source)`. It is small and refuses a busy thread before any bundle.
    4. Haves, through `GitVcsDriver.execute` (GitVcsDriver.ts 322) in the project root:
       `rev-parse --verify --quiet refs/remotes/origin/HEAD^{commit}` and `for-each-ref
       --sort=-committerdate --count=31 --format=%(objectname) refs/heads`, deduplicated. The
       first is the design's default-branch tip; the rest make a round trip (local → cloud →
       local) send only the new commits.
    5. `client.downloadSeed` to `<stateDir>/cloud-moves/<moveId>.bundle` (dir 0700; a finalizer
       removes it). Its `check` refuses when the headers' origin and the project's
       `repositoryGroupingKeyOf` differ (compared case-insensitively): `project-mismatch` ("The
       cloud thread's origin, `<origin>`, doesn't match this project's."), before the body is
       read.
    6. Under a per-project `KeyedLock`: if written, `git fetch --quiet --no-tags
       --no-write-fetch-head -- <file> +refs/*:refs/t3/moves/<moveId>/*`; then `cat-file -e
       <oid>^{commit}` for the head and the snapshot (else `failed`). The branch name: a move
       takes the session's branch, a copy `<branch>-copy`; a taken name (a local branch, or
       `origin/<name>` via `remoteBranchExists`) gets `-2`, `-3`, and so on.
       `GitWorkflowService.createWorktree({ cwd: root, refName: head, newRefName: name,
       baseRefName: base, path: null })`, as `prepareInBackground` does (ThreadLaunchService.ts
       717–739); a branch made from an oid tracks nothing (`createBranchAt`, GitVcsDriverCore.ts
       3955–3975), so nothing points a copy at the session's remote branch. With a snapshot,
       `read-tree --reset -u <snapshot>` then `reset --quiet` in the worktree (2.13's
       MirrorSync.ts 451–454). Last, delete `refs/t3/moves/<moveId>/`.
    7. `ThreadLaunchService.launch({ commandId: move:<moveId>, projectId, title:
       export.source.title, modelSelection, runtimeMode, interactionMode, workspaceStrategy: {
       type: "existing_worktree", worktreePath, branch: name }, contextExport: { value: export,
       copy }, createdBy: "user", creationSource: "web", actorId })`. 3.22 imports the history
       and the `from` row before the thread has a run; the launch's preparation runs the project
       setup script in the worktree (ThreadLaunchService.ts 866–890), which recreates ignored
       files. If step 6 or 7 fails after the worktree exists, `Effect.onError` removes the
       worktree (`removeWorktree({ force: true })`), deletes the branch (`deleteLocalBranch({
       force: true })`) and the temp refs.
    8. `client.reportContinued({ moveId, thread: { environmentId: <this server>, threadId },
       environmentLabel: <this server's label>, copy })`, retried twice on a schedule (TestClock in
       tests). When it still fails, `thread.notice.record` on the local thread: "Pair Cloud
       didn't record this move, so the cloud thread there stays as it was and doesn't link
       here." (true for a move and a copy; "wasn't settled" meant nothing for a copy) and
       `reported: false`. The local thread is the result either way.
  - `resolveContinueLocally(input) => { kind: "hidden" } | { kind: "disabled"; label: string;
    reason: string } | { kind: "ready"; localEnvironmentId; projectId }`, pure. Hidden: no
    primary environment, the primary is the thread's own or reports `cloudLaunch`, no `toLocal`
    permission there, the thread isn't a listed cloud thread, its environment doesn't report
    `cloudImport`, or the primary has no link to it. Disabled: the link expired ("link expired" /
    "The link to `<label>` expired. Link it again in Settings → Environments."); no local project
    matches the origin, chosen as `resolveCloudTarget` chooses (the oldest non-archived project
    with the same `repositoryGroupingKeyOf`, case-insensitive) ("no matching project" / "No
    project on this computer has origin `<key>`."); a run is active (`runtime.activeRunId`)
    ("turn running" / "Wait for the turn to end, or stop it.", 3.23's `run-active` text). Pair
    Cloud re-checks every one of these it can see.

- **Commands and events:** on Pair Cloud, `thread.move.record` and `thread.settle` on the cloud
  thread; on the laptop, `thread.create`, 3.22's `thread.history.import`, the launch's
  `thread.metadata.update`, and `thread.notice.record` when the report fails. No new command. New
  routes in `CloudMoveHttp.layer`, each 404 empty before auth off cloud-only, then
  `authenticateLinkMember`, then `:threadId` decoded as `ThreadId` (400):
  - `GET ${CLOUD_MOVE_ROUTE_PREFIX}/threads/:threadId/context-export` → 200 JSON
    (`OrchestrationV2ContextExport`).
  - `GET ${CLOUD_MOVE_ROUTE_PREFIX}/threads/:threadId/seed?have=<oid>…` (`have` repeatable, each a
    `GitOid`, at most `CLOUD_MOVE_MAX_HAVES`, else 400). It opens a `Scope` itself, runs
    `seed` in it, and answers 204 with the headers when `file` is null, else
    `HttpServerResponse.stream` of the file through the shared byte budget with
    `Stream.ensuring(Scope.close(scope, Exit.void))`: a scope closed when the handler returns
    would delete the file before Node sends it. Any failure before the response closes the scope.
    `content-type: application/x-git-bundle`, `content-length`.
  - `POST ${CLOUD_MOVE_ROUTE_PREFIX}/threads/:threadId/continued` (body `CloudMoveContinuedInput`,
    400 when it doesn't decode) → 200 `CloudMoveContinuedResult`.
  - Errors as `CloudMoveFailure`: `not-found` 404; `not-movable`, `run-active`,
    `snapshot-missing` 409; `snapshot-failed` 503; `too-large` 413; `failed` 500, logged.
- **Migrations:** none. A move leaves receipts and turn items on both sides; nothing else to keep.
- **Proposed gap answers** (each says what changes if overruled).
  - `?have=` replaces `?full=1`. The mirror refetches origin on every sync (`ensure`,
    1.31), so its default-branch tip is usually newer than the laptop's; using it as the
    prerequisite would make most moves send full history. Overruled: drop `have`, pass the mirror's
    seed tip, and the laptop re-requests with `?full=1` when `git fetch` reports a missing
    prerequisite.
  - Git facts ride `t3-move-*` headers; the bundle keeps the mirror's ref names and the laptop
    fetches them into its own namespace. Overruled (a JSON manifest): one more `GET`, same fields.
  - The snapshot goes in with 2.13's `read-tree --reset -u` and `reset`, not `restoreCheckpoint`
    (07 §8): `restoreCheckpoint` runs `git restore --worktree --staged` (GitVcsDriver.ts
    1374–1381) and would stage everything.
  - An asleep machine without a usable snapshot is refused; a destroyed disk moves what the mirror
    has. Overruled: drop step 3's `snapshot-missing` and the local thread records a notice that
    uncommitted changes stayed behind.
  - Settling is `thread.settle`, never `sandbox.sleep`: 2.1's rule (`decideAutoSleep`,
    SandboxDecisions.ts 155–168) sleeps the machine only once every attached thread is settled, so
    a teammate's fork keeps it awake. Overruled: `continued` also dispatches `sandbox.sleep` as the
    holder, and a fork on the machine is stopped with it.
  - The row reads "Continued locally on `<environment label>`" ("Continued locally on Kim's
    MacBook Pro"), not
    "`<name>`'s Mac": the local server knows its label, and the desktop also runs on Windows and
    Linux. Overruled: only the sentence in `continued` changes.
  - Branches: a move keeps the session's name, else `<branch>-<n>`; a copy is
    `<branch>-copy[-n]`. The usual taken case is a round trip, whose original worktree still has
    the branch checked out, and git refuses a second worktree on it.
  - The client picks the new thread's model as a new draft does, since those defaults live in
    client-runtime. Overruled (server picks): `ThreadMoveToLocalInput` loses three fields and the
    server needs a provider-default resolver it doesn't have today.
  - Continue locally stays a desktop action (the decision at the top of this page): no MCP tool, no keybinding (08
    §4).

**Tests.**

- `packages/contracts/src/cloudMove.test.ts` (3.20's table): `CloudMoveContinuedInput` refuses a
  `moveId` that isn't a `CloudStagingKey` and a 121-character label; `CloudMoveSeedHeaders`
  decodes a header record with and without the snapshot pair and refuses a short `t3-move-head`;
  `CloudMoveFailure` keeps `"snapshot-missing"`.
- `apps/server/src/auth/RpcAuthorization.test.ts`: "declares exactly one scope for every RPC in
  the server group" (40) covers the new method; add `threadMove.toLocal` to an operate assertion
  beside triage's (54).
- `apps/server/src/sandbox/mirror/MirrorSync.test.ts`:
  - "fails an oversized bundle as bundle-failed and leaves no temp file" (211): the reason is now
    `too-large` (rename the case).
  - "rebuilds a lost checkout from the mirror's branch and a snapshot on its tip" (231) passes
    unchanged through `bundleThread`. Extend it after the first sync: `bundleThread` with
    `prerequisites: () => [<origin main tip>]` gives a file whose `git bundle list-heads` names the
    branch and snapshot refs and whose `git bundle verify` lists that prerequisite; with an oid
    the mirror lacks, no prerequisite; with the branch tip and no newer commit than the
    snapshot's, `file` is null with `head` set; after "later" (the branch moved past the
    snapshot), `snapshot` is null. The file is gone once the scope closes. The never-synced thread
    is null and `prerequisites` never ran.
- New `apps/server/src/cloudMove/CloudMoveSource.test.ts`, `it.effect`, a real `CheckpointMirror`
  and `MirrorSync` over a loopback sandbox host (MirrorSync.test.ts 40–48), `Layer.mock`s for
  `ProjectionStoreV2` (shell, sandbox record, attached threads, runs), `CheckpointServiceV2`,
  `MirrorSyncWorker`, `ContextExports` and `ThreadManagementService` (dispatch collected), and a
  team layer. Table "seeds a move from $name":
  - an awake machine: capture and sync ran for the namer's snapshot ref and the worktree, then the
    bundle holds the fresh snapshot; `mode: "move"` for the holder;
  - an asleep machine with a snapshot on the tip: capture never ran, the bundle holds it;
  - an asleep machine with `sleepSnapshotAt: null`, or with a snapshot behind the tip:
    `snapshot-missing`, no file;
  - a destroyed disk: the branch only, no refusal;
  - a running or queued run, or an open request: `run-active`, nothing captured;
  - a side chat: `not-movable`;
  - another member: `mode: "copy"`;
  - a `have` the mirror lacks: a full bundle.
    Table "records a move back from $name": the holder (row `to` the local thread with "Continued
    on …", then `thread.settle`, `settled: true`); another member (the copy sentence, no settle);
    the holder while a run started meanwhile (row, no settle); the same `moveId` again (the same
    two command ids).
- `apps/server/src/cloudMove/CloudMoveHttp.test.ts` (3.20): the "answers $name" auth rows run for
  the three routes (`it.each` over route); `GET …/seed` streams the exact file bytes with the
  headers, answers 204 with headers for a null file, and its temp file is gone once the response
  ended; `have` past 32 is 400; `run-active` is 409 and `too-large` 413 with a `CloudMoveFailure`
  body; `POST …/continued` with a bad `moveId` is 400.
- New `apps/server/src/cloudMove/CloudMoveClient.test.ts`, table "maps $name": a 401;
  a 409 with a `CloudMoveFailure` (its message reaches `refused`); a peer without `cloudImport`;
  `PeerLinkError` `expired`; a transport failure; a body over the cap (stops, `refused`); headers
  whose `check` fails (the body is never read). An `HttpClient` test layer answers.
- New `apps/server/src/cloudMove/CloudMoves.test.ts`, `it.effect` with real git: an origin, a
  "cloud" clone whose branch has two commits not on origin, an edit and an untracked file, bundled
  the way `bundleThread` bundles (mirror-style ref names); the local project is another clone of
  origin. `Layer.mock(CloudMoveClient)` serves the export and that bundle;
  `Layer.mock(ThreadLaunchService)` records the launch; `ThreadManagementService` records
  dispatches. Cases:
  - "brings the branch, its commits and the uncommitted files into a new worktree": HEAD is the
    cloud tip on the session's branch, `git status --porcelain` shows the edit unstaged and the
    file untracked, nothing is left under `refs/t3/moves/`, the launch got `existing_worktree`
    and the export without `copy`, and the report carries `mv_` + the command id's digest, the new
    thread's ref and this server's label.
  - "a copy gets a branch of its own": `<branch>-copy`, then `-copy-2` when taken; `git rev-parse
    @{u}` fails in the worktree.
  - "the holder's branch, checked out here already, gets the next name": `<branch>-2`.
  - "an empty bundle uses objects already here": `written: false` works when the head is here and
    fails `failed` with nothing created when it isn't.
  - "refuses a project with another origin before the bundle": `project-mismatch`, the body
    never read, no worktree.
  - "undoes the worktree and branch when the launch fails".
  - "keeps the local thread when Pair Cloud doesn't hear about it": three report failures across
    `TestClock.adjust`, then the notice and `reported: false`.
- `packages/client-runtime/src/state/cloudTarget.test.ts`: new `describe("resolveContinueLocally")`
  table, one row per hidden, disabled and ready case above.
- `apps/web/src/components/threadActionMenu.logic.test.ts`: new `it` "offers Continue locally
  after the machine actions, disabled with why": its position, its label when disabled, and no
  item without `continueLocally`.

**Verify.** `vp test run packages/contracts/src/cloudMove.test.ts
apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/sandbox/mirror/MirrorSync.test.ts
apps/server/src/cloudMove/CloudMoveSource.test.ts apps/server/src/cloudMove/CloudMoveHttp.test.ts
apps/server/src/cloudMove/CloudMoveClient.test.ts apps/server/src/cloudMove/CloudMoves.test.ts
packages/client-runtime/src/state/cloudTarget.test.ts
apps/web/src/components/threadActionMenu.logic.test.ts`; `vp run typecheck` for contracts,
server, client-runtime, web, mobile; `vp run check:changed`. The primary agent runs one `test-t3-app` pass
with a local dev server linked to a cloud-only one, as G3 steps 2 and 3 do: the item in both
thread menus and the palette (enabled, and disabled during a turn), the move, the copy, the rows
on both sides, and 3.22's history and gap notice. Captures for the PR: the menu item enabled and
disabled, the palette item, the "Continued locally on …" and "Continued from …" rows on web and desktop.
G3 step 2 also wakes, sleeps and moves again to show an asleep machine stays stopped.

**Reviewer checks.**

- The laptop starts every request; Pair Cloud never calls it. Every Pair Cloud route checks the
  link member, and move versus copy is Pair Cloud's call from the thread's holder.
- An asleep machine is never woken: no `sandbox.wake`, no capture, only mirror reads. An awake
  one is captured with 2.7's code under the workspace lock.
- Nothing is pushed: no `git push` on either side, and a copy branch has no upstream.
- Uncommitted files arrive unstaged and untracked files untracked; a snapshot that isn't on the
  tip is never applied, and a machine without one is refused instead of losing it.
- The seed's temp file is removed after the response is sent, and on every failure; the laptop's
  bundle and temp refs too.
- A failed move leaves no worktree, branch or thread on the laptop; a failed report leaves the
  thread and says so on it.
- Settling is `thread.settle` only for the holder with no unfinished work; the machine sleeps by
  the settle rule.
- Surfaces: entry points (both thread menus, the palette; no composer, Settings or keybinding, per
  08 §4), clients (web and desktop, wherever the primary environment is the member's own server;
  mobile none by design, a phone has no local server), providers (none: the new thread starts a
  fresh session on the local default; native sessions don't move, 07 §8), agents (none in M3, the
  decision at the top of this page), contracts (`cloudMove.ts`, one RPC), reverse states (a moved session is
  unsettled or woken from its own menu, or continued in cloud again with 3.23; a copy is deleted
  like any thread), connection modes (the link resolves LAN, tailnet or public addresses; the RPC
  is the local connection), docs (3.26: the cloud guide's moving sessions and what stays behind).

### 3.26 `docs: cover moving sessions and the agent link`

The user guides say how a member moves a thread between their Mac and Pair Cloud in either
direction, what goes and what stays, and how agents on the Mac reach Pair Cloud through the agent
link; the internal docs record the one constraint a maintainer would otherwise break: a move
between servers is a new thread built from an export that carries its own provenance, started by
the laptop. It is its own PR because it describes 3.19, 3.23, 3.24 and 3.25 together, as landed,
and lands last in M3 (10 §5).

- **Needs:** 3.19, 3.23, 3.24, 3.25 (and 3.22 for the export's size cap). Read each one's
  progress.md note first: the text below follows the specs, and where a landed PR differs, the
  code wins. Quoted links are written as they go in the target file, relative to `docs/user/`.
  **Unblocks:** G3 (the integrated pass follows the cloud guide).
- **Files** (no new page; each change sits in the feature's existing section, per AGENTS.md
  "Documentation"):
  - `docs/user/cloud.md`:
    - New section **Move a thread between your Mac and Pair Cloud**, after **Start a cloud
      thread** (60–89), with the two subsections below. Its text, in the guide's voice:
      - **Continue in cloud.** "On a thread on your Mac, choose **Continue in cloud…** in the
        thread's menu or the command palette. Pair shows what goes: the commits not yet on
        `origin`'s base branch, and the files you changed or added that Git doesn't ignore.
        Uncheck a file to leave it out; it goes as last committed, or not at all if it's new.
        Write the first message for the cloud thread, and confirm. The thread continues on Pair
        Cloud in the project with the same `origin`, as a new thread you own, on your account
        there, with the conversation so far as read-only history
        (`[handoffs](./portable-handoffs.md)`). It starts with at most the access you gave your
        Mac's link. Your Mac's thread says **Continued in cloud** and links to it; its worktree
        and branch stay as they were. Nothing is pushed to GitHub, so this works for a branch you
        never pushed. If you're on the base branch itself, the cloud thread gets a new branch."
      - What stays, as one short list: ignored files such as `.env`, `node_modules` and build
        output (the project's setup script can recreate them); earlier checkpoints, whose diffs
        stay on the Mac's thread; terminals, running processes and previews; approvals and pull
        request links; the provider's own session (the cloud agent starts a new one from the
        handoff).
      - "An untracked file that isn't ignored, such as a local secrets file, goes along unless you
        uncheck it."
      - What it needs: Pair Cloud has the project (**Add to Pair Cloud** otherwise), an account
        there (the same notice as for Cloud), and your Mac linked to Pair Cloud (`[the agent`
        `link](./outside-agents.md#pair-cloud-from-your-macs-agents)`; the dialog offers **Link**).
        It is unavailable while a turn is running; the menu says so. The upload is at most 512 MB:
        leave out large untracked files, or push the branch first.
      - **Continue locally.** "In the desktop app, choose **Continue locally** on a cloud thread.
        Pair brings its branch, its uncommitted work and its conversation into a new worktree and
        thread in your project with the same `origin`. When the thread is yours, it moves: the
        cloud thread says it continued on your computer, settles, and its machine sleeps. When it
        is a teammate's, you get a copy on a new branch, and their cloud thread keeps going. An
        asleep machine isn't woken: Pair uses what it saved when it went to sleep." (3.25's facts:
        the row's final wording, the branch name of a copy, what happens to a waiting turn. 3.25
        names the computer by its environment label, not "<name>'s Mac".)
    - **Phone** (185–191): add "On a thread on your Mac, the **Cloud** menu in the thread header,
      or the thread's long-press menu, offers **Continue in cloud…** too. Your Mac does the
      upload, so the phone must be connected to both your Mac and Pair Cloud. Continue locally is
      desktop only." (3.24.)
    - **Start a cloud thread** (60–70): after "Push the branch first: …", add "To take unpushed
      work along, start the thread on your Mac and
      `[continue it in cloud](#move-a-thread-between-your-mac-and-pair-cloud)`."
  - `docs/user/outside-agents.md`:
    - New section **Pair Cloud from your Mac's agents**, after **Agents working with agents**
      (159–169). The agent link's own section (3.19 leaves it here):
      - What it is: "Link your Mac to your team's Pair Cloud once, and agents in threads on your
        Mac can start cloud threads there that belong to you: on your accounts, under the team's
        machine limit."
      - How: "In **Settings → Environments → Linked environments**, choose **Link**; Pair Cloud is
        preselected, and your app makes the sign-in code. Pick the access: the most an agent from
        your Mac, or a thread you move, may do there." (The page is **Environments** in the UI
        and in remote-access.md.) Then the facts 3.19 lands: no Labs beta is needed for a Pair
        Cloud link; a member's link goes up to **Auto**; it lasts 30 days, like any link; **Forget**
        removes it on the Mac and revoking it in Pair Cloud's **Settings → Sharing & access** ends
        it there; removing you from the team ends it too.
      - What agents do with it: "`t3_thread_launch` with Pair Cloud's environment, or
        `delegate_task` with `isolation: "cloud"`, start from a branch that is on `origin`.
        `t3 thread start … --environment <Pair Cloud> --cloud <base>` does the same from a
        terminal. To move a thread with unpushed work, an agent uses
        `t3_thread_continue_in_cloud`, as **Continue in cloud** does." Link to
        `[Move a thread](./cloud.md#move-a-thread-between-your-mac-and-pair-cloud)`.
      - "Pair Cloud never reaches back to your Mac: every move and launch starts from your Mac."
    - **Agents working with agents** (168–169): "Agents start cloud threads and cloud tasks the
      same way, when your server has Cloud set up." becomes "…on Pair Cloud, and from your Mac
      through `[its link](#pair-cloud-from-your-macs-agents)`."
  - `docs/user/remote-access.md` **Link another environment** (323–364): 3.19 adds that a Pair
    Cloud link needs no beta. Add one sentence after the bullets: "A link to your team's Pair Cloud
    works as you there; see `[Pair Cloud from your Mac's`
    `agents](./outside-agents.md#pair-cloud-from-your-macs-agents)`."
  - `docs/user/portable-handoffs.md`:
    - First paragraph (3–4): "…or use a fork that the provider cannot resume itself." becomes "…,
      use a fork that the provider cannot resume itself, or move a thread between your Mac and
      Pair Cloud."
    - New paragraph after the third (15–18): "A moved thread starts on the other server with the
      conversation as read-only history, up to <3.22's `CONTEXT_EXPORT_MAX_BYTES` in words>, and
      the handoff's references to omitted history read from that history, so teammates can scroll
      back and the agent can look things up."
    - **Context limits** (34–35), "Imported history has a separate 64,000-byte ceiling": say
      whether a moved thread's history shares that ceiling or has its own, as 3.22 landed.
  - `docs/user/pair-cloud.md`:
    - **Invite the team** (142–149): add a bullet to what each member does: "links their Mac to
      Pair Cloud, to move threads and let their Mac's agents start cloud threads (see `[Pair Cloud`
      `from your Mac's agents](./outside-agents.md#pair-cloud-from-your-macs-agents)`)."
    - **Offboard a member** (228–241), step 1: append "and ends the link from their Mac".
  - `docs/internals/context-handoffs.md`: one paragraph after the provider-handoff paragraph
    (60–62): "`OrchestrationV2ContextTransfer.sourceThreadId` names a thread in the same event
    store, so a move between servers does not use a context transfer. The sending server builds an
    `OrchestrationV2ContextExport` that carries its own provenance (environment, thread, title) and
    the thread's messages, size-capped; the receiving server imports them as read-only history
    (`historyOrigin: "context_export"`) and builds a `manual_context` handoff in
    `prepareLegacyImport`'s shape, so the handoff's omitted-history references resolve on the new
    thread. Keep exports self-describing: a reference back to the other server's store can't be
    followed." Then check the last paragraph (64–67) still holds: if 3.22's import reuses the v1
    selection (user and assistant messages, the 32,000-character suffix), say the export uses it
    too and keep the warning that it is not the portable-handoff budget.
  - `docs/internals/overview.md` **Pair Cloud and workspace hosts** (42–51), **proposed**: one
    sentence after the first paragraph: "The two never sync. A move between them is a new thread on
    the other server, always started by the local server over its member-scoped link (Pair Cloud
    never calls a laptop): the code travels as a git bundle staged in Pair Cloud's mirror, and the
    conversation as a context export (`[context handoffs](./context-handoffs.md)`)." A constraint
    across the server, the link and both clients, which a maintainer adding a Pair-Cloud-to-laptop
    call would otherwise break. Overruled: drop it; context-handoffs.md alone keeps the export rule.
  - `docs/product/pair-features.md`: a new entry after **Pair Cloud** (142–156), **Moving
    sessions** (10 §5's M3 row):
    - **Continue in cloud** from a thread on the Mac (menu, palette, phone), unpushed commits and
      uncommitted files included, with a preview to leave files out; nothing pushed to GitHub.
    - **Continue locally** on desktop: the owner moves a cloud thread home; anyone else gets a
      copy and the cloud thread stays live.
    - **The agent link**: one member-scoped link from the Mac to Pair Cloud; local agents launch,
      delegate and move threads there as the member.
    - User guide: `[Move a thread](../user/cloud.md#move-a-thread-between-your-mac-and-pair-cloud)`.
- **Types and services:** none.
- **Commands and events:** none.
- **Migrations:** none.
- **Not changed, and why** (each checked):
  - `docs/user/keybindings.md`: Continue in cloud has no command (3.23).
  - `docs/user/team.md`: ownership of a moved thread is "you own it", said in the cloud guide;
    team.md's "What is yours and what is shared" (233) holds as written.
  - No new page: moving is part of Cloud, and the link is part of agents and automation.
  - `docs/internals/remote.md` and `environment-auth.md`: 3.19 and 3.20 change them.

**Tests.** None; docs only.

**Verify.** `vp run check:changed` (formatting and links). Every new anchor resolves:
`cloud.md#move-a-thread-between-your-mac-and-pair-cloud`,
`outside-agents.md#pair-cloud-from-your-macs-agents`. Then the primary agent walks the new sections during
the M3 integrated pass (steps 1–5): every control named exists with that label, every
"stays" item stays, and the 512 MB and history-cap numbers match the code.

**Reviewer checks.**

- No section narrates buttons, layouts or every UI state; each answers what to do, what it needs,
  and what surprises (unpushed work moves, ignored files don't, untracked secrets do).
- Facts match landed code: labels, the access ceiling and expiry of a link, the cap numbers, who
  gets a copy, and that an asleep machine isn't woken.
- Internal text records constraints, not the feature: the export's provenance and the laptop-only
  direction.
- Surfaces: Docs. The other entries are the rows it documents.

## M3 integrated pass

One run of [G3](../10-delivery-plan.md#g3-end-of-m3) after the last M3 wave, by the primary agent
with the maintainer for the marked steps. It follows the install guide, the cloud guide (3.26),
[test-t3-app](../../../../.agents/skills/test-t3-app/SKILL.md) and
[test-t3-mobile](../../../../.agents/skills/test-t3-mobile/SKILL.md). Pair Cloud runs from a
release, never from `~/pair`; the Mac runs M3's local server from a worktree at the same release
tag. Subagents don't start their own servers.

0. **Before.**
   - **The release (maintainer).** Cut `V4` (`0.1.7-pair.4`, or `<upstream>-pair.<n+1>` if
     upstream moved) from `feat/pair` after the last M3 row: push the `v<version>` tag, let the
     release workflow publish it, then `gh release edit v<version> --prerelease`. Releases are
     public; ask the maintainer before tagging.
   - **The VM.** `gcloud compute instances start pair-cloud-pass --project vm-provider --zone
     asia-south1-a`, then `gcloud compute ssh …`. The CLI is `~/.local/bin/t3`, off `PATH` in a
     non-interactive shell. Check that the G2 settings survived (App ID 5668078 and key, the Claude
     team account, the member's GitHub connection, Docker on gVisor with the DNS shim, team cap 6)
     and that `t3 service status` reports V3. Delete `~/g2-local` (it holds a copy of the Claude
     setup token).
   - **Upgrade.** `t3 drain`, then `t3 update <V4> --yes`. Passes when `t3 --version` prints `V4`,
     a G2 machine wakes on V4, and the environment's capabilities report `cloudLaunch` and
     `cloudImport` (capture).
   - **The Mac (maintainer).** Two worktrees at the `v<V4>` tag beside the lead's folder, each
     with `vp i` and its own state: `g3-a` for the maintainer (member A) and `g3-b` for the second
     member (member B). Seed `g3-a` with `vp run migrate-dev-db`. Start each with `vp run dev` and
     record the PIDs at spawn. Each local server has a clone of `rutvikchandla3/pair-cloud-test`
     as a local project. Member B exists on Pair Cloud (`t3 member invite Teammate --github
     <login>` on the VM) with their own Claude account (setup token) and GitHub.
   - **Links (3.19).** Leave Linked environments off in Labs on every server. For each member,
     add Pair Cloud to that worktree's client, signed in as that member, then link its local
     server to Pair Cloud from Settings → Environments → **Link** (Pair Cloud is preselected).
     Passes when each link lists as reachable without the beta and Pair Cloud's Sharing & access
     shows each "Pair · …" session under its own member (as 3.19's transcript step 4).
1. **Continue in cloud (Mac, Credentials).** In `g3-a`, start a local worktree thread on
   `pair-cloud-test` and run two Haiku turns that leave: two commits not on origin, a changed
   tracked file, an untracked `notes/seed.md`, an untracked `scratch.env` that isn't ignored, and
   an ignored `node_modules/` folder. Open the thread menu → **Continue in cloud…**.
   Passes when:
   - the preview lists both commits, the changed file, `notes/seed.md` and `scratch.env`, and
     not `node_modules/` (capture);
   - after excluding `scratch.env` and confirming, the cloud session opens on Pair Cloud;
   - in its terminal, `git log` shows both commits, `notes/seed.md` and the tracked change are
     there, and `scratch.env` is not;
   - the cloud thread shows the local conversation as read-only history;
   - a Haiku turn ("what did we do so far, and what's left?") answers from that history;
   - the local thread shows "Continued in cloud" linking to the cloud thread (capture), and its
     worktree and branch are unchanged.

   Record the seed's size and upload time from the `cloud move` line in `g3-a`'s
   `server.trace.ndjson` (`seedBytes`, `uploadMs`). Repeat the move with a pushed branch and a
   clean tree, which needs no seed, and once from the command palette.

2. **Continue locally, owner (Mac).** On the step 1 cloud session, have Haiku change a file and
   leave it uncommitted. Then, from `g3-a`'s client, open the thread menu → **Continue locally**.
   Passes when:
   - a new local worktree is on the session's branch, with the cloud commits and the uncommitted
     change;
   - the new local thread has the history and links back;
   - the cloud session shows "Continued locally on `<g3-a's environment label>`", settles, and its
     container stops (`docker ps -a`).

   Then wake that session, **Sleep now**, and continue it locally again. Passes when the
   container stays stopped throughout (the sleep snapshot serves) and the local result matches.

3. **Continue locally, another member (Mac).** Start a fresh cloud session as member A and
   leave a change. From `g3-b`'s client, signed in as member B, run **Continue locally** on it.
   Passes when:
   - member B gets a local thread on a new branch (`<branch>-copy`), and the cloud session shows
     "`<member B>` copied this thread to `<g3-b's environment label>`";
   - the cloud session stays awake and takes a new prompt from member A;
   - no branch was pushed to GitHub (`git ls-remote`).
4. **The agent link (Mac, Credentials).** In a local `g3-a` thread, ask the agent (Claude Haiku)
   to delegate a small task to Pair Cloud. Passes when:
   - it calls `delegate_task` with the Pair Cloud environment;
   - a cloud session starts there attributed to member A, under A's accounts and the team cap;
   - the result comes back to the local thread.

   Then:
   - ask it to continue its own thread in cloud: it calls `t3_thread_continue_in_cloud` and the
     move matches step 1;
   - from `g3-a`'s terminal, `t3 thread start --environment <Pair Cloud's id> --cloud main`
     launches there, and the same without `--cloud` says to pass it;
   - with Linked environments on in Labs on both Mac servers, link `g3-a` to `g3-b` and ask for a
     `cloud` delegation there: `g3-b` doesn't report `cloudLaunch`, so it is refused with the
     typed failure. Turn the beta off again after.

5. **Phone (Phone).** On the maintainer's iPhone, paired with the Mac and with Pair Cloud, open a
   Mac thread's header **Cloud** menu → **Continue in cloud…** (and once from the row's
   long-press menu). Passes as step 1, with the preview as a sheet. This needs a
   Pair build signed by a paid Apple Developer team, as G1's and G2's phone steps did; without
   one, set it aside and say so.

Evidence (redact pairing links, startup URLs and tokens from all of it):

- G3's video, with a move each way (steps 1 and 2).
- Captures of the preview and of the "Continued in cloud on `<label>`" and "Continued locally on `<label>`" rows, on
  web and desktop.
- The `mcp-tool-use` eval output for 3.19 and 3.23, run with an `ANTHROPIC_API_KEY` in the
  repo's `.env`.
- The seed size and upload time.
- The upgrade transcript.

Record the run in progress.md's M3 section. Stop only the processes this run started, by the PIDs
it captured, and remove `g3-a` and `g3-b` when done. Stop the VM when idle; never delete it.
