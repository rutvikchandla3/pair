# M4 Team images: implementation specs

Status: implementation plan, 2026-11-10. Nothing here is built. Read [README](./README.md) first
for the shared names and traps, and [M3](./m3-continue-in-cloud.md) for what this milestone builds
on. The design is [05](../05-team-images.md), with [04 §6](../04-sandbox-lifecycle.md) for the
driver interface and [08 §9](../08-clients-and-contracts.md) for the contracts; the PR list is
[10 §2](../10-delivery-plan.md#m4-team-images), and [m2-m5](./m2-m5.md#m4-team-images) has each
row's scope as first sharpened. 05 §9 numbers the same rows 4.1–4.12, so its 4.1 is 4.11 here.

Each PR follows one template: what it makes true, Needs and Unblocks, Files, Types and services,
Commands and events, Migrations, Tests, Verify, Reviewer checks. Line numbers are from `feat/pair`
at `56b69e76c` (2026-11-10); re-read the symbol before editing, since 3.23 and the M3 fixes land
on top of this commit. Where a spec says **proposed**, it fills a gap the design docs left open; a
reviewer can overrule it in that PR, and the spec names what else would change.

M4's PRs merge after [G3](../10-delivery-plan.md#g3-end-of-m3) passes. G4 closes M4 together with
M5; G4 step 1 is M4's own, runs on the G3 server's Docker driver, and the
[last section](#m4-integrated-pass) turns it into steps. Steps 2–6 need M5 and an AWS account.

Decisions this milestone records (accepted 2026-11-08, not reopened here):

- **#9: one Pair recipe per team, in the database.** A base, the projects to pre-clone, build env,
  build secret references and one Bash install script. Image bases for Dockerfile and dev
  container teams (`base: { type: "image" }`) are not M4: the M4 schema has only `{ type: "pair" }`.
- **#10: an agent's build is announced to the admins who wrote its run.** A member's build is
  announced to the member who started it.
- **M4 is Docker only.** AMIs (5.7) and the hosted driver (old 3.6) are out. Every build goes
  through the driver's `create`, `snapshot` and `destroy`, so 5.7 adds a capture, not a flow.

Engineering calls made here:

- **Sandbox effects stay on the thread key (4.11).** The outbox gains an aggregate key for
  team-image effects only. Moving `sandbox.*` effects onto a sandbox key would drop 1.17's
  hand-over queue move, but nothing measured turns blocked behind sandbox retries; 4.11 leaves
  every thread row exactly as it is.
- **The Docker first-boot copy (4.17)** becomes a lazy copy per project at checkout, not a move at
  first boot: when a session checks out a project whose clone is in the image, it copies
  `/t3-sandbox/.image/repos/<host>/<owner>/<name>` into the sandbox volume with `cp -a`, then
  fetches as today. Stores under `$HOME` stay in the container layer and need no copy. 4.17
  measures `cp -a` against `git clone --shared` (alternates into the image layer) and a network
  clone, on gVisor, for the largest pre-cloned repo. **Default: the copy.** Switch to `--shared`
  only if the copy's median is over 30 s (**proposed** threshold), and record the numbers in
  progress.md either way.

## Build order

Waves respect every Needs below. About four workers run at once; two rows in one wave that touch
the same file land one after the other, in the order listed. **Critical** rows run on Opus at high
effort, **small** rows on Sonnet at high effort (the maintainer's answer of 2026-11-10).

| Wave | PRs                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | 4.11 outbox aggregate key (critical), 4.12 contracts (small)                                                                 |
| 2    | 4.13 team-image aggregate (critical)                                                                                         |
| 3    | 4.14 Docker builds (critical)                                                                                                |
| 4    | 4.16 activate, roll back and GC (critical), then 4.15 leak check and redaction (small)                                       |
| 5    | 4.17 boot from the build (critical), 4.18 Team image page (small), then 4.19 admin agent (critical)                          |
| 6    | 4.20 proposals (small), 4.21 mobile (small), then 4.22 rebuild hint (small); then the [integrated pass](#m4-integrated-pass) |

Same-file order inside a wave:

- Wave 4: 4.16 and 4.15 both touch `TeamImageCommands.ts` and `TeamImageBuildLog.ts`; 4.16 lands
  first because 4.17 waits on it.
- Wave 5: 4.18 writes the **Build a team image** section of `docs/user/pair-cloud.md` that 4.19
  adds a paragraph to, so 4.18 lands first; 4.19 can be built in parallel and rebased. 4.17 shares
  no file with either.
- Wave 6: 4.20 and 4.22 both edit `TeamImageSettings.tsx` and `TeamImageService.snapshot`; 4.20
  lands first. 4.21 touches neither.

The critical path is 4.11 → 4.13 → 4.14 → 4.16 → 4.17 → 4.22 → the pass, with 4.19 → 4.20 beside
it from wave 5. The pass also needs a prerelease that contains every M4 row.

| PR   | Needs (final)     | Size     |
| ---- | ----------------- | -------- |
| 4.11 | M2                | critical |
| 4.12 | M2                | small    |
| 4.13 | 4.11, 4.12        | critical |
| 4.14 | 4.13              | critical |
| 4.15 | 4.14              | small    |
| 4.16 | 4.14              | critical |
| 4.17 | 4.16              | critical |
| 4.18 | 4.15, 4.16        | small    |
| 4.19 | 4.16              | critical |
| 4.20 | 4.18, 4.19        | small    |
| 4.21 | 4.16, 4.18 (copy) | small    |
| 4.22 | 4.17, 4.18        | small    |

## What the code changed in 10 §2

Drafting each PR against the code changed the plan in these ways. The [track notes](#track-notes)
give the evidence.

- **Order.** 4.18 needs 4.15 as well as 4.16: the page is the first place anyone starts a build,
  and logs must be redacted before then. 4.20 needs 4.18, since its review UI lives on the page.
  4.22 needs 4.18 for the same reason. 4.21 needs 4.16, whose `buildFinished` it pushes. The
  waves of 10 §2 hold, with 4.18 landing before 4.19 inside wave 5.
- **Smaller than the rows said.**
  - 4.11 adds no lock. The only writer of the team-image stream is `TeamImageService` (4.13), which
    holds one semaphore, as `ProjectService` holds its `KeyedLock<ProjectId>` (ProjectService.ts
    183). Team-image events are invisible to every existing reader, which filter by
    `aggregate_kind` (OrchestrationEventStore.ts 432–434), so no reader changes.
  - 4.12 carries schemas only. Each RPC method lands with its handler: `RPC_REQUIRED_SCOPES`
    `satisfies Readonly<Record<WsRpcMethod, …>>` (RpcAuthorization.ts 227), so a method in the
    group without a handler and a scope breaks the server's typecheck. 4.13 adds `subscribe`,
    `saveRecipe`, `startBuild`, `cancelBuild` and `readRecipeRevision`; 4.14 `subscribeBuildLog`;
    4.16 `activateBuild`; 4.20 `dismissProposal`.
  - A build does not copy its recipe. Recipe revisions are immutable rows, so a build's
    `recipeRevision` is the copy, and **Restore recipe** reads that revision.
  - 4.14 needs no `RunnerHubFacts` change. `ComputeDriverCheck` already boots a machine with no
    sandbox record, waits for its runner and runs commands through `WorkspaceHosts.forPath`
    (ComputeDriverCheck.ts 59–235); a build does the same, and learns of the runner from
    `RunnerHub.boots` (RunnerHub.ts 129–132, 174–175).
  - 4.19 has no image-thread flag. 05 §7 gives the tools only to image threads to save context,
    but the MCP server registers one tool list for every session at start (McpHttpServer.ts
    `layerTools`, 1206–1219; `registerToolkit` at 1036–1062) and has no per-session listing. A
    per-session list is a new MCP-server feature; M4 instead advertises the tools everywhere with
    short descriptions, gates them in each handler, and pays the bytes (below). **Edit with an
    agent** starts an ordinary cloud session.
- **Larger than the rows said.**
  - 4.11: the claim predicate compares `active.thread_id = candidate.thread_id` (EffectOutbox.ts
    413). With a nullable `thread_id`, two team-image rows would never block each other (`NULL =
    NULL` is not true), so the predicate compares the aggregate key instead.
  - 4.14: the reconciler enters restore mode for any tagged backend with no sandbox record past a
    5-minute grace (SandboxReconciler.ts 280–311). A 45-minute build machine would trip it. 4.14
    makes the reconciler skip a live build's machine and destroy a finished one without counting
    it.
  - 4.13: a build machine counts against the cap, but `SandboxAdmission.snapshot` counts only
    sandbox records (SandboxAdmission.ts 68–75), and `t3 drain` waits for turns only (ServerDrain.ts
    62–80). 4.13 adds the live build to both.
  - 4.19: five tool descriptions in every session raise `mcpToolListJsonBytes` from 48,788 to
    50,313 (+1,525) in `agentContextBudget.json`, so the PR carries the `agent-context-increase`
    label. They are hidden on a server without `teamImages` (`McpInvocationScope.teamImages`, set
    from `cloudOnly` per request, read by `hiddenWithoutTeamImages`).
  - 4.21: `MemberPushNotifier` only streams thread domain events (MemberPushNotifier.ts 311–343) and
    builds its deep link from a thread id (264–267); the build push is a second, non-thread path.
- **Where the code and the design differ.**
  - The sandbox record carries `imageBuild: { id, number }`, not `imageBuildId` alone, because the
    machine details show "Build 14" and `sandboxImageLabel` (contracts sandbox.ts 122) reads only
    the record.
  - The effect 05 calls `team-image.build.cancel` is `team-image.build.destroy-machine`: it runs
    after every end state (success, failure, cancel), not only on cancel.
  - The build's clone token comes from `GitHubAppInstallationTokens.tokenFor({ sandboxId,
    repository })` keyed by the build machine's id, else the requester's `MemberGitHub.credentialFor`,
    passed in the program's environment. `GitCredentialService.answer` is for sandboxes with a
    thread and is not changed.
  - The image's `imageEnv` reaches processes through the runner, which reads it from
    `/etc/t3/build.json` into `RunnerInfo.imageEnvironment` (RunnerConfig.ts 85–88); the server's
    `sandboxBaseEnvironment` already layers that first (SandboxProcessEnvironment.ts 40–66, and
    218–221 for the host's environment). This works on every driver, and the runner bundle is
    fetched from or bound to the server at each boot, so images built before a server upgrade get
    the new runner.
  - "Not in the team image" is a thread notice (`thread.notice.record`, as `recordRebuild` in
    ThreadLaunchService.ts 341–353), not a line in the setup panel, whose snapshot has no message
    field (contracts worktreeSetup.ts 43–61).
- **Migrations.** Three, each taking the next free id at merge (P8): `094_OutboxAggregateKey`
  (4.11), `095_TeamImages` (4.13) and `096_TeamImageProposals` (4.20). The sandbox record lives in
  `payload_json` (migration 088), so `imageBuild` needs none.
- **Found outside M4.** `ComputeDriverCheck`'s comment says the reconciler destroys a machine a
  crash left as an orphan; the reconciler would enter restore mode instead if it outlived the
  5-minute grace. 4.14's skip list covers build machines only; the check's case needs a fix PR of
  its own if a check machine is ever left behind.

Open maintainer questions. The maintainer is away; every answer below is the **proposed** one this
page builds on, and a reviewer can overrule it in the named row.

- **A build when every machine slot is taken (4.13).** Refused with "Every machine is in use. Build
  when one frees up, or raise the limit in Compute." A build never waits in the admission queue.
- **Two admins editing the recipe (4.13).** A save names the revision it started from and is
  refused with "Someone saved the recipe since you opened it" when that is no longer current.
- **What a build runs on (4.13).** The default driver. Only sessions on that driver boot from the
  build; others boot the base.
- **The build timeout (4.13).** 45 minutes from the request, and 10 minutes from launch to the
  runner's first hello.
- **History (4.13).** The snapshot carries the newest 20 builds plus the active one. Rows are never
  deleted; a removed image leaves the row with `imageDeletedAt`.
- **`t3 drain` during a build (4.13).** New builds are refused; the drain waits for a running one,
  and the CLI says so.
- **Effect bounds (4.11).** Launch, destroy-machine and delete-image 60 s; capture 20 minutes,
  since a commit of a 10 GB layer on a slow disk can pass 10.
- **Clone credentials (4.14).** The GitHub App's one-repo token when the App is set up, else the
  GitHub connection of whoever started the build (an agent build: its run's first author).
- **The log (4.14).** 5 MiB per build: the first 1 MiB and the last 4 MiB, joined by a line saying
  how much was left out. A failed build keeps its last 30 lines on the record.
- **Retention (4.16).** Keep the active build, every build a live sandbox uses and the newest 5
  other succeeded builds (setting, 1–20; "other" keeps a rollback target when the newest is active). Failed and cancelled builds' logs go after 30 days; a removed
  image's log goes with it.
- **Who may call the image tools (4.19).** Every session sees all six; per-session tool lists (05
  §7's image threads) are Later, since they need a new MCP-server feature. Reads are open to any thread
  and to any client with read access, since members see the page read-only. Changes need a run
  whose every human author is an active admin, or a non-read-only client token of an active admin.
  A guest's message, a message with no human author, or a member's steer takes the run's authority
  away.
- **Who hears that a build finished (4.16, 4.18, 4.21).** A build started on the page: whoever
  started it. An agent's build: the admins among its run's authors (decision #10), minus whoever
  cancelled it. A toast on web and desktop unless the Team image section is open, and a push on
  mobile.
- **Edit with an agent (4.18).** An ordinary cloud session on a project the admin picks, booted from
  the active build, with a first message the admin can edit. **Fix with an agent** is the same with
  the failure in the message.
- **Proposals (4.20).** One open proposal per thread, at most 20 open per server. **Accept** loads it
  into the editor unsaved; saving closes it as accepted.
- **No CLI in M4.** `t3` gains no image command; agents use MCP and people use the page.
- **The first-boot copy threshold (4.17).** 30 s.
- **The context budget (4.19, 4.20).** Raised by what the six tools measure, at most 6,000 bytes
  in all; past that the descriptions are cut, not the tools. Both PRs need the
  `agent-context-increase` label from a maintainer.
- The 4.19 and 4.20 evals need an `ANTHROPIC_API_KEY` in the repo's `.env` (still open from G1; the
  maintainer adds it).

## Shared names

The names below cross PRs. Each is defined by the PR in brackets; later PRs use it as written.

- **Contracts (4.12)**, in a new `packages/contracts/src/sandboxImage.ts` unless noted:
  - `TeamImageBuildId` (`tib_` plus 20 lowercase hex), in `sandbox.ts` beside `SandboxId`, since the
    sandbox record uses it; `TeamImageProposalId` (`tip_` plus 20 hex).
  - `TeamImageBase` (`{ type: "pair" }` only), `TeamImageRecipe`, `TeamImageRecipeRevision`,
    `TEAM_IMAGE_INSTALL_MAX_CHARS` (64,000), `TEAM_IMAGE_MAX_PROJECTS` (50).
  - `TeamImageBuildStatus`, `TeamImageBuildPhase`, `TeamImageBuildFailure`, `TeamImageRequester`,
    `TeamImageManifest`, `TeamImageBuild`, `TeamImageProposal`, `TeamImageSnapshot`,
    `TeamImageError` and its reasons.
  - RPC inputs: `TeamImageSaveRecipeInput`, `TeamImageStartBuildInput`, `TeamImageBuildRef`,
    `TeamImageReadRecipeInput`, `TeamImageBuildLogChunk`, `TeamImageDismissProposalInput`.
  - Elsewhere: `OrchestrationV2Sandbox.imageBuild` and `sandbox.provision`'s `imageBuild`
    (`SandboxImageBuildRef = { id, number }`), `ExecutionEnvironmentCapabilities.teamImages`,
    `SandboxSettings.teamImage.keepSucceeded`, `ServerDrainStatus.runningBuilds`.
- **Outbox (4.11).** `TEAM_IMAGE_STREAM_ID` (`"team-image"`, the one stream per server),
  `TeamImageEffectRequestV2` (types `team-image.build.launch`, `.run-program`, `.capture`,
  `.destroy-machine`, `.delete-image`), `TeamImageEffectV2`, `PendingTeamImageEffectV2`,
  `isTeamImageEffect`, `EffectOutboxV2.cancelUnsettledTeamImage`, `EventSinkV2.commitTeamImageCommand`
  and `commitRejectedTeamImageCommand`, `OrchestrationEventStore.appendTeamImageEvents`, and the
  `TeamImageEffects` service tag (`execute`, `reportExhausted`).
- **The aggregate (4.13)**, in `apps/server/src/sandbox/image/`:
  - `TeamImageCommands.ts`: `TeamImageCommand` (server-internal; never on the wire),
    `TeamImageEvent`, `decideTeamImageCommand`, `TeamImageState`.
  - `TeamImageStore.ts` (the three tables), `LiveTeamImageBuild`, `TeamImageService` (`dispatch`,
    `snapshot`, `changes`, `saveRecipe`, `startBuild`, `cancelBuild`, `readRecipeRevision`; 4.14
    adds `subscribeBuildLog`, 4.16 `activateBuild` and `buildFinished`, 4.20 `dismissProposal`),
    `TeamImageWorker` (scheduler source `"team-image"`).
  - Events: `team-image.recipe-saved`, `team-image.build-updated`; 4.16 adds
    `team-image.active-changed` and `team-image.log-deleted`; 4.20 adds
    `team-image.proposal-updated`.
- **Builds (4.14).** `ComputeDriver.snapshot`, `DockerEngineApi.commit`, the image name
  `t3-team-image:<number>`, `TEAM_IMAGE_ROOT` (`/t3-sandbox/.image`; clones go to
  `clonePathFor(TEAM_IMAGE_ROOT, url, projectId)`), `BUILD_MANIFEST_PATH` (`/etc/t3/build.json`),
  `teamImageBuildProgram`, `TeamImageBuildLog`, `TeamImageEffectsLive.ts` (the layer for 4.11's
  tag), `CloudPreparation.clonePathFor` (now exported).
- **Activation (4.16).** Commands `team-image.build.activate`, `.collect`, `.log-deleted`;
  `planTeamImageCollection`; `ProjectionStore.listSandboxImageBuildIds`;
  `TeamImageService.buildFinished` (`TeamImageBuildFinished { build, recipients }`).
- **Boot (4.17).** `CloudPreparation.resolveCloudLaunch`'s `imageBuild`, `checkoutInSandbox`'s
  `cloneSource`, the runner's `imageEnvironmentFrom`.
- **Client (4.18).** client-runtime `createTeamImageAtoms` (the snapshot subscription, the log
  subscription, the commands) and `teamImagePresentation.ts` (`teamImageBuildPresentation`; 4.22
  adds `rebuildSuggestion`); web `TeamImageSettings`.
- **Agent (4.19).** `apps/server/src/mcp/toolkits/sandboxImage/` (05 §7's folder),
  `TeamImageAuthority.forCaller`, `ProjectionStore.listRunUserMessages`, the tools
  `t3_team_image_read`, `t3_team_image_build_log`, `t3_team_image_recipe_update`,
  `t3_team_image_build_start`, `t3_team_image_build_cancel`, `t3_team_image_propose` (4.20).
- **Notifications (4.21).** `@t3tools/shared` `teamImageBuildNotification(build)` and
  `TEAM_IMAGE_DEEP_LINK`, and `MemberPushNotifier.sendToMembers`. The server cannot import
  client-runtime, so `teamImageFinishedMessage` (the copy of the web toast and the push body) lives
  in `@t3tools/shared/teamImageBuildMessage` and client-runtime re-exports it.

## Track notes

### The outbox and the aggregate (4.11, 4.12, 4.13)

#### PR list and order

- 4.11 and 4.12 share no file and land in wave 1. 4.13 is the first row that writes team-image
  events and effects.
- 4.11 is the only row that changes thread code paths. Its rule: every existing thread test passes
  without edits. A thread fixture that constructs `OrchestrationEffectV2` must still compile, so
  `OrchestrationEffectV2` and `PendingOrchestrationEffectV2` (EffectOutbox.ts 219–240) keep their
  shape, and the team-image variants are separate types.

#### Where the code and the design differ (code wins on facts)

- **Events are kept, but the projection is the truth.** Event pruning keeps only each stream's head
  (ProjectionMaintenance.ts 97–145, by `aggregate_kind` and `stream_id`, kind-agnostic), so
  team-image events are pruned like any other and the tables of 095 are never rebuilt from them.
  They carry no `orchestration_v2_` prefix, for the reason migration 088 gives for the usage
  ledger. Events still go through the event store with a command receipt, so a replayed
  `commandId` returns its first receipt, as project commands do.
- **Team-image events never reach clients.** `ApplicationStoredEvent` (contracts
  applicationEvent.ts 115) stays project and thread events. Clients read `teamImage.subscribe`, a
  snapshot then each change, built by the service.
- **One build at a time makes the lock trivial.** A single `Semaphore` in `TeamImageService`
  serializes every command. A build request also takes `SandboxAdmission.withLock` first (it is
  "always taken before any thread lock", SandboxAdmission.ts 33), so the slot count and the commit
  agree.
- **Effects need bounds.** `EFFECT_TIMEOUTS` (EffectWorker.ts 664–685) is keyed by replay-safe types
  only, so `run-program`, which is process-bound, gets no entry; it returns as soon as the spawn is
  acknowledged, and the program runs in a fiber the service holds.

#### Smaller proposals

- `team-image.build.request` takes the recipe revision the client saw, so **Save and build** never
  builds a revision someone saved in between.
- A failed or cancelled build destroys its machine in the same commit (`destroy-machine`), and a
  succeeded one after its capture.
- Queued and capturing builds survive a restart (launch and capture are replay-safe); a launching
  or running build fails as `interrupted`, since its program died with the process.

### Builds on Docker (4.14, 4.15, 4.16)

#### PR list and order

- 4.14 is the largest row in M4. Its driver half (`ComputeDriver.snapshot`, `DockerEngineApi.commit`,
  the fake in `ComputeDriverTesting.ts`) needs nothing from 4.13; the worker may build it first as a
  separate commit in the same PR. Proposed: no split.
- 4.15 and 4.16 both extend 4.14's files; 4.16 first (critical path).

#### Where the code and the design differ (code wins on facts)

- **`docker commit` skips volumes.** The sandbox volume is mounted at `/t3-sandbox/<sandboxId>`
  (DockerComputeDriver.ts 182), and binds and the `/run/pair-runner` tmpfs are not committed either.
  So the build writes `/t3-sandbox/.image` in the container layer. `/t3-sandbox` is root-owned 0755
  (provision.sh 103), so the program creates `.image` with `sudo install -d -o t3` (t3 has
  passwordless sudo, provision.sh 78–81); no base image change.
- **The committed image keeps the container's config.** `containerCreateBody` sets `Env: []` and
  writes the bootstrap through `putArchive` (DockerComputeDriver.ts 165, 605–644), and
  pair-bootstrap.sh deletes the bootstrap file at start, so nothing secret is in the config or the
  layer. `docker commit` merges the container's labels into the image, so its `pair.*` labels
  carry over; every session's create sets the same keys, which win. The commit adds
  `pair.team-image.build=<tag>` for `docker image ls` and `pair.team-image.machine=<driverRef>`,
  and a replay returns an image only when both match, so two installs sharing a daemon cannot
  take each other's image. 4.14's contract test asserts the resulting label set.
- **The runner bundle is not baked on a local daemon.** It is bind-mounted (DockerComputeDriver.ts
  187–200), and sessions fetch or bind the server's bundle at boot as today. So 05 §3's verify step
  skips `t3 runner prefetch`, and the manifest records the server version instead of a bundle id.
- **Restore mode.** See [What the code changed](#what-the-code-changed-in-10-2). The reconciler gets
  the build machines from `TeamImageStore.machines()`; an unknown tagged backend still means a
  restore. In restore mode it leaves a finished build's machine alone, as it does any machine it
  would destroy.
- **Phases come from the program.** It prints `::t3-phase::<phase>` lines; the log writer strips
  them and the service dispatches `team-image.build.phase`. Leaks print `::t3-leak::<NAME>::<path>`
  (4.15), never the value.

#### Smaller proposals

- Builds run with the default driver's size.
- `team-image.build.capture` gets 20 minutes, not 10: a commit of a 10 GB layer on a slow disk can
  pass 10.
- GC runs daily and after each success, through the `"team-image"` scheduler source.

### Sessions, the page and the agent (4.17–4.22)

#### PR list and order

- 4.17 and 4.19 are independent server rows on top of 4.16. 4.18 is web and client-runtime only, plus
  the user guide.
- 4.20 needs 4.19's toolkit folder and 4.18's page. 4.21 needs 4.16's `buildFinished` and 4.18's
  copy (the phrases in `teamImageBuildPresentation`). 4.22 needs 4.17's boot path and 4.18's page.

#### Where the code and the design differ (code wins on facts)

- **The move at first boot.** See the engineering call above. Copying lazily per project means a
  session that never opens a project never copies it, and a sleeping machine wakes with its copy.
- **Pre-cloned paths.** The build and `checkoutInSandbox` must agree on the path, so 4.14 exports
  `clonePathFor` (CloudPreparation.ts 242–249) and the program receives each path from the server
  rather than computing it.
- **Stores on Docker.** A pnpm store under `$HOME` is in the container layer and a session's
  worktree is in the volume, another filesystem, so pnpm copies rather than hard-links. The install
  still makes no network fetch. 4.17 records the setup script's time with and without the build in
  its transcript; 05's "a hard-link pass" holds on VM drivers only.
- **The tools' audience.** See above (no per-thread filtering). The eval cases from 05 §7 stay.
- **Mobile.** The machines screen already exists (SettingsMachinesRouteScreen.tsx, 155 lines); 4.21
  adds a section to it, not a screen.

#### Smaller proposals

- The page is a section of Settings → Cloud, **Team image**, after **Compute** (CloudSettings.tsx
  369–510), with its own searchable id `cloud-team-image`.
- The user guide gains a **Team image** section in 4.18 and one paragraph each in 4.19 and 4.20; M4
  has no docs row of its own.

## PR specs

### 4.11 `feat(server): key outbox effects by aggregate`

**Critical.** The effect outbox can hold an effect that belongs to no thread. Each row carries an
aggregate key, `thread` plus a thread id for every effect today and `team-image` plus
`TEAM_IMAGE_STREAM_ID` for builds, and the worker runs at most one effect per key at a time, as it
runs one per thread now. The event store, command receipts and `EventSinkV2` accept a `team-image`
aggregate, so 4.13 can commit a command, its events and its effects in one transaction. Nothing
user-visible changes, and every thread path behaves exactly as before.

- **Needs:** M2. **Unblocks:** 4.13 (every team-image command and effect).
- **Files:**
  - Migration `apps/server/src/persistence/Migrations/094_OutboxAggregateKey.ts` (next free id at
    merge, P8), registered in `Migrations.ts` after `[93, "StagedCloudImports", Migration0093]`
    (195) and added to both lists in `reconcileV2PreviewMigration.test.ts` (after 75 and 191).
    Rebuild the table as `Migrations/OrchestrationV2/EffectCancellation.ts` did: create
    `orchestration_v2_effect_outbox_next` with every current column, except that `thread_id`
    becomes nullable, plus
    ```sql
    aggregate_kind TEXT NOT NULL DEFAULT 'thread'
      CHECK (aggregate_kind IN ('thread', 'team-image')),
    aggregate_id TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(thread_id, aggregate_kind)) VIRTUAL,
    CHECK ((aggregate_kind = 'thread') = (thread_id IS NOT NULL)),
    ```
    `aggregate_id` is derived, not written: a thread row's key is its thread id, and the one
    team-image stream is named after its kind, so the thread writers and the test fixtures that
    insert raw outbox rows stay as they are. Then `INSERT INTO …_next (rowid, …, aggregate_kind)
    SELECT rowid, …, 'thread' FROM orchestration_v2_effect_outbox ORDER BY rowid` (the claim
    predicate orders by `rowid`, so the copy keeps it), `DROP`, `ALTER TABLE … RENAME`, and
    recreate the three indexes
    (`_claim_idx`, `_command_idx`, `_thread_status_idx`) plus
    `orchestration_v2_effect_outbox_aggregate_idx (aggregate_kind, aggregate_id, status)`. One
    transaction, as the migrator runs it.
  - `apps/server/src/orchestration-v2/EffectOutbox.ts`:
    - `TEAM_IMAGE_STREAM_ID = "team-image"`.
    - `TeamImageEffectRequestV2`, a union beside `OrchestrationEffectRequestV2` (which ends at
      160), with the payloads 4.13 and 4.14 need:
      ```ts
      | { type: "team-image.build.launch"; imageBuildId: TeamImageBuildId }
      | { type: "team-image.build.run-program"; imageBuildId: TeamImageBuildId }
      | { type: "team-image.build.capture"; imageBuildId: TeamImageBuildId }
      | { type: "team-image.build.destroy-machine"; imageBuildId: TeamImageBuildId }
      | { type: "team-image.build.delete-image"; imageBuildId: TeamImageBuildId;
          driverId: ComputeDriverId; imageRef: string }
      ```
      Each effect reads the build row when it runs; the payload is only the key, so a cancel that
      commits between enqueue and claim is seen. Type `imageBuildId` as a plain `string` in this PR
      so 4.11 does not wait for 4.12 in the same wave; 4.13 swaps in `TeamImageBuildId`.
      (`ComputeDriverId` already exists.)
    - `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS` (163–183) gains launch, capture,
      destroy-machine and delete-image, and its `satisfies` clause widens to both unions.
      `PROCESS_BOUND_EFFECT_TYPES` stays thread-only, because `ProviderRuntimeRecoveryService`
      passes it to the thread `cancelUnsettled`; a private `PROCESS_BOUND_TEAM_IMAGE_EFFECT_TYPES`
      holds run-program (its program died with the process, so 4.14's recovery fails the build
      instead), and `reconcileAfterProcessLoss` cancels both lists. None is runner-bound
      (194–201), so team-image effects run in the shared lane.
    - `TeamImageEffectV2` and `PendingTeamImageEffectV2`, shaped as `OrchestrationEffectV2` and
      `PendingOrchestrationEffectV2` (219–240) without `threadId`. Those two keep their shape, so
      no thread fixture changes. `ClaimedEffectV2 = OrchestrationEffectV2 | TeamImageEffectV2` and
      `isTeamImageEffect(effect)` (by `request.type` prefix).
    - `EffectRow.thread_id` (316–330) becomes nullable, and a row with no thread id decodes as a
      `TeamImageEffectV2`.
    - `claimableCandidatePredicate` (395–443): line 413 becomes `active.aggregate_kind =
      candidate.aggregate_kind AND active.aggregate_id = candidate.aggregate_id`. With a nullable
      `thread_id` the old comparison would let two team-image effects run at once (`NULL = NULL`
      is not true). The `provider-thread.rollback` and `thread-title.generate` clauses stay; they
      never match a team-image row.
    - `enqueue` (459) takes either pending shape and writes `aggregate_kind`: `thread` with the
      thread id, or `team-image` with a null `thread_id`. `claimNext` returns `ClaimedEffectV2`.
    - `get` also returns `ClaimedEffectV2`: the worker rechecks every claim's durable status
      through it. `listByCommandId` stays thread-only and skips team-image rows. New
      `cancelUnsettledTeamImage({ effectTypes, reason })`, the twin of `cancelUnsettled` (529–541)
      for the team-image key. `expedite` (550–558) is unchanged.
  - `apps/server/src/orchestration-v2/EffectWorker.ts`:
    - New tag `TeamImageEffects` in `apps/server/src/sandbox/image/TeamImageEffects.ts`:
      `execute(effect: TeamImageEffectV2, options?: { willRetry })` and
      `reportExhausted(effect, cause)`, both failing with `OrchestrationEffectExecutionError`. 4.11
      ships the tag only; 4.14 ships the live layer.
    - `layerExecutor` (106) reads it with `Effect.serviceOption`, as it reads `CheckpointMirror`
      (135), so executor tests need none. `execute` (171) and `reportExhausted` (137) branch on
      `isTeamImageEffect` first; with no service, a team-image effect fails with "Team images are
      not available on this server" and is not retried. `OrchestrationEffectExecutionError` gains
      an optional `retryable`; `false` sends the effect straight to `reportExhausted` and `fail`,
      which 4.14 can use for failures a retry cannot fix.
    - `EFFECT_TIMEOUTS` (664–685): launch 60 s, capture 20 min (**proposed**, see the track notes),
      destroy-machine 60 s, delete-image 60 s. run-program has none: it returns once the program
      is spawned. `maxAttempts` (753) stays 5.
  - `apps/server/src/persistence/OrchestrationEventStore.ts`: the row literal (170) widens to
    `"project" | "thread" | "team-image"`. New `appendTeamImageEvents({ commandId?, events })`,
    taking `TeamImageEventInput { eventId, type, occurredAt, payload }` and modeled on
    `appendProjectEventRow` (310–368): `aggregate_kind = 'team-image'`, `stream_id =
    TEAM_IMAGE_STREAM_ID`, the same `stream_version` computation, `application_event_version = 2`.
    It returns `StoredTeamImageEvent`s with their `sequence` and `streamVersion`. The payload is
    `unknown` here and encoded by the caller (4.13 owns the schema); existing readers filter by
    kind (432–434) and never see these rows. `EventStoreV2` passes it through.
  - `apps/server/src/persistence/OrchestrationCommandReceipts.ts` (16–25): `aggregateKind` gains
    `"team-image"` and `aggregateId` gains the stream id literal. `CommandReceiptStore.ts` adds
    `TeamImageCommandReceiptV2` (`streamId` in place of `threadId`) and
    `getTeamImageByCommandId`; `getByCommandId` and `getProjectByCommandId` return none for a
    team-image receipt, and no client reads one.
  - `apps/server/src/orchestration-v2/EventSink.ts` (interface 69–197): `commitTeamImageCommand({
    commandId, commandType, acceptedAt, events, effects, cancelUnsettledEffects?, apply })` and
    `commitRejectedTeamImageCommand({ commandId, commandType, rejectedAt, error })`. One
    transaction, as `commitCommandEffect` (635–711): the receipt replay check, the events, `apply`
    (a callback that writes the caller's projection rows inside the transaction, so 4.13's tables
    and the receipt agree), the cancel, then the effects; `notifyAvailable` after commit. A
    replayed command id returns its first receipt with `committed: false` and runs nothing. The
    caller holds the lock; EventSink takes none.
- **Types and services:** above. No lock here; 4.13's `TeamImageService` is the stream's only
  writer and holds one `Semaphore`.
- **Commands and events:** none of its own.
- **Migrations:** 094.
- **Tests:**
  - New `Migrations/094_OutboxAggregateKey.test.ts` (as `093_StagedCloudImports.test.ts`): rows
    keep their order, ids and statuses, become `thread`, and a `team-image` row with a thread id is
    refused by the `CHECK`.
  - `FoundationPersistence.test.ts`: two pending team-image effects claim one at a time; a
    team-image effect and a thread effect claim together; `cancelUnsettledTeamImage` leaves thread
    rows alone; `commitTeamImageCommand` applies, cancels and enqueues once and replays its
    receipt. Extend the existing claim cases rather than adding a file.
  - `EffectWorker.test.ts`: a team-image effect reaches a stub `TeamImageEffects.execute`, and its
    exhaustion reaches `reportExhausted`; with no service it fails once, unretried.
  - `OrchestrationEventStore.test.ts`: appended team-image events get versions 0, 1, … and do not
    appear in thread or project reads.
  - Every existing thread test passes unedited.
- **Verify:** `vp test run` on the four test files, `vp run typecheck` in `apps/server`.
- **Reviewer checks:** no thread fixture changed; the copy is `ORDER BY rowid`; the claim predicate
  compares both key columns; team-image rows never join `orchestration_v2_projection_sandbox_threads`.
  Surfaces: server only; nothing crosses the wire, no client, provider or MCP change.

### 4.12 `feat(contracts): add team image recipes, builds and RPC methods`

**Small.** The wire shapes for team images exist in `packages/contracts`, so the server rows and the
clients build against one set of names. Schemas only: each RPC method lands with its handler (see
[What the code changed](#what-the-code-changed-in-10-2)).

- **Needs:** M2. **Unblocks:** 4.13 and every later row.
- **Files:**
  - `packages/contracts/src/sandbox.ts`: beside `SandboxId` (7),
    `TeamImageBuildId` (`/^tib_[0-9a-f]{20}$/`, branded) and `SandboxImageBuildRef = Struct({ id:
    TeamImageBuildId, number: PositiveInt })`.
  - New `packages/contracts/src/sandboxImage.ts`, exported from `index.ts`:
    - `TeamImageBase = Union([Struct({ type: Literal("pair") })])`. One member in M4 (decision #9);
      05's `{ type: "image" }` joins Later, so an older client reads a newer base as unknown
      through `ForwardCompatibleNullable` where it is shown.
    - `TeamImageRecipe` as 05 §2: `base`, `projectIds` (`Array(ProjectId)`, max
      `TEAM_IMAGE_MAX_PROJECTS` = 50, unique), `buildEnv: Record(ProviderInstanceEnvironmentVariableName,
      String)`, `buildSecrets: Record(ProviderInstanceEnvironmentVariableName, SecretReference)`,
      `install` (max `TEAM_IMAGE_INSTALL_MAX_CHARS` = 64,000). A name in both maps is invalid.
    - `TeamImageRecipeRevision = Struct({ revision: PositiveInt, recipe, savedAt, savedBy:
      TeamImageRequester })`.
    - `TeamImageBuildPhase = Literals(["launch", "preflight", "clone", "install", "env", "verify",
      "clean", "manifest", "capture"])` (05 §3's steps; launch is step 0 on Docker).
    - `TeamImageBuildStatus = Literals(["queued", "launching", "running", "capturing",
      "succeeded", "failed", "cancelled"])`.
    - `TeamImageRequester = Union([Struct({ kind: "member", memberId }), Struct({ kind: "agent",
      threadId, runId, authorIds: Array(MemberId) })])`. The agent's authors are recorded at
      request time so the build-done notice reaches them (decision #10).
    - `TeamImageManifest` as 05 §4 (`base { ref, digest: NullOr, pairVersion }`, `providers`,
      `repos { projectId, path, headSha }`, `imageEnv`, `sizeBytes`), except that 05's
      `runnerBuildId` is `serverVersion`: the code has no runner bundle id, and the runner is the
      server's own bundle, fetched or bound at each boot.
    - `TeamImageBuildFailure = Struct({ phase: Union([TeamImageBuildPhase, Literals(["interrupted",
      "timed-out", "leak"])]), detail: String, exitCode: optionalKey(Int), logTail:
      Array(String) max 30 })`. `leak` is 4.15's.
    - `TeamImageBuild`: `id`, `number`, `status`, `phase: NullOr(TeamImageBuildPhase)`,
      `recipeRevision`, `driverId: ComputeDriverId`, `requestedBy`, `activateOnSuccess: Boolean`,
      `imageRef: optionalKey(String)`, `manifest: optionalKey(TeamImageManifest)`, `failure:
      optionalKey`, `requestedAt`, `startedAt`, `finishedAt` (`NullOr(DateTimeUtc)`),
      `imageDeletedAt: NullOr(DateTimeUtc)`. Unlike 05's sketch it does not copy the recipe; the
      revision is immutable.
    - `TeamImageProposalId` (`tip_` plus 20 hex) and `TeamImageProposal = Struct({ id, threadId,
      projectId, baseRevision, install, reason (max 500), status: Literals(["open", "accepted",
      "dismissed"]), createdAt, closedAt })`. 4.20 is its first writer.
    - `TeamImageSnapshot = Struct({ recipe: NullOr(TeamImageRecipeRevision), activeBuildId:
      NullOr(TeamImageBuildId), builds: Array(TeamImageBuild) /* newest 20, plus the active */,
      proposals: Array(TeamImageProposal) /* open */, keepSucceeded: PositiveInt,
      currentBase: optionalKey(TeamImageCurrentBase) /* 4.22: { ref, digest: NullOr, version: NullOr } */ })`.
    - `TeamImageErrorReason = Literals(["not-admin", "not-available", "invalid-recipe",
      "recipe-changed", "build-running", "no-capacity", "draining", "not-found", "wrong-state",
      "image-deleted", "proposal-open", "too-many-proposals"])` and `TeamImageError`, a tagged error
      with `reason: ForwardCompatibleNullable(TeamImageErrorReason)` and a `message` the client
      shows as is.
    - Inputs: `TeamImageSaveRecipeInput { baseRevision: NullOr(PositiveInt), recipe }`,
      `TeamImageStartBuildInput { recipeRevision: PositiveInt }`, `TeamImageBuildRef {
      imageBuildId }`, `TeamImageReadRecipeInput { revision }`, `TeamImageBuildLogChunk { text,
      done: Boolean }`, `TeamImageDismissProposalInput { proposalId }`.
  - `packages/contracts/src/orchestrationV2.ts`: the sandbox record (503–527) gains `imageBuild:
    optionalKey(SandboxImageBuildRef)` after `baseImage` (520); the `sandbox.provision` command
    (4004–4014) gains the same optional field. `sandbox.updated` carries the record, so no event
    changes.
  - `packages/contracts/src/sandbox.ts` `sandboxImageLabel` (122–127): a record with `imageBuild`
    reads "Build `<number>`"; update the doc comment ("null once a team build replaces the base").
  - `packages/contracts/src/environment.ts`: `ExecutionEnvironmentCapabilities` gains, after
    `cloudImport` (174), `teamImages: optionalKey(Boolean)` with "True on a cloud-only server that
    builds team images (M4)."
  - `packages/contracts/src/settings.ts`: `SandboxSettings` (1228–1238) gains `teamImage:
    optionalKey(Struct({ keepSucceeded: Int, 1..20 }))`; the patch (1783–) the same. Absent means 5.
  - `packages/contracts/src/server.ts` `ServerDrainStatus` (969–973): `runningBuilds:
    optionalKey(NonNegativeInt)`.
- **Types and services, Commands and events, Migrations:** none.
- **Tests:** `packages/contracts/src/sandboxImage.test.ts`: the recipe refuses a name in both maps,
  51 projects and a 64,001-character script; a newer `TeamImageErrorReason` decodes as null;
  `sandboxImageLabel` returns "Build 14" (a row in `sandbox.test.ts`'s existing table). Nothing else: the rest is types.
- **Verify:** `vp test run packages/contracts/src/sandboxImage.test.ts`, `vp run typecheck` in
  `packages/contracts`.
- **Reviewer checks:** knip runs on this PR, so a non-schema constant no other file imports yet
  stays unexported until its row imports it (`TEAM_IMAGE_INSTALL_MAX_CHARS` waits for 4.18's
  editor); no `type: "image"` base. Surfaces: every new field is optional, so older clients and
  servers decode each other's records; mobile and desktop follow through client-runtime.

### 4.13 `feat(server): add the team-image aggregate with one build at a time`

**Critical.** Pair Cloud keeps one recipe with numbered revisions and a history of builds, and runs
at most one build at a time. An admin can save the recipe, start a build of a saved revision and
cancel it; every member can read the snapshot. A build takes a machine slot like a session, `t3
drain` waits for it, and a build that runs past 45 minutes fails as timed out. No machine starts
yet: the launch effect has no implementation until 4.14, so `startBuild` refuses with
`not-available` and the `teamImages` capability stays off until then.

- **Needs:** 4.11, 4.12. **Unblocks:** 4.14 (the effects it implements), 4.16, 4.18, 4.19, 4.21.
- **Files:**
  - Migration `095_TeamImages.ts` (next free id, P8), registered and listed as 094 is:
    ```sql
    CREATE TABLE IF NOT EXISTS team_image_recipe_revisions (
      revision INTEGER PRIMARY KEY,
      recipe_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      saved_by_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_image_builds (
      image_build_id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,          -- the TeamImageBuild
      machine_sandbox_id TEXT,             -- the build machine's id, never a sandbox record
      machine_driver_ref TEXT,
      machine_destroyed_at TEXT,
      log_deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS team_image_builds_status_idx ON team_image_builds (status);
    CREATE TABLE IF NOT EXISTS team_image_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_build_id TEXT,
      next_build_number INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO team_image_state (id, active_build_id, next_build_number) VALUES (1, NULL, 1);
    ```
    No `orchestration_v2_` prefix: these tables are the source of truth and are never rebuilt
    from events (see the track notes).
  - New `apps/server/src/sandbox/image/TeamImageCommands.ts`, pure, no Effect services:
    - `TeamImageState` (the latest revision number, the next number, the live build or null, and
      the build the command names or null); the service reads only those rows.
    - `TeamImageCommand`, server-internal, each with `commandId`:
      - `team-image.recipe.save { baseRevision, recipe, savedBy }`
      - `team-image.build.request { imageBuildId, machineSandboxId, recipeRevision, driverId,
        requestedBy, activateOnSuccess }` (the service draws both ids, so the decider stays pure)
      - `team-image.build.launched { imageBuildId, driverRef }` (from the launch effect)
      - `team-image.build.attached { imageBuildId }` (the runner said hello)
      - `team-image.build.phase { imageBuildId, phase }`
      - `team-image.build.program-finished { imageBuildId, manifest }`
      - `team-image.build.captured { imageBuildId, imageRef, sizeBytes }`
      - `team-image.build.fail { imageBuildId, failure }`
      - `team-image.build.cancel { imageBuildId, by: MemberId | null }`
      - `team-image.build.machine-destroyed { imageBuildId }`
    - `decideTeamImageCommand(state, command, now)` returns `{ events, effects,
      cancelUnsettledEffects? }` or a `TeamImageError`. Rules:
      - Save: `baseRevision` must equal the latest (null when none) else `recipe-changed` ("Someone
        saved the recipe since you opened it. Reload to see their change.").
      - Request: an unknown revision is `not-found`; a live build (queued, launching, running or
        capturing) is `build-running`. Emits the build as `queued` with the next number, and the
        `launch` effect.
      - Each later step applies only from the status before it (launched: queued → launching, and
        from running it records the `driverRef` only, since a fast runner can say hello before
        `create` returns; attached: queued or launching → running, effect `run-program`; phase:
        running, phase only moves
        forward; program-finished: running → capturing, effect `capture`; captured: capturing →
        succeeded, effect `destroy-machine`). A step from any other status is a no-op with no
        events, so a late report after a cancel changes nothing.
      - Fail and cancel apply to any live build: status `failed` or `cancelled`, `finishedAt`,
        `cancelUnsettledEffects` for launch, run-program and capture, and the `destroy-machine`
        effect. Cancel of a finished build is `wrong-state`.
      - Machine-destroyed records the time only.
    - Events, each carrying the whole build or revision, so the projection writes rows and the
      service publishes changes without re-reading: `team-image.recipe-saved {
      TeamImageRecipeRevision }` and `team-image.build-updated { TeamImageBuild, machine }`, where
      `machine` is `{ sandboxId, driverRef, destroyedAt }` (the build machine's columns).
  - New `apps/server/src/sandbox/image/TeamImageStore.ts` (`SqlClient`, `SqlSchema`,
    `PersistenceSqlError`, as `RunnerGrants.ts`): `state`, `latestRevision`, `readRevision(n)`,
    `build(id)`, `recentBuilds(limit)`, `liveBuild`, `machines` (builds whose machine is not
    destroyed: `{ imageBuildId, status, sandboxId, driverRef, driverId }`), and `apply(events)`,
    which writes rows for each event inside the caller's transaction.
  - New `apps/server/src/sandbox/image/LiveTeamImageBuild.ts`: a `SubscriptionRef<{ imageBuildId,
    driverId } | null>` service with no dependencies, so `SandboxAdmission` and `ServerDrain` can
    read it without depending on the service that writes it.
  - New `apps/server/src/sandbox/image/TeamImageService.ts`:
    - `dispatch(command)`: under the service's one `Semaphore`, return the receipt of a replayed
      `commandId` (as `ProjectService.commit`, 261–330), else decide, then
      `EventSinkV2.commitTeamImageCommand` with `apply: store.apply(events)`, or
      `commitRejectedTeamImageCommand`. A no-op step commits nothing. After commit, set
      `LiveTeamImageBuild` and publish the change. Effects call `dispatch`; so do 4.14's fibers and
      4.19's tools.
    - `snapshot` and `changes` (a `Stream` that emits the snapshot, then one per committed
      command), built from the store. `keepSucceeded` comes from settings (absent: 5).
    - `saveRecipe({ actorId, input })`, `startBuild({ actorId, input })`, `cancelBuild({ actorId,
      imageBuildId })`, `readRecipeRevision(revision)`. Each change first checks `isAdmin(actorId)`:
      not team mode, or `TeamState.members` has the actor as an active admin (the
      `ensureMaySignOut` rule, ProviderAuthService.ts 211–234); else `not-admin` ("Only an admin
      can change the team image.").
    - `startBuild` runs inside `SandboxAdmission.withLock` (taken before the service's semaphore,
      SandboxAdmission.ts 33): on the default driver (`defaultDriverId`, else the only driver;
      none is `not-available`), refuse `draining` when `snapshot.draining`, `no-capacity` when
      `running + waiting >= cap` ("Every machine is in use. Build when one frees up, or raise the
      limit in Compute."), then dispatch the request and `takeStart`. It refuses `not-available`
      while `Effect.serviceOption(TeamImageEffects)` is none (until 4.14).
    - At start, seed `LiveTeamImageBuild` from the store. Restart recovery is 4.14's.
  - New `apps/server/src/sandbox/image/TeamImageWorker.ts`: `scheduler.register("team-image",
    sweep)` (Scheduler.ts 14–17, as SandboxLifecycleWorker.ts 454 registers its source). The sweep
    fails a live build with `timed-out` 45 minutes after `requestedAt`, and a `launching` build
    whose runner has not said hello 10 minutes after `startedAt` with phase `launch` ("The build
    machine did not start."). 4.16 adds GC to the same sweep.
  - `apps/server/src/sandbox/lifecycle/SandboxAdmission.ts` `snapshot` (68–75): add 1 to
    `running` while `LiveTeamImageBuild` holds a build on this driver.
  - `apps/server/src/drain/ServerDrain.ts` `watch` (62–80): merge `LiveTeamImageBuild` changes
    into the re-count trigger; emit `{ since, runningTurns, runningBuilds }` and complete when both
    are 0. `apps/server/src/cli/drain.ts` (66) prints "Waiting for 1 team image build" when
    `runningBuilds > 0`.
  - `packages/contracts/src/rpc.ts`: `WS_METHODS` gains `teamImageSubscribe`
    (`"teamImage.subscribe"`), `teamImageSaveRecipe`, `teamImageStartBuild`,
    `teamImageCancelBuild`, `teamImageReadRecipe`; `Rpc.make` each beside the sandbox RPCs
    (1033–1049); subscribe uses `stream: true` and succeeds with `TeamImageSnapshot`; errors are
    `Union([TeamImageError, EnvironmentAuthorizationError])`. Add them to `WsRpcGroup` (2222).
  - `packages/contracts/src/clientRpcPermissions.ts` (19–30): the three mutations under
    `AuthSettingsWriteScope`, as `sandboxCheckDriver`. `apps/server/src/auth/RpcAuthorization.ts`:
    subscribe and readRecipe under `AuthOrchestrationReadScope`, as `sandboxOverview` (91).
  - `apps/server/src/ws.ts`: resolve `TeamImageService` beside the sandbox services (1593); one
    line per handler beside 2913–2917, passing `actorId: currentSession.memberId`.
  - `apps/server/src/orchestration-v2/runtimeLayer.ts` (`layerProduction`, which `server.ts`
    provides): the store, `LiveTeamImageBuild` (one reference, below `SandboxAdmission` and
    `ServerDrain`), the service and the worker, on every server; the service answers
    `not-available` when `ServerConfig.cloudOnly` is false.
- **Types and services:** `TeamImageService` (the stream's only writer), `TeamImageStore`,
  `LiveTeamImageBuild`, `TeamImageWorker`; the decider is plain functions.
- **Commands and events:** above. Team-image events never reach clients; the snapshot does.
- **Migrations:** 095.
- **Tests:**
  - `TeamImageCommands.test.ts`, table-driven over the decider: the save conflict, the one-build
    rule, each step from the wrong status as a no-op, cancel and fail cancelling unsettled effects
    and enqueuing `destroy-machine`, cancel of a finished build.
  - `TeamImageService.test.ts` (`it.effect`, a real SQLite layer, a stub `TeamImageEffects`):
    a replayed `commandId` returns the first receipt; a member's save is `not-admin`; a build at
    the cap is `no-capacity` and while draining is `draining`; `LiveTeamImageBuild` follows the
    build. Advance `TestClock` past 45 minutes and run the sweep once: the build is `timed-out`.
  - `095_TeamImages.test.ts`: the state row exists once after running twice.
  - `SandboxAdmission`: extend the existing admission case in `SandboxLifecycle.test.ts` with a
    live build on the driver.
  - `ServerDrain.test.ts`: the watch completes only after the build ends.
- **Verify:** the test files above; `vp run typecheck` in `packages/contracts` and `apps/server`.
- **Reviewer checks:** the decider does no I/O and draws no ids; `withLock` is taken before the
  semaphore, never inside it; a step after a cancel commits nothing; every method in `WS_METHODS`
  has a handler and a scope. Surfaces: the service methods are what 4.18's page, 4.19's tools and
  4.21's screen call, so no handler holds logic; reverse states: a build can be cancelled, a
  saved revision can be restored by saving it again (4.18); connection modes: the snapshot is one
  subscription over the WebSocket, so a relay or tunnel client sees what a LAN client sees.

### 4.14 `feat(server): build team images on Docker by snapshot`

**Critical; the largest row.** An admin's build runs end to end on Docker: Pair Cloud starts a
build machine from the base through the driver, waits for its runner, runs the generated build
program through the machine's workspace host, reads back the manifest, commits the container as
`t3-team-image:<number>` and destroys the machine. The log streams to anyone who has it open and
stays on disk. A cancel stops the program and destroys the machine. A restart fails a launching or
running build as interrupted and destroys its machine, without entering restore mode. The
`teamImages` capability turns on.

- **Needs:** 4.13. **Unblocks:** 4.15, 4.16. The driver half has no Needs and can merge first as
  its own commit.
- **Files:**
  - `apps/server/src/sandbox/compute/ComputeDriver.ts`:
    - `ComputeDriverError.operation` (33–42) gains `"snapshot"`.
    - The service (157–187) gains `snapshot: (driverRef: string, name: string) =>
      Effect<{ imageRef: string; sizeBytes: number | null }, ComputeDriverError>` with "Captures a
      stopped or running sandbox's disk as an image named `name`. Replaying it for the same name
      returns the image it made." Replace the comment at 156 ("snapshot and buildImage join in
      M3") with "`snapshot` is M4's; `buildImage` is Later (05 §3)". `capabilities.snapshot`
      (`false` on Docker, 78–94) means a sandbox's sleep snapshot and stays as it is;
      `imageBuild: "snapshot"` is the capability this row uses.
  - `apps/server/src/sandbox/compute/DockerEngineApi.ts`: `commit({ container, repo, tag, labels
    })` as `POST /commit?container=…&repo=…&tag=…&pause=true` with body `{ Labels: labels }`,
    returning the image id. Beside `inspectImage` (367) and `removeImage` (417).
  - `apps/server/src/sandbox/compute/DockerComputeDriver.ts`: `snapshot(driverRef, name)`: first
    `inspectImage(name)`; when it exists and its `pair.team-image.build` and
    `pair.team-image.machine` labels match the ones this call would set, return it (replay). Else
    `commit` with repo `t3-team-image`, the tag from `name`, and those two labels; the engine
    merges them over the container's, which carry over (a session's create sets its own anyway).
    `imageRef` is the image id and `sizeBytes` the inspected `Size`. `deleteImage` (854–857) already removes by ref and treats a missing
    image as success.
  - `apps/server/src/sandbox/compute/ComputeDriverTesting.ts`: the fake's `snapshot` is a call
    the test answers or fails; `answerFromMemory` returns `fake-image:<name>`.
  - New `apps/server/src/sandbox/image/teamImageBuildProgram.ts`, pure: `teamImageBuildProgram({
    repos: Array<{ projectId, url, path, tokenVariable: string | null }>, excludedEnvNames,
    paths? })` returns the Bash text of `t3-build.sh` (`paths` moves the image root, output and
    base info for the test). `set -euo pipefail`, stderr joins stdout, and each phase starts with
    a line `::t3-phase::<phase>`:
    1. `preflight`: `id -un` is `t3`; `bash`, `git`, `sudo`, `jq` exist; at least 2 GiB free on
       `/`; `~/.t3-build`, written by the root runner, is chowned to t3.
    2. `clone`: `sudo install -d -o t3 -g t3 /t3-sandbox/.image` (`/t3-sandbox` is root-owned
       0755, provision.sh 103; t3 has passwordless sudo, 78–81), then for each repo
       `git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo
       "password=${VAR}"; }; f' clone -- <url> <path>` with `VAR` its token variable, or no
       helper when null. The empty helper first clears the base's own. The helper is passed with
       `-c`, never written to a config file. Record `git -C <path> rev-parse HEAD`.
    3. `install`: `env -0` from a clean login shell (`env -i HOME USER LOGNAME SHELL PATH bash
       -lc`, so the spawn's env does not count) into `~/.t3-build/env.before`, then `bash -euo
       pipefail ~/.t3-build/install.sh` from `$HOME`.
    4. `env`: the same capture diffed against `env.before` with `jq --rawfile`; added or changed
       names (not `PWD`, `SHLVL`, `_`, `OLDPWD` or `excludedEnvNames`) become `imageEnv`.
    5. `verify`: each provider CLI the base installs (read the list from `/etc/pair-image.json`)
       answers `--version`; each repo's head resolves.
    6. `clean`: remove `~/.t3-build` and `~/.bash_history`; 4.15 adds the leak check here.
    7. `manifest`: `sudo install -d /etc/t3` and write `/etc/t3/build.json` as
       `TeamImageBuildOutput` (`pairVersion` and `providers` from `/etc/pair-image.json`, `repos`
       with their heads, `imageEnv`), readable by everyone. The server adds the rest.
       The server writes the install script and the env baseline under `~/.t3-build`; the program
       never echoes an environment value.
  - New `apps/server/src/sandbox/image/TeamImageBuildLog.ts`: `<ServerConfig.stateDir>/team-image/
    builds/<number>.log`. `open(number)` is scoped and returns a writer (`write(line)`, `tail`, the
    last 30 lines); lines go to the file until it holds 1 MiB, and after that to a 4 MiB
    in-memory ring that is appended when the writer's scope closes, after a line "… <n> bytes left
    out …" when the ring dropped lines (**proposed**; a crash loses the ring). `read(number)` is
    what is written so far, then live lines while the writer is open, then `done`; with no writer
    it is the file. `whenOpen(number)` waits for a writer. `delete(number)` is 4.16's.
    `::t3-phase::` lines are stripped from the log and returned to the caller.
  - New `apps/server/src/sandbox/image/TeamImageEffectsLive.ts`, the `TeamImageEffects` layer
    (4.11's tag). Each case reads the build and its machine columns first and succeeds without
    doing anything when the build is no longer in the status it expects.
    - `launch`: as `ComputeDriverCheck.ts` 59–235 does for its check machine:
      `bootstraps.forGeneration({ sandboxId: machineSandboxId, generation: 1, driverId })`, then
      `driver.create({ name: sandboxBackendName(installId, machineSandboxId, 1), sandboxId,
      generation: 1, image: { type: "base" }, size: the driver's, tags: sandboxTags(…),
      bootstrap })`, then dispatch `team-image.build.launched { driverRef }`. A replayed create
      returns the same `driverRef` (ComputeDriver.ts create comment).
    - `run-program`: start the program in a fiber of this layer's scope (one per build id) and
      succeed. The fiber races `LiveTeamImageBuild.changes`, so a cancel, fail or timeout that
      takes the build off the live slot interrupts it and its scope kills the process. The fiber:
      1. Resolves `buildSecrets` with `requireSettingsSecret` (secrets/settingsSecretValue.ts 41);
         an unresolved one fails the build at `install` naming the variable, never the value.
      2. For each recipe project: the origin URL from the project's root (`git.readRemoteUrl`,
         as `checkoutInSandbox` 273), the path `clonePathFor("/t3-sandbox/.image", url,
         projectId)` (export it from CloudPreparation.ts 242–249), and a token:
         `GitHubAppInstallationTokens.tokenFor({ sandboxId: machineSandboxId, repository })` when
         `configured`, else `MemberGitHub.credentialFor` of the requesting member (an agent build:
         its first author), else none.
      3. `hosts.forPath(`${SANDBOX_ROOT}/${machineSandboxId}`)`, then through `host.fileSystem`
         writes `~/.t3-build/install.sh` and `t3-build.sh`, and spawns `bash
         ~/.t3-build/t3-build.sh` through `host.spawner` with cwd `/home/t3` and env = build env,
         resolved secrets and `T3_CLONE_TOKEN_<i>`. Lines go through `TeamImageBuildLog`; each
         phase marker dispatches `team-image.build.phase`.
      4. Exit 0: read `/etc/t3/build.json` through `host.fileSystem`, decode it, add `base.ref`
         and `digest` from `create`'s base (`"unknown"` and null when the driver gave none) and
         `serverVersion`, and dispatch `program-finished`. Non-zero: dispatch `fail { phase:
         <last phase>, exitCode, logTail: the last 30 lines }`. Any other failure fails the build
         at the last phase with "Pair Cloud lost the build machine."
      5. Always: `GitHubAppInstallationTokens.revoke(machineSandboxId)`.
    - `capture`: `driver.snapshot(driverRef, `t3-team-image:${number}`)`, then dispatch
      `captured`.
    - `destroy-machine`: `driver.destroy(driverRef ?? backend name)`, `hub.revoke(sandboxId)`,
      `revoke` the tokens, dispatch `machine-destroyed`. A build with no machine yet succeeds.
    - `reportExhausted`: dispatch `fail` with the phase the effect was for (`launch`, `capture`,
      or `preflight` for run-program) and "Pair Cloud could not reach the build machine's
      driver." For destroy and delete-image, log. A refusal, a missing driver or a driver error
      marked not retryable skips the remaining attempts.
    - `delete-image`: `driver.deleteImage(imageRef)`.
    - At start, a scoped fiber over `RunnerHub.boots` (RunnerHub.ts 175) dispatches `attached`
      for a boot whose `sandboxId` is the live build's machine. No `RunnerHubFacts` change. It
      lives here, not in the service, so the service does not depend on its effects.
  - `TeamImageService.ts`:
    - Restart recovery, after the event store is ready: a `launching` or `running` build fails
      with phase `interrupted` ("Pair Cloud restarted during this build.", an empty `logTail`);
      `queued` and `capturing` continue, since their effects are replay-safe.
    - `subscribeBuildLog(imageBuildId)`: for a live build, waits until its writer opens (or the
      build ends), then `TeamImageBuildLog.read`, as `TeamImageBuildLogChunk`s.
  - `apps/server/src/sandbox/lifecycle/SandboxReconciler.ts` `reconcileDriver` (265–315): read
    `TeamImageStore.machines` first and drop those backends from `backends` before `unrecorded`
    (288–297) and `pairBackends` (312). A live build's machine is skipped; outside restore mode a
    finished build's listed machine is destroyed and `machine-destroyed` dispatched with the
    destroy effect's command id. Any other unrecorded backend keeps today's behavior.
  - `packages/contracts/src/rpc.ts`, `RpcAuthorization.ts`, `ws.ts`: `teamImage.subscribeBuildLog`
    (`stream: true`, `AuthOrchestrationReadScope`).
  - `apps/server/src/environment/ServerEnvironment.ts` 271: `cloudOnly` also sets `teamImages:
    true`.
- **Types and services:** `ComputeDriver.snapshot`; the `TeamImageEffects` layer;
  `TeamImageBuildLog`; `TeamImageService.subscribeBuildLog`. No new service for the program: it
  is a fiber of the `TeamImageEffects` layer.
- **Commands and events:** none new; this row implements 4.13's.
- **Migrations:** none.
- **Tests:**
  - `teamImageBuildProgram.test.ts`: run the generated script with `bash` against a temp `$HOME`
    and stub `sudo`, `git` and provider CLIs on `PATH` (`it.live`, a subprocess fixture): phases
    print in order, `imageEnv` holds a `PATH` change made in `~/.profile` and not a build secret's
    name, a failing install stops before `env`. Snapshot nothing.
  - `DockerComputeDriver.contract.test.ts`: `snapshot` commits once, replays without a second
    commit, and the image's labels are the container's plus the two team-image labels.
  - `TeamImageEffectsLive.test.ts` over the fake driver, a fake `RunnerHub` whose `boots` the test
    offers into, and a fake host whose spawner prints phase lines and exits: request to
    succeeded with `imageRef`; a cancel mid-program interrupts the fiber and destroys the machine;
    a failing capture retries, then fails the build at `capture`; tokens are revoked in each case.
  - `SandboxReconciler.test.ts`: a tagged backend that is a live build's machine, past grace, does
    not enter restore mode; a finished build's machine is destroyed.
  - Restart recovery: a `running` build is `interrupted` after a fresh service starts on the same
    database.
- **Verify:** the tests above. Runtime transcript from `vp run dev` in the worker's worktree on a
  Docker host (no agent turns): start a build of a recipe with one project and `sudo apt-get
  install -y postgresql-client`, calling `teamImage.saveRecipe` and `teamImage.startBuild` from a
  throwaway script outside the worktree that connects as `cli/drain.ts` does (the page is 4.18),
  watch it reach `succeeded`, then `docker image
  ls t3-team-image` and `docker image inspect` (labels: the container's plus the two team-image
  labels; `Config.Env` holds no secret). Record the build time and image size. Stop the server by the PID captured at spawn.
- **Reviewer checks:** no secret or token in a config file, a command line, the log or an error;
  the reconciler change covers build machines only; the program fiber is interrupted on every end
  state; nothing reads `/etc/t3/build.json` as trusted beyond its schema. Surfaces: server and the
  one RPC; drivers: Docker implements `snapshot` and the fake does, and M5's EC2 driver must
  (05 §3); connection modes: the log streams over the same WebSocket as everything else.

### 4.15 `feat(server): fail builds that leak a secret and redact build logs`

**Small.** A build whose install script wrote a build secret or a clone token to disk fails at
`clean` with the variable and the file ("NPM_TOKEN's value was found in /home/t3/.npmrc. Use
`${NPM_TOKEN}` instead.", 05 §8), and never becomes an image. Every log line has those values
replaced with `***` before it is written to disk or sent to a reader.

- **Needs:** 4.14. **Unblocks:** 4.18 (the first place people read logs).
- **Files:**
  - `teamImageBuildProgram.ts`: the program takes `leakCheckNames` (the build secret names and
    the `T3_CLONE_TOKEN_<i>` names). In `clean`, for each name with a non-empty value, `grep -rlF
    -e "${!name}"` over `~/.npmrc`, `~/.config`, `~/.docker/config.json`, `~/.git-credentials`,
    `~/.netrc`, `~/.bash_history`, `/etc/environment`, each clone's `.git/config` and
    `/etc/t3/build.json` once it is written (05 §6's list, plus the clones and the manifest,
    which carries `imageEnv`). A hit prints `::t3-leak::<NAME>::<path>` and the program exits 3
    after checking every name. `grep`'s pattern comes from the variable, never from the command
    line text, and the value is never printed (the pattern file is `grep`'s stdin). The manifest is
    checked on its own right after it is written, so `imageEnv` is covered without moving the
    `clean` and `manifest` phases. A value is checked line by line, skipping lines under 4
    characters.
  - `TeamImageEffectsLive.ts`: a `::t3-leak::` line dispatches `fail { phase: "leak", detail:
    "<NAME>'s value was found in <path>." … }`, taking the first hit, naming the count of the
    rest, and ending with "Use ${NAME} instead." for a build secret. The log gets a sentence for
    each hit, not the marker line. The server also checks the decoded `imageEnv` against the values it passed, as a second
    line of defense, before `program-finished`.
  - `TeamImageBuildLog.ts`: `open(number, values)` takes the values to redact, so the effects layer reads the recipe's
    secrets and the clone tokens before it opens the log (a failure before then has an empty
    `logTail`). A build secret shorter than 4
    characters fails the build at `install` before the program starts ("NPM_TOKEN is too short to
    keep out of the log."), since redacting it would star ordinary text. Each line is
    redacted before the file, the ring and live readers see it. Matching is per line: the program
    is line-buffered, and a value split across a line break is not a value.
  - `TeamImageCommands.ts` save rule: a build env or secret name the server reserves
    (`T3CODE_*`, `T3_CLONE_TOKEN_*`, `HOME`, `PATH`) is `invalid-recipe`.
- **Types and services:** none new; `teamImageBuildProgram`'s input gains `leakCheckNames`.
- **Commands and events:** none new.
- **Migrations:** none.
- **Tests:** extend `teamImageBuildProgram.test.ts` with a script that writes a secret into
  `~/.npmrc`: one leak line naming `.npmrc`, exit 3, and the value absent from all output. Extend
  `TeamImageEffectsLive.test.ts`: a spawner that prints a secret value logs `***`; a leak line
  fails the build at `leak`. One decider row for a reserved name.
- **Verify:** the two test files. Runtime transcript (as 4.14's): a recipe whose script runs `npm
  config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"` fails at `clean` naming `.npmrc`, and
  `grep` of the log file for the value finds nothing.
- **Reviewer checks:** the value appears in no argv (`ps` would show it), no log, no failure
  detail; the check runs on every name, not only the first. Surfaces: server only; 4.18 shows the
  failure and the editor's warning.

### 4.16 `feat(server): activate, roll back and garbage-collect builds`

**Critical.** A succeeded build can be made active, and making an older succeeded build active is
the rollback. A build an admin starts from the page becomes active when it succeeds; a build an
agent starts finishes as **Ready** and waits for an admin's **Activate** (05 §4, G4 step 1).
Garbage collection keeps the active build, every build a live sandbox uses and the newest
`keepSucceeded` succeeded builds, and deletes the other images; failed and cancelled logs go after
30 days. Whoever started the build, or the admins who wrote the agent's run (decision #10), get a
"build finished" signal that 4.18 and 4.21 show.

- **Needs:** 4.14. **Unblocks:** 4.17 (the active build), 4.18, 4.19.
- **Files:**
  - `TeamImageCommands.ts`:
    - `team-image.build.activate { imageBuildId, by: MemberId }`: the build must be `succeeded`
      (else `wrong-state`, "Only a succeeded build can be activated.") with no `imageDeletedAt`
      (else `image-deleted`, "This build's image was removed. Build again."). Activating the
      active build is a no-op. Emits `team-image.active-changed { activeBuildId, previousBuildId,
      by, at }`.
    - `captured` emits `active-changed` too when the build's `activateOnSuccess` is true.
    - `team-image.build.collect { imageBuildId }`: refused for the active build (`wrong-state`);
      sets `imageDeletedAt` in the same commit and adds the `delete-image` effect. Marking the row
      before the image goes means an activation that races the deletion is refused rather than
      pointing new sessions at a vanishing image, so there is no separate `image-deleted` command.
    - `team-image.build.log-deleted { imageBuildId }`: emits `team-image.log-deleted`, which sets
      `log_deleted_at` (the build schema has no field for it).
  - `TeamImageStore.ts`: `apply` writes `team_image_state.active_build_id`; `snapshot` returns it.
  - `TeamImageService.ts`:
    - `startBuild` sets `activateOnSuccess: true` for a member request (the page); 4.19 passes
      false.
    - `activateBuild({ actorId, imageBuildId })`, admin only. It never waits for a running build:
      activation only changes what new sandboxes boot from.
    - `buildFinished: Stream<{ build, recipients: ReadonlyArray<MemberId> }>`, emitted after a
      commit that moves a build to `succeeded`, `failed` or `cancelled`. Recipients: a member
      requester, or an agent requester's `authorIds` that are still active admins, minus the
      member who cancelled it. 4.18 and 4.21 read it.
  - New `apps/server/src/sandbox/image/TeamImageCollection.ts`: pure `planTeamImageCollection({
    builds, activeBuildId, referenced: Set<TeamImageBuildId>, keepSucceeded, now })` returns the
    builds whose image to delete and whose log to delete. `referenced` is every build id in a
    sandbox record that is not destroyed: one query on `orchestration_v2_projection_sandboxes`
    (migration 088), `json_extract(payload_json, '$.imageBuild.id')` where state is not
    `destroyed`, added to `ProjectionStore` as `listSandboxImageBuildIds`.
  - `TeamImageWorker.ts`: the sweep runs collection once a day (the last run time is kept in
    memory; a restart runs it once at start) and the service triggers it after each success. Each
    image to delete goes through a `team-image.build.collect { imageBuildId }` command, whose
    `delete-image` effect calls `driver.deleteImage(imageRef)` (a missing image succeeds,
    ComputeDriver.ts 183). The decider refuses `collect` for the active build and marks the image
    removed at commit, so a race with an activation loses safely either way. Planning keeps the
    newest `keepSucceeded` succeeded builds besides the active and referenced ones (the setting's
    own description), so a rollback target survives when the newest build is active. Docker refuses to remove an image a
    container uses; that error retries and is logged, and the referenced check means it should
    not happen.
  - `TeamImageBuildLog.delete(number)` for logs past 30 days, and for a deleted image's log.
  - `rpc.ts`, `clientRpcPermissions.ts`, `ws.ts`: `teamImage.activateBuild`
    (`AuthSettingsWriteScope`).
- **Types and services:** `TeamImageService.activateBuild` and `buildFinished`;
  `planTeamImageCollection`; `ProjectionStore.listSandboxImageBuildIds`.
- **Commands and events:** `activate`, `collect`, `log-deleted`; `team-image.active-changed`,
  `team-image.log-deleted`.
- **Migrations:** none (095 has the columns).
- **Tests:**
  - `TeamImageCommands.test.ts` rows: activate a failed build, a deleted image, the active build;
    a page build auto-activates, an agent build does not.
  - `TeamImageCollection.test.ts`, table-driven: with keep 1, the active build (old), a referenced
    build and the newest succeeded survive; a failed build's log goes at day 31, not day 29.
  - `TeamImageService.test.ts`: `buildFinished` recipients for a member build and for an agent
    build whose second author was demoted.
- **Verify:** the tests above. Runtime transcript (as 4.14's): two builds, activate the first
  again and see `activeBuildId` change in the snapshot within one round trip; with
  `keepSucceeded: 1` and a third build, `docker image ls t3-team-image` loses the oldest unused tag.
- **Reviewer checks:** the active build is never collected, even when it is the oldest; a sandbox
  record's build is never collected while the sandbox is not destroyed; activation is instant (no
  machine starts). Surfaces: the activate RPC is what 4.18 calls; no MCP tool activates (05 §7);
  reverse states: any surviving succeeded build can be re-activated, so every activation can be
  undone until GC removes the older one.

### 4.17 `feat(server): boot cloud sessions from the active build`

**Critical.** A new cloud session on the build's driver boots from the active build: its
processes see the build's `imageEnv`, a pre-cloned project starts from the copy in the image and
only fetches, and the machine details read "Build 14". A project not in the image clones as today,
and the thread says so once ("Not in the team image"). Sessions that already exist keep the build
they started on, including after sleep. This row also settles the Docker first-boot copy (the
engineering call at the top).

- **Needs:** 4.16. **Unblocks:** 4.22 and the integrated pass.
- **Files:**
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`:
    - `resolveCloudLaunch` (130–168) also returns `imageBuild: SandboxImageBuildRef | null`: the
      active build when its `driverId` is the resolved driver and its image is not deleted, else
      null. A store error logs and boots the base, so the launch's error types do not change.
      Both callers pass it on: ThreadLaunchService.ts 1266 and OrchestratorMcpService.ts 2500.
      The delegated provision (Orchestrator.ts 8887) takes it from `delegated_task.request`'s
      `sandbox`, which gains an optional `imageBuild`.
    - `checkoutInSandbox` (257–371): before the clone-or-fetch at 303–307, when `clonePath` is not
      a checkout and `clonePathFor(TeamImageCloneRoot, url, projectId)` has a `.git`, copy it
      through the host of the sandbox's root (`forPath` cannot route `/t3-sandbox/.image`): the
      agent user runs `mkdir -p <parent>` and `cp -a <image clone> <clonePath>.image-copy`, then
      the copy is renamed into place, so a failed one leaves nothing at `clonePath` and the
      checkout clones as today. Then it fetches instead of cloning. `TeamImageCloneRoot` is a
      `Context.Reference` defaulting to `/t3-sandbox/.image`, so the live test copies from a temp
      folder. Return `cloneSource: "image" | "origin" | "existing"` beside the current fields.
      The copy's span `CloudPreparation.copyImageClone` carries `team_image.copied` and
      `team_image.copy_ms`, the checkout's span carries `checkout.clone_source`, and a copy logs
      "Copied a project from the team image" with `copyMs`.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: `provisionCloud` (444) passes
    `imageBuild` into `sandbox.provision`. After the checkout call (750–766), when the sandbox has
    an `imageBuild` and `cloneSource` is `origin`, record a notice through `thread.notice.record`,
    as `recordRebuild` (341–353) does: "Not in the team image. <project> was cloned when this
    session started; an admin can add it to the team image so sessions start faster." Once per
    launch (its command id keys the notice); a restore's checkout records none. A copy that
    failed and fell back to a clone records it too.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts` `decideProvision` (506–537): copy the
    command's `imageBuild` onto the record.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` `sandbox.create` (460–485): a record with
    `imageBuild` creates with `image: { type: "build", imageRef }`, the ref read from
    `TeamImageStore.build(id)`. The Docker driver already boots that shape (`bootImage`,
    DockerComputeDriver.ts 646–658). A build with no image left (GC only protects builds of
    sandboxes not destroyed, so a discarded machine woken from scratch can outlive its build)
    logs and boots the base instead of failing forever, and `sandbox.created` with a
    `baseImage` drops `imageBuild` from the record, so the machine stops reading "Build N".
  - `apps/server/src/sandbox/runner/RunnerConfig.ts` (85–88): after the process env, read
    `/etc/t3/build.json` through `fs` and lay its `imageEnv` over `imageEnvironment` (a missing or
    unreadable file is the base: no build). Extract the merge as `imageEnvironmentFrom(env,
    manifestText)` so it is testable. The server's `sandboxBaseEnvironment` already starts from
    `host.info.environment` (SandboxProcessEnvironment.ts 218–221), so team, project and
    Pair-provided names still win, as 05 §6 orders them. Old images and the base have no file,
    so nothing changes for them.
- **The first-boot copy (engineering call).** Measure, for the largest pre-cloned repo in the
  test recipe, the time from the start of the checkout to a ready worktree, five runs each:
  `cp -a` from the image (the default), `git clone --shared` from the image path (alternates into
  the read-only layer; `git gc` in the session must not prune what the alternate holds), and a
  network clone (today). The worker measures on its own Docker host; the gVisor numbers come from
  the integrated pass on `pair-cloud-pass`. Keep `cp -a` unless its median on gVisor is over 30 s
  (**proposed**); if so, a follow-up PR switches to `--shared`. Record the table in progress.md
  either way. Stores under `$HOME` (pnpm, npm, pip caches) stay in the image layer and need no
  copy; a pnpm install from them copies rather than hard-links, since the worktree is on the
  volume. Record the setup script's time with and without the build in the transcript.
- **Types and services:** `resolveCloudLaunch`'s result and `checkoutInSandbox`'s result grow a
  field each; `imageEnvironmentFrom` in the runner.
- **Commands and events:** `sandbox.provision` and `delegated_task.request`'s `sandbox` gain
  `imageBuild`; no new type.
- **Migrations:** none (the record is JSON in migration 088's table).
- **Tests:**
  - `SandboxDecisions.test.ts`: a row for provision with `imageBuild`, and one for a create from
    the base dropping it.
  - `ThreadLaunchService.test.ts`: a launch with an active build on the same driver provisions
    with it; on another driver, without; one without an image clone records the notice once. The
    live end-to-end launch runs twice: from a clone of origin, and from a copy of an image clone
    with real `cp -a`, no clone call, a fetch that reaches a commit pushed after the build, and a
    create with `{ type: "build", imageRef }`.
  - `SandboxLifecycle.test.ts`: a record whose build is gone creates from the base.
  - New `RunnerConfig.test.ts` for `imageEnvironmentFrom`: a manifest's `PATH` wins over the
    process env; a broken file is ignored; `PAIR_*` names never pass.
- **Verify:** the tests above. Runtime transcript (as 4.14's): with build 1 active, a new cloud
  session's machine is created from `t3-team-image:1` (`docker inspect` of its container),
  `which psql` answers in its terminal, `echo $PATH` shows the `imageEnv` addition, and the
  checkout trace shows the copy and a fetch, with the measured times.
- **Reviewer checks:** a session on another driver ignores the build; a sleeping or existing
  sandbox is never moved to a new build; `imageEnv` never overrides a Pair-provided name.
  Surfaces: every launch path (chat, command palette, `t3 thread start --cloud`, delegation,
  scheduled tasks) goes through `resolveCloudLaunch`, so all of them get the build; providers: all
  adapters see the same process env, none needs a change; clients show "Build N" through
  `sandboxImageLabel`, on web, desktop and mobile.

### 4.18 `feat(client-runtime,web): add the Team image page`

**Small.** Settings → Cloud has a **Team image** section (05 §8's sketch): the active build with
its base, providers, pre-cloned projects and size; **Build** and **Edit with an agent**; the recipe
editor with **Save** and **Save and build**; and the history with **Activate**, **Log**, **Restore
recipe**, **Retry** and **Fix with an agent**. Admins edit; members see it read-only. When a build
someone started finishes, they get a toast unless the page is open. A thread's machine status
shows which build it runs on.

- **Needs:** 4.15, 4.16. **Unblocks:** 4.20, 4.21 (copy), 4.22.
- **Files:**
  - New `packages/client-runtime/src/state/teamImage.ts`, exported as `createTeamImageAtoms`:
    `snapshot` (`createEnvironmentRpcSubscriptionAtomFamily`, runtime.ts 912, over
    `teamImage.subscribe`), `buildLog(imageBuildId)` (the same, over `subscribeBuildLog`), and
    `saveRecipe`, `startBuild`, `cancelBuild`, `activateBuild`, `readRecipe` through
    `createEnvironmentRpcCommand` (986), each with its `permissionAtom` for UI availability (as
    sandbox.ts 468–472 does for the overview). `saveAndBuild` saves, then builds the returned
    revision.
  - New `packages/client-runtime/src/teamImagePresentation.ts`: `teamImageBuildPresentation(build,
    activeBuildId)` returns the row's status word ("Active", "Ready" for a succeeded agent build
    never activated, "Succeeded", "Building · install", "Failed", "Cancelled", "Image removed"),
    the requester line ("Alice", "agent, prompted by Alice") and the failure message per phase
    (05 §8's table, with 4.15's leak message; a clone or verify failure carries no repository or
    command, so those two messages are generic and the log tail says which). Shared with mobile
    (4.21), so the words are written once.
  - New `apps/web/src/components/settings/TeamImageSettings.tsx` and `TeamImageSettings.logic.ts`
    (diffs, editor state, the npm warning), rendered by `CloudSettings.tsx` after **Compute**
    (369–510) as a `SettingsSection` with `searchableSetting("cloud-team-image")`, only when the
    environment's capabilities include `teamImages`.
    - **Recipe.** Pre-cloned projects as a checklist of the environment's projects; the install
      script in a monospace `Textarea` (the settings' script editors are plain textareas, so
      `Textarea` gained `font="mono"`); build env and build secrets through `ProviderEnvironmentSection`
      (as **Environment variables**, 514–522, with `secretSources`), but secrets may only be
      references. Under the script, a warning when a line matches `npm config set
      …:_authToken <$VAR>`: "This writes the token into ~/.npmrc, and every machine gets it. Use
      `_authToken=${NPM_TOKEN}` in .npmrc instead." A `recipe-changed` error keeps the edit and
      says "Someone saved the recipe since you opened it. Copy your change, then reload."
    - **History.** The snapshot's builds, newest first, with
      `teamImageBuildPresentation`. **Log** opens a panel that streams `buildLog` and stops
      streaming when closed; a failed row shows its 30-line tail inline. **Restore recipe** reads
      the revision and loads it into the editor unsaved. **Retry** builds the same revision.
    - **Edit with an agent** asks which project, then opens a new cloud thread on it with the
      composer prefilled, using the same route as starting a cloud thread from the project:
      "Help me change the team image. Read the recipe with t3_team_image_read, try changes in
      this machine's terminal, then update the install script and start a build." **Fix with an
      agent** adds the failure and its tail. Nothing marks the thread; 4.19's authority check is
      what lets it build.
    - **Keep succeeded builds** (1–20, default 5) saves `sandbox.teamImage.keepSucceeded` through
      the settings patch, as the section's other settings save.
    - Members see the active build and history; the editor and buttons are hidden through the
      permission atoms, and the server refuses anyway.
  - The toast: a small component mounted once in the app shell for each cloud-only environment
    where the viewer may change the image. It watches the snapshot and, when a build whose
    requester is the viewer (or whose agent `authorIds` include them) reaches an end state while
    the Team image section is not open, shows "Build 15 is ready. Activate it in Team image." (an
    agent build), "Build 15 is active." or "Build 15 failed at install." with a link to the
    section.
  - `apps/web/src/components/sandbox/useSandboxThreadStatus.tsx` (web has no machine-details
    view, so the asleep status line, the failure banner and a quiet line on a ready machine that
    runs an older image carry it): the machine's detail gains
    `sandboxImageLabel(record)` ("Build 14", else "Pair base 0.1.7"), plus "New sessions use build
    15" when the snapshot's active build differs. Widen `sandboxImageLabel`'s `Pick` to
    `"baseImage" | "imageBuild"` if 4.12 did not.
  - `CloudSettings.tsx` Overview (354): with an active build, the image line reads "Build 14 ·
    Pair base 0.1.7".
  - User docs: `docs/user/pair-cloud.md` gains **Build a team image** after **Add projects**: what
    the recipe holds, that a page build becomes active and an agent's waits for **Activate**, how
    to roll back, the npm token trap, and that sessions already running keep their build.
    `docs/user/cloud.md` gains one sentence under **Start a cloud thread** on "Not in the team
    image".
- **Types and services:** client-runtime `createTeamImageAtoms` and
  `teamImageBuildPresentation`; no server change.
- **Commands and events, Migrations:** none.
- **Tests:** `TeamImageSettings.logic.test.ts` for the npm warning and the revision diff;
  `teamImagePresentation.test.ts` for each status word and failure message. No rendered-markup
  tests (AGENTS.md).
- **Verify:** `vp run typecheck` for client-runtime and web, the tests above. One `test-t3-app`
  pass in the worker's worktree, captured in light and dark at desktop and phone width: an
  admin's view with an active build, a failed build's tail, the log panel streaming, and a
  member's read-only view.
- **Reviewer checks:** no `className` restyling of `components/ui` exports; mutations only through
  `createEnvironmentRpcCommand`; the log subscription ends when the panel closes; the toast never
  shows on the page itself. Surfaces: web and desktop (desktop wraps web); mobile is 4.21;
  entry points: Settings search finds "Team image"; the command palette's settings search
  reaches it the same way; reverse states: Restore recipe and Activate undo a save and an
  activation.

### 4.19 `feat(server): let agents read, edit and build the team image with their authors' authority`

**Critical.** An agent in a cloud session can read the team image (recipe with secret names only,
the active build, the last 10 builds with manifests) and a build's redacted log. When every person
who wrote its current run is an active admin, it can also replace the install script, start a
build of the saved recipe and cancel the running build. Its build finishes as **Ready** and waits
for an admin's **Activate**; no tool activates, deletes or reads a secret value (05 §7). A member's
agent is refused with a reason it can repeat to the member.

- **Needs:** 4.16. **Unblocks:** 4.20.
- **Files:**
  - New `apps/server/src/mcp/toolkits/sandboxImage/tools.ts` and `handlers.ts`, in the shape of
    `toolkits/environment/` (tools.ts, handlers.ts 1–74), registered in `layerTools`
    (McpHttpServer.ts 1207–1219):
    - `t3_team_image_read`: `McpToolAccess.reads`. Returns the recipe revision (projects by name,
      build env names and values, build secret names only, the install script), the active
      build, and the last 10 builds with status, requester, failure and manifest. On a server
      without `teamImages`, a failure "Team images need Pair Cloud."
    - `t3_team_image_build_log { build: number, tail?: number ≤ 500, from?: number }`: `reads`;
      `TeamImageService.readBuildLog(number)` returns the redacted log so far, and the handler
      slices it (the last 100 lines by default).
    - `t3_team_image_recipe_update { install: string, baseRevision: number | null }` (null when
      there is no recipe yet): `McpToolAccess.writesEnvironment` (full access, not linked;
      McpToolAccess.ts 288–317), then `TeamImageAuthority`, then `TeamImageService.saveInstall`,
      which saves `baseRevision`'s projects, env and secrets with the new install. A stale
      `baseRevision` is refused as `recipe-changed`. It cannot change those (05 §7).
    - `t3_team_image_build_start { recipeRevision }`: the same gate, then `startBuild` with
      `by: { kind: "agent", threadId, runId, authorIds }` and `activateOnSuccess: false`. The
      service only lets a member's build from the page go live by itself, so an outside client's
      tool build waits too. Returns the build number and "It will wait for an admin to activate it
      on the Team image page."
    - `t3_team_image_build_cancel { build }`: the same gate, then `cancelBuild` on the build with
      that number among the snapshot's newest.
      Descriptions are one or two sentences each; the 05 §7 table is the copy's source. The tools'
      failure is `OrchestratorMcpFailure | TeamImageError`, so a refusal reaches the agent as the
      typed `TeamImageError`.
    - The service's `saveRecipe`, `startBuild` and `cancelBuild` take `by: TeamImageRequester`, and
      `ensureAdmin` checks every person it names, so the authority rule holds below the tools too.
      `activateBuild` keeps `actorId: MemberId`, so no agent can activate.
  - New `apps/server/src/sandbox/image/TeamImageAuthority.ts`: `forCaller(scope:
    McpInvocationScope)` returns the `TeamImageRequester` or a `TeamImageError` `not-admin` whose
    message names the reason:
    - A thread caller: the thread's `activeRunId` (none: "Only a running turn can change the team
      image."). Every user message of that run, read through a new
      `ProjectionStore.listRunUserMessages(threadId, runId)` (messages with `role = 'user'` and the
      run's id; `getRunMessage`, 751, returns only the prompt), must have `createdBy: "user"`, an
      `authorId`, no `context.guest` (composerContext.ts 286; a guest's words carry the
      forwarding member's `authorId`, HumanAuthorship.ts 34–35), and an author who is an active
      admin (`TeamState`, the 4.13 rule). Else "`<name>` is not an admin, so this turn cannot
      change the team image. Ask an admin to make the change." (4.20 adds "or propose the
      change"). A run with no human message (scheduled, delegated) has no authority, and so does a
      run with any message no person wrote, such as a notification or a delegated task's result
      steered into it.
    - A client caller (`scope.client` with a `memberId` and access that is not read-only): that
      member must be an active admin. A client with no `memberId` acts as the owner in solo mode
      and is refused in team mode. A linked caller is refused before this by `writesEnvironment`,
      so an admin's agent link cannot change the image yet (05 §7 allows it).
      The check runs at each call, so a steer by a member mid-run takes the authority away.
  - `agentContextBudget.json`: raise `mcpToolListJsonBytes` by what
    `AgentContextBudget.test.ts` measures for the five tools, at most 6,000 bytes (**proposed**);
    past that, cut the descriptions. Measured: 48,788 to 50,313. The PR needs the `agent-context-increase` label (the CI
    workflow `.github/workflows/agent-context-budget.yml` 5–54); ask the maintainer for it.
  - New `evals/mcp-tool-use/cases/team-image.ndjson` with 05 §7's two cases and a control,
    `team-image-ordinary-work-control`, where fixing a failing test calls none of the tools:
    - `team-image-admin-adds-postgres`: an admin asks "add the Postgres client to the team image
      and build it". Expect `t3_team_image_read`, then `t3_team_image_recipe_update` whose
      `install` contains `postgresql-client` and keeps the existing lines, then
      `t3_team_image_build_start`; `callsMustNot` any activate-shaped call; the final text says
      the build waits for an admin to activate.
    - `team-image-member-asks-to-build`: a member's run, where `recipe_update` returns 4.19's
      `not-admin` message. Expect no retry of `recipe_update` or `build_start`, and the final
      text tells the member an admin must do it (4.20 adds the proposal expectation).
      Run both with `--dry-run`, then `--samples 2` on the cheapest Claude model, before and after
      the descriptions, with an `ANTHROPIC_API_KEY` in the repo's `.env` (still open from G1; the
      maintainer adds it). Without the key the PR lands with the dry runs and the lead runs the
      evals in the pass.
  - User docs: one paragraph in `docs/user/pair-cloud.md`'s **Build a team image**: what an agent
    can do, that a member's agent cannot, and that agent builds wait for **Activate**.
- **Types and services:** `TeamImageAuthority.forCaller`; `ProjectionStore.listRunUserMessages`.
- **Commands and events:** none new; the tools call 4.13–4.16's service methods.
- **Migrations:** none.
- **Tests:** `toolkits/sandboxImage/handlers.test.ts`, table-driven over `TeamImageAuthority`:
  one admin author passes; an admin plus a member steer fails naming the member; a guest message
  fails; a scheduled run fails; a demoted admin fails; a full-access client of an admin passes and
  a read-only one fails. One row each that `recipe_update` keeps projects, env and secrets, and
  that `build_start` records the agent requester with `activateOnSuccess: false`.
  `AgentContextBudget.test.ts` passes with the new numbers.
- **Verify:** the tests, the eval runs above (their summary in the PR), and a runtime transcript
  (as 4.14's, with the free `Replay (dev)` provider only for plumbing; the real call is in the
  pass).
- **Reviewer checks:** the gate runs inside the handler at each call, after the mode checks; no
  tool returns a secret value or the env of a running sandbox; descriptions stay short.
  Surfaces: every provider reaches these through T3's MCP server, so no adapter changes; agents:
  the tools wrap service methods, so scheduled tasks and outside clients get the same rules;
  model-facing text: the evals above and the budget change.

### 4.20 `feat(server,web): let cloud sessions propose install script changes`

**Small.** Any cloud session's agent can file a proposed install script with a short reason
(`t3_team_image_propose`), whoever wrote its run. Admins see open proposals on the Team image page
with a diff against the saved script, and choose **Accept** (into the editor, unsaved; saving
closes it as accepted) or **Dismiss**. One open proposal per thread, at most 20 open per server.
Nothing is built or changed by a proposal.

- **Needs:** 4.18, 4.19. **Unblocks:** nothing.
- **Files:**
  - Migration `096_TeamImageProposals.ts` (next free id, P8), registered and listed as 094 is:
    ```sql
    CREATE TABLE IF NOT EXISTS team_image_proposals (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS team_image_proposals_open_thread
      ON team_image_proposals (thread_id) WHERE status = 'open';
    ```
  - `TeamImageCommands.ts`: `team-image.proposal.file { proposalId, threadId, projectId, install,
    reason }` (an open one for the thread is `proposal-open`; 20 open is `too-many-proposals`; the
    decider fills `baseRevision` from the latest revision, null when none exists, so the contract's
    `TeamImageProposal.baseRevision` is nullable), `team-image.proposal.dismiss { proposalId }`
    (one that is no longer open changes nothing), and the save command gains `acceptsProposalId?`,
    which closes the proposal as accepted in the same commit when it is still open; a save naming
    one that is not open just saves. Event `team-image.proposal-updated { proposal }`.
    `TeamImageStore.apply` writes the table; the snapshot lists open proposals, newest first.
  - `toolkits/sandboxImage/`: `t3_team_image_propose { install, reason }`, declared with
    `McpToolAccess.actsAsCaller` (a thread caller, writing; McpToolAccess.ts 130–138). Only a
    thread on a sandbox (a cloud session) may call it. Returns "Proposed. An admin will see it in
    Team image." `TeamImageAuthority`'s refusals now end "Ask an admin to make the change, or
    propose it with t3_team_image_propose."
  - `rpc.ts`, `clientRpcPermissions.ts`, `ws.ts`: `teamImage.dismissProposal`
    (`AuthSettingsWriteScope`); `saveRecipe`'s input gains `acceptsProposalId`.
  - `TeamImageSettings.tsx`: a **Proposals** list above the recipe, for admins ("Add
    postgresql-client for the api tests · Bob's thread [Review]"); **Review** shows the script
    against the saved one line by line (`installDiff`), a link to the thread, **Accept** and
    **Dismiss**. Accept sets the editor's install script and `acceptsProposalId`, keeping other
    unsaved changes.
  - `agentContextBudget.json`: the one tool's bytes, under the same label (+456: 50,313 to
    50,769, so 4.19 and 4.20 add 1,981 of the 6,000).
  - `team-image.ndjson`: `team-image-member-proposes`, the member case continued: after the
    refusal, expect `t3_team_image_propose` with a reason, once. The admin and control cases
    gain `t3_team_image_propose` as a forbidden call. Run as 4.19's.
  - User docs: one sentence on proposals in **Build a team image**.
- **Types and services:** `TeamImageService.fileProposal` and `dismissProposal`.
- **Commands and events:** `team-image.proposal.file`, `.dismiss`, and the save's
  `acceptsProposalId`; `team-image.proposal-updated`.
- **Migrations:** 096.
- **Tests:** `096_TeamImageProposals.test.ts` (a second open row for a thread is refused); decider
  rows (second open proposal, the 21st, accept on save, dismiss twice);
  `handlers.test.ts` rows (a local thread is refused, a cloud member's thread files one).
- **Verify:** tests, evals, and one `test-t3-app` capture of the review panel.
- **Reviewer checks:** a proposal changes nothing until an admin saves; the open-per-thread rule
  is the index as well as the decider. Surfaces: web shows it; mobile shows no proposals in M4
  (editing stays on the web, 05 §8); reverse states: dismiss, and a dismissed proposal can be filed
  again by the thread.

### 4.21 `feat(shared,server,mobile): show the active build and push build results`

**Small.** The mobile machines screen shows each cloud environment's active build ("Build 14 ·
Pair base 0.1.7 · 6.1 GB") and the last build's status, with its failure tail when it failed.
When a build finishes, the people 4.16 names get a push ("Build 15 is ready to activate", "Build
15 is active", "Build 15 failed at install") that opens that screen. Editing stays on the web.
This is the first push not tied to a thread.

- **Needs:** 4.13 (the snapshot), 4.16 (`buildFinished`), 4.18 (the shared words in
  `teamImageBuildPresentation`). **Unblocks:** nothing.
- **Files:**
  - `packages/shared/src/threadNotificationRouting.ts` (88 lines): beside the thread kinds, a
    `teamImageBuildNotification(build)` returning `{ title: "Team image", body }` (the body is
    `teamImageFinishedMessage`; null for a cancel), and `TEAM_IMAGE_DEEP_LINK = "/settings/machines"` (the mobile route's linking path,
    Stack.tsx 361–363). A build push skips `shouldNotifyMember`'s thread rules: its recipients
    are already chosen.
  - `apps/server/src/notifications/MemberPushNotifier.ts`: `start` (328–343) also forks a fiber
    over `TeamImageService.buildFinished`, through the same drainable worker, into a new
    `sendToMembers(recipients, message)` split out of `send` (249–309): the device listing, the
    batching, the Expo call and the `DeviceNotRegistered` cleanup stay shared; presence is not
    checked (a build has no thread to view), and `channelId` stays "agent-alerts". It runs where
    pushes run today (`pushes`, 84: always on a cloud-only server).
  - `apps/mobile/src/features/settings/SettingsMachinesRouteScreen.tsx` `MachinesSection`: when
    the environment reports `teamImages`, subscribe to the snapshot through 4.18's
    `createTeamImageAtoms` (mobile's `state/sandbox.ts` shows the pattern) and replace the **Base
    image** row (91–96) with **Team image**: the active build line, then **Last build** with its
    status word and, when failed, the 30-line tail in a monospace block. Footer: "Edit the team
    image on the web."
- **Types and services:** `teamImageBuildNotification`; `MemberPushNotifier.sendToMembers`.
- **Commands and events, Migrations:** none.
- **Tests:** `threadNotificationRouting.test.ts` rows for the three titles; extend
  `MemberPushNotifier.test.ts` with one case: a `buildFinished` item sends one message per live
  device of each recipient with the machines deep link, and none to others.
- **Verify:** `vp run typecheck` for shared, server and mobile; the tests. **Owed evidence, not
  this run:** the phone is set aside for this run (the maintainer's answer of 2026-11-10), so this
  row merges without a phone pass. It still owes a `test-t3-mobile` simulator pass of the
  machines screen (an active build, and a failed last build with its tail), and a push on a real
  phone opening that screen, which needs a Pair build signed by a paid Apple Developer team as
  G1–G3's phone steps did. Record both as owed in progress.md.
- **Reviewer checks:** the thread push path is unchanged; the build push carries no log text, only
  the number and phase. Surfaces: mobile reads, web edits; desktop gets the toast from 4.18, not
  a push.

### 4.22 `feat(server,client-runtime,web): hint "Rebuild to update" when a build's base is older than the server`

**Small.** After a server upgrade, the Team image page says "Built on Pair base 0.1.7. This server
runs 0.1.9. Rebuild to update provider CLIs." beside the active build, with a **Build** button.
Nothing rebuilds by itself, and the old build keeps working (its sessions fetch or bind the
server's runner at boot). The provider additions 3.13 also carried stay Later.

- **Needs:** 4.17, 4.18. **Unblocks:** nothing.
- **Files:**
  - `apps/server/src/sandbox/lifecycle/SandboxOverview.ts`: `currentBaseImage({ resolved, override,
    version })` is the pure choice of the base the server would boot now (the driver's resolved
    image, else the override, else `DEFAULT_BASE_IMAGE_REPOSITORY:<version>`), returning
    `TeamImageCurrentBase` (`digest` and `version` are null when unknown). Overview's label comes
    from it. `driverBaseImage(driver)` reads one driver's resolved base.
  - `TeamImageService.ts` `snapshot`: `currentBase` for the default driver. A resolved base is
    cached until `sandbox.baseImage` changes (the driver resolves once per override too); an
    unresolved one (pulling, unreachable) is looked up again after a minute, so a dead Docker host
    costs one 10 s probe a minute, not one per snapshot.
  - `packages/client-runtime/src/teamImagePresentation.ts`: `rebuildSuggestion(activeBuild,
    currentBase)` returns the sentence when both digests are known and differ, or when either
    digest is unknown and both versions are known and differ; else null. It tests "differs", not
    "older": a server rolled back to an older release also reads "Rebuild to update".
  - `TeamImageSettings.tsx`: an info alert under the active build for admins, with **Build** (a
    build of the saved revision). Mobile does not show it in M4: 4.21 owns that screen in the same wave, and the
    hint is an admin's prompt to act on the web.
- **Types and services:** `currentBaseImage` (SandboxOverview); `rebuildSuggestion`.
- **Commands and events, Migrations:** none.
- **Tests:** `teamImagePresentation.test.ts` rows: same digest, different digest, unknown digest
  with different versions, no active build.
- **Verify:** the tests; one `test-t3-app` capture with `sandbox.baseImage` overridden to another
  tag so the digests differ. G4's step for it is set aside (see the pass).
- **Reviewer checks:** the hint compares what the server would boot, not the server version alone
  (a pinned override must not nag). Surfaces: web and desktop; the words live in client-runtime,
  so mobile can show them later without new copy.

## M4 integrated pass

One run of [G4](../10-delivery-plan.md#g4-after-m4-and-m5) step 1 after the last M4 wave, by the
primary agent with the maintainer for the marked steps. Steps 2–6 need M5 and an AWS account and
are not part of this run. It follows the install guide's **Build a team image** (4.18) and
[test-t3-app](../../../../.agents/skills/test-t3-app/SKILL.md). Pair Cloud runs from a release,
never from `~/pair`; the browser is the Mac's, on the hosted or local web client paired with Pair
Cloud. Subagents don't start their own servers.

0. **Before.**
   - **The release (maintainer).** Cut `V5` (`0.1.7-pair.5`, or `<upstream>-pair.<n+1>` if
     upstream moved) from `feat/pair` after the last M4 row: push the `v<version>` tag, let the
     release workflow publish it (the base image too: the build starts from the base this version
     pins), then `gh release edit v<version> --prerelease`. Any prerelease is approved (the
     maintainer's answer of 2026-11-10).
   - **The VM.** `gcloud compute instances start pair-cloud-pass --project vm-provider --zone
     asia-south1-a`, then `gcloud compute ssh …`. The CLI is `~/.local/bin/t3`. Check that the G2
     and G3 settings survived (App ID 5668078 and key, the Claude team account, the member's
     GitHub connection, Docker on gVisor with the DNS shim, team cap 6) and that `t3 service
     status` reports V4.
   - **Upgrade.** `t3 drain`, then `t3 update <V5> --yes`. Passes when `t3 --version` prints V5,
     a G3 machine wakes on V5, and the environment's capabilities report `teamImages` (capture).
     The lead mints the pairing links; redact them everywhere.
   - **Second member.** Member B from G3 exists, with role member (not admin), for steps 5 and 6.
1. **Build (Mac).** As the admin, open Settings → Cloud → **Team image**. Set the recipe:
   pre-clone `rutvikchandla3/pair-cloud-test`, install script `sudo apt-get update && sudo apt-get
   install -y postgresql-client`, one build secret pointing at a test value. **Save and build.**
   Passes when:
   - the log streams while the page is open and the phases advance on the row;
   - the build succeeds and becomes **Active** without a click (a page build);
   - the row shows the base, the provider versions, one pre-cloned project and the size;
   - on the VM, `docker image ls t3-team-image` lists `:1`, and `docker image inspect` shows only
     the build label and no secret in `Config.Env` (capture).
     Record the build time and image size.
2. **A session boots from it (Mac, Credentials).** Start a cloud thread on `pair-cloud-test`.
   Passes when:
   - `docker inspect` of its container names `t3-team-image:1`;
   - in its terminal, `psql --version` answers and `echo $PATH` shows any `imageEnv` addition;
   - the thread's machine status reads "Build 1";
   - the checkout trace shows the copy from the image and a fetch, not a clone;
   - a Haiku turn runs as usual.
     Then measure the first-boot copy on gVisor (4.17): five fresh sessions, the median time from
     checkout start to a ready worktree, against five with the project removed from the recipe (a
     network clone). Keep the copy unless its median is over 30 s; record the table in progress.md.
3. **A leak fails the build (Mac).** Change the script to also run `npm config set
   //registry.npmjs.org/:_authToken "$NPM_TOKEN"` with `NPM_TOKEN` as the build secret. Passes
   when the build fails at `clean` naming `NPM_TOKEN` and `.npmrc`, the active build stays 1, and
   the log shows `***` where the value was (capture). Restore the previous recipe with **Restore
   recipe** and save.
4. **Roll back (Mac).** Build again (build 2, active on success). Start a session and check it
   boots from `:2`. Then **Activate** build 1. Passes when:
   - the page shows build 1 active within 10 s of the click (time it on the video);
   - the next new session boots from `:1`;
   - the session on build 2 keeps running on `:2`.
5. **The admin agent (Mac, Credentials).** **Edit with an agent**, pick `pair-cloud-test`, and
   ask (Claude Haiku): "add `jq` to the team image and build it". Passes when:
   - it calls `t3_team_image_read`, then `t3_team_image_recipe_update` keeping the existing lines,
     then `t3_team_image_build_start`;
   - build 3 finishes as **Ready**, not active, and the admin gets the "ready to activate" toast
     on another page;
   - **Activate** makes it active, and a new session has `jq`.
     Then, as member B in their own cloud thread, ask the agent to add something and build. Passes
     when the update is refused with the not-admin message, the agent files a proposal instead, and
     the admin sees it under **Proposals**, reviews the diff and dismisses it.
6. **Cancel and restart (Mac).** Start build 4 and **Cancel** it during `install`. Passes when
   it is **Cancelled**, its machine is gone (`docker ps -a`), and no tagged container is left.
   Start build 5, and during `install` run `t3 drain` on the VM: it prints that it waits for the
   build. Cancel the drain, then `t3 service restart` during the build. Passes
   when build 5 shows **Failed · interrupted**, its machine is destroyed after the restart, and
   Settings → Cloud does not show restore mode.
7. **Collection (Mac).** Set **Keep succeeded builds** to 1 and build once more. Passes when the
   active build and any build a live session uses survive, the oldest unused succeeded image is
   gone from `docker image ls`, and its row says "Image removed" with **Activate** disabled.

Set aside this run: 4.22's hint (covered by its test; no base upgrade happens between V5 builds)
and 4.21's phone steps (owed, as its spec says).

Evidence (redact pairing links, startup URLs and tokens from all of it):

- G4 step 1's video (steps 1, 2, 4 and 5), with the rollback timed.
- Captures of the Team image page as admin and as member, the leak failure, the agent's Ready
  row and the proposal review, on web and desktop.
- The `mcp-tool-use` eval output for 4.19 and 4.20, run with an `ANTHROPIC_API_KEY` in the repo's
  `.env`.
- The build time, image size and the first-boot copy table.
- The upgrade transcript.

Record the run in progress.md's M4 section. Stop only the processes this run started, by the PIDs
it captured. Stop the VM when idle; never delete it.
