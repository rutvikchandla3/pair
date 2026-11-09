# M2 Pair Cloud on Docker: implementation specs

Status: implementation plan, 2026-11-09. Nothing here is built. Read [README](./README.md) first
for the shared names and traps, and [M1](./m1-cloud-threads-docker.md) for what this milestone
builds on. The design is in docs [01](../01-product.md)–[09](../09-byoc.md); the PR list is
[10 §2](../10-delivery-plan.md#m2-pair-cloud-on-docker-first-release), and
[m2-m5](./m2-m5.md#m2-pair-cloud-on-docker-first-release) has each row's scope as first sharpened.

Each PR follows one template: what it makes true, Needs and Unblocks, Files, Types and services,
Commands and events, Migrations, Tests, Verify, Reviewer checks. Line numbers are from `feat/pair`
at `9e24f04d2` (2026-11-09); re-read the symbol before editing. Where a spec says **proposed**, it
fills a gap the design docs left open; a reviewer can overrule it in that PR without changing any
other row. Decisions #1–#6, #9, #10 and #13 of [10 §7](../10-delivery-plan.md#7-decisions-maintainers-must-make)
are accepted as recommended, and every spec follows them.

M2's PRs merge after G1, which closed on 2026-11-09 with its set-aside items in
[progress](./progress.md). M2 is done when [G2](../10-delivery-plan.md#g2-end-of-m2) passes; the
[last section](#m2-integrated-pass) turns G2 into steps.

## Build order

Waves respect every Needs below; rows in one wave can be built in parallel, and two rows in one
wave that touch the same file land one after the other.

| Wave | PRs                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 2.22 cloud-only mode, 2.1 idle sleep, 2.4 `retryAfterMs`, 2.25 redaction, 2.31 `branch-not-pushed`, 2.32 `historyOrigin`, 2.33 `/runner/*` mount, 2.34 webhook URLs, 2.36 release, 2.38 restore mode, 2.41 R1, 2.42 G1 defects, 2.43 team cap, 2.44 App PR reads, 2.46 cloud investigations, 2.47 managed Codex sign-in |
| 2    | 2.23 launch gate, 2.2 wake, 2.7 snapshot before sleep, 2.35 pushes, 2.37 drain, 2.39 effect lanes                                                                                                                                                                                                                       |
| 3    | 2.24 `cloudLaunch`, 2.8 asleep reads, 2.9 status without waking, 2.13 rebuild, 2.18 scheduled runs, 2.40 load test                                                                                                                                                                                                      |
| 4    | 2.26 Pair Cloud projects, 2.27 resolver, 2.45 cloud-only reads, 2.12 disk retention                                                                                                                                                                                                                                     |
| 5    | 2.28 web and desktop routing, 2.29 mobile routing                                                                                                                                                                                                                                                                       |
| 6    | 2.30 account onboarding                                                                                                                                                                                                                                                                                                 |
| 7    | 2.21 the install and cloud guides, then the [integrated pass](#m2-integrated-pass)                                                                                                                                                                                                                                      |

The critical path is 2.22 → 2.23 → 2.24 → 2.27 → 2.28 → 2.30 → 2.21 → G2, with 2.26 beside 2.27.
2.36 (the release) and 2.40 (the load test) must be in before G2 starts, since G2 installs the
release and runs the test. 2.47 unblocks G2 step 13, so it goes early.

| PR   | Needs (final)                                            |
| ---- | -------------------------------------------------------- |
| 2.1  | M1                                                       |
| 2.2  | 2.1                                                      |
| 2.4  | M1                                                       |
| 2.7  | 2.1                                                      |
| 2.8  | 2.7                                                      |
| 2.9  | 2.7                                                      |
| 2.12 | 2.1, 2.7, 2.13                                           |
| 2.13 | 2.7, 2.23                                                |
| 2.18 | 2.1, 2.2, 2.22, 2.23                                     |
| 2.21 | 2.12, 2.22, 2.26, 2.28, 2.30, 2.31, 2.34–2.38, 2.43–2.45 |
| 2.22 | M1                                                       |
| 2.23 | 2.22                                                     |
| 2.24 | 2.22, 2.23                                               |
| 2.25 | M1                                                       |
| 2.26 | 2.22, 2.24, 2.31, 2.44                                   |
| 2.27 | 2.24                                                     |
| 2.28 | 2.26, 2.27, 2.31                                         |
| 2.29 | 2.27, 2.31                                               |
| 2.30 | 2.28, 2.29                                               |
| 2.31 | M1                                                       |
| 2.32 | M1                                                       |
| 2.33 | M1                                                       |
| 2.34 | M1                                                       |
| 2.35 | 2.22                                                     |
| 2.36 | M1                                                       |
| 2.37 | 2.1                                                      |
| 2.38 | M1                                                       |
| 2.39 | 2.4                                                      |
| 2.40 | 2.39, 2.43                                               |
| 2.41 | —                                                        |
| 2.42 | M1                                                       |
| 2.43 | M1                                                       |
| 2.44 | M1                                                       |
| 2.45 | 2.22, 2.24                                               |
| 2.46 | M1                                                       |
| 2.47 | M1                                                       |

## What the code changed in 10 §2

Drafting each PR against the code changed the plan in these ways. The [track notes](#track-notes)
give the evidence.

- **New rows.** 2.44 reads pull requests with the App's installation token (decision #3, which no
  row owned). 2.45 takes 2.22's read-side and host-tool rows of 06 §10, so 2.22 stays small on the
  critical path. 2.46 (review-guide investigations in the machine) and 2.47 (a managed Codex
  account losing its provider instance during sign-in, G1) come out of 2.42.
- **Order.** 2.24 needs 2.23, which adds `NOT_CLOUD_ONLY_MESSAGE` and the direct check 2.24 folds
  into `cloudAvailability`; the critical path gains a wave. 2.26 needs 2.24, 2.31 and 2.44. 2.29
  needs 2.31. 2.37 needs 2.1, and 2.39 lands after 2.4 (same files). 2.13 needs 2.23. 2.12 needs
  2.13, so a disk is never destroyed before it can be rebuilt. 2.40 needs 2.43 for a cap above the
  VM's default.
- **Moves.** The G1 wake-after-settle fix moves from 2.2 to 2.1, since it is the settle rule that
  `idleDecision` replaces. The 7-day archived and 30-day asleep destroys move from 2.1 to 2.12. The
  Cloud item's **Add to Pair Cloud** moves from 2.26 to 2.28, which owns the Cloud item and lands
  after the resolver. 2.26 owns the `t3_project_clone` and `t3_project_create` row of 06 §10.
- **Names the code already has.** `stoppedBy` on the sandbox record is the existing `sleepReason`
  (`idle | manual | settled | archived | cap-pressure`); no literal is needed. The record's unions
  are strict, so a literal is safe only before G2 tags the first release. M2 adds three under that
  rule: 2.37's `"draining"` admission reason, and 2.22's `TerminalCloudOnlyError` and
  `ProjectFileFailure` `"cloud_only"`. After V1, a new value needs a forward-compatible decode. 07 and 08's `stoppedBy` is a terminal field (2.8).
  The origin key is `repositoryGroupingKeyOf`. `existingBranch` is `Schema.Literal(true)`, as 08 §2
  has it.
- **Smaller than the rows said.** 2.2 needs no MCP or CLI code: every send already wakes through
  M1's prompt path, and lists never wake. 2.7 takes its snapshot inside the `sandbox.stop` executor,
  not a new effect that could fail the stop. 2.9 stores the head context as a mirror ref, so no
  migration. 2.12 adds a two-field `diskRetention` instead of reusing `WorktreeCleanupRules`, whose
  fields mean nothing for a mirrored disk.
- **Larger than the rows said.** 2.36 must fix `readReleased` (RunnerBundle.ts 140): a
  single-executable server refuses its own runner bundle, and the archive's `t3` is one. It also
  makes `t3 update` follow `T3CODE_RELEASE_BASE_URL`. Its smoke test serves the archive's runner
  tree to a real runner, since the fake driver boots nothing. 2.24 makes Cloud the only mode on a
  `cloudLaunch` server and stops reading `defaultsToCloud`. 2.30 lets web Settings → Team pick its
  environment, since the Mac app shows only the local server's team today. 2.43 keeps the cap out
  of the driver instance, because any config change rebuilds the driver and fails its in-flight
  calls.
- **Engineering calls against the rows.** 2.4 keeps counting `capacity` and `rate-limited`
  attempts (04 §4), so a persistent capacity error still ends. 2.39 bounds only replay-safe effect
  types; `provider-turn.start` gets the lane but no timeout, since a cut start that retries can
  start the turn twice. 2.22 refuses MCP `create_threads` for every caller on a cloud-only server
  and for cloud callers everywhere: on M1 a cloud caller's child runs on the machine untracked.
- **Migrations.** One, `091_ScheduledTaskCloudRuns` (2.18).

Open questions for a maintainer, each with a proposed answer in its spec:

- Pair's own store ids, Apple team, EAS project and Firebase project (2.35). Proposed: the
  maintainer creates them before 2.35 merges; the PR carries placeholders until then. G1's
  `machine-failed` push needs the same signed build.
- The App's permissions (2.44). Proposed: the install guide asks for Checks and Commit statuses
  read too, so the PR panel shows checks under the App.
- The release version scheme (2.36). Proposed: `<upstream version>-pair.<n>`, which every version
  check in the code already accepts. G2 step 10 upgrades to `-pair.<n+1>` cut from the same branch.
- Opening a settled thread (2.2). Proposed: it doesn't wake the machine (04 §2 says it does); a
  prompt, a terminal, a restore or **Wake** does.
- Universal links (2.35). Proposed: app.t3.codes links don't open Pair's build in M2.

## Shared names

The names below cross PRs. Each is defined by the PR in brackets; later PRs use it as written.

- **Mode and gate.** `--cloud-only`, `T3CODE_CLOUD_ONLY`, `ServerConfig.cloudOnly` (2.22);
  `CloudOnly.refuseLocalHost` and `CLOUD_ONLY_MESSAGE` in `apps/server/src/environment/CloudOnly.ts`
  (2.22); `SandboxDecisionInput.cloudOnly` and the module-private `SandboxRefusalReason`
  `"not-cloud-only"` in `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`, and
  `NOT_CLOUD_ONLY_MESSAGE` in `packages/shared/src/sandbox.ts` (2.23);
  `ExecutionEnvironmentCapabilities.cloudLaunch`, `CloudAvailability` reason `"not-cloud-only"`,
  `cloudAvailability(settings, projectId, cloudLaunch)` (2.24).
- **`CloudLaunchError` reasons.** `"local-launch"` (2.22), `"not-cloud-only"` (2.23),
  `"branch-not-pushed"` with `branch` and `remote` (2.31), `"repo-unreadable"` (2.30).
- **Launch.** `existingBranch: Schema.optional(Schema.Literal(true))` on
  `OrchestrationV2ThreadLaunchCloudStrategy`, `GitWorkflowService.remoteHasBranch` (2.31);
  `discardOnSettle` on `ScheduledTask`, `ThreadLaunchInput` and `OrchestrationV2Sandbox`,
  `ScheduledTask.lastRunThreadId` (2.18).
- **Pair Cloud projects and routing.** A Pair Cloud project is a project on a cloud-only server
  whose root is `<ServerConfig.checkoutsDir>/<projectId>`; `PairCloudProjects` (`add`, `gitEnvFor`,
  `fetchCheckout`) and `PairCloudProjectError` (2.26); `resolveCloudTarget`, `CloudTarget`,
  `CloudTargetOption`, `isCloudLaunchEnvironment` (2.27); `routedCloudLaunch`, `cloudBranchCheck`,
  the web draft's `cloudEnvironmentId` (2.28); `cloudAccountNotice` (2.30).
- **GitHub.** `GitHubAppInstallationTokens.readTokenFor({ repository })` and
  `READ_TOKEN_PERMISSIONS`, `withAppReads`, `GitHubCredentialSource` `"installation"` (2.44; 2.26
  clones with `readTokenFor`).
- **Idle and wake.** RPC `sandbox.viewing` (`WS_METHODS.sandboxViewing`, `SandboxViewingInput`),
  `SandboxActivity`, `VIEWER_LEASE_MS`, `idleDecision`, `APPROVAL_HOLD_MS`,
  `ComputeCapabilities.sleepOnSettle` and `.defaultIdleSleepMs`, `sandbox.auto-sleep.reason` (2.1);
  `SandboxWake`, `EffectOutboxV2.expedite` (2.2).
- **Effects.** `retryDelayMs`, `RETRY_AFTER_CAP_MS` (2.4); `RUNNER_BOUND_EFFECT_TYPES`,
  `EFFECT_LANE_SLOTS` (2.39).
- **Operations.** `t3 drain [--timeout] [--cancel]`, RPCs `server.drain` and `server.cancelDrain`,
  `ServerDrain`, admission reason `"draining"` (2.37); `--restore-mode`, `T3CODE_RESTORE_MODE`,
  `SandboxSettings.restoreModeSince`, `SandboxRestoreMode`, `ReconcileAction.StopOrphan` (2.38);
  `DockerSandboxDriver.runningCap`, `ComputeDriverRegistry.runningCap` (2.43); `RunnerRoute.layerWhen`
  (2.33); `--public-url`, `T3CODE_PUBLIC_URL`, `ServerConfig.publicUrl`, `WebhookOrigin.hookBaseUrl`
  (2.34).
- **Mirror and asleep reads.** `sandboxSnapshotRef`, `OrchestrationV2Sandbox.sleepSnapshotAt`,
  `CheckpointServiceV2.captureSnapshot` (2.7; every sleep arm patches `sleepSnapshotAt: null`);
  terminal `stoppedBy`, `TerminalManager.stopForSleep`, `StoppedSandboxReads.diffPreview` (2.8);
  `refs/t3/sandbox/<thread>/head`, `SandboxHeadContext` (2.9); `SandboxSettings.diskRetention`,
  `decideDiskExpiry`, `sandbox.expire` (2.12); `ThreadLaunchService.restoreCheckout` (2.13).
- **Release.** Assets `t3-<v>-linux-{x64,arm64}.tar.gz`, `SHA256SUMS` and `install.sh` at tag
  `v<v>`; `RunnerBundle.layerFromTree`; `cliReleaseRepositoryOf` (2.36). The user guide
  `docs/user/pair-cloud.md` (2.21).

## Track notes

Each track's rows were drafted together; these notes keep the reasoning behind the changes above.

### Cloud-only mode and the launch gate (2.22, 2.23, 2.24, 2.25, 2.33, 2.35, 2.43)

Cloud-only mode is a startup flag, `ServerConfig.cloudOnly`. 2.22 adds it and closes every 06 §10
row that runs work on the server's own machine. While the flag is on, the server also refuses to
start if a local thread still has work. 2.45 closes the remaining read-side rows and
the host tools. 2.23 then puts every decision that creates a machine behind the flag. It also moves
`delegated_task.request` out of the client's reach, so the server's launch gate is the only way a
machine gets made. 2.24 tells clients about the flag (`capabilities.cloudLaunch`), and `cloudAvailability`
gains `not-cloud-only`, so Cloud leaves every other server's UI. 2.25, 2.33 and 2.43 are wave-1
hardening and don't depend on the flag. 2.25 shows members a reduced driver view. 2.33 serves
`/runner/*` on the member listener only when some driver dials it over TCP. 2.43 adds an admin cap
per driver. 2.35 needs the flag, because a cloud-only server pushes to Pair's own app build from its
first member.

#### PR-list changes

- **2.22 splits.** 2.22 keeps the mode, the startup refusal, and every row that _executes_ on the
  host. That covers local threads, terminals and scripts, the launch tools including `create_threads`,
  workspace writes, host-tool RPCs, and git writes on host paths. A **new row, 2.45**,
  `fix(server,web): confine reads and host tools on cloud-only servers`, takes the rest:
  - `filesystem:read` confinement.
  - Device tools, preview tools and the server browser.
  - `t3_environment_link` for admins only.
  - Text generation with an empty `cwd`.
  - Provider probes without a project `cwd`.
  - Claude member sign-in by setup token or API key only.
  - The D15 trust text in the invite dialog and `team.md`.

  It needs 2.22 and 2.24 and goes in wave 4. 2.22 is wave 1 and on the critical path, and the
  read-side rows touch many files without blocking 2.23 or 2.24. The trust text must describe the
  finished state, so it moves with the last rows.

- **2.22 refuses `create_threads` on a cloud-only server for every caller, and on any server for a
  cloud caller (proposed).** 06 §10 says "refused for local callers". On cloud-only, local callers
  can't run anyway. Cloud callers hit an M1 bug: `createThreads` (OrchestratorMcpService.ts 2829)
  dispatches `thread.create` with the parent's machine `worktreePath` and no `sandboxId` (2895–2914).
  `thread.create` can't carry one (orchestrationV2.ts 3170–3198), so the child runs on the machine
  untracked by admission and auto-sleep.
- **2.24's scope grows.** On a `cloudLaunch` environment, the mode picker offers only Cloud and new
  drafts default to Cloud (web and mobile). `newThreadPrefersCloud` stops reading `defaultsToCloud`.
  The title's `desktop` scope becomes `mobile`, because desktop wraps web and needs no `apps/desktop`
  change, while mobile has three callers. This touches Track B's 2.27 (see "For the lead").
- **2.43 keeps the cap out of the driver instance.** Settings hold the cap, and admission reads it.
  Today any config change rebuilds the driver (`ComputeDriverRegistry.sync` 83–98 compares the whole
  struct, `sameConfig` 57), and "In-flight calls on the old driver fail `unavailable`" (92). So a cap
  edit would fail a member's in-flight create. A raised cap must also wake the admission sweep. A
  full-cap queue reports `nextDueMs: Infinity` (SandboxLifecycleWorker.ts 121), and only domain
  events invalidate the due hint (`affectsLifecycle` 37–44). `defaultRunningCap` keeps its name,
  because it stays the driver's default.
- **2.23 also owns** the decider's own cloud-only input and the Pair Cloud refusal text that 2.24's
  clients reuse (`NOT_CLOUD_ONLY_MESSAGE`).

### Pair Cloud projects and routing (2.26, 2.27, 2.28, 2.29, 2.30, 2.31, 2.32)

These rows make Cloud work from a member's Mac. Two contract PRs land first and alone: 2.31 lets a
launch say "this branch already exists, refuse it if it isn't pushed", and 2.32 lets an M2 client
read M3's history value. 2.26 gives a cloud-only server its own kind of project, a **Pair Cloud
project**: a checkout of an https github.com repo that the server clones itself, which local projects
match by **origin key**. 2.27 is the pure resolver that finds a local project's Pair Cloud target,
and it keeps auto balance and machine pickers off Pair Cloud for non-cloud modes. 2.28 (web and
desktop) and 2.29 (mobile) route the Cloud item, drafts and send through it, with the branch check.
2.30 closes with the notices that tell a member what to connect on Pair Cloud. Nothing here adds a
migration: Pair Cloud projects are ordinary project rows, told apart by where their checkout lives.

#### PR-list changes

- **2.26 loses the Cloud item's Add to Pair Cloud.** It needs the resolver (2.27), and both land
  in wave 4 side by side. The button moves to 2.28, which already owns the Cloud item. 2.26 keeps the server side
  and the existing add-project flows on a `cloudLaunch` server (palette, link view, mobile Add
  project), so its scope becomes `feat(server,web,mobile)`.
- **2.26 Needs:** 2.22, 2.24 (clients hide the destination path on `cloudLaunch` servers), 2.31
  (2.26 passes the checkout's credential to the branch check), 2.44 (`readTokenFor`). Was 2.22.
- **2.26 owns the `t3_project_clone` / `t3_project_create` row of 06 §10** (the refusal of
  arbitrary roots and the Pair Cloud add), so 2.22 drops that row. Proposed; Track A to agree.
- **2.27 scope covers the web and mobile picker filters** (`useLogicalProjectEnvironments`,
  `useAddProjectTargets`, mobile `environments`), not only client-runtime. Title becomes
  `feat(client-runtime,web,mobile): resolve a local project's Pair Cloud target`.
- **2.29 Needs:** 2.27, 2.31 (mobile sends `existingBranch`). Was 2.27.
- **2.30 scope adds web Settings → Team picking its environment.** Today it shows only the primary
  environment's team (`TeamSettings` (76) reads `usePrimaryEnvironmentId`, and
  `useTeamSettingsVisible` (team.ts 86) hides the page unless the primary knows teams). On the Mac
  app the primary is the local server, so a member cannot reach Pair Cloud's Team page at all, which
  D8 needs.

### Lifecycle and operations (2.1, 2.2, 2.4, 2.37, 2.38, 2.39, 2.42)

These rows make a Pair Cloud machine's life predictable and keep the server safe to operate.
2.4 and 2.39 touch the effect worker and the outbox claim, which every later row runs through:
driver hints set retry timing, and slow machines get their own worker slots. 2.4 lands in wave 1
and 2.39 after it. 2.1 replaces M1's settle-only sweep with one pure `idleDecision`, adds the viewer lease
RPC, and fixes G1's wake-then-stop bug at the rule. 2.2 then hangs each wake trigger on that
lease and on a small `SandboxWake` service, and parks a restore until the machine is ready. 2.37
(drain) and 2.38 (restore mode) are the two operator switches the install guide (2.21) and G2
steps 10 and 11 use. 2.42 closes three small G1 defects. Its other two candidates move to rows of
their own. Build order: 2.4, 2.1, 2.38, 2.42 (wave 1), then 2.2, 2.37, 2.39 (wave 2).

#### PR-list changes

- **2.1 takes the G1 wake-after-settle fix from 2.2.** The fix is part of the settle rule that
  `idleDecision` replaces: a settle stops the machine only when the settle came after the machine
  last became ready. 2.2 keeps a test that each trigger's wake stays up.
- **2.1 drops the 7-day archived and 30-day asleep destroys.** Track D's 2.12 owns them
  (`decideDiskExpiry`, `sandbox.expire`), behind 2.7 and 2.13, so a destroy never loses
  uncommitted work. m2-m5 2.1's Scope lists them; 10 §2 already gives 2.12 decision #2 too.
- **2.2 needs no MCP or CLI code.** `t3_thread_send`, `t3 thread send`, delegated tasks and
  scheduled tasks already wake through M1's prompt path (`gateCloudMessage`, Orchestrator.ts
  11037). `t3_worktree_status` and `t3_worktree_handoff` act on the caller's own running thread
  (`apps/server/src/mcp/toolkits/worktree/handlers.ts` 42, 49). `t3_worktree_list` (13) is a list,
  and 04 §2 says lists never wake. No MCP tool reads another thread's files. 2.2's new triggers
  are the thread view, a terminal write, and restore.
- **2.4 keeps counting attempts.** m2-m5 2.4 proposes that `capacity` and `rate-limited` attempts
  not count. 04 §4 (381–382) says they "fail the sandbox only when the effect's attempts run out".
  Not counting would retry a persistent capacity error forever with no message. Spec follows 04.
- **2.39 gives no time bound to turn starts.** m2-m5 2.39 names `provider-turn.start`. It is
  process-bound (`PROCESS_BOUND_EFFECT_TYPES`, EffectOutbox.ts 185), and a timeout that cuts a
  start midway then retries it can start the turn twice. The lane alone stops slow starts from
  stalling other threads. Bounds go only on replay-safe types.
- **2.42 keeps (a), (b) and (c). (d) and (e) become new rows, 2.46 and 2.47.** (d) runs review-guide
  investigations inside the machine with its env. It is a provider-shaped feature, not a small
  defect, and today it already fails with a clear message
  (`TextGenerationOperations.cloudInvestigationUnsupported`,
  `packages/provider-core/src/server/textGenerationOperations.ts` 43). (e) is undiagnosed provider
  auth and blocks G2 step 13 (a managed Codex turn), so it needs its own owner and urgency.
  Specs for both close this track.

### Mirror, asleep data and scheduled runs (2.7, 2.8, 2.9, 2.12, 2.13, 2.18, 2.34)

M1 left a machine's last diff in the checkpoint mirror and nothing else. This track makes sleep a
state a user can work around. 2.7 snapshots each attached thread's working tree into the mirror
before the machine stops. 2.8 reads files, search and Changes from that snapshot, labels them with
the time it was taken, and shows terminals that sleep stopped. 2.9 keeps PR discovery working
while asleep from a small head-context record taken with the snapshot. 2.12 destroys disks that
sat unused (archived 7 days, asleep 30), which is safe only because 2.7 and 2.13 exist. 2.13
rebuilds a lost or destroyed disk from the mirror's branch and snapshot instead of handing the
user an empty folder. 2.18 turns scheduled and webhook runs into cloud launches on a cloud-only
server, ahead of 2.22's local-launch refusal, and adds "discard the machine when the run settles". 2.34 stands apart: it gives webhook tasks a full URL
on a server with a public origin and no T3 Connect tunnel. 2.7 is the spine: 2.8, 2.9 and 2.12
need its snapshot, and 2.13 needs the snapshot to restore uncommitted work.

#### PR-list changes

- **2.7 takes the snapshot inside the `sandbox.stop` executor, not in a new
  `sandbox.snapshot-tree` effect** (proposed). m2-m5 names a separate effect enqueued before
  `sandbox.stop`. A separate effect that exhausts its retries hits `SandboxEffects.reportExhausted`
  and fails the sandbox, and it adds an outbox row and a decider effect list change for work that
  must never fail the stop. The stop executor already flushes the mirror first
  (`SandboxEffects.ts` 388–397). The snapshot goes in the same place, bounded, and never fails.
- **"`stoppedBy` on the sandbox record" is the existing `sleepReason`.** The record already says why
  a machine stopped: `OrchestrationV2Sandbox.sleepReason` (`orchestrationV2.ts` 476) with
  `SandboxSleepReason` (`sandbox.ts` 86) = `idle | manual | settled | archived | cap-pressure`.
  The literal set is strict, so a new value breaks M1 clients' decode of `sandbox.updated`. No new
  record field. The owner docs' `stoppedBy` (07 §4, 08 §7 `stoppedBy: "sleep"`) is a
  **terminal** field; 2.8 defines it.
- **2.8 owns 08 §9's "2.10" and 2.18 owns 08 §9's "2.11"**, as m2-m5 already says. 08 §9 still
  uses the old ids.
- **2.9's head-context record lives in the mirror, not a table** (proposed): one blob ref per
  thread, `refs/t3/sandbox/<thread>/head`, written with 2.7's snapshot. No migration, and the
  mirror's existing `deleteThreadNamespace` (`CheckpointMirror.ts` 439) cleans it up.
- **2.9's frozen status is in-memory only.** `VcsStatusBroadcaster` already keeps the last status
  for an unreachable machine (`VcsStatusBroadcaster.ts` 585). 2.9 labels it and stops the PR
  fallback. A server restart forgets the status until wake (proposed; no persisted status).
- **2.12 does not reuse `WorktreeCleanupRules`** (proposed). Its fields
  (`worktreeKeepWhen`, `worktreeUnchanged`, `worktreeSettledAfterDays`) have no meaning for a
  mirrored disk, and it has no archived rule. 2.12 adds a two-field `diskRetention` setting and
  reuses `threadActivityAt` (`orchestration-v2/threadActivity.ts`, moved there by 2.1) for "inactive".
- **2.13's real G1 bug is the Retry button, not the prompt path.** A prompt to a thread with no
  disk already re-checks out from GitHub (1.16: `decideCloudPrompt` Defers with a `worktree`
  strategy, `releaseWaiters` re-arms `prepareRun`). Retry and Wake with no queued message
  re-provision and then nothing re-creates the checkout, so the panel finds an empty folder.
  2.13 fixes both paths and switches the source to the mirror.
- **2.13's refusal on a non-cloud-only server belongs to 2.23** (Track A). M2 tests list "a wake of
  `destroyed` and a retry with no disk are refused" off cloud-only. 2.13 only routes its rebuild
  through that gate.
- **2.18 needs migration 091** (scheduled task columns). 2.34, 2.7, 2.8, 2.9, 2.12 and 2.13 need
  none.
- **2.34's Needs stays M1, but the web already builds a full URL.** `webhookAddress`
  (`packages/client-runtime/src/webhookAddress.ts` 10) joins the path to the client's
  `httpBaseUrl`. What is missing: the server's own `webhook.url` (agents and MCP see only the
  path), and the hold-while-offline control, which today shows for any non-null URL.

### Release, performance, PR reads and docs (2.21, 2.36, 2.40, 2.41, 2.44)

These rows turn M2's code into something a team installs and trusts. 2.36 makes the release: a
tagged download in the CLI archive format that carries the runner tree, so G2 and every later gate
install Pair Cloud by exact version and not from a checkout. 2.41 and 2.40 are the two performance
proofs: local work does not pay for Pair Cloud (R1), and one server carries 30 machines without one
machine's output starving the rest. 2.44 is new: the team's GitHub App reads pull requests where
it is installed, so a Pair Cloud server with only the App shows PRs (decision #3). 2.21 lands last
and documents what the other rows built. 2.36, 2.41 and 2.44 are wave 1 and touch disjoint files;
2.40 follows 2.39; 2.21 follows everything it documents.

#### PR-list changes

- **2.36 scope grows by one code fix.** A single-executable server refuses to serve a runner
  bundle today: `readReleased` (RunnerBundle.ts 140) fails with `"single-executable"` when
  `HostProcess.IsExecutable` (HostProcess.ts 73) is true. The CLI archive's `t3` is that
  executable, so a release that only adds `runner/` to the tarball still could not start a
  machine. 2.36 reads the tree beside the executable. It also makes `t3 update` follow
  `T3CODE_RELEASE_BASE_URL`; without that, a bare `t3 update` installs upstream T3 Code over Pair.
- **2.36's smoke test is the hub plus the image's bootstrap, not the fake driver.** The fake
  driver (ComputeDriverTesting.ts 73) boots nothing; `answerFromMemory` (186) posts a stand-in
  hello. The smoke instead serves the archive's runner tree from the real route and hub, downloads
  it the way `pair-bootstrap.sh` does, unpacks it, and attaches a real runner. Same intent as
  10 §4's "boots a machine from the release archive", stronger proof.
- **2.36 version scheme (proposed):** `<upstream version>-pair.<n>`, for example `0.1.7-pair.1`.
  `planRelease` (sandbox-image.ts 185) already requires the tag to equal the server's version, and
  `RELEASE_VERSION` (179), `isExactServiceVersion` (serviceProtocol.ts 66) and
  `cliReleaseChannelOf` (cliRelease.ts 87, Stable) all accept it.
- **2.41 measures one more thing.** `t3_git_command_duration` times only `processRunner.run`
  (VcsProcess.ts 266–279). The seam's host lookup and `host.info` read run before the timer
  (292–294), so the metric cannot see them. 2.41 adds the `VcsProcess.run` span from
  `t3 trace summary` to the comparison.
- **2.44 is a new row (proposed), wave 1, Needs M1, must land before 2.21:**
  `feat(server): read pull requests with the team's GitHub App where it is installed`.
- **2.40's code does not need 2.39.** The load test and the hub's byte budget touch only the runner
  hub and the benchmark script. It keeps "Needs 2.39" so the test runs with the lanes in, which is
  what G2 measures; 2.39 owns its own bound values. G2 step 12 runs it with 2.43's cap raised.
- **2.21 Needs, in full:** 2.12, 2.22, 2.26, 2.28, 2.30, 2.31, 2.34, 2.35, 2.36, 2.37, 2.38,
  2.43, 2.44, 2.45. The guide documents each of them. 10 §5 also gives M2 the
  owed M0 seam page in `docs/internals`; no row owns it. Proposed: 2.21 writes it as part of the
  overview change (see 2.21).

## PR specs

### 2.1 `feat(server): sleep idle sandboxes from the scheduler`

A ready machine now sleeps when nobody is using it: 60 idle minutes on Docker, at once when its
threads settle or archive, early under cap pressure, and after a question waits 2 hours
(decision #2). One pure `idleDecision` decides, from activity across every attached thread,
terminal I/O, a new viewer lease and scheduled tasks. Settle-sleep is now a driver capability,
not `kind === "docker"`. A settle stops the machine only if it came after the machine last became
ready, so a wake on a settled thread stays up (the G1 finding). Its own PR because it is the
lifecycle worker's whole policy.

- **Needs:** M1 (1.18's admission lock, 1.19's worker). **Unblocks:** 2.2, 2.7, 2.12, 2.37.
- **Files:**
  - `packages/contracts/src/orchestrationV2.ts` `sandbox.auto-sleep` (3931): add
    `reason: Schema.Literals(["idle", "settled", "archived", "cap-pressure"])`. It is internal
    (dispatch refuses it from clients), so the field is required.
  - `packages/contracts/src/sandbox.ts`: `SandboxViewingInput = Schema.Struct({ threadId: ThreadId })`.
  - `packages/contracts/src/rpc.ts`: `sandboxViewing: "sandbox.viewing"` beside `sandboxOverview`
    (562). `WsSandboxViewingRpc` beside `WsSandboxOverviewRpc` (1004), with payload
    `SandboxViewingInput`, success `Schema.Void` and `EnvironmentAuthorizationError`. Add it to the
    group beside the overview RPC.
  - `packages/contracts/src/clientRpcPermissions.ts` `CLIENT_GUARDED_RPC_SCOPES` (18):
    `[WS_METHODS.sandboxViewing]: AuthOrchestrationOperateScope`.
  - `apps/server/src/auth/RpcAuthorization.ts` needs no entry: it spreads
    `CLIENT_GUARDED_RPC_SCOPES`.
  - `apps/server/src/ws.ts` beside `sandboxOverview` (2851):
    `[WS_METHODS.sandboxViewing]: ({ threadId }) => sandboxActivity.view(threadId).pipe(Effect.asVoid)`.
    There is no per-thread check, as `presenceReport` (2474) has none: every team member sees
    every team thread. The operate scope keeps read-only sessions out, and `view` ignores a thread
    whose shell has no sandbox.
  - `apps/server/src/sandbox/compute/ComputeDriver.ts` `ComputeCapabilities` (72): add
    `readonly sleepOnSettle: boolean` and `readonly defaultIdleSleepMs: number`, documented as
    static per driver kind like `defaultRunningCap`. `DockerComputeDriver.ts` `capabilities` (76):
    `true`, `60 * 60_000`. `ComputeDriverTesting.ts` `make` (73): add both to `options`, with
    defaults `true` and 60 minutes.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`:
    - `SandboxAttachedThread` (51) gains `activeRunId: RunId | null` (rule 2 interrupts it),
      `activityAt: number` (epoch ms,
      `threadActivityAt`, moved from `storageCleanup.ts` 192 to the pure
      `orchestration-v2/threadActivity.ts` so the decider does not import storage cleanup; Track
      D's 2.12 also uses it), `restingAt: number | null` (`archivedAt` when archived, else `settledAt` when
      settled), `pendingRequestAt: number | null` (`pendingRuntimeRequest.createdAt` when
      `blocking !== false`, orchestrationV2.ts 2222), and `backgroundWork: boolean`
      (`pendingBackgroundTasks.length > 0`). `sandboxAttachedThread` (59) takes the full shell.
    - `decideAutoSleep(threads, readySinceMs)` (119): the M1 rule, plus null when the newest
      `restingAt` is strictly older than `readySinceMs`. This makes the settle rule fire only on
      the settle transition. A settle at the same instant as attach still sleeps, which keeps the
      existing row at 1167.
    - New constants `APPROVAL_HOLD_MS = 2 * 60 * 60_000` and `CAP_PRESSURE_IDLE_MS = 5 * 60_000`,
      and `holdsMachine(thread, nowMs)` (module-private, like `decideAutoSleep`): `backgroundWork`, or an active run, unless its blocking
      question is older than the hold. An active run with no question holds.
    - New pure `idleDecision(input: IdleInput): IdleDecision`:

      ```ts
      export interface IdleInput {
        readonly record: OrchestrationV2Sandbox; // ready
        readonly threads: ReadonlyArray<SandboxAttachedThread>;
        readonly activity: {
          readonly viewedAt: number | null;
          readonly terminalAt: number | null;
          readonly nextScheduledAt: number | null;
        };
        readonly policy: { readonly idleMs: number; readonly sleepOnSettle: boolean };
        readonly capPressure: boolean; // another sandbox on this driver waits for admission
        readonly nowMs: number;
      }
      export type IdleDecision =
        | { readonly _tag: "Busy" }
        | { readonly _tag: "Awake"; readonly untilMs: number }
        | {
            readonly _tag: "Sleep";
            readonly reason: "idle" | "settled" | "archived" | "cap-pressure";
            readonly interrupt: ReadonlyArray<{
              readonly threadId: ThreadId;
              readonly runId: RunId;
            }>;
          };
      ```

      Rules, in order:
      1. Any thread `holdsMachine` gives `Busy`, except a question still inside its hold, which
         gives `Awake { untilMs: pendingRequestAt + APPROVAL_HOLD_MS }`.
      2. Active runs whose questions all passed the hold give `Sleep { reason: "idle", interrupt }`.
      3. With `policy.sleepOnSettle`, a non-null `decideAutoSleep(threads, record.updatedAt)` gives
         `Sleep` with that reason.
      4. `anchor = max(record.updatedAt, every activityAt, viewedAt, terminalAt)`, plus
         `nextScheduledAt` once it is due, so a run about to start is not slept under.
      5. Under `capPressure`, `nowMs - anchor >= CAP_PRESSURE_IDLE_MS` gives
         `Sleep { reason: "cap-pressure" }`. Otherwise it stays awake until that instant.
      6. A `nextScheduledAt` before `anchor + 2 * idleMs` keeps the machine awake until that
         instant. The task's run then counts as activity.
      7. Otherwise, `Sleep { reason: "idle" }` at `anchor + idleMs`. Before then, it stays awake
         until that instant.

      Every sleep has `interrupt: []` except rule 2.

    - `decideSandboxCommand` `sandbox.auto-sleep` arm (405–413):
      - Refuse `wrong-state` unless `ready`.
      - Refuse `active-run` if any thread `holdsMachine(thread, now)`. A run past its hold no
        longer holds.
      - For `settled` and `archived`, the reason must equal `decideAutoSleep(threads,
        record.updatedAt)`, else refuse `in-use`.
      - For `idle` and `cap-pressure`, refuse `in-use` if `record.updatedAt` (a wake) or any
        `activityAt` is later than `command.snapshotAt`.
      - Otherwise `update({ state: "sleeping", sleepReason: command.reason }, ["sandbox.stop"])`.

      `busy` (382) stays as is for `sandbox.sleep` and `sandbox.discard`.
  - New `apps/server/src/sandbox/lifecycle/SandboxActivity.ts`. This is the in-memory idle input,
    and its test layer keeps the sweep testable:
    ```ts
    export const VIEWER_LEASE_MS = 6 * 60_000;
    export class SandboxActivity extends Context.Service<
      SandboxActivity,
      {
        /** Renews this thread's lease; true when no live lease covered it (2.2 wakes on that). */
        readonly view: (threadId: ThreadId) => Effect.Effect<boolean>;
        readonly read: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<IdleInput["activity"]>;
      }
    >()("t3/sandbox/lifecycle/SandboxActivity") {}
    ```
    `layer` keeps `Map<ThreadId, renewedAtMs>`. A renewal is activity for the whole idle window,
    so entries are pruned after a day, not when the lease expires; `VIEWER_LEASE_MS` only decides
    `view`'s result, and stays unexported until 2.2 needs it. It reads
    `terminalAt` from a new `TerminalManager.lastActivityAt(threadIds)`, and `nextScheduledAt`
    with one `SqlClient` query: the min `next_run_at` over enabled `scheduled_tasks` rows with
    `thread_id IN (...)` (table in `Migrations/OrchestrationV2/ScheduledTasks.ts` 8). It does not
    use `ScheduledTaskService`, which is built inside the runtime layer (`runtimeLayer.ts` 303) and
    would make a cycle. `makeTest` returns the service, with real leases on the test clock, and a
    `Ref` for each of the other two inputs.
  - `apps/server/src/terminal/Manager.ts` `TerminalManager` (158): add `lastActivityAt(threadIds)`,
    the max `updatedAt` of those threads' sessions (it advances on every event,
    `advanceEventSequence` 458). Read from the map `sessionsForThread` (2177) uses.
  - `apps/server/src/sandbox/lifecycle/SandboxLifecycleWorker.ts`:
    - `affectsLifecycle` (37): add `runtime-request.updated`, `provider-thread.updated` (background
      work) and `message.updated`.
    - Replace `shouldSleep` (98) with `idleFor(sandbox, driver, capPressure, nowMs)`. It reads the
      attached shells as today, plus `activity.read`, and calls `idleDecision` with
      `policy: { idleMs: driver.capabilities.defaultIdleSleepMs, sleepOnSettle:
      driver.capabilities.sleepOnSettle }`.
    - `sweep` (151): drop `dockerDriverIds` (157–164) for a `driverId → driver` map from
      `registry.list`. For each ready sandbox:
      - `Busy` adds no deadline. An event re-runs the sweep.
      - `Awake` folds `untilMs` into `nextDueMs`.
      - `Sleep` first dispatches `run.interrupt` for each `interrupt` entry, with id
        `server:sandbox-approval-expiry:<runId>` and reason `APPROVAL_EXPIRED_MESSAGE` ("Stopped
        after 2 hours without an answer, so the machine could sleep. Send a message to
        continue."). Then `sandbox.auto-sleep` with `freshCommandId("auto-sleep", sandbox)` (46),
        `snapshotAt: now` and the reason. A failed interrupt skips the sleep until the next tick.
      - `capPressure` is true when `admissionQueues(sandboxes)` (52) has a waiter on this
        sandbox's driver.
  - `apps/server/src/server.ts`: provide `SandboxActivity.layer` at the server level. Both
    `ws.ts` and the lifecycle worker (`runtimeLayer.ts` 417) use the same instance.
  - Client: new `packages/client-runtime/src/sandboxViewing.ts` with a pure
    `stepViewerLease(state, { threadId, cloud, visible, focused, nowMs }) => { state, send }`.
    `send` is that thread id when a cloud thread is visible and focused and its last send is 5 or
    more minutes old, or it has none. Nothing is sent for a hidden, unfocused or local thread.
    Web: `apps/web/src/state/sandboxViewing.ts` `mountViewerLease` beside `mountPresenceReporter`
    (`apps/web/src/state/presence.ts` 98). It runs on the thread route with one 60-second timer
    and a visibility and focus listener, and calls the RPC through
    `createEnvironmentRpcCommand` (`sandboxEnvironment.viewing`). `ViewerLeaseWatch`
    (`apps/web/src/components/sandbox/`) mounts it beside `PresenceWatch` in `__root.tsx`. Mobile: `apps/mobile/src/features/threads/ViewerLeaseWatch.tsx`
    beside `PresenceWatch.tsx`, on `AppState` and screen focus. Desktop wraps web.
- **Types and services:** `idleDecision`, `IdleInput`, `IdleDecision`, `holdsMachine`,
  `APPROVAL_HOLD_MS`, `CAP_PRESSURE_IDLE_MS`, `VIEWER_LEASE_MS`, `SandboxActivity`,
  `TerminalManager.lastActivityAt`,
  `ComputeCapabilities.sleepOnSettle` and `.defaultIdleSleepMs`, `stepViewerLease`.
- **Commands and events:** `sandbox.auto-sleep` gains `reason`. The approval expiry uses the
  existing `run.interrupt` (orchestrationV2.ts 3534) with `reason`, which the interrupt turn item
  shows (`runInterruptReason`, Orchestrator.ts 11756). No new event.
- **Migrations:** none. Activity, leases and the approval clock come from projections and memory.
- **Proposed gap answers.**
  - The viewer lease is `sandbox.viewing`, renewed every 5 minutes, expiring after 6. A renewal
    counts as activity, so a viewed machine stays up for the idle window after the last one.
  - Leases and terminal activity are in memory. After a restart, `record.updatedAt` and thread
    activity anchor the idle clock, which can only keep a machine up longer.
  - An approval past its hold sleeps the machine with `sleepReason: "idle"` and interrupts the run
    with a message (agreed with Track D: no new literal).
  - "Became ready" is `record.updatedAt`. Any record update while ready (a runner re-attach)
    pushes settle-sleep to idle-sleep. That is conservative, and needs no new field.
  - 04 §2 calls idle a per-driver setting. M2 ships the capability default only. If wanted, 2.43
    can add `idleMinutes` beside its cap field.
  - The idle arm is the existing auto-sleep update, so Track D's 2.7 `sleepSnapshotAt: null`
    patch on that arm covers it.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts`: new
  `describe("idleDecision")`. It is pure with an explicit `nowMs`, so it needs no clock. Rows:
  "a run with no question keeps it busy"; "background work keeps it busy"; "a question younger
  than 2 hours holds it until the hold ends"; "a question 2 hours old sleeps it and names the run
  to interrupt"; "a settle after it became ready sleeps it at once"; "a settle before its last
  wake waits for the idle deadline"; "every thread archived sleeps as archived"; "a driver without
  sleepOnSettle ignores settling"; "terminal output inside the window keeps it awake"; "a lease
  renewal keeps it awake"; "a scheduled run due inside the window keeps it awake until it runs";
  "60 idle minutes sleeps as idle"; "a waiter queued sleeps one idle 5 minutes"; "a waiter queued
  waits until 5 idle minutes".
- Same file, the `decideSandboxCommand` rows (329–360). `autoSleep` (64) gains a reason. The
  `attached` helper defaults `restingAt` to `now` when settled or archived, so the existing rows
  keep passing. New rows: "auto-sleep idle after a thread was active past the snapshot" refuses
  `in-use`; "auto-sleep idle with only a question past its hold" sleeps as idle; "auto-sleep
  settled when the settle predates the last wake" refuses `in-use`.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts` "stops a ready Docker sandbox once
  its owner settles, and not before" (1167). After the stop, `sandbox.wake`, answer the start,
  and attach the runner. Then `sweep()`: the machine stays `ready`. This fails on `main`. Then
  `TestClock.adjust` 60 minutes and `sweep()`: it is `sleeping` with `sleepReason: "idle"`. A
  `TestClock.adjust("1 minute")` between the settle-stop and the wake makes the settle strictly
  older than the new ready time.
- `makeSandboxRuntime` (201) adds `SandboxActivity.makeTest`'s service to `layerDriver` and
  returns it as `activity`, so the existing sweep cases build unchanged.
- Same file, new cases (one per sentence, the last in its own `layerAdmissionTest(1)` block). A
  ready machine with an unsettled idle thread stays ready
  at 59 minutes and sleeps as `idle` at 60. A second case's lease renewal at 30 minutes moves the
  sleep to 90. With `defaultRunningCap: 1` and a second thread queued, the first sleeps as
  `cap-pressure` at 5 idle minutes, and the waiter is admitted on the next sweep. Drain the
  worker after each sweep.
- `packages/client-runtime/src/sandboxViewing.test.ts`: a table for `stepViewerLease`.
  "focused cloud thread sends once, then every 5 minutes"; "hidden or unfocused sends nothing";
  "a local thread sends nothing"; "forty listed cloud threads with none focused send nothing".

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts
apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts
packages/client-runtime/src/sandboxViewing.test.ts`; `vp run typecheck` for `packages/contracts`,
`packages/client-runtime`, `apps/server`, `apps/web`, `apps/mobile`; `vp run check:changed`.
Client pass (`test-t3-app`, Replay provider, the fake or Docker driver in the worktree's `.t3`):
the network panel shows one `sandbox.viewing` on focus and none while the window is hidden. A
server log transcript shows an idle machine sleeping at a shortened `defaultIdleSleepMs`, set for
the pass only and not committed.

**Reviewer checks.**

- `idleDecision` and the auto-sleep arm agree. A sleep the worker decides on stale reads is
  refused, not applied.
- Every auto-sleep takes a fresh id. The approval interrupt's id is per run, so a repeat sweep
  replays its receipt.
- No polling. `Busy` waits for an event, and the new `affectsLifecycle` types cover every way out
  of `Busy`.
- One `sandbox.viewing` per focused cloud thread per 5 minutes (performance). The sidebar and
  subscriptions send none.
- Surfaces: clients (web, desktop through web, mobile lease watchers); contracts (one RPC, one
  field); agents (none: MCP and scheduled work count through thread activity and
  `next_run_at`); reverse states (a slept machine wakes through 2.2 and M1's prompt path);
  connection modes (the RPC goes over the same `/ws` locally, remotely and through the tunnel).
  Docs: none until 2.21.

### 2.2 `feat(server): wake sandboxes from threads, terminals, MCP, the CLI and restores`

A sleeping machine wakes once on each explicit trigger: when its thread opens (a new viewer
lease), on typing in its terminal, and on a checkpoint restore. Messages, MCP, the CLI and
scheduled tasks already wake through M1's prompt path. A restore parks its rollback until the
machine is `ready`, then runs. Nothing else wakes: a sidebar of forty threads sends nothing. All
triggers share one id per generation, so two at once make one wake. Its own PR because it is the
other half of 2.1's policy.

- **Needs:** 2.1. **Unblocks:** 2.8's terminal Wake (Track D), G2 step 8.
- **Files:**
  - New `apps/server/src/sandbox/lifecycle/SandboxWakeService.ts` (the tag alone, as
    `StoppedSandboxReadsService.ts` is: the terminal manager imports it, and the layer reaches
    `ThreadLaunchService`, which imports the terminal manager) and `SandboxWake.ts` (`layer`):
    ```ts
    export class SandboxWake extends Context.Service<
      SandboxWake,
      {
        /** One `sandbox.wake` when the thread's machine sleeps; a no-op otherwise. */
        readonly wake: (input: {
          readonly threadId: ThreadId;
          readonly actorId?: MemberId;
        }) => Effect.Effect<void>;
        /** Renews the lease; wakes on a new one, unless the thread is settled or archived. */
        readonly viewed: (input: {
          readonly threadId: ThreadId;
          readonly actorId?: MemberId;
        }) => Effect.Effect<void>;
      }
    >()("t3/sandbox/lifecycle/SandboxWakeService/SandboxWake") {}
    ```
    `wake` reads the shell's sandbox and does nothing unless it is `sleeping`. It dispatches
    through `ThreadMessageIntake.dispatchSandboxCommand` (now exported, so the layer needs only
    `ThreadManagementService` and `TeamState`, not the attachment services). It routes to the
    owner thread. Only sleep and discard check the owner or an admin, so any member who can reach
    the thread may wake it. The command id is `sandbox-wake:<sandboxId>:<ownerThreadId>:<generation>`,
    the one `request-wake` uses (SandboxEffects.ts 323–328), so the triggers dedupe. Failures are
    logged, never raised into the caller's RPC.
  - `apps/server/src/ws.ts`: the `sandbox.viewing` handler (from 2.1) calls `sandboxWake.viewed`.
  - `apps/server/src/terminal/Manager.ts` `write` (3377): when the session is not running and
    `sandboxIdFromPath(session.cwd)` (`WorkspaceHost.ts` 44) is set, call `SandboxWake.wake` (read
    per call with `Effect.serviceOption`: the layer sits above the terminal layer, so it comes from
    the RPC handler's context), then fail as today. Attaching or
    viewing a terminal does not wake. Track D's 2.8 drawer **Wake** button sends the existing
    `sandbox.wake` command (`wakeSandbox`, `packages/client-runtime/src/operations/commands.ts`
    464).
  - Restore. `apps/server/src/orchestration-v2/Orchestrator.ts`, the `checkpoint.rollback` arm:
    - Before the `thread.metadata-updated` emit (13161), a cloud thread
      (`thread.sandboxId !== undefined`) reads its record as `gateCloudMessage` (11037) does.
    - A `ready` record, or none, changes nothing.
    - A record where `hasNoDisk` (SandboxDecisions.ts 193) is true refuses with "This machine's
      disk is gone, so there is nothing to restore."
    - Otherwise, get the wake decision from `decideCloudPrompt` (200) with `checkout: null`. Apply
      it exactly as `gateCloudMessage`'s `Defer` branch does: the owner's wake events and effects
      in this commit, or a side chat's `sandbox.request-wake` effect. Then enqueue the rollback
      effect (13192) with `availableAt: now + RESTORE_PARK_MS` (10 minutes,
      `PendingOrchestrationEffectV2.availableAt`, EffectOutbox.ts 221). Enqueue it after the wake
      effects, so their rowids come first.
    - `takesSandboxSlot`: a `checkpoint.rollback` on a cloud thread takes the admission lock, as
      a prompt does, since it can start the machine.
  - `apps/server/src/orchestration-v2/EffectOutbox.ts`:
    - New `expedite({ threadIds, effectTypes })`: `UPDATE ... SET available_at = now WHERE status =
      'pending' AND thread_id IN (...) AND effect_type IN (...) AND available_at > now`, then
      `notifyAvailable`.
    - `claimableCandidatePredicate` (361): a pending `provider-thread.rollback` does not block a
      `sandbox.*` candidate on the same thread. Without this, the owner's `sandbox.release-waiters`
      would queue behind the parked rollback it is meant to release. Comment it in one line.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` `releaseWaiters` (246): on `ready` and
    on `failed`, call `outbox.expedite({ threadIds: rows, effectTypes: ["provider-thread.rollback"] })`
    after releasing runs. On `failed`, the rollback runs on an unavailable host and records
    `checkpoint.rollback.fail` with its message (EffectWorker.ts 470–476). If the machine never
    gets there (a discard, a long cap wait), the park ends on its own after 10 minutes.
  - `apps/server/src/server.ts`: provide `SandboxWake.layer` at the server level, after
    `SandboxActivity`.
- **Types and services:** `SandboxWake`, `RESTORE_PARK_MS`, `EffectOutboxV2.expedite`.
- **Commands and events:** none new. The ids are shared with `request-wake`. A wake of a `waking`
  or `ready` machine is already a no-op (SandboxDecisions.ts 388).
- **Migrations:** none.
- **Proposed gap answers.**
  - A view of a settled or archived thread does not wake. Settling just put the machine to sleep,
    and 2.8 serves its reads from the snapshot. A prompt, a terminal key, a restore or **Wake**
    still wakes it. This narrows 04 §2's "opening the thread".
  - A bounded park (10 minutes) instead of a sentinel, so a restore can never pin a thread's
    queue.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`:
  - New `it.layer` block "restores" (the prompt cases leave a provider turn queued), case "a
    restore on a sleeping machine wakes it and runs once it is ready". Replace the
    runtime's `Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({})` (makeSandboxRuntime, 201) with an `execute` that records its input. Dispatch `checkpoint.rollback` on a cloud
    thread whose machine sleeps: the record is `waking` and the rollback is not run. Answer the
    start, attach the runner, and drain the worker. The machine is `ready` and the rollback ran
    once. No clock advance.
  - Extend "stops a ready Docker sandbox once its owner settles, and not before": its
    `sandbox.wake` dispatch becomes `SandboxWake.viewed` (still `sleeping`), then
    `SandboxWake.wake`. Covers the G1 finding through the 2.2 entry points.
  - Extend "two side-chat prompts make one wake" (1107): a `viewed` on the owner and a terminal
    `wake` in the same generation still make one `sandbox.wake` event.
- `apps/server/src/terminal/Manager.test.ts`: extend "keeps a stopped machine's terminal exited…":
  a write to the exited sandbox terminal calls `SandboxWake.wake` with its thread.
- `apps/server/src/orchestration-v2/FoundationPersistence.test.ts`: new case "a parked rollback
  lets the thread's sandbox effects pass and runs once expedited". A rollback enqueued with a
  future `availableAt` blocks a `provider-turn.start` and lets a `sandbox.release-waiters` claim.
  `expedite` makes the rollback claimable at once.
- The forty-thread guarantee is the client stepper row in 2.1. No server path but these three
  calls `SandboxWake`.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts
apps/server/src/terminal/Manager.test.ts
apps/server/src/orchestration-v2/FoundationPersistence.test.ts`; `vp run typecheck` for
`apps/server`; `vp run check:changed`. Client pass (`test-t3-app`, Docker driver, Replay
provider): sleep a machine, refocus its unsettled thread, and it wakes once (one `sandbox.wake`
in the server log). Type in its terminal after a sleep: one wake. Restore with "Revert files too"
on a sleeping machine: it wakes, then the file is gone. Forty threads in the sidebar: no wake.

**Reviewer checks.**

- Every trigger calls `SandboxWake.wake`, and transports stay one line.
- The id matches `request-wake`'s, and the generation in it means the next sleep's wake is a new
  command.
- The outbox exemption is only for `sandbox.*` candidates past a pending rollback. Turns still
  wait behind it.
- No wake from subscriptions, search, push, mirror diffs or MCP lists (04 §2).
- Surfaces: entry points (thread view, terminal, restore from the timeline and the command
  palette, both through `checkpoint.rollback`); clients (none new; web and mobile already send the
  lease); agents (prompt path, unchanged); reverse state (2.1 sleeps it again); connection modes
  (same RPCs everywhere).

### 2.4 `feat(server): honor retryAfterMs from compute drivers`

A driver error that carries `retryAfterMs` makes the outbox wait that long before the next
attempt (capped at 10 minutes) instead of the 100 ms doubling backoff. The other threads' effects
keep moving while it waits. No driver sets the hint in M2. EC2 (M5) needs it for
`InsufficientInstanceCapacity` and API throttling, so the plumbing lands and is tested with the
fake driver. Its own PR because it changes the retry path every effect uses.

- **Needs:** M1. **Unblocks:** 2.39 (same files), 5.4.
- **Files:**
  - `apps/server/src/orchestration-v2/EffectWorker.ts`:
    - `OrchestrationEffectExecutionError` (34): add `retryAfterMs: Schema.optionalKey(NonNegativeInt)`.
    - The sandbox cases in `layerExecutor` (608–620): when the cause is a `SandboxEffectError` with
      `retryAfterMs`, copy it onto the execution error.
    - The retry branch (~903): `delayMs: retryDelayMs(effect.attemptCount, exit.cause)`, a new pure
      function in this file:
      ```ts
      export const RETRY_AFTER_CAP_MS = 10 * 60_000;
      export const retryDelayMs = (attemptCount: number, cause: Cause.Cause<unknown>) => {
        const backoff = Math.min(30_000, 100 * 2 ** Math.max(0, attemptCount - 1));
        const hint = Option.match(Cause.findErrorOption(cause), {
          onNone: () => undefined,
          onSome: (error) =>
            Schema.is(OrchestrationEffectExecutionError)(error) ? error.retryAfterMs : undefined,
        });
        return hint === undefined ? backoff : Math.max(backoff, Math.min(RETRY_AFTER_CAP_MS, hint));
      };
      ```
      `maxAttempts` (726) still applies: five hinted attempts fail the sandbox through
      `reportExhausted` as today.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts`:
    - `SandboxEffectError` (47): add `retryAfterMs: Schema.optionalKey(NonNegativeInt)`.
    - `driverFor`'s failure mapping (291): copy `ComputeDriverError.retryAfterMs` (ComputeDriver.ts 47) onto it.
    - `call` (301): the in-effect `DRIVER_RETRY` (100) retries `while: (error) => error.retryable &&
      error.retryAfterMs === undefined`. A hinted error leaves the effect at once, so the outbox
      does the waiting and holds no worker slot.
  - `apps/server/src/sandbox/compute/ComputeDriver.ts` `retryAfterMs` (47): drop the comment
    "Carried now, honored in 2.4".
- **Types and services:** `RETRY_AFTER_CAP_MS`, `retryDelayMs`. No new service.
- **Commands and events:** none.
- **Migrations:** none. `retry` (EffectOutbox.ts 652) already takes `delayMs` and sets
  `available_at`.

**Tests.**

- `apps/server/src/orchestration-v2/EffectWorker.test.ts`: new case "waits out a driver's
  retry-after hint, capped, instead of the backoff". Mock the outbox as "requeues a claim when a
  pre-execution worker check fails" (327) does, with `retry` capturing `delayMs`. The executor
  (via `layerExecutorFor`, 80) fails a `sandbox.start` with `retryAfterMs: 45_000`, then with
  `retryAfterMs: 3_600_000`. Assert `delayMs` 45 000, then 600 000. With no hint, it stays
  `100 * 2^(n-1)`.
- `apps/server/src/orchestration-v2/FoundationPersistence.test.ts` "keeps later thread effects
  behind an earlier effect waiting to retry" (2257): enqueue one effect on a second thread after
  the 60-second retry, and assert it claims while the first thread stays blocked. This passes on
  `main`. It pins the invariant 2.4 depends on, in the case that already sets it up.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts` "records the last driver failure
  once every attempt of a create has failed" (461): add a variant row where the fake answers
  `create` with `retryable: true` and `retryAfterMs: 1_000`. The fake sees one call per attempt,
  not four (`DRIVER_RETRY` is `times: 3`), and the
  sandbox still fails after the last attempt (`TestClock.adjust` past each `available_at`, then
  drain the worker).

**Verify.** `vp test run apps/server/src/orchestration-v2/EffectWorker.test.ts
apps/server/src/orchestration-v2/FoundationPersistence.test.ts
apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`; `vp run typecheck` for
`apps/server`; `vp run check:changed`. No runtime pass: no shipped driver sets the hint.

**Reviewer checks.**

- A hinted error skips the in-effect 2-second retries, so no worker slot sleeps through the wait.
- The cap bounds a malicious or buggy hint. Five attempts still end in `reportExhausted`.
- Only `available_at` changes. The thread's later effects stay blocked behind the waiting row
  (the rule at EffectOutbox.ts 360).
- Surfaces: providers (no change), contracts (none), connection modes (none). Server-only.

### 2.7 `feat(server): snapshot a machine's working tree into the mirror before it sleeps`

Before a sleeping machine stops, the server captures each attached checkout's working tree into a
commit, syncs it to the mirror as `refs/t3/sandbox/<thread>/snapshot`, and records the time on the
sandbox record. Uncommitted work then survives sleep, a lost disk and an expired disk. Its own PR
because it is the one change to the stop path, and three rows read what it writes.

- **Needs:** 2.1 (Track C: idle sleep is the stop this mostly serves; the code here works for
  M1's manual and settled sleeps without it). **Unblocks:** 2.8, 2.9, 2.12, 2.13.
- **Files:**
  - `apps/server/src/sandbox/mirror/CheckpointMirror.ts`: add
    `sandboxSnapshotRef = (threadId) => CheckpointRef.make(`${sandboxThreadRefPrefix(threadId)}snapshot`)`
    beside `sandboxThreadRefPrefix` (96). The same name is used in the machine's clone and in the
    mirror, so `MirrorSync.sync` (205) maps it ref-to-ref like any checkpoint ref (its `targets`
    map, 220) and needs no change. Its parent is the branch tip (capture commits use `-p HEAD`,
    `GitVcsDriver.ts` 1308), so 1.31's first prerequisite tier (branch tip) applies.
  - `apps/server/src/orchestration-v2/CheckpointService.ts`: add `captureSnapshot({ cwd, ref })` to
    `CheckpointServiceV2Shape` (114). It runs under `withWorkspaceLock` (264) and calls
    `coarseFor(cwd)` (259) `.checkpointCapture({ _tag: "turn", cwd, checkpointRef: ref,
    previousCheckpointRef: ref })`. `turn` always overwrites the ref (`captureTurn`,
    `CheckpointCapture.ts` 50); `baseline` keeps an existing one. Passing the same ref as previous
    makes the file summary empty, which is the point; say so in a one-line comment. Returns
    `"ready" | "missing" | "error"` from the result's `status`, and never fails: a failed runner
    call logs and returns `"error"`. No coarse host (a local path) returns `"missing"`; snapshots
    are cloud-only.
  - `apps/server/src/sandbox/mirror/MirrorSyncWorker.ts`: add `syncRefs({ threadId, cwd,
    checkpointRefs }) => Effect<boolean>` to the service (20). It calls `MirrorSync.sync`, bounded
    by `SYNC_TIMEOUT` (16), and returns false on any failure or timeout. It never fails.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts`:
    - `make` (144): `const checkpoints = yield* Effect.serviceOption(CheckpointService.CheckpointServiceV2)`,
      beside `mirrorSync` (152). Lifecycle tests run without it.
    - New `snapshotBeforeSleep(record)` (an `Effect.fn("SandboxEffects.snapshotBeforeSleep")`):
      lists `projections.listSandboxThreads(record.id)`, reads each shell, keeps threads with a
      `worktreePath`, and dedupes by `worktreePath` (side chats share the parent's checkout; the
      owner thread, else the oldest attached, names the ref). For each:
      `captureSnapshot` then `syncRefs({ threadId, cwd: worktreePath, checkpointRefs: [ref] })`.
      All threads run concurrently, the whole step under one 15 s `Effect.timeoutOption`. Returns
      the capture instant when every checkout captured `ready` and synced, else `null` (also when
      no attached thread has a checkout).
    - `sandbox.stop` case (388): when `record.state === "sleeping"` (manual, settled, archived, and
      2.1's idle and cap-pressure sleeps), run `snapshotBeforeSleep` before `mirrorSync.flush`. A
      boot-timeout stop (`record.state === "failed"`, decider 462–467) skips it. Pass the result to
      the `sandbox.stopped` report as `sleepSnapshotAt` when non-null.
  - `apps/server/src/orchestration-v2/runtimeLayer.ts` `layerSandboxEffectsProvided` (338): add
    `layerCheckpointServiceProvided` (124) to its `Layer.mergeAll`.
  - `packages/contracts/src/orchestrationV2.ts`:
    - `OrchestrationV2Sandbox` (462): `sleepSnapshotAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))`,
      documented as "When this sleep's working-tree snapshot reached the mirror; null until it does."
    - `OrchestrationV2SandboxJson` (485): `sleepSnapshotAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString))`.
    - `sandbox.stopped` (3923): `sleepSnapshotAt: Schema.optionalKey(Schema.DateTimeUtc)`.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`:
    - `sandbox.sleep` (398) and `sandbox.auto-sleep` (412) patches add `sleepSnapshotAt: null`: a
      new sleep has no snapshot yet. Track C's 2.1 idle arm does the same.
    - `sandbox.stopped` (454): on `sleeping`, `command.sleepSnapshotAt === undefined ? noOp :
      update({ sleepSnapshotAt: command.sleepSnapshotAt })`. `failed` stays `noOp`. The
      ready/waking arm (a machine stopped under us) also patches `sleepSnapshotAt: null`: it took
      no snapshot, and an older sleep's time would label the files with the wrong snapshot.
    - `nextGeneration` (357) leaves `sleepSnapshotAt` alone, so 2.13's rebuild can say which
      snapshot it restored.
- **Types and services:** `CheckpointServiceV2.captureSnapshot`; `MirrorSyncWorker.syncRefs`;
  `CheckpointMirror.sandboxSnapshotRef`; `OrchestrationV2Sandbox.sleepSnapshotAt`.
- **Commands and events:** `sandbox.stopped` gains optional `sleepSnapshotAt`; `sandbox.updated`
  carries the new record field. No new command, event or effect type.
- **Migrations:** none (records are `payload_json`).
- **Proposed gap answers.** The time is a record field, not a read of the ref's committer date,
  because clients label files from the projection with no round trip (`stoppedFilesFamily`,
  `stoppedFilesNotice.tsx` 37), and because a failed snapshot must read as "no snapshot" even
  when an older snapshot ref is still in the mirror. One time per sleep, set only when every
  checkout made it, keeps the label honest. A partial failure falls back to checkpoints for all.
  The name avoids `snapshotAt`, which `sandbox.auto-sleep` (3931) already uses for the
  attached-thread reading.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts` `decideSandboxCommand` rows (459):
  add `sandbox.stopped` on `sleeping` with `sleepSnapshotAt` (updates the field, no effects), the
  same without it (`NoOp`), and extend the `sandbox.sleep` and `sandbox.auto-sleep` rows to expect
  `sleepSnapshotAt: null`.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: extend "stops a ready Docker sandbox
  once its owner settles, and not before" (1167) with a fake `CheckpointServiceV2` and
  `MirrorSyncWorker`: after the drain, the record has `sleepSnapshotAt` and the fake saw one
  `captureSnapshot` per distinct `worktreePath`. New case "a snapshot that fails or times out still
  stops the machine, with no sleepSnapshotAt": the fake capture returns `error`; the record ends
  `sleeping` without the field and the driver's `stop` was called. Use `it.effect` with
  `TestClock.adjust` past 15 s for the timeout half; drain `OrchestrationEffectWorkerV2`.
- `apps/server/src/orchestration-v2/CheckpointService.test.ts`: one case that `captureSnapshot`
  twice on a real temp repo moves the ref to the newer tree (the `baseline` trap).

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts
apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts
apps/server/src/orchestration-v2/CheckpointService.test.ts`; `vp run typecheck` for contracts,
server, web, mobile; `vp run check:changed`. Runtime transcript on Docker: edit a file in a cloud
thread's terminal, sleep it from the menu, then `git --git-dir <stateDir>/sandbox/mirrors/<p>.git
show --stat refs/t3/sandbox/<b64>/snapshot` shows the edit.

**Reviewer checks.**

- The stop never waits more than 15 s on the snapshot and never fails because of it.
- A boot-timeout stop does not snapshot.
- The capture holds the workspace lock, and a second sleep overwrites the ref.
- The server picks every ref name; the machine only produces bytes (06 §7).
- Hit every surface: contracts (two optional keys). No client change here; providers, MCP,
  connection modes, docs do not apply.

### 2.8 `feat: read files, search, Changes and terminals while a machine sleeps`

While a machine sleeps, the file browser, file reads, search and the Changes panel come from the
sleep snapshot, labeled "As of 14:02, when the machine slept". Without a snapshot they keep 1.33's
checkpoint and "As of turn 7". Terminals that sleep killed say so, and the first attach after a
wake starts a fresh shell under a divider. Fixes G1's "Changes fail while asleep". One PR because
the label, the reads and the terminal state are one user-visible state across web and mobile.

- **Needs:** 2.7. **Unblocks:** G2 step 8 ("read files and Changes while asleep").
- **Files:**
  - `apps/server/src/sandbox/mirror/StoppedSandboxReads.ts` `viewFor` (164): when the record's
    `sleepSnapshotAt` is non-null, add one candidate per attached thread with a `worktreePath`:
    `{ threadId, ref: sandboxSnapshotRef(threadId), turn: 0, scopeCwd: posix.resolve(worktreePath),
    source: "snapshot" }`, kept only when `isInside(scopeCwd, cwd)`, the filter checkpoint
    candidates use (185), so a scoped read never surfaces another thread's worktree. Rank as today (innermost scope, then newest capture); a snapshot taken
    at sleep is newer than every checkpoint. Snapshot refs are not considered when
    `sleepSnapshotAt` is absent or null, so a stale one never wins.
  - `apps/server/src/sandbox/mirror/StoppedSandboxReadsService.ts` `StoppedView` (26): add
    `source: "snapshot" | "checkpoint"`. Add to the service (42)
    `diffPreview(view, input: ReviewDiffPreviewInput) => Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>`.
    It returns one `working-tree` source: `git --git-dir <mirror> diff --no-color <commit>^ <commit>`
    over the whole tree, so paths stay repo-relative as the live diff's are (empty tree when the
    commit has no parent), with the same byte cap and
    `metadataOnly`/`file` handling the live path uses (`GitVcsDriver.getReviewDiffPreview`). No
    `branch-range` source: the mirror does not hold the base branch (07 §6 says Changes diffs the
    snapshot against the branch).
  - `apps/server/src/review/ReviewService.ts` `getDiffPreview` (114): before
    `assertWorkspaceBoundCwd` (75), when `sandboxIdFromPath(input.cwd)` (`WorkspaceHost.ts` 44) is
    set and `hosts.forPath(input.cwd)` fails, call `stopped.viewFor` then `stopped.diffPreview`.
    Read `StoppedSandboxReads` with `Effect.serviceOption` (the runner bundle has no layer).
    `SandboxAsleep` from `viewFor` (no checkpoint yet) returns `{ cwd, generatedAt, sources: [] }`.
    `getBranchCommits` returns `{ commits: [], truncated: false }` on the same condition, and
    `getDiffFileContents` fails with `VcsUnsupportedOperationError` ("This machine is asleep. Wake
    it to expand unchanged lines."): `ReviewDiffPreviewError` has no `SandboxAsleep`.
  - `packages/contracts/src/terminal.ts`: add
    `TerminalStoppedBy = Schema.Struct({ reason: ForwardCompatibleNullable(Schema.Literals(["sleep"])), at: Schema.String })`
    and `stoppedBy: Schema.optionalKey(TerminalStoppedBy)` on `TerminalSessionSnapshot` (90),
    `TerminalSummary` (109) and `TerminalExitedEvent` (165). `TerminalSessionStatus` (87) stays
    as is (07 §4: a field, not a status).
  - `apps/server/src/terminal/Manager.ts`: `TerminalSessionState` gains `stoppedBy`. New method
    `stopForSleep({ sandboxId, at })`: for each session whose `cwd` is under
    `/t3-sandbox/<sandboxId>/`, set `stoppedBy = { reason: "sleep", at }`, run `stopProcess` (2334),
    and publish `exited` with `stoppedBy`. `snapshot` (378) and the summary copy the field.
    `openWithWorkspaceLease` (2877): the stopped-machine branch (2884–2890) is unchanged. On a
    reachable host, an existing session with `stoppedBy` and `restartIfNotRunning: true`
    (`TerminalAttachInput` 55), or an explicit `open`, appends "Machine woke. Earlier processes were
    stopped." to history (history only, not written to the PTY; no time, since the server does not
    know the viewer's zone), clears `stoppedBy`, and restarts. `write` and
    `resize` on a stopped machine already fail; map them to `SandboxAsleep` if they do not.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts`: add a hook
    `SandboxSleepHooks = Context.Reference<{ beforeSleep: (input: { sandboxId; at }) => Effect<void> }>`
    with a no-op default (the `MirrorHooks` pattern, `MirrorSync.ts` 50). The `sandbox.stop` case
    (388) calls it after 2.7's snapshot and before `driver.stop`, only when sleeping.
    `apps/server/src/server.ts` provides it from the terminal manager's `stopForSleep`, beside
    `layerMirrorSync` (614).
  - `packages/client-runtime/src/state/sandbox.ts`: add a pure
    `stoppedReadLabel({ sleepSnapshotAt, turn }): string` ("As of 14:02, when the machine slept",
    else "As of turn 7", else "No saved turn to show yet") and a pure
    `stoppedFilesFromProjection(projection)` lifted from web's `stoppedFilesFamily`
    (`stoppedFilesNotice.tsx` 37), now also returning `sleepSnapshotAt`. Also
    `terminalStoppedLabel(stoppedBy)` ("Stopped when the machine slept at 14:02").
  - `packages/client-runtime/src/state/terminalSession.ts` `exited` case (200): keep `stoppedBy`
    from the event on the session state. `transitionTerminalLifecycle` neither closes nor reopens
    a stopped shell, so attaching to it after a wake does not restart it; typing (once the machine
    is ready) or this viewer's **Wake** calls `terminal.open`.
  - Web: `apps/web/src/components/sandbox/stoppedFilesNotice.tsx` `StoppedFiles` (20) gains
    `sleepSnapshotAt`; `StoppedFilesNotice` (83) uses `stoppedReadLabel`. The Changes panel (the
    consumer of `packages/client-runtime/src/state/review.ts`) shows the same notice above an
    asleep diff and shows the Uncommitted scope, the only source asleep. The terminal drawer shows "This machine is asleep" with **Wake** (allowed via
    `sandboxEnvironment.actionAllowedAtom`) for a session with `stoppedBy`.
  - Mobile: `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`,
    `apps/mobile/src/features/review/ReviewSheet.tsx` and the terminal screen in
    `apps/mobile/src/features/terminal/` show the same labels and Wake from the shared helpers.
- **Types and services:** `StoppedView.source`; `StoppedSandboxReads.diffPreview`;
  `TerminalStoppedBy`; `TerminalManager.stopForSleep`; `SandboxSleepHooks`.
- **Commands and events:** none (terminal events gain an optional key).
- **Migrations:** none.
- **Proposed gap answers.** Asleep Changes shows only the working-tree source; branch commits are
  empty until wake. Terminals record the stop at the moment the server decides to stop, so the
  reason never depends on racing the runner's disconnect. Asset-URL reads and HtmlRender still
  fail asleep (1.33 notes); they stay out of 2.8.

**Tests.**

- `apps/server/src/sandbox/mirror/StoppedSandboxReads.test.ts`: extend "reads the newest
  checkpoint among threads sharing the checkout" (309) with a snapshot ref: it wins when
  `sleepSnapshotAt` is set and is ignored when it is null. New case "diffs the sleep snapshot
  against its branch tip", seeding the real mirror with `seedMirror` (87) as
  `seedOneCheckpoint` (139) does.
- `apps/server/src/review/ReviewService.test.ts`: beside "allows a thread's checkout on a
  registered sandbox, which git never lists" (268), new case "serves a stopped machine's diff from
  the mirror": a fake `StoppedSandboxReads`, an unregistered sandbox path, and the result is the
  fake's, not the "must stay within the configured workspace root" error (the G1 bug; fails on
  `main`).
- `apps/server/src/terminal/Manager.test.ts`: extend "keeps a stopped machine's terminal exited and
  starts no new one there" (712): after `stopForSleep`, the snapshot has `stoppedBy`; after the
  host comes back, `attach` with `restartIfNotRunning` restarts, the history has the divider, and
  `stoppedBy` is gone.
- `packages/client-runtime/src/state/sandbox.test.ts`: rows for `stoppedReadLabel`.

**Verify.** `vp test run` the four files; `vp run typecheck` for contracts, client-runtime, server,
web, mobile; `vp run check:changed`. Client pass: `test-t3-app` on Docker (sleep, open Files,
search, Changes and a terminal; wake; type in the terminal) and `test-t3-mobile` for the same
screens. Before/after captures of the Changes panel asleep (G1's error, then the diff).

**Reviewer checks.**

- No asleep read reaches the machine or wakes it; writes still refuse with `SandboxAsleep`.
- A stale snapshot ref never backs a view when `sleepSnapshotAt` is null.
- The divider is in history only, and viewing a terminal never restarts it; typing or Wake does.
- Old clients decode the new terminal keys (optional, forward-compatible literal).
- Hit every surface: web, desktop (same web), mobile; contracts; reverse state (wake restarts the
  shell); entry points (file browser, search, Changes, terminal drawer). Not providers or MCP.

### 2.9 `feat(server,web,mobile): keep PR discovery and status for an asleep machine without waking it`

While a machine sleeps, PR discovery for its threads asks only the forge, from a head-context
record saved with the sleep snapshot, and the status line shows the last status labeled with the
sleep time. Today discovery skips stopped machines, so a PR opened on GitHub during sleep never
appears, and a ready machine with no `.git` falls back to the server's own checkout. Its own PR
because it touches GitManager; the clients only gain the sleep-time label.

- **Needs:** 2.7. **Unblocks:** none.
- **Files:**
  - `apps/server/src/sandbox/mirror/MirrorSync.ts`: add `readHeadContext(threadId, host, cwd,
    branch)` beside `readSandboxTips` (138), using `runGit` (111): one `for-each-ref` on
    `refs/heads/<branch>` with `%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)`
    (the format `readPrLookupBranchRef` uses, `GitManager.ts` 2674), `config --get-regexp
    ^remote\..*\.url$`, and `symbolic-ref --short refs/remotes/origin/HEAD` (missing is null).
    Add `MirrorSync.recordHead({ threadId, cwd })` that writes the JSON as a blob and points
    `refs/t3/sandbox/<b64>/head` at it.
  - `apps/server/src/sandbox/mirror/CheckpointMirror.ts`: add `writeBlobRef(projectId, ref, bytes)`
    (`hash-object -w --stdin`, then the existing `updateRefs` (385) path) and `readBlob(projectId,
    ref) => Option<Uint8Array>`. `deleteThreadNamespace` (439) already removes the ref.
  - `apps/server/src/sandbox/mirror/MirrorSyncWorker.ts`: 2.7's `syncRefs` takes
    `recordHead?: boolean`; 2.7's `snapshotBeforeSleep` passes `true`. Same 15 s bound.
  - `apps/server/src/sandbox/mirror/StoppedSandboxReadsService.ts`: add
    `headContext(threadId) => Effect<SandboxHeadContext | null>`.
  - `apps/server/src/git/GitManager.ts`: add `pullRequestForRecordedHead({ cwd, head })` to the
    service type beside `branchPullRequest` (152). It builds a `BranchHeadContext` (248) from the
    record (split the URL-only half of `resolveHeadAndOriginContexts` (1640) into a pure helper
    both use) and calls `findLatestPrForHeadContext(cwd, context)` (1992). `cwd` is the project
    root, which only picks the forge (`sourceControlProvider`, 753); no git runs at a sandbox path.
  - `apps/server/src/orchestration-v2/ThreadPullRequestService.ts`:
    - The stopped skip (178–181): for a sandbox path whose host is unreachable, read
      `stopped.headContext(first.id)`. Null keeps today's `finishBackfill`. Otherwise call
      `git.pullRequestForRecordedHead({ cwd: project.workspaceRoot, head })` and continue into the
      existing matching and dispatch (`thread.pull-request.sync`).
    - The `.git` fallback (187–197): never falls back to `project.workspaceRoot` for a sandbox path
      (`sandboxIdFromPath`, `WorkspaceHost.ts` 44). A ready machine whose checkout has no `.git`
      keeps the last link (2.13 rebuilds the checkout).
  - Status: no server change; `VcsStatusBroadcaster` (585) already keeps the last status. Web and
    mobile label the status line with 2.8's `stoppedReadLabel` when the thread's machine is not
    ready (the branch-toolbar status and the mobile thread header).
- **Types and services:** `SandboxHeadContext = Schema.Struct({ version: Schema.Literal(1),
  capturedAt: Schema.DateTimeUtcFromString, branch: Schema.String, headOid: Schema.String,
  upstream: Schema.NullOr(Schema.Struct({ remoteName: Schema.String, remoteRef: Schema.String })),
  remotes: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  defaultBranch: Schema.NullOr(Schema.String) })`, server-internal, in
  `apps/server/src/sandbox/mirror/`. `GitManager.pullRequestForRecordedHead`.
- **Commands and events:** none new; discovery dispatches the existing `thread.pull-request.sync`.
- **Migrations:** none (a mirror ref).
- **Proposed gap answers.** The record is a mirror blob ref, not a `091_` table: it is written with
  the snapshot, read only while asleep, and removed with the thread's namespace. Status is not
  persisted: after a server restart an asleep thread shows no counts until wake.

**Tests.**

- `apps/server/src/sandbox/mirror/MirrorSync.test.ts`: new case "records a thread's head context
  as a blob ref" on the file's real repos: remotes, upstream, tip, and a null default branch when
  `origin/HEAD` is unset.
- `apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts`: new case "finds a PR for an
  asleep cloud thread from its recorded head without touching the sandbox path": an unreachable
  sandbox host, a fake `StoppedSandboxReads.headContext`, a fake `GitManager` whose
  `branchPullRequest` fails the test if called; asserts one `thread.pull-request.sync`. Add a row
  that a ready sandbox path with no `.git` dispatches nothing (fails on `main`).

**Verify.** `vp test run apps/server/src/sandbox/mirror/MirrorSync.test.ts
apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts`; `vp run typecheck` for server,
web, mobile; `vp run check:changed`. Runtime transcript: sleep a cloud thread, open a PR for its
branch on GitHub, wait one sweep, and the thread shows the PR with the machine still asleep.

**Reviewer checks.**

- No git process runs at a `/t3-sandbox/` path while the machine is asleep.
- The forge lookup uses the recorded remote, so a cross-repo head still matches.
- Hit every surface: web and mobile labels; connection modes do not matter (server-side); MCP,
  providers and contracts do not apply.

### 2.12 `feat(server): destroy archived and long-asleep machines' disks`

An asleep machine whose threads are all archived loses its disk after 7 days; any asleep machine
whose threads saw no activity for 30 days loses it too (decision #2). Its thread stays readable
from the mirror, and a wake rebuilds it (2.13). The admin sets both in Settings → Cloud → Compute.
Its own PR because it is the first thing that deletes a disk on a timer.

- **Needs:** 2.1, 2.7, 2.13 (a wake after expiry must restore work). **Unblocks:** none.
- **Files:**
  - `packages/contracts/src/settings.ts` `SandboxSettings` (1216): add
    `diskRetention: Schema.optionalKey(Schema.Struct({ archivedAfterDays: StorageRetentionDays,
    asleepAfterDays: StorageRetentionDays }))` (null means never; `StorageRetentionDays` is the
    1–3650 schema at 995). Absent means 7 and 30. The sandbox struct in `ServerSettingsPatch`
    (1767) gains the same key as `Schema.optionalKey(Schema.NullOr(...))`, and
    `packages/shared/src/serverSettings.ts` `mergeSandboxPatch` (236) merges it with `patched`
    (248) and counts it in the "nothing set" check (255), as 2.38 does for `restoreModeSince`.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: add a pure
    `decideDiskExpiry({ record, attachedThreads, retention, now })` beside `decideAutoSleep` (119):
    `"archived"` when `state === "sleeping"`, every attached thread is archived, and the newest
    `restingAt` (2.1) is older than `archivedAfterDays`; `"inactive"` when `state === "sleeping"` or
    `"failed"` with a `driverRef`, no thread has an active run, and the newest
    `activityAt` (2.1) is older than `asleepAfterDays`; else null. It also returns the instant it
    becomes due. It reads only the fields 2.1 adds to `SandboxAttachedThread` (51), so this PR
    adds none.
  - Same file, a new server-only arm `sandbox.expire` in `decideSandboxCommand` (325): recheck
    `decideDiskExpiry`; due gives `update({ state: "destroyed" }, ["sandbox.destroy"])`; not due
    refuses `in-use`; a non-sleeping, non-failed record refuses `wrong-state`.
  - `packages/contracts/src/orchestrationV2.ts`: `sandbox.expire` beside `sandbox.auto-sleep`
    (3931): `{ type, commandId, threadId, sandboxId, reason: Schema.Literals(["archived", "inactive"]) }`.
  - `apps/server/src/orchestration-v2/Orchestrator.ts`: route `sandbox.expire` with the other
    server sandbox commands: the thread-id switch (705–716), the dispatch switch (14590–14600),
    and the attached-thread read, which today loads threads only for sleep, discard and
    auto-sleep (10899–10903).
  - `apps/server/src/sandbox/lifecycle/SandboxLifecycleWorker.ts` sweep (151): for each sleeping or
    failed sandbox, read its attached shells (as `shouldSleep`, 98, does) and the settings, call
    `decideDiskExpiry`, dispatch `sandbox.expire` (`freshCommandId("expire", sandbox)`, 46) when
    due, and fold the due instant into `nextDueMs`. Track C's 2.1 rewrites this loop; land after it.
  - Web: `apps/web/src/components/settings/CloudSettings.tsx` Compute section: two number fields,
    "Delete archived threads' disks after N days" and "Delete asleep machines' disks after N days",
    with a "Never" option; `CloudSettings.logic.ts` holds the parse. Mobile: none (Compute
    settings are web and desktop only).
- **Types and services:** `SandboxSettings.diskRetention`; `decideDiskExpiry`; `sandbox.expire`.
- **Commands and events:** new command `sandbox.expire`; it emits the existing `sandbox.updated`.
- **Migrations:** none.
- **Proposed gap answers.** A two-field setting rather than `WorktreeCleanupRules` (1009): the
  rules' keep-when and unchanged checks are about losing local files, which the mirror makes moot
  (07 §9 already says `uncommitted-changes` does not hold a disk). One global setting, not per
  driver: Docker has no disk limit of its own, and 04's "sooner if the driver's
  `diskRetentionDays` is shorter" waits for the first hosted driver (M3). An expired machine shows
  as "Machine discarded" (existing copy) and its thread stays readable.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts`: a new `describe("decideDiskExpiry")`
  table (archived at 6 and 8 days; inactive at 29 and 31 days; an active run holds; `null`
  settings never expire; a ready machine never expires), and `decideSandboxCommand` rows for
  `sandbox.expire`.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: new case "destroys an archived
  machine's disk after 7 days, and the thread still reads from the mirror": `TestClock.adjust` by 7
  days, drain, assert `sandbox.destroy` ran and the record is `destroyed`, then a
  `StoppedSandboxReads.viewFor` on the thread's checkout still returns a view.
- `packages/shared/src/serverSettings.test.ts`: extend "upserts and removes sandbox drivers per id
  so concurrent edits cannot clobber" (620) with `diskRetention`: a
  patch sets it, a later patch without it keeps it, and `null` clears it.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts
apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts
apps/web/src/components/settings/CloudSettings.logic.test.ts`; `vp run typecheck` for contracts,
server, web; `vp run check:changed`. Capture of the new Compute fields.

**Reviewer checks.**

- Only sleeping (or failed with a disk) machines expire; a running or waking one never does.
- The worker wakes for the due instant without polling (`nextDueMs`).
- The mirror keeps the thread's refs after destroy (`deleteThreadNamespace` runs only on delete).
- Hit every surface: web settings, contracts, reverse state (wake rebuilds, 2.13); mobile settings
  not applicable; providers and MCP not applicable; docs: 2.21 lists the defaults.

### 2.13 `fix(server): rebuild a lost or destroyed disk from the mirror`

When a machine comes back on a new disk (Retry after `missing`, Wake after discard or expiry, or a
prompt to such a thread), each attached thread's checkout is rebuilt at its recorded path from the
mirror's branch and sleep snapshot, then setup reruns. Today Retry and Wake with no queued message
leave an empty `/t3-sandbox/<id>` (G1: the details panel offers "Initialize Git"), and the prompt
path re-checks out from GitHub and loses unpushed and uncommitted work. A bug fix with its own
failing test, so its own PR.

- **Needs:** 2.7; 2.23 (Track A) for the off-cloud-only refusal. **Unblocks:** G2 step 8's
  `docker rm -f` half.
- **Files:**
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts` `checkoutInSandbox` (212):
    - Input gains `threadId: ThreadId`. Result gains `restoredFrom: "disk" | "mirror" | "origin"`.
    - Order: move today's kept-disk check (234–241, using `isCheckout`, 222) ahead of the
      clone/fetch (228–232); a kept checkout returns `restoredFrom: "disk"` with no fetch. Then
      clone or fetch origin as today.
    - New middle case, when `existingWorktreePath !== null` and the mirror holds
      `${sandboxThreadRefPrefix(threadId)}branch`: on the server, bundle that ref and, when
      present, `sandboxSnapshotRef(threadId)` from the mirror with `git --git-dir <mirror> bundle
      create`, trying prerequisite tiers `[SEED_HEAD_REF tip]` then `[]` (`MirrorSync.ts` 26, the
      same tiers 1.31 uses). `SEED_HEAD_REF` is module-private today; export it from MirrorSync.ts. Write it into the machine with the sandbox host's `fileSystem`
      (`WorkspaceHost.ts` 109) under `<root>/tmp/`, `git fetch <bundle>
      <prefix>branch:refs/heads/<branch> <snapshot>:<snapshot>` in the clone, delete the file, and
      `git worktree add <existingWorktreePath> <branch>`. With a snapshot, restore it with
      `CheckpointStore.restoreCheckpoint({ cwd: existingWorktreePath, checkpointRef: snapshot,
      fallbackToHead: false })` (`CheckpointStore.ts` 59). Returns `restoredFrom: "mirror"`.
    - Otherwise today's GitHub path (242–264), `restoredFrom: "origin"`.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`:
    - Pass `threadId` to `checkoutInSandbox` from `prepareInBackground` (360).
    - New service method `restoreCheckout({ commandId, threadId })` beside `prepareRun`: reads the
      shell; if it has a `sandboxId`, a `worktreePath` and a `branch`, and the checkout is missing on
      the machine, runs `checkoutInSandbox` with the first run's `worktree` `baseRef` (the same
      lookup `gateCloudMessage` uses, `Orchestrator.ts` 11055–11061) and reruns the project's setup
      script the way a fresh cloud worktree does. Never fails the caller; a failure is logged and
      the thread keeps its "machine" status.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` `releaseWaiters` (246): on `ready`, for
    each attached thread with no `preparing` run that carries `workspacePreparation` (those are
    re-armed already, 259–267), call `threadLaunch.value.restoreCheckout({ commandId:
    sandbox-restore:<threadId>:<generation>, threadId })`. It is idempotent: a kept disk is a
    checkout and costs one `isRepository`.
  - `apps/server/src/orchestration-v2/ThreadMessageIntake.ts` `dispatchSandboxCommand` (112) and
    `ThreadLaunchService.retryPreparation` (1275): before dispatching `sandbox.wake` or
    `sandbox.retry` for a record where `hasNoDisk` (`SandboxDecisions.ts` 193) holds, call 2.23's
    gate (the same check as `resolveCloudLaunch`, `CloudPreparation.ts` 87). Track A owns the
    refusal; this PR only wires the call where a disk is about to be created.
  - Client: the details panel's "Initialize Git" must not show for a cloud thread whose machine is
    not ready. `restoreCheckout` logs `restoredFrom`; no client copy names it (**proposed**: a
    one-time "Rebuilt from…" label would need a new field on the record and the shell summary,
    which `sandboxStatePresentation`, client-runtime/src/state/sandbox.ts 135, can't derive today).
- **Types and services:** `checkoutInSandbox` input `threadId`, result `restoredFrom`;
  `ThreadLaunchService.restoreCheckout`.
- **Commands and events:** none new. The restore runs on the server; the thread's
  `worktreePath` and `branch` do not change, because the worktree goes back at the same path.
- **Migrations:** none.
- **Proposed gap answers.** Ignored files are lost on rebuild (07 §9). The snapshot restores into
  the working tree, not the index. A thread whose branch never reached the mirror uses GitHub, as
  M1 does. 3.21's seed uses the same mirror case.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: extend "a wake whose backend is gone
  fails as missing, and a retry provisions anew" (596): after the retry and the runner hello, drain
  and assert `restoreCheckout` ran for the owner thread (a fake `ThreadLaunchService`). This is the
  G1 bug: on `main`, nothing runs.
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`: beside "launches a cloud thread
  and releases it on runner hello" (2555), new case "rebuilds a lost checkout from the mirror's
  branch and snapshot": a real temp mirror with a branch and a snapshot holding an uncommitted file,
  a fake sandbox host on a temp dir, `existingWorktreePath` set and missing. Asserts the worktree
  exists at the same path, `HEAD` is the mirror's branch tip, the uncommitted file is back, and
  `restoredFrom` is `mirror`.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts
apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`; `vp run typecheck` for server,
client-runtime, web, mobile; `vp run check:changed`. Runtime transcript on Docker (G2 step 8): make
an uncommitted edit, sleep, `docker rm -f` the container, Retry; the checkout is back with the edit
and the server log shows `restoredFrom: "mirror"`. Capture of the details panel before (G1's
"Initialize Git") and after.

**Reviewer checks.**

- The restored worktree is at the thread's recorded `worktreePath`, so nothing else moves.
- The mirror is never written by the machine here; bytes flow mirror to machine only.
- A kept disk does no fetch and no bundle.
- Every path that creates a disk calls 2.23's gate (README Traps).
- Hit every surface: web and mobile copy (shared presentation), entry points (Retry, Wake, a
  prompt), reverse state (this is the way back from 2.12 and discard). Not providers or MCP.

### 2.18 `feat: scheduled and webhook runs on Pair Cloud`

On a Pair Cloud server each scheduled or webhook run that starts a new thread is placed in the
cloud by 2.23's gate, runs on the task owner's provider account, waits for a machine at the cap,
and can discard its machine when it settles. The task editor shows Cloud as the placement and the
task's last run shows "Waiting for a machine" while its thread waits. Its own PR because it is
the scheduled-task half of 01 J7, with one migration.

- **Needs:** 2.1 and 2.2 (Track C), 2.22 and 2.23 (Track A). **Unblocks:** G2 step 9.
- **Files:**
  - Migration `apps/server/src/persistence/Migrations/091_ScheduledTaskCloudRuns.ts`:
    `ALTER TABLE scheduled_tasks ADD COLUMN discard_on_settle INTEGER NOT NULL DEFAULT 0` and
    `ADD COLUMN last_run_thread_id TEXT`. Register it where 090 is registered.
  - `packages/contracts/src/scheduledTask.ts`: `ScheduledTask` (227) gains
    `discardOnSettle: Schema.optionalKey(Schema.Boolean)` and
    `lastRunThreadId: Schema.optionalKey(ThreadId)`; `ScheduledTaskUpsertInput` (262) gains
    `discardOnSettle: Schema.optionalKey(Schema.Boolean)`. `workspaceStrategy` stays
    `OrchestrationV2ThreadLaunchWorkspaceStrategy` (`orchestrationV2.ts` 752: never `cloud`).
  - `apps/server/src/scheduledTasks/ScheduledTaskService.ts`: `ScheduledTaskRow` (195) gains the two
    columns; `decodeRow` maps them (`discardOnSettle` only when 1). Upsert writes
    `discard_on_settle` only when the input has the key, so a client that does not know the field
    keeps the stored value. `runTask` (826): pass `discardOnSettle` to `threadLaunch.launch` (956)
    when the task has no bound thread, and store `last_run_thread_id` with the completion record.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: `ThreadLaunchInput` (90) gains
    `discardOnSettle?: boolean`; `provisionCloud` (282) passes it on `sandbox.provision`.
    `ThreadLaunchInput` also gains `cloudPlacement?: true`, which only `ScheduledTaskService` sets.
    On a cloud-only server, `launch` (960) first turns such an input's strategy into
    `{ type: "cloud", baseRef, branch }`: a `worktree` base without its `origin/` prefix (MCP stores
    `origin/main`), else the strategy's branch, the checkout's current branch or `main`. This runs
    ahead of 2.22's `local-launch` check, so scheduled and webhook runs pass it and take the same
    `checkCloudLaunch` and `resolveCloudLaunch` path as a client launch. On a server that isn't
    cloud-only the key does nothing, and tasks keep M1 behavior.
  - `ScheduledTaskService.ts` `runTask` (826) sets `cloudPlacement: true` on its `launch` call (956).
  - `packages/contracts/src/orchestrationV2.ts`: `sandbox.provision` (3898) and
    `OrchestrationV2Sandbox` (462) gain `discardOnSettle: Schema.optionalKey(Schema.Boolean)`;
    `OrchestrationV2SandboxJson` (485) passes it through.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: `decideProvision` (291) copies
    `discardOnSettle` onto the record when true. The `sandbox.auto-sleep` arm as 2.1 rewrites it
    (405): when `record.discardOnSettle === true` and the reason is `settled` or `archived`,
    `update({ state: "destroyed" }, ["sandbox.destroy"])` instead of sleeping. `idle` and
    `cap-pressure` still sleep, so a run that never settles keeps its disk until it does.
    `idleDecision` (2.1) rule 3 applies to a `discardOnSettle` record even when the driver's
    `sleepOnSettle` is false, so settle-discard works on every driver.
  - `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` `destroy` (406): flush the mirror first,
    as `sandbox.stop` does (390), so the discarded machine's last diff lands. 2.12's expiry
    destroys go through the same effect.
  - Web `apps/web/src/components/settings/ScheduledTasksSettings.tsx`: when the environment's
    `cloudLaunch` capability (2.24) is true, the workspace field (built at 1341) shows "Cloud" as
    the placement (read-only) and a "Discard the machine when the run settles" switch. The last-run
    badge (785) reads the `lastRunThreadId` thread's shell (the `useThreadShell` pattern
    `ScheduledTaskDestination` uses, 1144) and shows "Waiting for a machine" from
    `sandboxStatePresentation` (`client-runtime/src/state/sandbox.ts` 135, copy at 146) while its
    sandbox has `admission`.
  - Mobile `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx` and
    `scheduledTaskDraft.ts`: the same placement, switch and badge.
  - MCP: `schedule_task` (OrchestratorMcpService.ts 2026) has its own schema and builds the upsert
    itself (2106). It does not expose `discardOnSettle` in M2 (**proposed**: the editor is where a
    team decides it), so no tool text changes and no evals run.
- **Types and services:** `ScheduledTask.discardOnSettle`, `ScheduledTask.lastRunThreadId`,
  `ThreadLaunchInput.discardOnSettle`, `OrchestrationV2Sandbox.discardOnSettle`.
- **Commands and events:** `sandbox.provision` gains an optional key; no new command or event.
- **Migrations:** `091_ScheduledTaskCloudRuns`.
- **Proposed gap answers.** A missing `discardOnSettle` on upsert keeps the stored value, so an old
  client that re-saves a task does not drop it (m2-m5 accepted the loss; keeping it costs one SQL
  `CASE`). A bound-thread task (`threadId` set) is unchanged: it sends to its thread, and a message
  to an asleep cloud thread already wakes it (`gateCloudMessage`). "Discard when the run settles"
  is per machine, so a task that reuses one thread ignores it. Waiting runs need no run-history
  table: the last run's thread already carries the admission state.

**Tests.**

- `apps/server/src/persistence/Migrations/091_ScheduledTaskCloudRuns.test.ts`: existing rows read
  `discard_on_settle = 0` and a null thread (the pattern of `057_ScheduledTaskWebhooks.test.ts`).
- `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts`: new case "a cloud task's run
  launches with discardOnSettle and records its thread" with a fake `ThreadLaunchService`; and an
  upsert without the key keeps a stored `true`.
- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts` rows: `sandbox.auto-sleep`
  `settled` with `discardOnSettle` destroys, `idle` with it sleeps; `idleDecision` with
  `discardOnSettle` and `sleepOnSettle: false` sleeps on settle; `sandbox.provision` copies the flag.
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`: a row in "refuses a cloud launch
  for $name before any thread or machine" (2674) shows a cloud-only `worktree` launch without
  `cloudPlacement` refused with `local-launch`, and a new case "places a scheduled worktree launch
  in the cloud on a cloud-only server" shows one with it provisions a sandbox.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: extend "a cloud task's own machine
  waits at a full cap" (1483) to settle the run and assert `sandbox.destroy` ran when the flag is set.

**Verify.** `vp test run` the four files; `vp run typecheck` for contracts, client-runtime,
server, web, mobile; `vp run check:changed`. Client pass with `test-t3-app` on a cloud-only dev
server: create an interval task and a webhook task (2.34's URL), fire both (G2 step 9), watch
"Waiting for a machine" at a cap of one, then the machine discarded after settle. `test-t3-mobile`
for the editor.

**Reviewer checks.**

- The task never stores `cloud`; the gate places each run.
- A run's launch commits the thread before the machine exists, so "succeeded" means "launched".
- Discard keeps the mirror and the thread's reads.
- Hit every surface: web and mobile editors; MCP and agents (scheduled tasks are agent-created
  too); contracts; providers (the owner's account goes through `resolveCloudLaunch`); reverse
  state (a discarded run's thread wakes and rebuilds, 2.13); docs (`docs/user/cloud.md` "Start a cloud
  thread": Cloud runs and discard).

### 2.21 `docs: add the Pair Cloud install guide and update the cloud guide`

A team admin can install, run, upgrade, restore and offboard Pair Cloud from the user docs alone,
and the existing guides match what M2 changed. Last, because it documents the rows in its Needs
as they landed. Follow AGENTS.md "Documentation": tasks and decisions,
no feature catalogs, a settings path where useful.

- **Needs:** 2.12, 2.22, 2.26, 2.28, 2.30, 2.31, 2.34, 2.35, 2.36, 2.37, 2.38, 2.43, 2.44, 2.45.
  **Unblocks:** G2 (it installs "as the install guide says").
- **Files:**
  - Add `docs/user/pair-cloud.md`, "Install Pair Cloud" (**proposed** name). The outline, one
    short section each:
    1. **What you need.** A Linux x64 or arm64 host with Docker, a domain with TLS, a GitHub
       organization. Sizing from the team cap: Docker's default is a quarter of the vCPUs (1 per
       4 vCPUs).
    2. **Install the release.** `curl -fsSL <base>/v<version>/install.sh | T3CODE_VERSION=<version> T3CODE_RELEASE_BASE_URL=<base> sh`;
       check against `SHA256SUMS`; `t3 service install`. Always an exact version.
    3. **Configure the service.** `service.env` (background-service.md "Configure the service
       environment") with `T3CODE_CLOUD_ONLY=1` (2.22), `T3CODE_RELEASE_BASE_URL`,
       `T3CODE_GITHUB_APP_CLIENT_ID`, and 2.34's public origin `T3CODE_PUBLIC_URL`. Then `t3 service restart`. A server that is not cloud-only offers no
       Cloud.
    4. **Reach it on your own domain.** A reverse proxy with TLS in front of the port, or
       Tailscale (remote-access.md). No T3 Connect. Webhook URLs use the public origin.
    5. **Set up Docker.** Install gVisor and register `runsc`. The driver prefers it
       (`isolationFromInfo`, DockerComputeDriver.test.ts 167), and Settings → Cloud → **Test** shows
       the isolation. Or point the driver at another host's daemon with `dockerHost`
       (settings.ts 1207). Add the service user to the `docker` group, then log out and back in.
    6. **Connect GitHub.** One App: device flow for members, the App ID and key for pushes and
       clones, installed on the repositories. Permissions now include Checks and Commit statuses
       read (2.44). Link team.md "Set up the GitHub App" instead of repeating it. What PR reads use,
       per 2.44.
    7. **Invite the team.** `t3 member invite <name> --github <login>`, and the trust text: what a
       member can reach (D15), as 2.45 words it. Link team.md.
    8. **Add projects.** Add each repository by its GitHub `owner/name` (2.26). Members then pick
       **Cloud** on their own clone and land on the matching project (2.28, 2.29), on a pushed
       branch (2.31). Each member adds a Claude setup token or API key, or a Codex account, on
       Pair Cloud (2.30).
    9. **Set the team cap and disk retention.** Settings → Cloud → Compute: machines at once
       (2.43), and archived and asleep disks deleted after 7 and 30 days by default (2.12).
    10. **Back up hourly.** Snapshot the disk that holds the T3 home every hour with the cloud's
        disk snapshot schedule, or a timer running `sqlite3 <home>/userdata/statev2.sqlite ".backup …"`
        plus `secrets` and `settings.json`. Restore and start with restore mode (2.38,
        `--restore-mode` or `T3CODE_RESTORE_MODE`). Machines started after the snapshot are
        stopped and listed for admins; none is destroyed.
    11. **Upgrade.** Drain first (2.37, `t3 drain`): new turns wait and running
        ones finish or continue after the restart. Then `t3 update <version>`, or **Update
        server** in Settings, which installs the client's exact version.
    12. **Offboard a member** (decision #6, manual). `t3 member remove`. Revoke their GitHub
        connection (team.md "Connect your account", 115; **Disconnect** at 126). Remove them from the GitHub organization and the App's
        installation. Delete or reassign their cloud sessions. Rotate the App key if they had admin.
    13. **Coming from Conductor Cloud.** Move cloud.md's section here or link it. It fits a new
        install better.
  - `docs/user/cloud.md`:
    - "Turn on Cloud" (15) points at the install guide; a desktop's own server offers no Cloud.
    - "Start a cloud thread" (55): pick **Cloud** from a local project on the Mac; the branch must
      be pushed (`branch-not-pushed`, "Push <branch> first").
    - "What the status means" (75): asleep and waking, sleep at the idle deadline, wake on send,
      asleep reads come from the snapshot.
    - "Provider accounts" (109): accounts on Pair Cloud.
    - "Pushing and pull requests" (123): 2.44's read rule.
    - "Phone" (145): Pair's one app build, a plain push.
  - `docs/user/team.md`: check the trust text 2.45 wrote in the invite section still reads true; "Set up
    the GitHub App" permissions (2.44); the per-team build paragraph under notifications, gone
    with 2.35.
  - `docs/user/mobile-notifications.md`: Pair's one app build reaches any Pair Cloud. No per-team
    build.
  - `docs/user/project-settings.md` "Webhook automations" (97): the full URL on a Pair Cloud
    reached by its public origin.
  - `docs/README.md`: add "Install Pair Cloud" under "Using Pair", after "Cloud threads" (23).
  - `docs/internals/overview.md`: two servers (a team's Pair Cloud and each member's local
    server), one launch gate (`cloudLaunch` on a cloud-only server only), clients route a cloud
    launch to Pair Cloud. Plus the owed M0 seam paragraph (10 §5): the reserved `/t3-sandbox/`
    root fails closed, thread-scoped code reads `host.info`, and the host owns the base
    environment. Proposed: a section here, not a new page.
  - `docs/operations/release.md`: links 2.36's "Pair Cloud release" from the self-update
    invariant (429).
  - `docs/operations/team-push.md`: drops the per-team build (if 2.35 did not).
  - `docs/product/decisions.md`: amendments from 01 §5 and the team-build guidance with 2.35;
    `docs/product/pair-features.md`: M2's entry with PR links.
- **Types and services:** none.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - Hourly snapshots are an operator's disk or `sqlite3 .backup` schedule, not a `t3` command
    (D11 names the cadence, not a tool). A `t3 backup` only when a team asks.
  - The seam paragraph goes into overview.md, so M2 adds no internal page.

**Tests.** None (docs).

**Verify.** `vp run check:changed` (format and links). G2 itself proves the guide: the installer
follows it word for word on the VM, and every place it diverges is a guide fix in this PR.

**Reviewer checks.**

- Every flag, env and settings path in the guide exists under that exact name in the code that
  landed.
- No step depends on a checkout, `vp`, or T3 Connect.
- Offboarding covers the server, GitHub, the App and the member's sessions.
- No feature catalog; existing pages link the guide instead of repeating it.
- Hit every surface: docs only; the guide covers web, desktop and mobile where steps differ
  (Settings paths are the same on all three).

### 2.22 `feat(server): add cloud-only startup mode`

This PR makes a server started with `--cloud-only` run nothing on its own machine. Every agent,
terminal, project script and git write must land on a sandbox host. Threads that ran on the server
before stay readable but take no new work. While a local thread still has work, the server refuses to
start in this mode. The PR is its own, and first, because every other cloud-only row reads the flag
it adds.

- **Needs:** M1. **Unblocks:** 2.23, 2.24, 2.26, 2.35, 2.45; 2.18 through 2.23.
- **Files:**
  - `apps/server/src/config.ts`: the `ServerConfig` shape (84–108) gains `readonly cloudOnly: boolean;`
    after `autoBootstrapProjectFromCwd` (105). `makeTest` (213) sets `cloudOnly: false` (beside 246).
  - `apps/server/src/cli/config.ts`:
    - Add `cloudOnlyFlag = Flag.Boolean("cloud-only")` beside `lanFlag` (88), described as "Run every
      thread, terminal and script on cloud machines, never on this server (equivalent to
      T3CODE_CLOUD_ONLY)."
    - Add the env entry `cloudOnly: Config.Boolean("T3CODE_CLOUD_ONLY").pipe(Config.option,
      Config.map(Option.getOrUndefined))` beside `lan` (174).
    - Thread the flag through the same places `lan` goes: the flags interface (210), the flag map
      (245), `normalizedFlags` (293) and the empty flags block (550).
    - In `resolveServerConfig` (263), resolve `cloudOnly` from flag then env, defaulting to false. It
      is never read from the desktop bootstrap envelope.
    - When `cloudOnly && mode === "desktop"`, fail with `CliError.UserError` (precedent at 358):
      "Cloud-only mode is for Pair Cloud servers, not the desktop app."
    - Add `cloudOnly ? Option.some(false) : Option.none()` to the `autoBootstrapProjectFromCwd`
      precedence (389–397), because a cwd project is a local project.
    - Return `cloudOnly` with the config (522).
  - **New** `apps/server/src/environment/CloudOnly.ts`:
    - It re-exports `CLOUD_ONLY_MESSAGE` and `CloudOnlyRefusedError` (`operation`; its message is
      `CLOUD_ONLY_MESSAGE`). Both are defined in `packages/contracts/src/environment.ts`, so the
      wire errors below and `TerminalCloudOnlyError` share the one string.
    - `refuseLocalHost(operation, path)`: on a cloud-only server it fails for a null path or a path
      whose host is not `"sandbox"`. A path under the sandbox root whose machine is not connected
      passes, because routing to it already fails closed.
    - `localHostGuard` reads the services once, so a service's methods can call the check without
      gaining an R.
    - It reads `ServerConfig` and `WorkspaceHosts.forPath` (WorkspaceHosts.ts 52). It is fail-closed
      by type: there is deliberately no `Context.Reference` default that could leave the flag off in
      a layer that forgot to provide it.
  - `apps/server/src/orchestration-v2/Orchestrator.ts`:
    - Add `OrchestratorLocalThreadReadOnlyError` (`commandId`, `threadId`) beside
      `OrchestratorSubagentThreadReadOnlyError` (309–316). Its message: "This thread ran on the
      server, which now runs threads only in the cloud. Start a cloud thread to continue."
    - Add it to `OrchestratorV2Error` (395–409) and to `dispatchWasNotAccepted`
      (ThreadMessageIntake.ts 21–39).
    - The Orchestrator reads `ServerConfig` once in `makeOrchestrator`, and `layer`'s R (15459) gains
      `ServerConfig.ServerConfig`.
    - When `cloudOnly && thread.sandboxId === undefined`, refuse:
      - in the `message.dispatch` case (14346), after the subagent check and before `gateCloudMessage`
        (14365);
      - in `prepared-run.retry` (14392);
      - in `checkpoint.rollback` (14532), whose rollback touches the host checkout.
    - The refusal records no rejected receipt, like the mode-limit refusals: the same command must
      work again after a restart without `--cloud-only`.
    - Forks and merge-backs are transcript-level and stay open.
  - `apps/server/src/orchestration-v2/ProviderSessionManager.ts` `open` (~2160): on cloud-only, a
    null `cwd`, or a `cwd` whose host is not `"sandbox"`, fails `CloudOnlyRefusedError` before any
    spawn. `ProviderWorkspaceMissingError` would tell the user the folder is gone. This is the backstop for every path that reaches a
    provider without the Orchestrator's check, such as outbox effects queued before the restart.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts` `launch` (960): on cloud-only, a
    `workspaceStrategy.type !== "cloud"` fails before `checkCloudLaunch` (969–975). It uses
    `CloudLaunchError` with a new reason `"local-launch"`, message "This server runs threads only in
    the cloud. Launch it as a cloud thread." (CloudPreparation.ts 35–61). `isCloudLaunchRefusal` (64) already
    covers the type, so MCP `t3_thread_launch` and `t3 thread` get the message. Scheduled and
    webhook runs are turned into cloud launches ahead of this check by 2.18's `cloudPlacement`;
    until 2.18 lands they are refused here.
  - `apps/server/src/mcp/OrchestratorMcpService.ts` `createThreads` (2829): refuse with
    `failure("invalid_request", ...)` when `cloudOnly || parent.thread.sandboxId !== undefined`.
    The message: "create_threads shares your checkout, which cloud threads can't do. Use
    delegate_task with isolation 'cloud'." (proposed).
  - Same file, `delegateTask` (2382): on cloud-only, an `isolation` other than `"cloud"` fails
    `failure("invalid_request", "This server runs threads only in the cloud. Use isolation
    'cloud'.")` before the worktree branch (2446). `dispatchDelegatedTaskRequest` (Orchestrator.ts 8419) calls `gateCloudMessage` itself and never reaches the `message.dispatch` check, so
    without this a `worktree` or `shared` child fails late at the `ProviderSessionManager.open`
    backstop.
  - Terminals:
    - `packages/contracts/src/terminal.ts`: add `TerminalCloudOnlyError` (`threadId`, `terminalId`)
      to the `TerminalError` union (365). The union is strict, so this is a new value old clients
      can't decode. It is safe under the header's rule: 2.22 lands before G2 tags the first
      release. The same holds for `"cloud_only"` below.
    - `apps/server/src/terminal/Manager.ts` `openWithWorkspaceLease` (2877): after `assertValidCwd`
      (2881), a non-null `host` with `host.kind !== "sandbox"` on cloud-only fails
      `TerminalCloudOnlyError`. `make` reads `ServerConfig` (1403) and passes `cloudOnly` as a
      required `TerminalManagerOptions` field, so `makeWithOptions` callers can't leave it off.
    - Setup and project scripts open terminals (`ProjectSetupScriptRunner.ts`), so this one check
      covers them. The server still parses `t3.json`.
  - Workspace writes:
    - `packages/contracts/src/project.ts`: `ProjectFileFailure` (453) gains `"cloud_only"`.
    - `apps/server/src/workspace/WorkspaceFileSystem.ts` `writeFile` (496): after `hostForCwd`
      (500), a local host on cloud-only fails `CloudOnlyRefusedError`. `ws.ts`
      `projectFileFailureContext` maps it to `ProjectWriteFileError` (552) with `"cloud_only"`.
  - Host-tool RPCs, each refused with a plain cloud-only check:
    - `projectsEnsureScratch` (3031) and `projectsCreateNew` (3037), until 2.26 replaces create:
      in `ManagedProjectFolders`, so the MCP project tools refuse too. The existing
      `OrchestrationDispatchCommandError` carries the message.
    - `serverImportAcpRegistrySession` (2536): in ws.ts `importAcpRegistrySession`, as
      `AcpRegistryOperationError` `"session_import_failed"` with `CLOUD_ONLY_MESSAGE`. Its root
      launch is refused by `"local-launch"` anyway.
    - `agentSessionsScan` and `agentSessionsImport` (3163–3164): in `AgentSessionScanner` `scan` and
      `recentThreads`, which the importer reads before it writes anything.
    - `shellOpenInEditor` (ws.ts 3148) and `previewStopLocalServer` (3381): in the ws.ts handler,
      because `ExternalLauncher` and `PortScanner` also run where no `ServerConfig` exists (`t3
      connect`, the runner).
    - These four RPCs' errors have fixed messages, so `CloudOnlyRefusedError` joins their error
      unions in `rpc.ts`. Like `"cloud_only"`, that is safe before G2.
  - Startup auto-pull: `autoPullProjects` (serverRuntimeStartup.ts 192) returns at once on
    cloud-only. It runs `git pull` on the server's checkouts, the write `pullCurrentBranch` refuses.
  - Git writes on host paths: `GitWorkflowService.ts` `pullCurrentBranch` (378), `runStackedAction`
    (382), `createWorktree` (418), `removeWorktree` (472), `createRef` (487), `switchRef` (496),
    `preparePullRequestThread` (interface 71), and `VcsProvisioningService.initRepository`
    (VcsProvisioningService.ts 42). These are the source-control writes in
    `CLIENT_GUARDED_RPC_SCOPES` (clientRpcPermissions.ts 51–58). Each calls
    `refuseLocalHost(operation, input.cwd)` first, mapped to its `GitCommandError` or
    `GitManagerError` with `detail: CLOUD_ONLY_MESSAGE`. A cloud thread's `cwd` resolves to its
    sandbox host and passes. The server's own fetches (`fetchRemote` 428, which 2.26 uses for Pair
    Cloud projects) are not guarded.
  - Startup refusal, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts` `recover`
    (930):
    - When `cloudOnly`, it first reads `getRecoveryThreadIds("runtime")` and
      `getRecoveryThreadIds("queued-runs")` (ProjectionStore.ts 751, kinds 176–180), then
      `getThreadShell` (573).
    - If any thread has no `sandboxId`, it fails a new `CloudOnlyLocalWorkError` (`threadIds`). Its
      message: "Cloud-only mode can't start while N local threads have work (ids…). Start without
      --cloud-only, let them finish or stop them, then restart with it."
    - The failure stops startup through `runOrderedV2StartupPhases` (serverRuntimeStartup.ts
      412–440, `recover` at 544), before the effect worker starts.
  - Test harness, `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts`:
    - `makeReplayServerConfig` (82) takes `options?: { cloudOnly?: boolean }`. It defaults to false.
    - `layerWithRegistry` (282) gains `cloudOnly?: boolean` and passes it on.
    - Its `layerServerConfig` (315) joins the `Layer.mergeAll` that provides the orchestrator (506).
    - Production `runtimeLayer.ts` `layerOrchestratorProvided` (231) gets `ServerConfig` from the
      server's outer layer.
- **Types and services:** `ServerConfig.cloudOnly`; `CloudOnly.refuseLocalHost`,
  `CloudOnlyRefusedError`, `CLOUD_ONLY_MESSAGE`; `OrchestratorLocalThreadReadOnlyError`;
  `TerminalCloudOnlyError`; `ProjectFileFailure` `"cloud_only"`; `CloudLaunchError` reason
  `"local-launch"`; `CloudOnlyLocalWorkError`.
- **Commands and events:** none new. `message.dispatch`, `prepared-run.retry` and
  `checkpoint.rollback` gain a refusal.
- **Migrations:** none.
- **Proposed gap answers.**
  - Cloud-only is refused in desktop mode.
  - Auto-bootstrap from cwd is forced off.
  - "Local thread running" means a thread in the `runtime` or `queued-runs` recovery set with no
    `sandboxId`.
  - `create_threads` is refused for every caller on cloud-only, and for cloud callers everywhere.
  - Git writes on Pair Cloud project checkouts are refused, because those checkouts are the
    server's own.
- **Already closed by M1.** The 06 §10 "Checkpoint mirror and diffs" row: `CheckpointMirror.ts` runs
  `index-pack --strict` on every bundle (350–359). Reviewers confirm that, and nothing changes here.

**Tests.** The existing cloud tests keep `cloudOnly` false and still pass.

- `apps/server/src/cli/config.test.ts`:
  - Extend "applies flag then env precedence over bootstrap envelope values" (379) with
    `--cloud-only` and `T3CODE_CLOUD_ONLY`.
  - Add "refuses cloud-only in desktop mode and never bootstraps a cwd project". It asserts the
    `UserError` and `autoBootstrapProjectFromCwd: false`.
- `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts`: extend
  `it.effect.each` "recovers $0 work after restart" (514) with a cloud-only pass. Local scenarios
  fail `CloudOnlyLocalWorkError` naming the thread, and `preparing-cloud` still recovers.
- **New** `apps/server/src/orchestration-v2/CloudOnlyDispatch.test.ts`, on
  `ProviderReplayHarness.layerWithRegistry(..., { cloudOnly: true })` as DispatchModeLimit.test.ts
  does (36). It has one case, "refuses a prompt, a rollback and a retry on a local thread and
  records nothing". It asserts the tag, no events and no receipt. No existing file covers a
  server mode, so the new file is justified.
- `apps/server/src/terminal/Manager.test.ts`: beside "keeps a stopped machine's terminal exited and
  starts no new one there" (712), add "refuses a server terminal on a cloud-only server and opens a
  machine's". The sandbox terminal setup at 1991 already exists to reuse.
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts`: beside "refuses a path under the sandbox
  root without touching local disk" (207), add "refuses a local write on a cloud-only server".
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`: beside "launches a cloud thread
  and releases it on runner hello" (2555), add "refuses a worktree launch on a cloud-only server
  before creating a thread".
- `apps/server/src/mcp/OrchestratorMcpService.test.ts`: add a `create_threads` refusal row for a
  cloud-only server and for a cloud caller. Beside "a cloud task $name" (1952), add "a worktree or
  shared task on a cloud-only server is refused before any thread": `delegateTask` with each
  isolation returns `invalid_request` and dispatches nothing.
- The git writes share `refuseLocalHost`. Add one table `CloudOnly.test.ts` for it (local path,
  connected and sleeping machine paths, null, a path that climbs out of a machine), and give each
  git site, `ProviderSessionManager` and the host-tool RPCs a reviewer check rather than its own
  test.
- `apps/server/src/serverRuntimeStartup.test.ts`: extend "automatic pull only updates enabled,
  behind, clean default-branch checkouts" with a cloud-only pass that pulls nothing.

**Verify.**

- `vp test run` on the files above.
- `vp run typecheck` for `apps/server` and `packages/contracts`.
- `vp run check:changed`.
- Runtime transcript:
  - Start a worktree with a seeded DB that has an active local run under `--cloud-only`. Startup
    refuses and names the thread.
  - Restart without the flag and let the run finish.
  - Restart with the flag. The old thread is read-only (prompt refused with the message), a
    terminal on the server is refused, and a cloud launch works.

**Reviewer checks.**

- Every 06 §10 row maps to a refusal in this PR, to 2.45, to 2.26 (project clone/create), or
  to M1 (the mirror), and the PR body lists the mapping.
- No refusal reads a default that could leave cloud-only off: each site yields `ServerConfig`.
- The server's own git (mirror bundles, project fetches, checkpoint capture on machines) is not
  guarded.
- The desktop app can't start cloud-only, and the server's `--help` shows the flag.
- Surfaces:
  - Entry points: composer, MCP tools (`delegate_task` refuses itself, since it skips
    `message.dispatch`), `t3 thread`, scheduled tasks (placed by 2.18) and terminals all hit the
    same services.
  - Clients: the web and mobile error copy is the server message.
  - Providers: every adapter goes through `ProviderSessionManager.open`.
  - Contracts: the terminal error and the file failure code.
  - Reverse state: restarting without the flag restores today's behavior.
  - Connection modes: none differ.
  - Docs: 2.45.

### 2.23 `feat(server,contracts): put every new machine behind one cloud-only launch gate`

This PR lets only a cloud-only server create a machine, and a client can no longer choose a
machine's driver or size. On every other server, existing machines still wake from a kept disk,
sleep and are discarded. Anything that would make a new machine is refused with a pointer to Pair
Cloud. It is its own PR because it changes the pure sandbox decider and the contract's command
split, and both need careful review.

- **Needs:** 2.22. **Unblocks:** 2.18, 2.2 (wake keeps working under the gate), 2.40.
- **Files:**
  - `packages/shared/src/sandbox.ts`: add `export const NOT_CLOUD_ONLY_MESSAGE = "New cloud threads
    run on your team's Pair Cloud. Connect to it to start one."` (proposed copy). 2.24 reuses it.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`:
    - `SandboxDecisionInput` (73–83) gains `readonly cloudOnly: boolean`, and
      `SandboxRefusalReason` (85–95) gains `"not-cloud-only"`.
    - Rename today's body of `decideSandboxCommand` (325) to a module-private `decide` and wrap it:
      ```ts
      /** A decision that would make a new machine is the launch gate's, and only cloud-only servers pass it. */
      const createsMachine = (record: OrchestrationV2Sandbox | null, decision: SandboxDecision) =>
        decision._tag === "Accept" &&
        (decision.effects.some((effect) => effect.type === "sandbox.create") ||
          (decision.next.state === "provisioning" &&
            (record === null || decision.next.generation !== record.generation)));
      ```
    - When `!input.cloudOnly && createsMachine(input.record, decision)`:
      - `sandbox.admit` returns `update`-style Accept of the record as `state: "failed"`,
        `failure: { code: "not-cloud-only", message: NOT_CLOUD_ONLY_MESSAGE, retryable: false }`,
        with effects `["sandbox.release-waiters"]`. This matches the `sandbox.failed` arm (471–481),
        so a waiter left by an older server fails visibly and can be discarded.
      - Every other command gets `refuse("not-cloud-only")`.
    - What this catches: `decideProvision` (291); `sandbox.wake` on `destroyed` (`nextGeneration(true)`);
      wake and retry on a no-disk failure (`nextGeneration(false)` with `driverRef === null`); and
      admitting a waiting create.
    - Wake from `sleeping` with a disk, `sandbox.start`, sleep, discard and auto-sleep are untouched.
  - `decideCloudPrompt` (200):
    - The input gains `cloudOnly` and passes it into its inner `decideSandboxCommand` (217–228).
    - On `Refuse` with reason `"not-cloud-only"` it returns `{ _tag: "Refuse", message:
      NOT_CLOUD_ONLY_MESSAGE }` instead of `record.failure?.message ?? ...` (239–241).
  - `apps/server/src/orchestration-v2/Orchestrator.ts`:
    - `dispatchSandboxCommand` (10859) passes `cloudOnly` (read in 2.22) into `decideSandboxCommand`
      (10911). A `"not-cloud-only"` refusal fails `OrchestratorDispatchError` with
      `cause: NOT_CLOUD_ONLY_MESSAGE` (10921–10931).
    - `gateCloudMessage` (11037) passes `cloudOnly` into `decideCloudPrompt` (11064).
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`: `CloudLaunchError` reasons (35–61) gain
    `"not-cloud-only"`, with `NOT_CLOUD_ONLY_MESSAGE` as its message. `resolveCloudLaunch` (87) fails
    with it first when `!(yield* ServerConfig).cloudOnly`. 2.24 moves this into `cloudAvailability`.
    `ThreadLaunchService.checkCloudLaunch` (276) and MCP `delegate_task` (OrchestratorMcpService.ts
    2489–2500) already route through it.
  - `packages/contracts/src/orchestrationV2.ts`: move the `delegated_task.request` struct (3636) from
    `OrchestrationV2Command` (3157) into `OrchestrationV2InternalCommand` (3702), unchanged.
    `OrchestrationV2ServerCommand` (3953) still holds it. Fix the type references:
    - Orchestrator.ts 8421 (`dispatchDelegatedTaskRequest` takes `OrchestrationV2ServerCommand`);
    - OrchestratorMcpService.ts 2477–2480 (the `sandbox` field type);
    - ThreadManagementService.ts 106 (drop the case from `withCreationProvenance` (93), which sees
      only client commands);
    - ws.ts 2105 (drop it from the client span's thread-id switch).
    - ThreadManagementService.ts 183 and 907 take server commands and stay.
- **Types and services:** `SandboxDecisionInput.cloudOnly`, `SandboxRefusalReason` `"not-cloud-only"`,
  `NOT_CLOUD_ONLY_MESSAGE`, `CloudLaunchError` `"not-cloud-only"`.
- **Commands and events:** `delegated_task.request` becomes internal. No new commands or events.
  `SandboxFailure.code` is an open set (sandbox.ts 95–103), so `"not-cloud-only"` needs no contract change.
- **Migrations:** none.
- **Proposed gap answer.** A waiting create on a server that isn't cloud-only fails for good on its
  next admit rather than waiting forever. Its thread shows the Pair Cloud message, and Discard works.
  The sweep sends `sandbox.admit` only while its driver has a free slot (SandboxLifecycleWorker
  `admitWaiters`), so at a full cap the waiter fails once a slot frees.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts`:
  - The `Row` tuple gains an optional seventh element, `cloudOnly` (default `true`), and the
    `it.each` (470) passes it. Every existing row runs as today.
  - New rows with `cloudOnly: false`:
    - "provision on a server that is not cloud-only" → `"not-cloud-only"`;
    - "wake after discard on a server that is not cloud-only" → `"not-cloud-only"`;
    - "retry without a disk on a server that is not cloud-only" → `"not-cloud-only"`;
    - "wake from sleep starts the kept disk anywhere" → accept `sandbox.start`;
    - "discard anywhere" → accept;
    - "admit a waiting create on a server that is not cloud-only" → accept `failed` with
      `["sandbox.release-waiters"]`.
  - `describe("decideCloudPrompt")` (579) gains a `cloudOnly` field per case, and one new case:
    "a discarded machine on a server that is not cloud-only points at Pair Cloud".
- `packages/contracts/src/rpc.test.ts`: extend "rejects server-internal commands sent to
  dispatchCommand" (9). Assert `delegated_task.request` (with and without `sandbox`),
  `sandbox.provision` and `sandbox.admit` fail to decode.
- The existing cloud tests in `SandboxLifecycle.test.ts` and `ThreadLaunchService.test.ts` must run
  with `cloudOnly: true`. Set it once in the harness or layer they share, not per case.

**Verify.**

- `vp test run` on SandboxDecisions.test.ts, rpc.test.ts, SandboxLifecycle.test.ts and
  ThreadLaunchService.test.ts.
- `vp run typecheck` for `apps/server` and `packages/contracts`.
- `vp run check:changed`.
- Runtime transcript on a non-cloud-only dev server with an M1 cloud thread:
  - Sleep and wake work.
  - After discard, a prompt is refused with the Pair Cloud message.
  - `delegate_task isolation:"cloud"` is refused.

**Reviewer checks.**

- `createsMachine` is checked after the inner decision, so no arm can create a machine without
  passing it, including future arms.
- Wake from a kept disk still works on desktop (2.2 depends on it).
- No client code dispatches `delegated_task.request` (`git grep` in `apps/web`, `apps/mobile` and
  `packages/client-runtime` is empty today).
- The decider stays pure: `cloudOnly` is input, not a service read.
- Surfaces: MCP `delegate_task`, the composer launch, retry in the details panel, and the mobile
  Machines page all show the same message.

### 2.24 `feat(contracts,server,web,mobile): offer Cloud only on cloud-only servers`

This PR tells clients which servers launch cloud work. Cloud then shows only where it can work, and
on those servers it is the only mode. Everywhere else Cloud leaves the composer, the palette and the
settings, existing cloud threads stay readable, and a stale client gets the Pair Cloud refusal. It
is its own PR because it is the contract every client keys on (D12), and Track B's 2.27 builds on it.

- **Needs:** 2.22, 2.23 (`NOT_CLOUD_ONLY_MESSAGE`, and the direct check this PR folds into `cloudAvailability`). **Unblocks:** 2.26, 2.27, 2.45.
- **Files:**
  - `packages/contracts/src/environment.ts`: `ExecutionEnvironmentCapabilities` gains
    `cloudLaunch: Schema.optionalKey(Schema.Boolean)` after `oneTimeSchedules` (170), documented
    "True only on a cloud-only server, the only kind that starts cloud machines (D12)."
  - `apps/server/src/environment/ServerEnvironment.ts` `make` (185): read `ServerConfig` and add
    `...(serverConfig.cloudOnly ? { cloudLaunch: true } : {})` to the capability block (270–283).
  - `packages/shared/src/sandbox.ts`:
    - `CloudAvailability` (5–11) reasons gain `"not-cloud-only"`.
    - `cloudAvailability(settings, projectId, cloudLaunch: boolean)` (14) returns `{ available:
      false, reason: "not-cloud-only", message: NOT_CLOUD_ONLY_MESSAGE }` first when `!cloudLaunch`.
      The parameter is required, so typecheck finds every caller.
    - `newThreadPrefersCloud` (39–48) becomes `projectId !== null && cloudAvailability(settings,
      projectId, cloudLaunch).available`. It no longer reads `defaultsToCloud`, which stays decodable
      in contracts (D4).
  - Server callers pass `config.cloudOnly`:
    - CloudPreparation.ts 92: `resolveCloudLaunch` maps `"not-cloud-only"` to the 2.23 reason and
      drops 2.23's direct check.
    - OrchestratorMcpService.ts 2377: `cloudThreads` in the tool context.
  - Web callers pass `environment.capabilities.cloudLaunch === true`:
    - BranchToolbar.tsx 667;
    - ChatView.tsx 2208;
    - CommandPalette.tsx 1296;
    - useHandleNewThread.ts 203;
    - `readCloudAvailable` (state/sandbox.ts 17–22, used by chatRouteCommands.ts 120).
  - Mode picker:
    - `BranchToolbar.logic.ts` `resolveCloudEnvModeItem` (114–125) hides only `"not-cloud-only"`.
      `"not-configured"` now occurs only on a cloud-only server, where local modes are refused, so
      Cloud shows there disabled with its message instead of hiding (as landed).
    - On a `cloudLaunch` environment, the picker shows Cloud alone (`CloudEnvModeItem.only`), and
      `resolveEffectiveEnvMode` (194–215) returns `"cloud"` for a draft.
  - Project defaults: the `defaultsToCloud` toggle leaves `ProjectDefaultsSettings`, and its search
    row `project-defaults-to-cloud` leaves `settingsSearch.ts` (1279).
  - `CloudSettings.tsx`:
    - Remove the `desktopServer` warning (150–172).
    - Show the page and its nav entry (settingsSearch.ts 157–165, SettingsSidebarNav.tsx 142–145)
      when `cloudLaunch` or drivers remain.
    - Without `cloudLaunch`, show a notice "Cloud moved to Pair Cloud. Existing machines here keep
      working until you discard them.", keep Overview read-only, and keep **Remove** on driver rows.
      As landed, Add, Test, Edit, base image, limits and environment variables go too; Leave
      restore mode stays. With no drivers either, Overview shows `NOT_CLOUD_ONLY_MESSAGE`.
  - Mobile:
    - `use-new-task-project-defaults.ts` (67, 70) passes the environment's `cloudLaunch`, and the
      draft screens follow through `new-task-flow-provider.tsx` and `NewTaskDraftScreen.tsx`.
    - `cloudEnvironmentIdsAtom` (state/sandbox.ts 36–43) still lists environments with drivers, so
      existing machines stay manageable.
  - `apps/desktop`: no change, because desktop renders web.
- **Types and services:** `ExecutionEnvironmentCapabilities.cloudLaunch`; `CloudAvailability`
  `"not-cloud-only"`.
- **Commands and events:** none. **Migrations:** none.
- **Proposed gap answers.**
  - On a `cloudLaunch` environment every new thread is cloud, which is what "every launch is a cloud
    launch" means for the UI.
  - A new client on an older server sees no `cloudLaunch` and hides Cloud. That is D12's intent.

**Tests.**

- `packages/shared/src/sandbox.test.ts`:
  - Extend `describe("cloudAvailability")`'s `it.each` (24–43) with a `cloudLaunch` column and a
    `not-cloud-only` row.
  - Extend `describe("newThreadPrefersCloud")` (52) with "prefers Cloud on a cloud-launch server
    without the old default" and "never on another server".
- `BranchToolbar.logic.test.ts`: add a `not-cloud-only` row to the existing `resolveCloudEnvModeItem`
  table.
- The UI changes are visual, so they get captures instead of tests.

**Verify.**

- `vp test run` on sandbox.test.ts and BranchToolbar.logic.test.ts.
- `vp run typecheck` for `packages/contracts`, `packages/shared`, `apps/server`, `apps/web` and
  `apps/mobile`.
- `vp run check:changed`.
- Before and after captures:
  - the composer on a desktop server with a driver (Cloud gone) and on a cloud-only server (Cloud
    only);
  - Settings → Cloud on both;
  - the mobile new-task draft on both.
- `test-t3-app` and `test-t3-mobile` passes.

**Reviewer checks.**

- Every `cloudAvailability` caller passes a real capability or config, with no `true` literals.
- Existing cloud threads on a desktop server still render, sleep, wake and discard.
- `defaultsToCloud` still decodes in settings files.
- The palette's "New cloud thread" and its keybinding follow the same availability.
- Surfaces: composer, palette, keybinding, Settings, mobile, the server's MCP context, contracts;
  reverse state: Remove driver keeps working.

### 2.25 `fix(server): redact driver config for members in the settings stream`

This PR stops members from receiving the Docker host and runner URL of every driver. Members get
only what `cloudAvailability` and Overview's read-only rows need. It is its own PR because the
settings stream is shared by every client and every role.

- **Needs:** M1. **Unblocks:** 2.40 (the member view stays decodable), 5.x drivers with secrets.
- **Files:**
  - `apps/server/src/serverSettings.ts` `redactServerSettingsForClient` (144–159): `client` becomes
    `{ readonly secretReferences: boolean; readonly settingsWriter: boolean }`.
    - When `!settingsWriter`, each `sandbox.drivers` entry is rebuilt from an allowlist: `kind`,
      `id`, `label`, `size` and, once 2.43 lands, `runningCap`. Unknown keys never pass.
    - `defaultDriverId`, `baseImage` and `env` keep today's treatment, so secret env values are
      still redacted by `mapSettingsSecrets`.
  - `apps/server/src/ws.ts` `layerWsRpc` (1403–1408): build `const client = { ...settingsClient,
    settingsWriter: currentSession.scopes.includes(AuthSettingsWriteScope) }` (auth.ts 34). Use it
    at the three call sites: `loadServerConfig` (1938), `serverUpdateSettings` (2833) and the
    settings stream (3497). The caller in `ws.ts` (3698–3703) is unchanged.
- **Types and services:** the `settingsWriter` field. `DockerSandboxDriver` (settings.ts 1202–1210)
  already has `dockerHost`, `runnerUrl` and `size` as `optionalKey`, so the member copy decodes.
- **Commands and events:** none. **Migrations:** none.
- **Proposed gap answer.** The gate is the `settings:write` scope, not the role name. That matches
  what can patch `sandbox`, and covers API tokens.

**Tests.** `apps/server/src/serverSettings.test.ts`, beside "sends clients a known secret
provider's config but never an unknown kind's" (306): add "sends members each driver's kind, id,
label and size, and admins the rest". The existing redaction call sites (315, 1456, 1494, …) pass
`settingsWriter: true`, and `MemberProviderAccounts.test.ts` (120) does the same. ws.test.ts's
`scopes: []` sessions (940–952) now get the member view. Its sandbox assertions, if any, move to the
writer case.

**Verify.**

- `vp test run apps/server/src/serverSettings.test.ts apps/server/src/ws.test.ts`.
- `vp run typecheck` for `apps/server`.
- `vp run check:changed`.
- Runtime transcript: a member session's `subscribeSettings` frame shows no `dockerHost` or
  `runnerUrl`, while the admin's does.

**Reviewer checks.**

- It uses an allowlist, not a denylist.
- Members still see Cloud in the composer (drivers non-empty) and Overview's rows.
- `serverUpdateSettings`'s echo to an admin is unredacted for drivers.
- Mobile's Machines page and `cloudEnvironmentIdsAtom` still work for members.
- Surfaces: web, mobile and the MCP settings read, if any, all go through the same function.

### 2.26 `feat(server,web,mobile): add Pair Cloud projects by repo`

On a cloud-only server, adding a project means a **Pair Cloud project**. The URL must be https
github.com. The member's read access is checked. The server clones the checkout itself under
hardened git config, with the App's installation token or the member's own GitHub, and fetches it
before each launch (07 §1). Every other way to make a project there is refused. It is its own PR
because it is the server half of decision 16 and the only thing that puts a project on Pair Cloud.

- **Needs:** 2.22 (`ServerConfig.cloudOnly`), 2.24 (`capabilities.cloudLaunch`), 2.31, 2.44
  (`readTokenFor`).
  **Unblocks:** 2.27, 2.28.
- **Files:**
  - `apps/server/src/config.ts`: `ServerDerivedPaths` (36) gains `checkoutsDir: join(stateDir,
    "checkouts")`, next to `worktreesDir` (43). A Pair Cloud project's checkout is
    `<checkoutsDir>/<projectId>`. Not `<baseDir>/projects`, which ManagedProjectFolders.ts (344)
    already uses for named projects.
  - New `apps/server/src/project/PairCloudProjects.ts`, service `PairCloudProjects`, layer wired
    where `ProjectCloneTracker` is. See Types and services.
  - `packages/contracts/src/projectClone.ts`: `ProjectCloneStartInput.destinationPath` (56) becomes
    `Schema.optional(TrimmedNonEmptyString)`. `packages/contracts/src/sourceControl.ts`:
    `SourceControlCloneRepositoryInput.destinationPath` (73) the same. Old clients still send one,
    and a cloud-only server ignores it.
  - `apps/server/src/sourceControl/SourceControlRepositoryService.ts`: `prepareClone` (295) refuses a
    missing `destinationPath` with "Choose where to clone." (a non-cloud-only server needs one).
    `SourceControlCloneOptions` (70) gains `config?: Readonly<Record<string, string>>`, rendered as
    `-c key=value` before `--` in `runClone` (330) so `git clone` persists it in the new repo, and
    `env?: NodeJS.ProcessEnv`, merged over `CLONE_ENV` (78).
  - `apps/server/src/project/ProjectCloneTracker.ts`: `ProjectCloneHooks` (55) gains optional
    `cloneOptions?: Effect.Effect<Pick<SourceControlCloneOptions, "config" | "env">>`.
    `cloneWatchingForStall` (214) runs it on every attempt and spreads the result into the
    `cloneRepository` options (220), so a retry mints a fresh token.
  - New `apps/server/src/project/ProjectCloneHooks.ts`: `makeProjectCloneHooks`, an Effect that
    builds the `ProjectCloneHooks` (ProjectCloneTracker.ts 55) now inline in ws.ts's
    `projectCloneStart` (2994). It reads `ProjectService`, `RepositoryIdentityResolver`,
    `ProjectEnrichment` and the `vcsStatusBroadcaster` that ws.ts's `refreshGitStatus` (2022)
    uses. ws.ts and `PairCloudProjects` both use it, so no caller passes hooks to `add`.
  - `apps/server/src/ws.ts` `projectCloneStart` (2994): on a cloud-only server it calls
    `pairCloudProjects.add(input, { memberId: currentSession.memberId })`; otherwise
    `projectCloneTracker.start(input, yield* makeProjectCloneHooks)` as today. A
    `PairCloudProjectError` maps to `SourceControlRepositoryError({ provider: "github", operation:
    "add-pair-cloud-project", detail: error.message })`, so the RPC's error union (rpc.ts 1325–1332)
    and old clients' decode stay as they are.
  - `apps/server/src/project/ProjectService.ts`: on a cloud-only server, `create` (344) and an
    `update` that moves `workspaceRoot` refuse a root outside `checkoutsDir` with
    `ProjectOperationError` "On Pair Cloud, add a project by its GitHub URL." That one guard covers
    `projectsMutate`, `projectsCreateNew`, `projectsCreateFromThread`, CLI `project create` and
    `t3_project_create`. Scratch is already refused on cloud-only by 2.22 (`projectsEnsureScratch`).
  - `apps/server/src/mcp/toolkits/project/handlers.ts`: `t3_project_clone` (388) on a cloud-only
    server calls `PairCloudProjects.add`, which clones and registers. The input maps as
    `{ ...input, projectId: ProjectId.make(yield* newCommandId()), title: <repository name>,
    createdAt: now }`, the id pattern `t3_project_create` uses (362). The member is
    `caller?.ownerId ?? scope.client?.memberId` (as 228 reads it). It returns once the project
    exists and the clone has started, as the RPC does; the clone itself is tracked.
    `PairCloudProjectError` maps to `OrchestratorMcpFailure` `invalid_request` with its message.
    `SourceControlCloneRepositoryResult` (sourceControl.ts 78) gains
    `projectId: Schema.optionalKey(ProjectId)`, set only here. `tools.ts` `ProjectCloneTool`
    (108) description: "Clone a repository (`destinationPath` new or empty). Register after with
    `t3_project_create`, with the same `environmentId`. On Pair Cloud, pass only the https GitHub URL:
    it picks the folder and registers the project."
  - `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.ts`: no change here. The
    server-side clone and fetch use 2.44's `readTokenFor({ repository })`, a token with no sandbox and
    `READ_TOKEN_PERMISSIONS` (contents, metadata, pull requests, checks and statuses, all read),
    cached per repository and never revoked.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: `PreparationInput` (122) picks
    `actorId` and `ownerId` too. In the cloud branch (467), before `awaitSandboxReady`, call
    `pairCloudProjects.fetchCheckout({ projectId, workspaceRoot: project.workspaceRoot, memberId:
    input.actorId ?? input.ownerId })`; failures are logged and ignored. 2.31's launch-time
    `remoteHasBranch` passes `env: yield* pairCloudProjects.gitEnvFor(...)` with the same member.
  - Web: `CommandPalette.tsx` clone flow (2240) and `promptLinks/NewThreadLinkView.tsx` (219) skip
    the destination step and omit `destinationPath` when the target's
    `serverConfig.environment.capabilities.cloudLaunch === true`. `lib/addProjectToMachine.ts`:
    `destinationPath` (40) becomes optional, passed through only when set (130).
  - Mobile: `features/projects/AddProjectScreen.tsx` hides the path step and omits `destinationPath`
    (1436) on a `cloudLaunch` environment.
- **Types and services:**

  ```ts
  export class PairCloudProjectError extends Schema.TaggedError<PairCloudProjectError>()(
    "PairCloudProjectError",
    {
      reason: Schema.Literals([
        "unsupported-remote",
        "already-added",
        "no-access",
        "github-not-connected",
      ]),
      repository: Schema.optional(Schema.String), // "owner/name"
    },
  ) {} // messages below
  class PairCloudProjects extends Context.Service<
    PairCloudProjects,
    {
      /** Validates, checks the member's access, picks the checkout path, then starts the tracked clone. */
      readonly add: (
        input: ProjectCloneStartInput,
        options: {
          readonly memberId: MemberId | null;
        },
      ) => Effect.Effect<
        ProjectCloneStartResult,
        PairCloudProjectError | SourceControlRepositoryError | OrchestrationDispatchCommandError
      >;
      /** Credential env for git on a checkout: App token, else the member's GitHub, else none. */
      readonly gitEnvFor: (input: {
        readonly repository: string;
        readonly memberId: MemberId | null | undefined;
      }) => Effect.Effect<NodeJS.ProcessEnv>;
      readonly fetchCheckout: (input: {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly memberId: MemberId | null | undefined;
      }) => Effect.Effect<void>;
    }
  >()("t3/project/PairCloudProjects") {}
  ```

  `add`, in order:
  1. URL: `input.remoteUrl`, or `https://github.com/<repository>.git` when `provider` is GitHub and
     `repository` is set. `parseGitRemoteRepository` (shared/git.ts 137) must give host
     `github.com`, the scheme must be `https:`, and there must be no userinfo. Otherwise
     `unsupported-remote`: "Pair Cloud clones only https://github.com repositories."
  2. Origin key `sourceControlDefinitions.repositoryKeyFromRemote(url)`, the function persisted
     keys come from (RepositoryIdentityResolver.ts 99, 111; `normalizeGitRemoteUrl`'s own doc at
     shared/git.ts 163 says not to use it for them). If a live project from `ProjectService.listShells`
     (150) has `repositoryGroupingKeyOf(identity)` equal to it, or a running clone's `remoteUrl`
     normalizes to it: `already-added`, "<owner/name> is already on Pair Cloud."
  3. Access: `GET https://api.github.com/repos/<owner>/<name>` with `MemberGitHub.credentialFor`
     (MemberGitHub.ts 72) when the member has one, unauthenticated otherwise, using the request
     shape of `isForkOf` (GitCredentialService.ts 198). 200 passes. 404 or 403 with a credential is
     `no-access`, "Your GitHub account can't read <owner/name>." 404 with none is
     `github-not-connected`, "Connect GitHub to clone private repos, in Settings → Team." A
     network failure fails the add with git-style detail; it never skips the check.
  4. `projectCloneTracker.start({ ...input, remoteUrl: url, destinationPath:
     `${checkoutsDir}/${projectId}` }, { ...(yield* makeProjectCloneHooks), cloneOptions })`, where `cloneOptions` gives
     `config` (`HARDENED_CHECKOUT_CONFIG`) and `env: yield* gitEnvFor({ repository, memberId })`.

  `HARDENED_CHECKOUT_CONFIG` (proposed, in `PairCloudProjects.ts`): `core.hooksPath=/dev/null`,
  `core.fsmonitor=false`, `protocol.allow=never`, `protocol.https.allow=always`,
  `transfer.fsckObjects=true`, `fetch.recurseSubmodules=false`, `submodule.recurse=false`. `gitEnvFor`
  adds, through `gitConfigEnv` (VcsProcess.ts 105), `http.https://github.com/.extraHeader` =
  `Authorization: Basic base64("x-access-token:<token>")`, plus `GIT_CONFIG_NOSYSTEM=1` and
  `GIT_CONFIG_GLOBAL=/dev/null`, so no filter or diff driver from the host's config runs. The token
  rides in the environment, never in the URL or in the repo's config. `fetchCheckout` runs `git
  fetch --prune origin` in the checkout with that env. It is a no-op off cloud-only.

- **Commands and events:** none new. `project.create` / `project.update` as the clone tracker issues
  them today.
- **Migrations:** none. A Pair Cloud project is a project row whose root is under `checkoutsDir`.
- **Proposed gap answers.**
  - Origin key is `repositoryGroupingKeyOf` (environment.ts 214), which is the origin remote's key.
    No new identifier. `RepositoryIdentityLocator` (186) already records which remote it came from.
  - A public repo needs no member GitHub; GitHub's unauthenticated 200 is the access check.
  - The mirror needs no change: `CheckpointMirror.ensure` (200) clones it from the checkout with
    `--local` when the first cloud thread needs it.
  - The checkout fetch at launch uses the launching member's credential when the App isn't
    installed. Agent and scheduled launches with no actor fall back to the App or no credential.
  - A monorepo subdirectory project matches Pair Cloud's repo-root project. The Pair Cloud project
    is always rooted at the repo.

**Tests.**

- New `apps/server/src/project/PairCloudProjects.test.ts`. It mocks `ProjectCloneTracker.start` to
  capture input and hooks, mocks HTTP with `HttpClient.make` as GitCredentialService.test.ts (111)
  does, and provides a cloud-only `ServerConfig`.
  - `it.effect.each` "refuses adding $name before any git runs": rows `git@github.com:acme/app.git`,
    `https://gitlab.com/acme/app`, `https://x:y@github.com/acme/app`, a project with that origin
    key, a GitHub 404 with a member token (`no-access`), a GitHub 404 with no member token
    (`github-not-connected`). Each asserts the reason and that `start` was never called.
  - "clones under the checkouts folder with the App token and hardened config": App configured;
    `start` gets `destinationPath` `<checkoutsDir>/<projectId>` whatever the client sent; running
    `hooks.cloneOptions` gives the hardened `config` and an env whose extra header carries the App
    token.
  - "falls back to the member's GitHub where the App isn't installed": the env carries the member
    token. A public repo with neither gets no header.
- `apps/server/src/project/ProjectCloneTracker.test.ts`, extend "keeps a failed clone with git's own
  explanation and retries it" (149): hooks with a counting `cloneOptions`; the retry runs it again
  and passes the second result to `cloneRepository`.
- `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`, new case "passes clone
  config before the URL and env over the defaults": `-c k=v` lands before `--`, and `env` overrides
  `CLONE_ENV`. A missing `destinationPath` is refused.
- `apps/server/src/project/ProjectService.test.ts`, new case "refuses a workspace outside the Pair
  Cloud checkouts on a cloud-only server": a root under `checkoutsDir` is created, one elsewhere is
  refused, and a non-cloud-only layer still accepts both (the existing block).
- `readTokenFor` itself is tested in 2.44.

**Verify.** `vp test run` the four test files above; `vp run typecheck` for contracts, server,
client-runtime, web, mobile; `vp run check:changed`. Run the `mcp-tool-use` eval (the
`t3_project_clone` text and schema changed). Runtime transcript on a cloud-only dev server: add a
public repo through the palette and see the checkout under `<stateDir>/checkouts/` with the
hardened keys in its `.git/config`. Then try `git@…`, a gitlab URL and a private repo with no
GitHub, and see each refusal. One `test-t3-app` pass for the palette flow, and one `test-t3-mobile`
pass for Add project on a `cloudLaunch` environment.

**Reviewer checks.**

- No token is written to disk: not in the URL, not in `.git/config`, not in the clone snapshot
  (`remoteUrl` stays redacted).
- Every project-creating path on cloud-only goes through the `ProjectService` guard or
  `PairCloudProjects.add`; nothing else can create a root.
- The access check runs before any git, and a GitHub network error fails closed.
- A non-cloud-only server behaves exactly as before, including a clone without `destinationPath`
  refused with a clear message.
- Surfaces: server, contracts, MCP (`t3_project_clone`, `t3_project_create`, eval), CLI (guard),
  web palette and link view, mobile Add project. Connection modes: the add runs on Pair Cloud
  whatever transport the client used. Reverse state: deleting a Pair Cloud project goes through
  today's delete. Removing its checkout folder is left to project deletion as today, flagged. Docs:
  2.21's cloud guide covers adding a repo.

### 2.27 `feat(client-runtime,web,mobile): resolve a local project's Pair Cloud target`

One pure function answers "where does Cloud go for this project": the project itself on Pair Cloud,
the Pair Cloud project with the same origin key, **Add to Pair Cloud**, or why not. The same PR
keeps auto balance and the machine pickers off `cloudLaunch` environments for every non-cloud
mode. Otherwise, once 2.24 lands, a New worktree draft can balance onto Pair Cloud and become a
refused launch. It is its own PR so 2.28 and 2.29 share one tested rule (decision 17).

- **Needs:** 2.24. **Unblocks:** 2.28, 2.29, 2.30.
- **Files:**
  - New `packages/client-runtime/src/state/cloudTarget.ts`:
    ```ts
    export type CloudTarget =
      /** No paired environment reports cloudLaunch: Cloud stays hidden. */
      | { readonly kind: "hidden" }
      /** Cloud shows disabled with `message`. */
      | { readonly kind: "unavailable"; readonly message: string }
      | { readonly kind: "targets"; readonly targets: ReadonlyArray<CloudTargetOption> };

    export interface CloudTargetOption {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      /** The matching Pair Cloud project, or null: Cloud offers Add to Pair Cloud here. */
      readonly projectId: ProjectId | null;
      /** Why it can't launch now (offline, turned off for the project), or null. */
      readonly disabledReason: string | null;
    }

    export function isCloudLaunchEnvironment(serverConfig: ServerConfig | null): boolean;
    export function resolveCloudTarget(input: {
      readonly project: Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;
      readonly environments: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly connected: boolean;
        readonly serverConfig: ServerConfig | null;
      }>;
      readonly projects: ReadonlyArray<EnvironmentProject>;
    }): CloudTarget;
    ```
    Rules, in order:
    1. The project's own environment reports `cloudLaunch`: one target, itself, with
       `disabledReason` from `cloudAvailability` (shared/sandbox.ts 14). `not-configured` gives
       `hidden`. This is the M1 path.
    2. No environment reports `cloudLaunch`: `hidden`. A phone paired only with the Mac sees
       nothing new (D17).
    3. No `repositoryIdentity`, or an origin key (`repositoryGroupingKeyOf`, environment.ts 214)
       not under `github.com/`: `unavailable`, "Cloud needs this project's origin on github.com."
    4. Otherwise one option per `cloudLaunch` environment, sorted by label. `projectId` is that
       environment's oldest (`createdAt`, orchestrationProject.ts 23) unarchived project with the
       same origin key, or null. `disabledReason` is "<label> is offline." when not connected, else
       that project's `cloudAvailability` message. A null project uses
       `cloudAvailability(settings, null, true)`, which checks only the driver.
  - `apps/web/src/hooks/useLogicalProjectEnvironments.ts` (19): skip environments where
    `isCloudLaunchEnvironment(serverConfig)`, except the active project's own. Auto balance
    (`useDraftEnvironmentRouting.ts` candidates, 76) and the machine picker both read this list, so
    one filter covers both.
  - `apps/web/src/hooks/useAddProjectTargets.ts` (16): skip `cloudLaunch` environments. Otherwise
    the filter above makes Pair Cloud look like a machine without the project, and the Add item
    would offer to clone into it. Adding to Pair Cloud is the Cloud item's job (2.28).
  - `apps/mobile/src/features/threads/new-task-flow-provider.tsx`, `environments` (847): skip
    `cloudLaunch` environments except the selected project's own. This list backs
    `NewTaskEnvironmentPickerRouteScreen` (NewTaskContextPickerScreens.tsx 185).
- **Types and services:** `CloudTarget`, `CloudTargetOption`, `resolveCloudTarget`,
  `isCloudLaunchEnvironment`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - Forks match on the origin key only. A fork's checkout has the fork as `origin`, so it matches
    a Pair Cloud project cloned from the fork, never the parent's. Matching the parent would launch
    on a repo without the member's branch.
  - Several Pair Cloud servers with the repo: one option each, by environment label (08 open
    question 2). Duplicate projects on one server: the oldest wins.
  - An offline Pair Cloud stays listed with its reason, so the item doesn't vanish when Wi-Fi drops.

**Tests.** New `packages/client-runtime/src/state/cloudTarget.test.ts`, one `it.each` table
"resolves $name". Rows: a Pair Cloud project itself; a local project with a match; with no match
(Add); a fork whose origin key differs from the Pair Cloud project's upstream key (Add, not a
match); no origin; a gitlab origin; no `cloudLaunch` environment (hidden); Pair Cloud offline; two
Pair Clouds (two options, by label); two matching projects on one (oldest); an archived match
ignored. The picker filters are one-line wiring on top and get no test of their own.

**Verify.** `vp test run packages/client-runtime/src/state/cloudTarget.test.ts`; `vp run typecheck`
for client-runtime, web, mobile; `vp run check:changed`. No client pass on its own; 2.28's pass
covers the filters (a New worktree draft on a repo that Pair Cloud also has never balances there).

**Reviewer checks.**

- The resolver is pure: no atoms, no I/O.
- The active project's own `cloudLaunch` environment stays in the list, so a Pair Cloud draft keeps
  its machine.
- Rule 1 wins over rule 4, so a Pair Cloud project never routes to a second Pair Cloud.
- Surfaces: client-runtime, web, mobile (filters). Desktop wraps web. Server, MCP: none.

### 2.28 `feat(web,desktop): route Cloud on local projects to Pair Cloud`

On the Mac, picking Cloud on a local project launches on the matching Pair Cloud project, with
Pair Cloud's models and uploads, on the member's pushed branch. When there is no match, it offers
**Add to Pair Cloud**. The palette and `chat.newCloud` follow. It is its own PR because it is the
whole web surface of 01 J2 and has one client pass.

- **Needs:** 2.26, 2.27, 2.31. **Unblocks:** 2.30.
- **Files:**
  - `apps/web/src/components/BranchToolbar.logic.ts`: `resolveCloudEnvModeItem` (114) takes the
    `CloudTarget` and the draft's chosen target in place of `CloudAvailability`. `CloudEnvModeItem`
    (109) becomes:
    ```ts
    { readonly disabledReason: string | null; readonly targets: ReadonlyArray<CloudTargetOption> }
    ```
    `hidden` returns null. `unavailable` disables with its message. `forceNewWorktree` keeps its
    reason. A server thread keeps today's null.
  - `apps/web/src/components/BranchToolbar.tsx` and `BranchToolbarEnvModeSelector.tsx`: one target
    with a project shows "Cloud". One with `projectId: null` shows "Add to Pair Cloud", which calls
    `addProjectToMachine` with `files: []`, `subdirectory: ""`, no `destinationPath`, and
    `remoteUrl` the https form of the local origin (`cloneUrlForProtocol` from
    `@t3tools/shared/cloneUrl`). It then opens the new Pair Cloud project, as
    `AddProjectToMachineDialog` callers do (`openAddProjectToMachine`, 70). Several targets show
    "Cloud on <label>" per option.
  - `apps/web/src/composerDraftStore.ts`: draft gains optional `cloudEnvironmentId: EnvironmentId`,
    set only when the member picks one of several targets. Otherwise the target is derived at
    render and send. The loader decodes `cloudEnvironmentId` by hand, as it does the other draft
    fields (1712). `normalizeDraftThreadEnvMode` (1335) is unchanged: it sees only the stored
    value. The way back is a render rule in `resolveEffectiveEnvMode` (BranchToolbar.logic.ts
    194), which takes the resolver's result and falls back from `cloud` to the project's default
    mode when there is no launchable target.
  - `apps/web/src/components/ChatView.tsx`: in routed Cloud mode (draft, mode `cloud`, target
    environment differs from the project's), `serverConfig` (1230) and `providerEnvironmentId`
    (1233) are the target's, so the model picker, `providerStatuses` and attachment capabilities
    read Pair Cloud. Model selection re-resolves through `resolveTeamNewThreadModelSelection`
    (providerInstanceEntries.ts 224) with the target's providers, settings and project id.
  - `packages/client-runtime/src/state/cloudTarget.ts` adds two pure helpers shared with mobile:
    ```ts
    /** What a routed launch sends: the member's branch, or a fresh one from the default branch. */
    export function routedCloudLaunch(input: {
      readonly selectedBranch: string;
      readonly defaultBranch: string;
    }): { readonly baseRef: string; readonly branch?: string; readonly existingBranch?: true };
    export type CloudBranchCheck =
      | { readonly kind: "ok" }
      | { readonly kind: "block"; readonly message: string }
      | { readonly kind: "warn"; readonly message: string };
    export function cloudBranchCheck(input: {
      readonly branch: string;
      readonly ref: Pick<VcsRef, "upstreamRef" | "isDefault"> | null;
      readonly status: Pick<VcsStatusResult, "refName" | "aheadCount"> | null;
    }): CloudBranchCheck;
    ```
    Both names drop a remote prefix (`origin/feature` becomes `feature`). Equal names give
    `{ baseRef }`; others give `{ baseRef: defaultBranch, branch, existingBranch: true }`.
    `cloudBranchCheck` reads the selected branch's own `VcsRef` (git.ts 83), not the checked-out
    HEAD's status. The default branch (`isDefault`) is `ok`. No `upstreamRef` (88) is `block`,
    "Push <branch> first." An `upstreamRef` other than `refs/remotes/origin/<branch>` is `warn`,
    "<branch> tracks <upstream>, not origin/<branch>. Pair Cloud looks on origin." `aheadCount`
    (248) counts only when `status.refName` is the branch, since status describes HEAD; above zero
    it is `warn`, "<n> commits not pushed won't be included."
  - `apps/web/src/components/ChatView.logic.ts`: `planComposerTurn` (1406) is unchanged; its
    `baseRefForCloud` (1437) is the selected branch. `useComposerSend.ts` (1355): in routed mode,
    `prepareCloud` is `routedCloudLaunch({ selectedBranch: baseRefForCloud, defaultBranch })`. The
    default branch comes from the local refs (`isDefault`). It sends `startThreadTurn` to the
    target environment, with `createThread.projectId` the target project, then opens the thread
    there. A `block` stops send with its message, as `missingWorktreeBaseBranch` does (897). A
    `warn` shows in the composer banner slot (`useSystemComposerBanners`) and doesn't block.
  - The local branch status is the existing `vcsEnvironment.status` query (as
    `GitActionsControl.tsx` 1035 reads it). The current ref comes from `vcsEnvironment.listRefs`
    with `query: branch` (as `BranchToolbarBranchSelector.tsx` 293 reads it). Both are on the
    project's own environment.
  - `apps/web/src/state/sandbox.ts`: `readCloudAvailable` (17) becomes `readCloudTarget(projectRef)`,
    the resolver over the atom registry's environments and projects. `chatRouteCommands.ts`
    `chat.newCloud` (117) runs when it gives a launchable target. `CommandPalette.tsx` (1296) shows
    "New cloud thread" from the same read. Both start the draft in `cloud` mode, and the draft
    routes.
- **Types and services:** `routedCloudLaunch`, `CloudBranchCheck`, `cloudBranchCheck`; draft field
  `cloudEnvironmentId`.
- **Commands and events:** none new; the launch is `thread.launch` with the 2.31 strategy.
- **Migrations:** none. The draft field is an optional key in the persisted draft schema.
- **Proposed gap answers** (copy and layout, for the ux-designer pass).
  - Routed Cloud continues the selected branch. Only the default branch starts a new branch.
  - After Add to Pair Cloud the member lands on the new Pair Cloud project, where the clone banner
    shows. The unsent local draft stays on the local project.
  - The copy strings above, and "Cloud on <label>" for several Pair Clouds.

**Tests.**

- `packages/client-runtime/src/state/cloudTarget.test.ts`: new tables "plans a routed launch for
  $name" (default branch, feature branch, `origin/feature` picked) and "checks $name before a cloud
  send" (no upstream, ahead by 2, upstream on `fork`, upstream with a different name, default
  branch, clean, and a selected branch that isn't checked out while HEAD is ahead: no warning).
- `apps/web/src/components/BranchToolbar.logic.test.ts`: a `resolveEffectiveEnvMode` row where a
  stored `cloud` draft with no launchable target falls back to the project's default mode.
- `apps/web/src/components/BranchToolbar.logic.test.ts`, describe "resolveCloudEnvModeItem" (126):
  replace the `CloudAvailability` rows with `CloudTarget` rows (hidden, unavailable, one launch
  target, one add target, two targets, forced new worktree, server thread).
- `apps/web/src/components/ChatView.logic.test.ts`, "prepares a worktree or a cloud launch from the
  selected branch on a new thread": unchanged; it pins that `baseRefForCloud` is the selected
  branch.

**Verify.** `vp test run` the three files; `vp run typecheck` for client-runtime and web; `vp run
check:changed`. One `test-t3-app` pass with two dev servers, local plus one started cloud-only (the
`Replay (dev)` provider): Cloud on a local project with a pushed branch opens the thread on Pair
Cloud; an unpushed branch blocks; an ahead branch warns; no match shows Add to Pair Cloud and opens
the cloning project; New worktree never balances onto Pair Cloud; `chat.newCloud` and the palette
route. Before/after captures of the Cloud item.

**Reviewer checks.**

- No local instance id is ever sent to Pair Cloud. The model selection re-resolves against the
  target.
- The launch goes to the target environment and project, never the local one.
- `existingBranch` is sent only to a `cloudLaunch` server (always true for a resolver target).
- `defaultsToCloud` is not read here (D4). 2.24 removes it.
- Surfaces: web composer, branch toolbar, palette, `chat.newCloud`. Desktop wraps web. Mobile is
  2.29. MCP: an agent launches on Pair Cloud directly, no routing. Reverse state: the draft leaves
  Cloud when the target goes away. Connection modes: Pair Cloud is a remote environment, so this
  works the same over LAN, Tailscale or T3 Connect.

### 2.29 `feat(mobile): route Cloud on Mac projects to Pair Cloud`

On the phone, picking **Cloud** on a Mac project launches on the matching Pair Cloud project, with
its models and the same branch check. The machine picker skips Pair Cloud for non-cloud modes (from
2.27). A phone paired only with the Mac shows nothing new (D17). It is its own PR because mobile has
its own navigation, draft flow and outbox.

- **Needs:** 2.27, 2.31. **Unblocks:** 2.30.
- **Files:**
  - `apps/mobile/src/features/threads/use-new-task-project-defaults.ts`: `cloud` (67) becomes the
    resolver's answer for the selected project, over the mobile environment and project atoms,
    mapped to `{ available, message, target }`. `newThreadPrefersCloud` (70) already reads
    `cloudLaunch` after 2.24; the mobile default now comes from the resolver instead.
  - `new-task-flow-provider.tsx`: `cloud` (150) and `cloudAvailable` (415) read the mapped value.
    The cloud server config (481) is the target's, so models and uploads come from Pair Cloud.
  - `NewTaskDraftScreen.tsx` `workspaceModeMenuActions` (107): the Cloud entry reads the mapped
    value. A `projectId: null` target is disabled with "Add <owner/name> to Pair Cloud first."
    Several targets get one entry per label.
  - `apps/mobile/src/lib/projectThreadStartTurn.ts` (87): a routed spec sends
    `prepareCloud: routedCloudLaunch(...)` (client-runtime). `state/threadOutboxDelivery.ts` (1104)
    keeps its temporary branch name only for a non-routed cloud launch. The queued message carries
    the target environment and project, so delivery and retries go to Pair Cloud.
  - The branch check uses `cloudBranchCheck` with the Mac environment's VCS status and ref, as
    `ThreadGitControls.tsx` reads status. It shows in the draft's notice area; `block` disables
    send.
- **Types and services:** none new; uses 2.27 and 2.28's client-runtime helpers.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answer.** The phone has no Add to Pair Cloud. Cloning onto Pair Cloud from a phone
  draft is rare, and Add project on the Pair Cloud environment already does it (2.26). The disabled
  subtitle names the repo. Flagged for the ux-designer pass.

**Tests.** None new at this layer: the resolver, `routedCloudLaunch` and `cloudBranchCheck` are
tested once in client-runtime (2.27, 2.28), and the mobile side maps them. If
`resolveNewTaskWorkspaceSelection` changes its `cloudAvailable` input, extend "keeps a cloud
selection while Cloud is available, else starts a new worktree"
(`new-task-context-presentation.test.ts` 48) instead of adding a case.

**Verify.** `vp run typecheck` for mobile and client-runtime; `vp run check:changed`. One `test-t3-mobile` pass (install with `vp
run mobile:install ios`), the phone paired with a local dev server and a cloud-only one: Cloud on a
Mac project launches on Pair Cloud with a Pair Cloud model; an unpushed branch blocks; the machine
picker doesn't list Pair Cloud in Worktree mode; a phone paired only with the local server shows no
Cloud.

**Reviewer checks.**

- The outbox delivers a routed launch to Pair Cloud, including after an app restart.
- No Mac instance id reaches Pair Cloud.
- The temporary branch name is used only when the launch isn't routed.
- Surfaces: mobile New task, machine picker, outbox. Web is 2.28. MCP: none.

### 2.30 `feat(server,web,mobile): say what a member must connect before a cloud session`

A member who picks Cloud without a usable account or GitHub on Pair Cloud is told what to add, and
gets a link to their own row in Pair Cloud's Settings → Team, on web and mobile. A clone that fails
for lack of a credential says "Connect GitHub to clone private repos" instead of G1's bare "git
clone failed" (progress, G1). It is its own PR because it is the onboarding layer over 2.28 and
2.29, and it fixes a G1 finding.

- **Needs:** 2.28, 2.29. **Unblocks:** G2 step 3.
- **Files:**
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`: `CloudLaunchError` (35) gains reason
    `"repo-unreadable"` (uses `remote` from 2.31). Message: `` `Pair Cloud can't read ${remote}.
    Connect GitHub to clone private repos, in Settings → Team.` `` In `checkoutInSandbox`
    (212), a `GitCommandError` from `fetchRemote` or `cloneRepository` (229–232) whose `reason` is
    `authentication_failed` or `remote_unreachable` becomes this error. The classifier
    (GitVcsDriverCore.ts 443) already sets those reasons for "could not read Username" and
    "repository not found", and `runGit` (1183) keeps the reason beside `fallbackErrorDetail`
    "git clone failed" (1747).
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: `failureDetail` (221) returns a cloud
    refusal's own message, without "Workspace preparation failed during …", when
    `CloudPreparation.isCloudLaunchRefusal(cause)`.
  - `packages/client-runtime/src/state/sandbox.ts`, next to `cloudPushCredential` (110):
    ```ts
    export type CloudAccountNotice =
      | { readonly kind: "provider"; readonly title: string; readonly description: string }
      | { readonly kind: "github"; readonly title: string; readonly description: string };
    export function cloudAccountNotice(input: {
      readonly settings: Pick<ServerSettings, "providerInstances" | "sourceControlHosts">;
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly memberId: MemberId | null;
      readonly member: TeamMember | undefined;
    }): CloudAccountNotice | null;
    ```
    `provider` when no provider is enabled, installed, the member's own or shared
    (`providerInstanceOwner`, providerInstanceOwnership.ts 3, undefined or the member), and
    `cloudModelDisabledReason` (sandboxCredentials.ts 86) null. Copy: "Add an account on Pair
    Cloud". "Cloud threads use a Claude setup token or API key, or a Codex account, that you add on
    Pair Cloud. Your Mac's own sign-in stays on your Mac." `github` when `cloudPushCredential({
    appConfigured: githubAppConfigured(settings), owner: member })` is `"missing"`: "Connect GitHub
    on Pair Cloud". "Pair Cloud needs your GitHub to clone private repos and push." Provider comes
    first.
  - New `apps/web/src/components/sandbox/cloudAccountBanner.tsx`, `useCloudAccountBanner(target:
    CloudTargetOption | null)`, shaped like `useCloudPushBanner` (cloudPushBanner.tsx 15). It shows
    on a draft in Cloud mode, and its action links `/settings/team?environmentId=<target>`.
    `ChatView.tsx` adds it beside `cloudPushBannerItem` (2642).
  - `apps/web/src/components/team/TeamSettings.tsx` (76): an environment picker like
    `AccessSettings` (ConnectionsSettings.tsx 169), over environments with a current member. The
    initial pick is the `machine` search key, which `validateSettingsRouteSearch` (5) makes from
    `environmentId`, falling back to the primary. `state/team.ts` `useTeamSettingsVisible` (85)
    keeps today's rule per environment (the member is known, and can write access or the server is
    in team mode) and is true when any connected environment passes it. A solo non-admin still
    sees no Team page.
  - Mobile `features/threads/NewTaskDraftScreen.tsx`: the same notice in Cloud mode, opening
    `SettingsTeam` (Stack.tsx 353). `SettingsTeamRouteScreen` (100) already lists every
    environment's team.
- **Types and services:** `CloudAccountNotice`, `cloudAccountNotice`; `CloudLaunchError` reason
  `repo-unreadable`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - One server reason covers a missing credential and a credential without access. The sandbox
    can't tell them apart from git's stderr, and the fix is the same row in Settings → Team.
  - The company account is offered by the same notice only when an admin has set one up. Otherwise
    the notice names the member's own options (D8). Copy above, for the ux-designer pass.

**Tests.**

- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`, "fails a cloud launch's run when
  $name" (2613): new row "the repo is private and nobody can read it", with `git: {
  cloneRepository: () => Effect.fail(new GitCommandError({ …, reason: "authentication_failed",
  detail: "git clone failed" })) }`, reason "Pair Cloud can't read github.com/acme/app. Connect
  GitHub to clone private repos, in Settings → Team." The table's assertion moves from
  `include` to `equal` for refusals, to pin the dropped prefix.
- `packages/client-runtime/src/state/sandbox.test.ts`, next to describe "cloudPushCredential"
  (193): new `it.each` "says what to connect when $name": no instances; only another member's
  instance; a Local-only Claude instance; a company Codex instance (null); App configured with no
  member GitHub (null); no App and no member GitHub (`github`).

**Verify.** `vp test run apps/server/src/orchestration-v2/ThreadLaunchService.test.ts
packages/client-runtime/src/state/sandbox.test.ts`; `vp run typecheck` for server, client-runtime,
web, mobile; `vp run check:changed`. A runtime transcript of a private-repo launch with no
credential showing the new message. For G2 step 3's member-token run, the gate tester clears the
GitHub App ID in Pair Cloud's settings: `makeSourceFor` (GitCredentialService.ts 123) picks the App
whenever one is configured (129), so only then does the member's token serve. One `test-t3-app`
pass (desktop with local + Pair Cloud: the notice shows, its link opens Pair Cloud's Team page) and
one `test-t3-mobile` pass. Before/after captures of the notice and of the failure text.

**Reviewer checks.**

- The notice reads Pair Cloud's settings, providers and team, never the Mac's.
- Settings → Team on the Mac app can reach Pair Cloud's team even when the local server has none.
- Only the two git reasons map to `repo-unreadable`; every other clone failure keeps its text.
- Surfaces: server, web, desktop (via web), mobile. MCP: an agent launch gets the same refusal
  text. Docs: 2.21 covers accounts on Pair Cloud.

### 2.31 `feat(contracts,server): refuse a cloud launch whose branch isn't on origin`

A cloud launch can name a branch that already exists. With `existingBranch: true`, a branch missing
from origin is refused with `branch-not-pushed`, which names the remote it checked (decision #4),
instead of silently starting from the base and dropping the member's commits (D7). Without the key,
M1 behavior stays, which M1 mobile relies on (it sends a fresh `branch` name). It is its own PR
because it is a contract change every routed client (2.28, 2.29) builds on, and it lands in wave 1.

- **Needs:** M1. **Unblocks:** 2.26, 2.28, 2.29.
- **Files:**
  - `packages/contracts/src/orchestrationV2.ts`: `OrchestrationV2ThreadLaunchCloudStrategy` (757)
    gains `existingBranch: Schema.optional(Schema.Literal(true))`, with a one-line comment: "`branch`
    already exists and must be on origin; without it `branch` is a new name from `baseRef`." The
    run union (`OrchestrationV2RunWorkspacePreparation`) is unchanged: the run still records
    `{ type: "worktree", baseRef, branch }`.
  - `apps/server/src/vcs/GitVcsDriver.ts`: new `GitRemoteHasBranchInput extends
    GitRemoteBranchExistsInput` (267) with `env?: NodeJS.ProcessEnv`; new interface method
    `remoteHasBranch` next to `remoteBranchExists` (414), doc comment "Asks the remote itself, not
    the local remote-tracking refs."
  - `apps/server/src/vcs/GitVcsDriverCore.ts`: implement next to `remoteBranchExists` (1715):
    ```ts
    executeGit(
      "GitVcsDriver.remoteHasBranch",
      input.cwd,
      ["ls-remote", "--exit-code", "--", input.remoteName, `refs/heads/${input.refName}`],
      { allowNonZeroExit: true, timeoutMs: 15_000, ...(input.env ? { env: input.env } : {}) },
    );
    ```
    Exit 0 is true, exit 2 is false, anything else fails with `GitCommandError` carrying
    `classifyGitFailure` (505)'s reason, as `executeGit` (1155–1183) does.
  - `apps/server/src/git/GitWorkflowService.ts`: `remoteHasBranch` in the interface next to
    `remoteBranchExists` (94) and the implementation next to (445), wrapped in `ensureGitCommand`
    like it.
  - `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`: `CloudLaunchError` (35) gains reasons
    `"branch-not-pushed"` and `"no-branch"` ("Name the existing branch to launch from.") and fields `branch: Schema.optional(Schema.String)`,
    `remote: Schema.optional(Schema.String)`. Message:
    `` `${this.branch} is not on ${this.remote}. Push ${this.branch} first.` ``, where `remote` is
    `normalizeGitRemoteUrl(url)` (shared/git.ts 168), e.g. `github.com/acme/app`.
    `checkoutInSandbox` (212) takes `existingBranch: boolean`. After `pushed` (244): when
    `existingBranch && !pushed`, fail with `branch-not-pushed`; the `base-ref-missing` fallback (245)
    applies only without it. The existing-worktree reuse (234) still returns first.
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`:
    - the hand-written cloud member (77) gains `readonly existingBranch?: true | undefined`;
    - `PreparationInput` (122) gains `readonly existingBranch?: true`;
    - in `launch` (960), after `launchReceipt` (996): when `cloud !== null`,
      `input.workspaceStrategy.existingBranch === true` and `Option.isNone(launchReceipt)`, read
      origin's URL from `project.workspaceRoot` and call `git.remoteHasBranch({ cwd:
      project.workspaceRoot, remoteName: "origin", refName: branch })`. False refuses with
      `CloudLaunchError` `branch-not-pushed`, mapped with `mapError(input, "resolve-project")` like
      `checkCloudLaunch` (969), so it reaches the client through the existing
      `isCloudLaunchRefusal` branch in ws.ts (2388). A `GitCommandError` is logged and the launch
      goes on: the in-sandbox check catches it later. No thread or machine exists yet;
    - the schedule call (1229) passes `existingBranch` from the cloud strategy;
    - the cloud branch of `prepareInBackground` (467) passes
      `existingBranch: input.existingBranch === true` to `checkoutInSandbox` (474).
  - `packages/client-runtime/src/operations/commands.ts`: `prepareCloud` (173) gains
    `readonly existingBranch?: true`; the builder (764) copies it into the strategy.
  - `apps/server/src/mcp/toolkits/project/tools.ts`: `t3_thread_launch` picks the field up through
    the schema. Append to its `workspaceStrategy` description (141): "`existingBranch: true`: `branch`
    is already on the remote."
- **Types and services:** `GitVcsDriver.remoteHasBranch`, `GitWorkflowService.remoteHasBranch`
  `({ cwd, remoteName, refName, env? }) => Effect<boolean, GitCommandError>`.
- **Commands and events:** none. The refusal happens before `thread.create`; the in-sandbox failure
  rides the existing `prepared-run.fail`.
- **Migrations:** none.
- **Proposed gap answers.**
  - The schema is `Schema.optional(Schema.Literal(true))`, as 08 §2 and m2-m5 write it, not a
    boolean. `false` and absent would mean the same thing.
  - Launch-time check: `git ls-remote` from the project checkout (m2-m5's proposal). It only
    speeds up the refusal; the in-sandbox check is the guarantee.
  - Retry keeps M1 behavior: `scheduleRunPreparation` (1298) rebuilds from the run record, which
    has no `existingBranch`, so a retry whose branch was deleted from origin falls back to the base.
    So does a run re-armed after a server restart (`prepareRun` from recovery or `SandboxEffects`),
    including one still waiting for its machine when the server stopped.
    Recording the key on the run would widen the frozen run union. Inferring it from
    `isTemporaryWorktreeBranch` (shared/git.ts 121) would wrongly refuse agent-named new branches.
    Left as is, flagged.
  - `existingBranch: true` without `branch` is refused before any thread with `no-branch`, in
    `launch` beside the `remoteHasBranch` call. Preparation would otherwise make a temp branch
    and check that name on origin.
  - Clients never send `existingBranch` for the default branch: `git worktree add -b main` would
    collide with the clone's own checkout. 2.28 and 2.29 send a fresh launch from it instead.

**Tests.**

- `packages/contracts/src/orchestrationV2.test.ts`, extend "takes cloud only in the launch input
  and records a run old clients decode" (853): the cloud input carries `existingBranch: true` and
  decodes unchanged; `existingBranch: false` fails to decode; the recorded run has no key.
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`:
  - "fails a cloud launch's run when $name" (2613): new row "an existing branch was never pushed",
    `git: { hasCommit: ({ refName }) => Effect.succeed(refName === "refs/remotes/origin/main") }`,
    workspace `{ ...cloudWorkspace, branch: "feature/login", existingBranch: true }` (the table
    gains a `workspace` column defaulting to `cloudWorkspace`), reason
    `"feature/login is not on github.com/acme/app. Push feature/login first."`. It asserts no
    worktree was created. This row reaches the sandbox because the harness's `remoteHasBranch`
    answers true, the race where a branch disappears after launch. `makeHarness`'s
    `GitWorkflowService` mock (224–237) gains
    `remoteHasBranch: options.remoteHasBranch ?? (() => Effect.succeed(true))`.
  - "refuses a cloud launch for $name before any thread or machine" (2674): new row "a branch that
    isn't on origin". The table gains `git` and `workspace` columns; the row uses `cloudSettings`,
    `git: { readRemoteUrl: () => Effect.succeed(cloudRemote), remoteHasBranch: () =>
    Effect.succeed(false) }` and the same workspace, refusal `{ _tag: "CloudLaunchError", reason:
    "branch-not-pushed", branch: "feature/login", remote: "github.com/acme/app" }`. A second row,
    "an existing branch with no name", sends `existingBranch: true` without `branch` and is refused
    with `no-branch`.
  - "launches a cloud thread and releases it on runner hello" (2555) stays as is: without the key a
    missing branch still starts from `origin/main`.
- `apps/server/src/vcs/GitVcsDriverCore.test.ts`, describe "remote operations" (5960), new case "asks
  the remote whether a branch was pushed, not the local refs": push a branch to the bare remote from
  a second clone without fetching in `cwd`; `remoteBranchExists` says false, `remoteHasBranch` says
  true; an unknown branch gives false.

**Verify.** `vp test run packages/contracts/src/orchestrationV2.test.ts
apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts`;
`vp run typecheck` for contracts, client-runtime, server; `vp run check:changed`. The
`t3_thread_launch` description changed, so run the `mcp-tool-use` eval (evals/README.md). A short
runtime transcript: a `t3 thread` or MCP launch with `existingBranch` on an unpushed branch shows the
refusal and no thread.

**Reviewer checks.**

- The run union and `RunWorkspaceStrategy` (79) are unchanged.
- The launch-time check runs only for a new launch (`Option.isNone(launchReceipt)`), so a replay
  never re-asks GitHub.
- A git failure in the launch-time check never refuses the launch.
- The refusal message names the remote, and the branch name is passed after `--`.
- Surfaces: contracts, server, MCP (description and eval). Clients send the key from 2.28 and 2.29.
  CLI `--cloud` (cli/thread.ts 635) keeps fresh launches. Docs: none.

### 2.32 `feat(contracts): decode unknown thread historyOrigin values as absent`

`historyOrigin` reads a value it doesn't know as absent instead of failing the whole thread, so an
M2 client survives M3 adding an imported-history value. It is its own PR because it must ship in a
release before M3 does.

- **Needs:** M1. **Unblocks:** M3's history import.
- **Files:** `packages/contracts/src/orchestrationV2.ts`: `historyOrigin` on the app thread (514) and
  on the thread shell (2275) becomes `ForwardCompatibleOptional(OrchestrationV2ThreadHistoryOrigin)`
  (baseSchemas.ts 48). The Type stays `"native" | "v1_import" | undefined`, so the readers
  (Orchestrator.ts 1110, 2288; ProjectionStore.ts 1498, 1745, 2052; threadWorkflows.ts 102;
  AgentAwarenessRelay.ts 83) need no change.
- **Types and services:** none new.
- **Commands and events:** none.
- **Migrations:** none.

**Tests.** `packages/contracts/src/orchestrationV2.test.ts`, extend "reads a machine state or
admission reason from a newer server as unknown" (809), renamed "reads a machine state, admission
reason or history origin from a newer server as unknown". It decodes a shell
(`decodeThreadShellJson`) and an app thread (`decodeAppThreadJson`) with `historyOrigin:
"cloud_import"` and expects `historyOrigin` to be `undefined` (`ForwardCompatibleOptional` keeps
the key), and `"v1_import"` kept.

**Verify.** `vp test run packages/contracts/src/orchestrationV2.test.ts`; `vp run typecheck` for
contracts, server, client-runtime, web, mobile; `vp run check:changed`.

**Reviewer checks.**

- Both fields change, not only the shell.
- No reader compares against a value outside the two literals.
- Surfaces: contracts only. Every client decodes through it. No UI.

### 2.33 `fix(server): mount /runner/* only when a configured driver needs it`

This PR makes the member listener answer `/runner/*` only while some configured Docker driver dials
over TCP: a `runnerUrl`, a remote `DOCKER_HOST`, or the macOS Docker Desktop path. Machines on the
server's own Linux daemon dial the Unix socket, so on Pair Cloud's usual install the routes are 404
on the public listener and over T3 Connect. It is its own PR because it touches the server's route
composition.

- **Needs:** M1. **Unblocks:** 5.19 (moves the route to an internal listener).
- **Files:**
  - `apps/server/src/sandbox/runnerHub/RunnerRoute.ts`:
    - `layer` (17–118) becomes `layerWhen(mounted: Effect.Effect<boolean>)`, with `export const
      layer = layerWhen(Effect.succeed(true))` for the socket.
    - The connect (46) and bundle (81) handlers first run `if (!(yield* mounted)) return
      HttpServerResponse.empty({ status: 404 })`.
  - `apps/server/src/sandbox/runnerHub/RunnerEndpoint.ts`: the `RunnerEndpoint` service (90–98)
    gains `readonly dialsOverTcp: Effect.Effect<boolean>`.
    - In `make` (100), it reads `ServerSettingsService.getSettings` (orElse false) on every call.
    - It returns true when any `kind === "docker"` driver's `chooseRunnerRoute` (63–88), with the
      same inputs `planFor` uses (133–145), succeeds with `_tag: "url"`.
    - The socket's `listen` (114–131) keeps `RunnerRoute.layer`.
  - `apps/server/src/server.ts` `layerMakeRoutes` (881): replace `RunnerRoute.layer` with
    `Layer.unwrap(Effect.map(RunnerEndpoint.RunnerEndpoint, (endpoint) =>
    RunnerRoute.layerWhen(endpoint.dialsOverTcp)))`. The composition lives here because
    RunnerEndpoint already imports RunnerRoute, and the reverse import would be circular.
- **Types and services:** `RunnerRoute.layerWhen`, `RunnerEndpoint.dialsOverTcp`.
- **Commands and events:** none. **Migrations:** none.
- **Proposed gap answer.** The check runs per request, not once at startup, because an admin can add
  a `DOCKER_HOST` driver at runtime.

**Tests.**

- `apps/server/src/sandbox/runnerHub/RunnerRoute.test.ts`: new `it.live` "answers 404 on the member
  listener until a driver dials over TCP". It uses `layerWhen` over a `Ref<boolean>`: 404, then
  after the flip the same 400 or 401 as "answers 400, 426 and 401 without spending a secret, then
  upgrades and says hello" (58). `it.live` fits the existing network fixture.
- Which drivers dial TCP is `chooseRunnerRoute`, whose table (RunnerEndpoint.test.ts 40) already
  covers it. Add no second table.

**Verify.**

- `vp test run apps/server/src/sandbox/runnerHub/RunnerRoute.test.ts`.
- `vp run typecheck` for `apps/server`.
- `vp run check:changed`.
- Runtime transcript:
  - Linux local Docker: `curl -i <origin>/runner/v1/connect` returns 404 while a cloud thread still
    boots over the socket.
  - With a `runnerUrl` driver it returns 400 or 401.
  - On macOS dev it returns 400 or 401.

**Reviewer checks.**

- The socket listener stays ungated.
- No 404 leaks whether a driver exists beyond what `/api` already shows.
- `RunnerEndpoint`'s layer has `ServerSettingsService` where it is provided (server.ts 816–820).
- The macOS dev path keeps working.
- Connection modes: LAN, Tailscale and T3 Connect all hit the gated listener.

### 2.34 `feat(server,web): give webhook tasks a full URL without T3 Connect`

A server that has a public origin (Pair Cloud on a VM, a reverse proxy) reports a full webhook URL
in `ScheduledTask.webhook.url`, so the task editor, mobile, and agents that read tasks through MCP
all get one. Today `url` is non-null only with a T3 Connect tunnel. Its own PR because it touches
only scheduled tasks and the CLI, and wave 1 has room.

- **Needs:** M1. **Unblocks:** G2 step 9's webhook half on a server without a tunnel; 2.21's guide
  (Track E documents the flag).
- **Files:**
  - `apps/server/src/cli/config.ts`: add `publicUrlFlag = Flag.String("public-url")` with
    `Flag.withSchema(Schema.URLFromString)`, `Flag.optional`, beside `devUrlFlag` (50). Add
    `publicUrl: Config.URL("T3CODE_PUBLIC_URL")` (option, like `devUrl` at 140) to the env config,
    the flag record (220) and its interfaces (203, 215). Resolve flag over env as the other flags do.
    Refuse at startup a URL with a path other than `/`, a query or a fragment:
    "--public-url must be an origin, like https://pair.example.com."
  - `apps/server/src/config.ts`: `ServerConfig` gains `readonly publicUrl?: URL | undefined` beside
    `devUrl` (92), optional so hand-built test configs need no change; `layerTest` sets it to
    `undefined`.
  - `apps/server/src/scheduledTasks/ScheduledTaskService.ts`: rename `WebhookOrigin.relayHookBaseUrl`
    (100) to `hookBaseUrl` and add `relayed: boolean`. `ScheduledTaskWebhookOrigin` (118) default
    becomes `{ hookBaseUrl: null, relayed: false }`. `webhookEndpoint` (350) reads `hookBaseUrl` and
    sets `relayed` on the endpoint when the URL is non-null. `relayHookBaseUrl` (106) keeps its name;
    it still builds the relay base.
  - `apps/server/src/server.ts` `layerScheduledTaskWebhookOrigin` (590): read `ServerConfig.publicUrl`.
    A managed tunnel wins (`{ hookBaseUrl: relayHookBaseUrl(...), relayed: true }`), since it keeps
    "Hold webhooks while offline" working. With no tunnel and a `publicUrl`, return
    `{ hookBaseUrl: new URL(WEBHOOK_ROUTE_PREFIX, publicUrl).href, relayed: false }`
    (`WEBHOOK_ROUTE_PREFIX` (78) is `/api/hooks`). Otherwise `{ hookBaseUrl: null, relayed: false }`.
    That choice is the exported `webhookOrigin({ relayHookBaseUrl, publicUrl })` in
    `ScheduledTaskService.ts`, so the test drives it without the secret store.
  - `packages/contracts/src/scheduledTask.ts` `ScheduledTaskWebhookEndpoint` (220): add
    `relayed: Schema.optionalKey(Schema.Boolean)`.
  - `apps/web/src/components/settings/ScheduledTasksSettings.tsx` (1093): show
    `WebhookDeliveryMode` (1098) only when `endpoint.relayed === true`, or when `relayed` is absent
    and `url !== null` (an older server).
  - `packages/client-runtime/src/webhookAddress.ts` (10): the two notes for a null `url` (21, 29–30)
    say "Set the server's public URL or link T3 Connect for a public URL." Web and mobile both use it.
  - `docs/user/project-settings.md` (101–102): "A public URL needs a T3 Connect managed tunnel"
    becomes "a T3 Connect managed tunnel or a server started with `--public-url`". The flag itself
    goes in 2.21's operator guide.
- **Types and services:** `ServerConfig.publicUrl: URL | undefined`;
  `WebhookOrigin { hookBaseUrl: string | null; relayed: boolean }`;
  `ScheduledTaskWebhookEndpoint.relayed?: boolean`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.** A CLI flag and env var, not a settings field: the origin is fixed by how
  the server is deployed, like `--host`, and a settings field would need an admin UI and a
  per-request read. The tunnel wins when both exist. The webhook route already accepts direct
  requests (webhookRoute.ts 86–88 counts the relay's proof only when it verifies), so no route change.

**Tests.** `apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts`: extend
"gives webhook tasks a relay URL when the environment has a managed tunnel" (332) into a small table
over the origin layer's two inputs: tunnel only (relay URL, `relayed: true`), public URL only
(`https://pair.example.com/api/hooks/<task>/<token>`, `relayed: false`), both (relay wins), neither
(`url: null`). The helper's `relayHookBaseUrl` option (175, 255) becomes `hookBaseUrl` plus
`relayed`. `apps/server/src/cli/config.test.ts` (or the existing flag-resolution test there): one
row that `--public-url https://x/path` fails at startup.

**Verify.** `vp test run apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts
apps/server/src/cli/config.test.ts`; `vp run typecheck` for contracts, client-runtime, server, web,
mobile; `vp run check:changed`. Runtime transcript: start dev with `--public-url
https://example.test`, save a webhook task, show `scheduledTasks.list` returning the full URL.

**Reviewer checks.**

- A tunnel still wins, and hold-while-offline still shows for relay URLs.
- No origin is read from request headers (`Host`, `X-Forwarded-Host`); only the flag.
- Hit every surface: web and mobile (shared `webhookAddress`), MCP (agents read `webhook.url`),
  contracts (optional key), docs. Not providers, not connection modes, no reverse state.
- `VITE_HTTP_URL`/`VITE_WS_URL` are untouched (AGENTS.md rule 3).

### 2.35 `feat(server,mobile): push to Pair's one app build from any Pair Cloud`

This PR makes Pair ship one mobile build under its own store ids and EAS project, which any
self-hosted Pair Cloud can push to, and makes a cloud-only server push from its first member. It is
its own PR because it changes the install identifiers, which `decisions.md` holds fixed today.

- **Needs:** 2.22. **Unblocks:** G2's mobile checks.
- **Files:**
  - `apps/server/src/notifications/MemberPushNotifier.ts`:
    - Read `ServerConfig` and define `const pushes = config.cloudOnly ? Effect.succeed(true) :
      team.isTeamMode`.
    - Use it in `handle` (307–320) and `start` (324–329).
    - `send` keeps `shouldNotifyMember(notification, { memberId, teamMode: true })`
      (threadNotificationRouting.ts 36), so a single member hears their own agents.
  - `apps/server/src/ws.ts` (2010): advertise `memberPush` when `cloudOnly || isTeamMode`.
  - `apps/server/src/relay/AgentAwarenessRelay.ts` (519, 863): treat `cloudOnly` like team mode, so
    a cloud-only server linked to the relay never doubles a push with a Live Activity.
  - `apps/mobile/app.config.ts`:
    - The overrides block (22–27) gains `T3CODE_ANDROID_PACKAGE`, used at `android.package` (~318).
    - The existing `T3CODE_IOS_BUNDLE_ID`, `T3CODE_IOS_TEAM_ID`, `T3CODE_EAS_PROJECT_ID` and
      `T3CODE_EAS_OWNER` are unchanged.
  - `apps/mobile/eas.json`: add `pair-production` build and submit profiles whose `env` sets the five
    overrides to Pair's ids, plus Pair's `ascAppId`. `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` is an EAS
    file variable in Pair's project's production environment, as for T3's build, not a profile
    `env` entry, which would replace the file with a literal (without it app.config.ts 319–321 adds
    no `googleServicesFile`, and Android pushes can't register). The maintainer supplies the values,
    the EAS project has push access-token enforcement off, and Firebase/FCM is set up for Android.
  - `docs/product/decisions.md` "Identifiers and builds" (119–125): rewrite to say that Pair ships
    one build under its own ids, and that T3's ids stay for T3's builds.
  - `docs/operations/team-push.md` (13–31): replace the per-team build with "use Pair's app" and
    keep the override path for forks.
- **Types and services:** none new.
- **Commands and events:** none. **Migrations:** none.
- **Proposed gap answers.**
  - Universal links on app.t3.codes (associated domains asserted in app.config.test.ts 28) won't
    open Pair's build, so pairing links open in the browser until Pair has a domain. That is
    accepted for M2.
  - The ids are a maintainer input.

**Tests.**

- `apps/server/src/notifications/MemberPushNotifier.test.ts`: turn "sends nothing and reads nothing
  on a single-member server" (423) into an `it.effect.each` over `cloudOnly`. With false nothing is
  sent; with true the single member gets the completion push.
- `AgentAwarenessRelay.test.ts`: extend "publishes nothing for a completion on a team server" (520)
  with a cloud-only single-member row.
- `apps/mobile/app.config.test.ts`: beside "keeps the iOS and Android identifiers for
  APP_VARIANT=%j" (28), a case that the iOS and Android overrides replace both ids. It is its own
  case because that table also asserts app.t3.codes lists the id, which Pair's build isn't.

**Verify.**

- `vp test run` on the three tests.
- `vp run typecheck` for `apps/server` and `apps/mobile`.
- `vp run check:changed`.
- A device pass on Pair's preview build: register against a cloud-only dev server with one member;
  a cloud thread's completion arrives as a push.

**Reviewer checks.**

- No push is sent on a solo non-cloud-only server (today's behavior).
- The relay publishes nothing on cloud-only.
- No T3 identifier changes for the default build.
- The docs no longer tell a team to build its own app.
- Surfaces: mobile registration (`memberPushEnvironments`, memberPushRegistration.ts 86) keys on the
  advertised `memberPush`; desktop and web are unaffected.

### 2.36 `ci: publish versioned Pair Cloud server releases with the runner tree`

A tag `v<version>` on `rutvikchandla3/pair` publishes a GitHub release with `t3-<version>-linux-x64.tar.gz`,
`t3-<version>-linux-arm64.tar.gz`, `SHA256SUMS` and `install.sh`, beside the sandbox image of the
same version. Each archive is the CLI archive format plus a `runner/` tree from the same
`runner-<id>` artifact the image bakes in, and the `t3` inside it serves that tree to machines.
`T3CODE_VERSION=<version> T3CODE_RELEASE_BASE_URL=https://github.com/rutvikchandla3/pair/releases/download`
installs it. Its own PR because decision #1 fixes the release form and every later gate installs
from it.

- **Needs:** M1 (the sandbox image workflow). **Unblocks:** 2.21, G2, and the next release G2
  step 10 upgrades to.
- **Files:**
  - `apps/server/src/sandbox/runnerHub/RunnerBundle.ts`:
    - `RunnerBundleUnavailableError` (39): reasons become `["not-bundled", "build-failed"]`.
      `not-bundled` says "This server was built without a runner tree, so it cannot start cloud
      machines. Install a Pair Cloud release." `single-executable` goes away.
    - `readReleased` (140) becomes `readReleased(directory: string)`: no `IsExecutable` check; if
      `<directory>/MANIFEST.json` (`RUNNER_MANIFEST_FILE`, 20) is missing, fail `not-bundled`;
      otherwise `fromTree(directory)` (114) as today.
    - `layer` (224) passes `path.join(import.meta.dirname, "runner")`. In the executable,
      `import.meta.dirname` is the executable's own directory; that is how `resolveStaticDir`
      (apps/server/src/config.ts 269) finds `client/` and `ResourceMonitorBinary.ts` (167) finds
      `resource-monitor/`. In `dist/bin.mjs` it is `dist/`, so the npm layout keeps working.
    - New export `layerFromTree(directory: string)`: `Layer.effect(RunnerBundle, make(readReleased(directory)))`,
      for the release smoke and 2.40's `--runner-dir`.
    - The four tests that construct `"single-executable"` switch to `"not-bundled"`:
      DockerComputeDriver.contract.test.ts (110), DockerComputeDriver.test.ts (323),
      SandboxBootstrapSource.test.ts (58), RunnerEndpoint.test.ts (137).
  - `apps/server/src/sandbox/compute/DockerComputeDriver.ts`: the Engine API client moves from
    `NodeHttpClient.makeUndici` to `makeAgent` + `makeNodeHttp`. `makeUndici` kept a static
    `import "undici"` in the executable bundle, which `build-exe`'s import check rejects (a single
    executable imports only builtins), so no archive could be built.
  - `scripts/build-cli-archive.ts`: a `--runner-dir` flag beside `--resource-monitor-dir` (623).
    `buildCliArchive` (494) copies the tree to `<root>/runner/`, keeping exec bits, and fails
    when `MANIFEST.json` is missing. Optional, so the upstream desktop release (release-desktop.yml
    410–438) builds the archive it builds today.
  - `scripts/smoke-cli-archive.ts`: an optional `--expect-runner` flag. With it,
    `smokeCliArchive` (61) adds `runner/MANIFEST.json`, `runner/runner.mjs` and the node-pty
    prebuild for the archive's arch to the layout check (101–112). The serve probe (141–193) does
    not ask `/runner/*`: it runs with an empty home and no driver, so after 2.33 the route answers 404. `runner-release-smoke.ts` below proves the tree instead.
  - Add `apps/server/scripts/runner-release-smoke.ts` (**proposed**). Flag `--runner-dir <dir>`.
    It builds the route stack runner-benchmark.ts's `program` (607) builds (`RunnerRoute.layer`,
    `RunnerHub.layer`, `RunnerGrants.layer`, `SqlitePersistence.layerMemory`, on `NodeHttpServer`
    port 0), with `RunnerBundle.layerFromTree(dir)`. Then it does what `pair-bootstrap.sh` does:
    `hub.mintEnrollment(sandboxId, 1)`; fetch `/runner/v1/bundle/<id>.sha256` and `.tar.gz` with
    `Authorization: Bearer <secret>`; check the digest; untar to a temp dir; write the secret to
    `<stateDir>/enroll`; spawn `node <dir>/runner.mjs runner` with the `PAIR_*` env startRunner
    (332) uses; await `hub.connection(sandboxId)`; run `echo ok` through it; exit 0. A script, not
    a test: it needs the built tree and runs in CI after the archive exists.
  - `.github/workflows/sandbox-image.yml` (display name "Pair Cloud release"; the path stays):
    - New job `archive` (needs `bundle`, 95), matrix `linux-x64` on `ubuntu-24.04` and
      `linux-arm64` on `ubuntu-24.04-arm`. It must be native because node-pty compiles from
      source (release.yml 679–702). Steps copied from release-desktop.yml: resource monitor
      `cargo build` for `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu` (257–260) and its
      staging (388–399); `vp run --filter t3 build`, then `node apps/server/scripts/cli.ts build-exe --verbose`
      (348–355) with `T3CODE_TELEMETRY_CHANNEL=dev` and the public relay/Clerk values read from
      `.env.example` the way release.yml's preview branch does (473–479); patchelf (404–408). Then
      download `runner-<id>` (the bundle job's upload, 144–149) and untar it to `$RUNNER_TEMP/runner`.
      Then `build-cli-archive.ts --platform linux --arch <arch> --version <version> --resource-monitor-dir … --runner-dir "$RUNNER_TEMP/runner" --output-dir release-cli`,
      then `smoke-cli-archive.ts --archive release-cli/* --expect-version <version> --expect-runner`,
      then `runner-release-smoke.ts --runner-dir <extracted>/runner`. Upload `pair-cli-linux-<arch>`.
    - New job `release` (needs `bundle`, `manifest` (244) and `archive`; only on a tag push;
      `permissions: contents: write`). It downloads both archives, writes `SHA256SUMS` with
      `sha256sum t3-*.tar.gz`, copies `scripts/install.sh`, and runs `gh release create "v$VERSION" --verify-tag`
      with the four files. It refuses when the release exists (`gh release view` succeeds), like
      the manifest job's existing-tag refusal (275). Needing `manifest` means no release appears
      before its image.
    - On `workflow_dispatch` (dry run) there is no release. The same four files upload as the
      artifact `pair-cloud-release-<tag>`, where `<tag>` is planRelease's dry-run tag (206).
  - `packages/shared/src/cliRelease.ts`: `cliReleaseIndexPageUrl` (134) takes an optional
    `repository` (default `CLI_RELEASE_REPOSITORY`, 6). New `cliReleaseRepositoryOf(baseUrl)`
    parses `https://github.com/<owner>/<repo>/releases/download[/]` and returns `owner/repo`, or
    `undefined` for any other base.
  - `apps/server/src/cli/update.ts`:
    - `resolveNewestVersion` (65) takes the resolved base URL (`resolveNewestVersion(channel, releaseBaseUrl)`):
      with one, list that repository's releases. A base that is not a GitHub releases URL fails with "Name the version:
      `t3 update <version>`. `<base>` has no release list."
    - `runUpdate` (349): with no base URL in the shell, read `T3CODE_RELEASE_BASE_URL` from
      `service.env` through `readServiceEnv` (cli/service.ts 66), for both the lookup and the
      download (505). An admin's shell rarely carries the service's env.
  - `docs/operations/release.md` "Sandbox base image" (467): becomes "Pair Cloud release". It
    covers the version scheme, bumping with `node scripts/update-release-package-versions.ts <version>`
    (its `version` argument, 150), tagging, what the workflow publishes, and the dry run.
- **Types and services:** `RunnerBundleUnavailableError.reason: "not-bundled" | "build-failed"`;
  `RunnerBundle.layerFromTree(directory)`; `cliReleaseRepositoryOf(baseUrl): string | undefined`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - Version scheme `<upstream>-pair.<n>`, set in a release commit by
    `update-release-package-versions.ts`, so web, desktop and server agree.
  - The release ships `install.sh` (upstream serves it from t3.codes). Its default `repo` (20)
    stays upstream; the base URL overrides it (21).
  - Linux only. macOS and Windows Pair Cloud hosts are out of scope for M2.

**Tests.**

- `apps/server/src/sandbox/runnerHub/RunnerBundle.test.ts`: new case "serves a released tree from
  any directory, and calls a missing tree not-bundled". One temp tree with a `MANIFEST.json`, built
  like `layerTest` (237) builds one: `layerFromTree` reports its `runnerBuildId` and digest. An
  empty directory fails with `reason: "not-bundled"`. Fails on `main`: `layerFromTree` does not
  exist and the old reason does.
- `packages/shared/src/cliRelease.test.ts`: extend "picks the newest non-draft release on the
  requested channel" (28) with a `0.1.7-pair.2` row (Stable, newer than `0.1.7-pair.1`). New case
  "names the repository a GitHub releases base URL points at": rows for the fork's base, a trailing
  slash, a non-GitHub mirror (`undefined`).
- `apps/server/src/cli/update.test.ts`: extend "authenticates each release page until the requested
  channel is found" (48) with a row where `T3CODE_RELEASE_BASE_URL` names the fork. The requested
  pages are the fork's. New case "reads the release base URL from service.env when the shell has
  none": the download URL uses the fork's base.

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerBundle.test.ts packages/shared/src/cliRelease.test.ts apps/server/src/cli/update.test.ts`
plus the four switched test files; `vp run typecheck` for `@t3tools/shared` and `t3`;
`vp run check:changed`. A dry run on the fork (`workflow_dispatch` with the version), with the
run's link and the smoke logs. One real tag push before G2, with the release page link. A runtime
transcript of `install.sh` on the VM: `t3 --version` prints the version, and `ls` of
`~/.t3/runtime/versions/<v>/runner`.

**Reviewer checks.**

- No path in `RunnerBundle.ts` still branches on `IsExecutable`, and `dist/bin.mjs` still finds
  `dist/runner`.
- The archive's runner tree comes from the bundle job's artifact, not a second `build-runner`, so
  its `runnerBuildId` equals the image's.
- The release job needs `manifest`, and refuses an existing release.
- A dry run publishes no GitHub release and no tag.
- `t3 update` with no version on a fork install never asks pingdotgg's API.
- Hit every surface: connection modes and docs apply (release.md; 2.21 links it). Clients,
  providers, contracts and MCP do not.

### 2.37 `feat(server): drain Pair Cloud before an upgrade`

An admin runs `t3 drain` before an upgrade. New turns on cloud threads and new machines wait
(decision #5), and running turns get up to 15 minutes to finish. The command then returns, and
the guide's next step restarts onto the new release. Everything that waited starts after the
restart. A turn still running continues through `RestartContinuation.ts` ("Continue where you
left off"). Members see one line saying why their turn waits. Its own PR because it is an
operator switch that touches admission, prompt gating and a CLI.

- **Needs:** 2.1 (same sweep and decider files). **Unblocks:** 2.21's upgrade steps, G2 step 10.
- **Files:**
  - New `apps/server/src/drain/ServerDrain.ts`:
    ```ts
    export interface DrainState {
      readonly since: DateTime.Utc;
      readonly actorId: MemberId | null;
    }
    export class ServerDrain extends Context.Service<
      ServerDrain,
      {
        readonly current: Effect.Effect<DrainState | null>;
        readonly changes: Stream.Stream<DrainState | null>; // SubscriptionRef
        readonly start: (actorId: MemberId | null) => Effect.Effect<DrainState>; // idempotent
        readonly cancel: Effect.Effect<void>;
        /** Emits on start and on each run change; completes when no turn is running. */
        readonly watch: Stream.Stream<ServerDrainStatus, ProjectionStoreV2Error | EventSinkV2Error>;
      }
    >()("t3/drain/ServerDrain") {}
    ```
    The state is in memory only. A restart ends the drain, and that is what releases the work.
    `watch` re-reads `ProjectionStoreV2.countRunningRuns()` (new: `SELECT COUNT(*) FROM
    orchestration_v2_projection_runs WHERE status IN ('starting','running','waiting')`, table
    from `055_OrchestrationV2.ts` 73) on each `run.updated` from the orchestrator's event stream.
    It reads only while a drain is active, so the unindexed status count costs nothing otherwise.
  - `packages/contracts/src/server.ts`:
    - `ServerDrainStatus = Struct({ since: DateTimeUtc, runningTurns: NonNegativeInt })`.
    - `ServerConfig` (610) gains `drainingSince: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))`.
      `ServerConfigUpdatedPayload` is unused, so the config stream gains a `drainUpdated` event
      (`{ drainingSince }`) from `ServerDrain.changes`. Older clients reject an unknown event type,
      so it is sent only to subscribers that pass `drainUpdates: true`, as client-runtime does.
  - `packages/contracts/src/rpc.ts`: `serverDrain: "server.drain"` (stream, payload `{}`, success
    `ServerDrainStatus`) and `serverCancelDrain: "server.cancelDrain"` (void).
    `apps/server/src/auth/RpcAuthorization.ts` (84–86) and `CLIENT_GUARDED_RPC_SCOPES` (18):
    `AuthEnvironmentMaintainScope` for both. `ws.ts`: `serverDrain` is
    `Stream.unwrap(drain.start(memberId).pipe(Effect.as(drain.watch)))`, and `serverCancelDrain`
    is `drain.cancel`.
  - `packages/contracts/src/sandbox.ts` `SandboxAdmissionReason` (83): add `"draining"`. This is
    safe because no Pair release exists until G2 tags V1 after every M2 row has merged (2.36 lands
    only the workflow), so no installed client has the old union. The shell already decodes the reason with
    `ForwardCompatibleNullable` (`OrchestrationV2ThreadShellSandbox`, orchestrationV2.ts 2241).
  - `apps/server/src/sandbox/lifecycle/SandboxAdmission.ts`: `AdmissionSnapshot` gains
    `draining: boolean`, filled from `ServerDrain.current` in `snapshot`.
  - `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`:
    - `admissionWait` (100): `snapshot.draining` gives `{ reason: "draining", since: now }` before
      the cap check. Wakes and provisions then wait as at a cap.
    - `decideCloudPrompt` (200): when `input.admission?.draining` and the record is `ready`, return
      `{ _tag: "Defer", workspaceStrategy: undefined, wake: null }`. The run parks in `preparing`,
      as on a provisioning machine. `gateCloudMessage` (Orchestrator.ts 11037) reads the snapshot
      before its `record.state === "ready"` early return. It reads under the same lock, and only
      for cloud threads.
  - `apps/server/src/sandbox/lifecycle/SandboxLifecycleWorker.ts`:
    - `admitWaiters` (114) returns `{ admitted: 0, nextDueMs: Infinity }` while draining.
    - New rule in `sweep` (151), when not draining: for a ready sandbox whose attached shells show
      `activityRunStatus === "preparing"` (orchestrationV2.ts 2285), read the runs and dispatch
      `prepared-run.release` for each `preparing` run with no `workspacePreparation`. The id is the
      one `releaseWaiters` uses, `sandbox-release:<runId>:<generation>` (SandboxEffects.ts 259),
      so the two dedupe.
    - A cancel sends no domain event, so the first sweep after a drain ends runs even when its
      `DueHint` is idle, and releases work on that tick. (A subscription to `ServerDrain.changes`
      would invalidate the hint on another fiber, after the tick it was meant for.)
    - `sandbox.admit` refuses `no-capacity` while draining, and `releaseWaiters`
      (SandboxEffects.ts) skips plain releases on a machine that turns ready during a drain; the
      sweep releases those after it.
  - `apps/server/src/cloud/selfUpdate.ts`: `ServerSelfUpdate.update` calls `drain.start(null)`
    before the boot service's hand-off. It does not wait. The Settings update button then holds
    new cloud turns through the install and restart. A refused hand-off cancels the drain it
    started, never one an admin started before it.
  - New `apps/server/src/cli/drain.ts`: `t3 drain [--timeout 15m] [--cancel]`, registered in
    `binCli.ts` beside `updateCommand`. It connects like `connectLiveTeam` (`cli/member.ts` 86) and
    reads `server.drain`, printing "Draining: N turns running" on each status. It exits 0 when
    `runningTurns` reaches 0. At the timeout it exits 0 with "N turns still running; they continue
    after the restart." `--cancel` calls `server.cancelDrain`.
  - Client: `packages/client-runtime/src/state/sandbox.ts`. The admission labels (77–79) gain
    `draining` ("Waiting: Pair Cloud is restarting for an upgrade"). A pure
    `drainNoticeLabel(drainingSince)` ("Pair Cloud is restarting for an upgrade. New turns start
    when it's back."). Web shows it above the composer of a cloud thread, and in Settings → Cloud
    (`CloudSettings.tsx` 228) with **Cancel drain** for admins (`server.cancelDrain`). Mobile shows
    the same line on the thread screen.
- **Types and services:** `ServerDrain`, `DrainState`, `ServerDrainStatus`,
  `ProjectionStoreV2.countRunningRuns`, `AdmissionSnapshot.draining`, `drainNoticeLabel`.
- **Commands and events:** none new. Parked runs reuse `prepared-run.release`. Drain is server
  state, not domain state.
- **Migrations:** none.
- **Proposed gap answers.**
  - The bound is the CLI's `--timeout` (default 15 minutes). The server drain has no deadline and
    ends on restart or cancel.
  - Local threads on a non-cloud-only server are not held. A cloud-only server (2.22) has none,
    and holding them would need a second parking path. `runningTurns` counts them, so the admin
    sees them.
  - Drain sets no `stoppedBy`, because it stops no machine (agreed with Track D).

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts`:
  - `decideSandboxCommand` rows: "wake while draining waits as draining" (`admission.reason`
    `draining`).
  - `describe("decideCloudPrompt")` (579): "a prompt on a ready machine waits while draining" gives
    `Defer` with `wake: null`; the not-draining ready row still gives `Send`.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: new case "a drain holds a prompt
  on a ready machine and releases it after". Provide a `ServerDrain` test layer. Start the drain
  and send a prompt: the run is `preparing` and no `provider-turn.start` is enqueued. Cancel and
  `sweep()`, then drain the worker: the run is released once. A restart reads the same as a
  cancel, because state is in memory.
- Same file, extend "two threads at one free slot admit one" (1388) with a draining variant:
  nothing is admitted while draining, and the queue moves after cancel.
- `apps/server/src/drain/ServerDrain.test.ts`: new case "watch reports running turns and completes
  at zero". `it.effect`, fake `countRunningRuns` driven by a `Queue` of `run.updated` events.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts
apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts apps/server/src/drain/ServerDrain.test.ts`;
`vp run typecheck` for `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web`,
`apps/mobile`; `vp run check:changed`. Runtime transcript on the worktree dev server (Replay
provider, Docker driver): `node apps/server/src/bin.ts drain --timeout 1m` while a Replay turn
runs. It shows the countdown. A second thread's prompt waits with the notice. Then stop the dev
server by its tracked PID and restart it: the waiting turn starts. Capture the web notice.

**Reviewer checks.**

- Drain never stops a machine or interrupts a turn. Only the restart does.
- A held prompt parks in `preparing` with no start effect, so process-loss recovery
  (`reconcileAfterProcessLoss`, EffectOutbox.ts 534) has nothing to cancel.
- The release rule skips runs with `workspacePreparation`. `releaseWaiters` re-arms those.
- `"draining"` is decoded forward-compatibly on the shell. The record schema stays strict, which is
  fine while no release is tagged (before G2).
- Surfaces: entry points (CLI, Settings → Cloud cancel, the self-update RPC); clients (web, mobile
  label); contracts; reverse state (cancel, and restart ends it; the notice shows it); connection
  modes (the CLI runs on the server host, as `t3 member` does). Docs: 2.21 owns the upgrade steps.

### 2.38 `feat(server): keep live machines when Pair Cloud restores an older snapshot`

Restore mode stops the reconciler from destroying anything. It turns on from a startup flag the
guide's restore steps pass, or by itself when a machine tagged with this install has no record
at all. While it is on, a machine with no record, a `destroyed` record, or a stray backend is
stopped and listed in Settings → Cloud. An admin leaving restore mode is the confirmation (04 §5,
D11). Its own PR because it is the one guard between a restored database and lost work.

- **Needs:** M1. **Unblocks:** 2.21's restore steps, G2 step 11.
- **Files:**
  - `packages/contracts/src/settings.ts`:
    - `SandboxSettings` (1216) gains `restoreModeSince: Schema.optionalKey(Schema.DateTimeUtc)`.
    - The sandbox patch in `ServerSettingsPatch` (1767) gains
      `restoreModeSince: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))`.
    - `packages/shared/src/serverSettings.ts` `mergeSandboxPatch` (237) merges it with `patched`,
      and counts it in the "no key" check (255).
  - `apps/server/src/cli/config.ts`: `--restore-mode` flag and `T3CODE_RESTORE_MODE` env, built
    like `noBrowserFlag` (55), into the server config booleans (`apps/server/src/config.ts`
    95–107) as `restoreMode`. At startup, when set and `restoreModeSince` is absent, the server
    writes `restoreModeSince: now` to settings before the reconciler's first pass. The scheduler
    starts sources after startup recovery (SandboxReconciler.ts `layer`, 294).
  - `apps/server/src/sandbox/lifecycle/SandboxReconciler.ts`:
    - `ReconcileAction` (31) gains `{ _tag: "StopOrphan" }`.
    - `planReconciliation(record, backend, now, restoreMode)` (86). In the
      null/destroyed/failed-for-good branch, restore mode returns `isRunning(backend) ?
      StopOrphan : keep`, with no grace check. Every other branch is unchanged, so records still
      follow their backends.
    - `execute` (161): `StopOrphan` is handled in the first switch, beside `DestroyBackend`, with
      `callDriver(driver.stop(...))`. No record lock is needed, because no live record uses this
      backend.
    - `reconcileDriver` (238): `restoreMode` is the settings' `restoreModeSince !== undefined`. If
      it is off and a listed backend older than `ORPHAN_GRACE_MS` (45) has a `sandboxId` with no
      record in `records` (the map already includes destroyed records via `getSandboxes`), write
      `restoreModeSince: now`. A younger one may be a create whose record hasn't committed yet,
      so it never turns restore mode on. Nor does a sandbox id the last restore-mode pass listed:
      leaving restore mode confirmed it, so the next pass destroys it instead of turning restore
      mode back on (a restart forgets the list, so it is listed again). Then log a
      warning naming the sandbox ids, and plan this pass in restore mode. After the pass, record
      the listed machines: pairs whose record is null, destroyed or failed for good, with a
      backend that is not `missing`.
  - New `apps/server/src/sandbox/lifecycle/SandboxRestoreMode.ts`. It holds the last pass's list
    per driver in a `Ref`, and the reconciler and the overview share it:
    ```ts
    export class SandboxRestoreMode extends Context.Service<
      SandboxRestoreMode,
      {
        readonly record: (
          driverId: ComputeDriverId,
          machines: ReadonlyArray<SandboxRestoreModeMachine>,
        ) => Effect.Effect<void>;
        readonly machines: Effect.Effect<ReadonlyArray<SandboxRestoreModeMachine>>;
      }
    >()("t3/sandbox/SandboxRestoreMode") {}
    ```
  - `packages/contracts/src/sandbox.ts`:
    - `SandboxRestoreModeMachine = Struct({ sandboxId: SandboxId, driverId: ComputeDriverId,
      createdAt: DateTimeUtc, hasRecord: Boolean })`.
    - `SandboxOverview` (139) gains `restoreMode: Schema.optionalKey(Schema.Struct({ since:
      DateTimeUtc, machines: Schema.Array(SandboxRestoreModeMachine) }))`. It holds ids, a driver
      id and a time, and no host value, so the overview stays member-readable.
  - `apps/server/src/sandbox/lifecycle/SandboxOverview.ts`: fill `restoreMode` from settings and
    `SandboxRestoreMode.machines`.
  - Web: `apps/web/src/components/settings/CloudSettings.tsx` (228) gets a "Restore mode" section
    when `overview.restoreMode` is set. It shows "Restore mode since 14:02. Nothing is destroyed
    while it is on." and one row per machine: id, driver, created, and "no record" or "discarded".
    Admins (settings write permission) get **Leave restore mode**. A confirm dialog says "Machines
    without a record are destroyed at the next check, within 10 minutes. Copy any work off them
    first." Then
    it writes `{ sandbox: { restoreModeSince: null } }`. Members see the first line only. Mobile:
    the worker checks for a Settings → Cloud screen in `apps/mobile/src`. If there is none, mobile
    shows nothing, and admins use web.
- **Types and services:** `ReconcileAction.StopOrphan`, `SandboxRestoreMode`,
  `SandboxRestoreModeMachine`, `SandboxOverview.restoreMode`, `SandboxSettings.restoreModeSince`,
  server config `restoreMode`.
- **Commands and events:** none. Leaving is a settings write.
- **Migrations:** none.
- **Proposed gap answers.** The switch lives in settings, so it survives restarts until an admin
  leaves. The flag only turns it on. Strays of a live record are covered too: after a restore, a
  newer generation's container pairs as a stray. A restored `sleeping` record whose machine was
  woken since is still stopped by the normal `StopBackend` (harmless, 04 §5).

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxReconciler.test.ts` `rows` (72–149): each row gains
  `restoreMode: false`, and the `planReconciliation` call (151) passes it. New rows: "restore mode,
  no record, running" gives `StopOrphan`; "restore mode, destroyed with an old backend" gives
  `StopOrphan`; "restore mode, a stray of a record that holds another ref" gives `StopOrphan`;
  "restore mode, no record, stopped" gives `Keep`; "restore mode, ready and stopped" gives
  `ReportStopped`.
- Same file, new case "turns restore mode on for a tagged backend with no record, and destroys
  nothing", beside "lists backends on activation, then every 10 minutes" (206). The fake driver
  lists one unrecorded running backend 60 minutes old. One pass sets `restoreModeSince`, the fake
  sees `stop` and never `destroy`, and `SandboxRestoreMode.machines` lists it. After the setting is
  cleared and `TestClock.adjust` passes 10 minutes, the next pass destroys it. A second row: an
  unrecorded backend 1 minute old leaves restore mode off and is kept.
- `packages/shared/src/serverSettings.test.ts`: extend the sandbox patch case with
  `restoreModeSince` set, then null.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxReconciler.test.ts
packages/shared/src/serverSettings.test.ts`; `vp run typecheck` for `packages/contracts`,
`packages/shared`, `apps/server`, `apps/web`; `vp run check:changed`. Runtime transcript in the
worktree (never `~/.t3`): start a Docker machine, stop the dev server by its PID, restore the
worktree's `statev2.sqlite` from a copy taken before the machine existed, and start with
`--restore-mode`. `docker ps -a` shows the container stopped, not removed. Capture Settings →
Cloud listing it, and after **Leave restore mode** the next pass removes it.

**Reviewer checks.**

- No code path destroys while `restoreModeSince` is set, the startup pass included.
- Auto-enable triggers only on a sandbox id with no record. A stray of a live record does not
  turn it on.
- `StopOrphan` never runs against a backend whose record is live.
- Leaving goes through the normal plan: the next pass (within 10 minutes) destroys strays older
  than `ORPHAN_GRACE_MS`, which counts from each backend's `createdAt`.
- Surfaces: entry points (flag, auto, Settings → Cloud); clients (web; mobile only if it has a
  Cloud screen); contracts; reverse state (leave restore mode); docs (2.21's restore steps name
  `--restore-mode`).

### 2.39 `perf(server): give runner-bound effects their own lane and time bounds`

Effects that wait on a machine run in four slots of their own, beside the four shared ones, so
four slow machines no longer stall every thread's effects, sandbox lifecycle included. The
replay-safe ones also get a time bound and take the normal retry path when they hit it. Local
threads see no change: their effects are never runner-bound. Its own PR because it changes the
claim query, the hottest SQL in the server.

- **Needs:** M1 (after 2.4: same files). **Unblocks:** 2.40.
- **Files:**
  - `apps/server/src/orchestration-v2/EffectOutbox.ts`:
    - Beside `PROCESS_BOUND_EFFECT_TYPES` (185), add `RUNNER_BOUND_EFFECT_TYPES = ["provider-turn.start",
      "provider-turn.restart", "provider-runtime.continue", "provider-thread.rollback",
      "checkpoint.capture", "terminal.cleanup"]` and `EFFECT_LANE_SLOTS = 4`.
      `provider-turn.interrupt`, `provider-turn.steer` and `runtime-request.respond` stay shared,
      so a stop or an answer never queues behind a slow machine.
    - `claimableCandidatePredicate` (361): add a lane clause. A row is runner-bound when its type
      is in the list and its thread is on a sandbox:
      ```sql
      -- runnerBound(x): x.effect_type IN (...) AND EXISTS (SELECT 1 FROM
      --   orchestration_v2_projection_sandbox_threads AS st WHERE st.thread_id = x.thread_id)
      -- running(lane): SELECT COUNT(*) FROM orchestration_v2_effect_outbox AS busy
      --   WHERE busy.status = 'running' AND [NOT] runnerBound(busy)
      AND CASE WHEN runnerBound(candidate) THEN running(runner) ELSE running(shared) END
          < ${EFFECT_LANE_SLOTS}
      ```
      `runnerBound` and `running` are small `sql` fragment functions. The two counts do not
      reference the candidate, so SQLite runs each once per statement (`SCALAR SUBQUERY`, not
      `CORRELATED`), instead of once per candidate row. They read running rows through
      `orchestration_v2_effect_outbox_claim_idx` (Foundation.ts 119, `status` first). The join uses
      `idx_sandbox_threads_thread` (088). Because `nextClaimableAt` (599) uses the same predicate, a
      full lane reports nothing claimable for that lane. The worker sleeps to the liveness poll and
      wakes on the `notifyAvailable` that `succeed` sends (641), instead of spinning.
  - `apps/server/src/orchestration-v2/EffectWorker.ts`:
    - `DEFAULT_EFFECT_WORKER_CONCURRENCY` (963): 8, that is `2 * EFFECT_LANE_SLOTS`.
    - `EFFECT_TIMEOUTS` (646): add `checkpoint.capture: 10 min`, `provider-thread.rollback: 10 min`,
      `terminal.cleanup: 60 s`. These are the final values, and 2.39 owns them (2.40's load test
      does not time these effects): each is far above a healthy run, so a hit means the call hung,
      not that it was slow. `provider-turn.start`, `provider-turn.restart` and
      `provider-runtime.continue` stay unbounded, because a timeout midway would retry a
      half-started turn. The table `satisfies` a record keyed by
      `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`, so a bound on a process-bound type fails to
      compile. The bounds apply to local threads too; 10 minutes is far past any local capture,
      and a retry beats a stalled thread queue.
    - A timeout interrupts the execution, so the rollback arm's "last attempt failed" report
      (`checkpoint.rollback.fail`, which sets `rollbackFailure`) never saw a timed-out last attempt.
      That report moves to the executor's `reportExhausted`, which the worker calls after every
      last attempt, timeout included.
- **Types and services:** `RUNNER_BOUND_EFFECT_TYPES` (module-private until another file needs it),
  `EFFECT_LANE_SLOTS`.
- **Commands and events:** none.
- **Migrations:** none. The lane comes from the 088 membership table at claim time, so no
  outbox column and no enqueue-site change.
- **Proposed gap answers.** Four runner slots (04 §4 gives no number). The title lane's
  same-thread exemption (390–396) is unchanged. Lanes split worker slots, not per-thread order.

**Tests.**

- `apps/server/src/orchestration-v2/FoundationPersistence.test.ts`: new case "gives runner-bound
  effects four slots of their own beside the shared four", using `layerEffectOutboxProvided`.
  Insert five `orchestration_v2_projection_sandbox_threads` rows. Enqueue a `provider-turn.start`
  on each of those five threads, and a `checkpoint.capture` and a `provider-turn.interrupt` on two
  local threads. Claim: four starts claim, the fifth does not, the local capture and the interrupt
  still claim, and `nextClaimableAt` reports no time for the fifth. `succeed` one start, and the
  fifth claims.
- Make "runs distinct threads concurrently while serializing effects within a thread" (2325) a
  table with a cloud row: a runner-bound effect and a shared effect on the same cloud thread
  still run one at a time in rowid order (lanes do not split a thread).
- `apps/server/src/orchestration-v2/EffectWorker.test.ts`: "reports a rollback blocked by $name
  only after the last attempt" runs through the worker, with a row for a restore that never
  returns: its timed-out last attempt still reports the failure.

**Verify.** `vp test run apps/server/src/orchestration-v2/FoundationPersistence.test.ts
apps/server/src/orchestration-v2/EffectWorker.test.ts`; `vp run typecheck` for `apps/server`;
`vp run check:changed`. Runtime: `EXPLAIN QUERY PLAN` on the claim statement against a copied dev
database (`vp run migrate-dev-db` into the worktree's `.t3`, never `~/.t3`). Paste it to show both
subqueries use indexes.

**Reviewer checks.**

- Per-thread order is unchanged: the `NOT EXISTS` blocking clause is untouched.
- A full runner lane makes `nextClaimableAt` return none for those rows, so the daemon does not
  spin at the 25 ms floor (EffectWorker.ts runDaemonWithOptions, 966).
- No bound on a process-bound type, and every bounded type is in
  `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS` (163).
- A local server's claim does the same work plus one cheap `EXISTS` against an empty table.
- Surfaces: server-only. Performance is the point: watch the claim's cost in the PR.

### 2.40 `perf(server): load-test 30 machines and bound bytes per sandbox`

`vp run bench:runner --load` runs 30 loopback runners against one in-process hub: one saturating a
PTY, one streaming the runner bundle download, and 28 emitting timestamped lines. It reports
whether the quiet runners' p95 stdout latency rises. The hub gains a per-sandbox ingress byte
budget, so one machine's output can't take the event loop from the rest (03 §9 "Capacity"). M1's
two misses are met or restated: PTY throughput 41 against 50 MB/s, server CPU 25 against 5 ms per
MB. Its own PR because the target (30 machines, 03 §9) is proven by this test.

- **Needs:** 2.39 (the lanes the test runs with; see PR-list changes), 2.43 (a cap above the VM's
  default). **Unblocks:** G2 step 12.
- **Files:**
  - `apps/server/scripts/runner-benchmark.ts`:
    - `BUDGET` (47): `cpuMsPerMB: 5` becomes `cpuOverheadMsPerMB: 5`, compared as runner minus
      local (03 §9 says restate it as overhead). `throughputMBps` stays 50 unless the profile
      below shows the gap is the window (256 KiB per round trip). Then restate it with the
      measured number and that reason.
    - New flag `--load` on `cli` (686). After the normal rows, `loadTest(harness)` starts
      `LOAD_RUNNERS = 30` loopback runners with `startRunner` (332).
      1. Baseline: all 30 quiet, each echoing a stamped line every 50 ms for 20 s. Record p50/p95
         line latency over the quiet runners.
      2. Load: runner 1 runs `ptyThroughput` (260) on a loop. A fiber downloads
         `/runner/v1/bundle/<id>.tar.gz` back to back with a download credential from
         `mintEnrollment`. Runners 3–30 repeat the stamped lines. Record the same p50/p95 over
         runners 3–30.
      3. Throughout: event loop delay p99 (`perf_hooks.monitorEventLoopDelay`), ELU, process
         CPU, RSS per runner from `memoryPerSandbox` (432), and the hog's MB/s.
         A new table (`renderLoadTable`, beside `renderTable`, 584): baseline vs load. It fails when
         p95 rises by more than `max(1 ms, 10%)` (**proposed**), or memory per sandbox exceeds 8 MiB.
    - New flag `--runner-dir <dir>`: use `RunnerBundle.layerFromTree(dir)` (2.36) in `program`
      (607) instead of building one. G2 step 12 benchmarks the release's own tree.
  - `apps/server/src/sandbox/runnerHub/RunnerConnection.ts`: `makeRunnerConnection` (192) takes
    `ingress: IngressBudget`. One token bucket per connection, so per sandbox, shared by all its
    output streams. In `output`, after a chunk is sliced (the `Stream.mapEffect` near 245),
    `ingress.take(data.length)`. When the bucket is empty it waits on `Clock`, so the next pull,
    and so the runner's window ack, waits too. The runner then pauses at its own buffer caps
    (HandleTable.ts `Flow`, 170), which `t3_runner_source_paused_ms_total` (`runnerSourcePausedTotal`, Metrics.ts 134) already counts.
  - `apps/server/src/sandbox/runnerHub/RunnerHub.ts`: `layerWith` (691) takes
    `ingressBytesPerSecond?: number`. The default `DEFAULT_INGRESS_BYTES_PER_SECOND` sits beside
    `DEFAULT_LIMITS` (66), with the value the load test passes at (**proposed** starting point
    16 MiB/s, burst 1 MiB). `make` (214) passes it to `makeRunnerConnection` (372).
  - Throughput gap: profile `ptyThroughput` on Docker with `--cpu-prof`. Look first at per-frame
    work in `instrumentClient` (RunnerWireMetrics.ts) and the copy in `sliceFrom`. Fix it if it is
    a copy or per-frame cost, or restate the budget.
  - `docs/product/cloud/03-runner.md` §9: the table's CPU row becomes overhead over local.
    The measured column gets the M2 numbers. The capacity paragraph names the budget and the
    load-test result. `docs/internals/performance-regressions.md` "## Runner" (147): one line on
    `--load`.
- **Types and services:** `IngressBudget { take(bytes: number): Effect<void> }`, internal to
  `RunnerConnection.ts`; `RunnerHub.layerWith({ limits?, ingressBytesPerSecond? })`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - "No rise in p95" means at most `max(1 ms, 10%)` above the all-quiet baseline.
  - The budget is a fixed per-sandbox rate, not a fair share. One number the load test picks is
    the smallest model that stops a hog. A hog alone is capped too, so the PTY throughput budget
    reads "per machine, up to the hub's per-sandbox budget".
  - Worker threads only if the load test fails with the budget in place (03 §9).
  - The team cap the 30 machines need on a real server is Track A's 2.43; the loopback test needs
    none.

**Tests.** `apps/server/src/sandbox/runnerHub/RunnerResume.test.ts`, beside "the sandbox cap pauses
every source at once" (260): new case "a sandbox past its ingress budget waits, and another
sandbox's output still flows". Two runners from `makeRunner` (RunnerHubTesting.ts 129) on a hub
with `ingressBytesPerSecond` of 64 KiB. Runner A emits 256 KiB, runner B 1 KiB.

1. B's chunk arrives while A has delivered at most the burst.
2. A's next chunk arrives only after `TestClock.adjust("1 second")`.
3. `runnerSourcePausedTotal` rises for A's source.
   `it.effect` on `TestClock`; it awaits the output fibers, with no sleeps. Fails on `main`: no budget
   exists, so A drains at once.

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerResume.test.ts`;
`vp run typecheck` for `t3`; `vp run check:changed`. On the VM (8 vCPU): `vp run bench:runner --load`
and the normal Docker rows. Both tables go in the PR body: the old and new CPU and throughput
rows, and baseline vs load p50/p95, ELU, loop delay and MiB per sandbox. A server-only PR: the
bench output is the transcript.

**Reviewer checks.**

- The bucket is per connection, and every output stream of the sandbox draws from it.
- Waiting uses `Clock`, so the test runs on `TestClock` and production cannot busy-loop.
- The load table compares the quiet runners only, against a baseline from the same run.
- Restated budgets say why, in 03 §9, not only in the PR.
- Hit every surface: none of clients, providers, contracts or MCP; connection modes (loopback here,
  Docker's numbers in the same PR); docs (03 §9, performance-regressions.md).

### 2.41 `perf(server): close or explain the local git p50 regression`

M0 measured `feat/pair` head about 15% slower than `main` at git p50 (mean 23.9 → 27.5 ms, five
of five paired runs), with no single commit to blame (progress.md 138–144). This PR repeats that
comparison on the release candidate, adds a profile, fixes what the profile shows, and leaves the
R1 table G2 step 12 needs. Its own PR because it is local-only work with its own proof, and
nothing in M2 should wait on it.

- **Needs:** nothing. **Unblocks:** G2 step 12.
- **Files:** none until the profile names one. Places to look first, all verified fork-only
  (`git log main..feat/pair`, b93bd84cc and later):
  - VcsProcess.ts `runUnbounded` (282): `hosts.forPath(input.cwd)` and `host.info` (292–294) run
    before every git call, outside the metric's timer.
  - processRunner.ts `runProcessCore` (279) reads `input.host.info` again, inside the timer.
  - LocalWorkspaceHost.ts `info` (177) reads six `HostProcess` references per call, on purpose,
    so per-call overrides apply.
  - Background work a local server runs only for Cloud. A loop that runs with no compute driver
    configured is a fix: local work must not pay for Pair Cloud.
- **Types and services:** none planned.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.** The method below, since 02 §6 names the metric but not the procedure.
  1. Two worktrees beside this one: the release candidate and `main`'s merge base `e8eb50b4b`
     (`git worktree add ../pair-r1-main e8eb50b4b`). Each runs `vp i` and seeds `.t3` from the
     same snapshot with `vp run migrate-dev-db`. Remove the worktree after.
  2. One dev server at a time, so the two never share CPU. Export OTLP to local LGTM
     (observability.md "LGTM", env per its OTLP section).
  3. Ten Replay turns per build: five on a local thread and five on a worktree thread of the same
     Hello-World project. Use `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase [--worktree main] <project> "go"`
     (the flag exists on both, thread.ts 775).
  4. Record per build: `t3_git_commands_total` (same operations and counts, or the difference
     explained); count-weighted p50 and p95 of `t3_git_command_duration` by `operation`; and
     `t3 trace summary --since 30m` percentiles for `VcsProcess.run` and `VcsProcess.spawn`.
  5. Alternate builds, A B A B A B, three pairs. "Within noise" means head's mean p50 sits inside
     `main`'s run-to-run range, about ±1.5 ms on the VM (progress 143).
  6. If outside: `node --cpu-prof` on one Replay turn per build, and diff the top self-time frames
     under `VcsProcess`/`processRunner` and in the idle loop. Fix, then rerun 3–5.

**Tests.** Only if the fix is logic. Say the fix gates a cloud-only loop off a server with no
driver: extend that loop's existing test file with a case that drains the worker on a server with
no driver and asserts the loop's effect never ran (counts, not time). A pure speed-up with no
behavior change gets no test; its proof is the table.

**Verify.** The R1 table in the PR body: per build, runs, operation counts, p50/p95 per operation,
the `VcsProcess.run` span p50, and the verdict. If code changed: `vp test run` on the touched
tests, `vp run typecheck` for `t3`, `vp run check:changed`. A server-only PR, so a short runtime
transcript (the two `t3 trace summary` outputs).

**Reviewer checks.**

- Both builds made the same git operations the same number of times, or the PR says why not.
- The runs alternated and used the same seeded data.
- A claimed fix moves the number the profile blamed, and the rerun shows it.
- Any gated background work still runs where Cloud is configured.
- Hit every surface: none besides docs. Record the result in progress.md's M2 section, not a new
  internal page.

### 2.42 `fix(server,web): close the smaller defects from the M1 pass`

Three G1 defects, each with a failing test first. (a) A cloud thread waiting for its machine
shows the base it asked for, not the host checkout's branch. (b) Changes refreshes when a restore
completes, not on refocus; this one is not cloud-specific. (c) The runner's other file writes
make files the agent user owns, not root. One PR because each is a few lines, and G2 runs after
all three.

- **Needs:** M1. **Unblocks:** G2 steps 3 and 8 (cleaner passes).
- **Files:**
  - (a)
    - `apps/web/src/components/BranchToolbar.logic.ts` `resolveBranchToolbarValue` (233): add
      `cloudThread: { baseRef } | null` (null for a cloud draft, which still defaults its base to
      the host branch). For a cloud thread with no `activeWorktreePath`, return
      `activeThreadBranch ?? baseRef`, never `currentGitBranch`.
    - `cloudBaseRef` comes from a new pure helper beside `orchestrationV2WorktreePending`
      (orchestrationV2.ts 819): `orchestrationV2PendingWorktreeBase(runs)`, the `baseRef` of the
      newest `preparing` run's `workspacePreparation` of type `worktree`.
    - `apps/web/src/components/BranchToolbarBranchSelector.tsx` `branchCwd` (159): null for a
      cloud thread (`serverThread?.source.sandboxId !== undefined`) with no worktree path, so it
      lists no host refs and reads no host status. `apps/web/src/components/ChatView.tsx`
      `gitCwd` (1637) and `gitStatusCwd` (1643): the same null, so Changes does not query the host
      checkout.
    - Mobile had the same host fallback: `useSelectedThreadWorktree` and `useThreadCwd`
      (`apps/mobile/src/state/use-selected-thread-worktree.ts`) answered the project root, so the
      thread screen's `vcs.status` read the host checkout and `ThreadGitControls` showed its
      branch. Both answer null for a cloud thread with no worktree, and the thread screen's
      `currentBranch` falls back to the pending base.
  - (b)
    - `packages/client-runtime/src/state/threadDetail.ts` `deriveWorkspaceMutationId` (51) gains a
      third input, the thread's runs, and keys on the newest `completedAt` among runs with
      `status === "rolled_back"`. A successful restore sets it
      (`CheckpointRollbackService.ts` 365). Neither old input changes when a rollback leaves the
      last finished item and the last ready checkpoint in place.
    - Both callers pass it: `workspaceMutationIdAtomFamily` (536), which mobile reads through
      `WorkspaceMutationIdProvider.tsx`, and web's `ChatView.tsx` (1632).
  - (c) `apps/server/src/sandbox/runner/handlers.ts`:
    - Add `ownForAgent(path)`: when `config.facts.agent.uid !== null` and `path` is not under
      `config.stateDir` or `facts.bundleDirectory`, run `fs.chown(path, uid, uid)`, the call
      `fsMakeTempDirectory` (231–240) already makes.
    - `writeAtomic` (109): chown the staging file before the rename, so the final path is never
      root-owned.
    - `fsWriteFile` (209): chown after the write.
    - `fsMakeDirectory` (214): chown each directory from the first one made (Node's answer, which
      `Effect.asVoid` drops today) down to `path`.
    - `fsCopy` (221): chown the destination tree.
    - `fsWriteStreamOpen`: `HandleTable.openFileWriter` takes an `own` hook and chowns the file
      (the staging file when atomic) as it opens it, so close needs nothing.
    - `filesWriteNoFollow`: chown after a non-append write. The web editor saves through it.
    - `fsSymlink` (225) stays: Linux ignores a link's owner outside sticky directories.
- **Types and services:** `orchestrationV2PendingWorktreeBase`; `deriveWorkspaceMutationId`'s new
  input; `ownForAgent` (local).
- **Commands and events:** none.
- **Migrations:** none.

**Tests.**

- (a) `apps/web/src/components/BranchToolbar.logic.test.ts`: a case for `resolveBranchToolbarValue`,
  "a cloud thread waiting for its machine shows its base, not the host branch". Fails on `main`.
- (b) `packages/client-runtime/src/state/threadDetail.test.ts` `describe("deriveWorkspaceMutationId")`
  (358): extend "keys on the latest finished command or file change and the latest checkpoint"
  (364) with a restore that rolls back a run and leaves the other two inputs equal. The id changes.
  Fails on `main`.
- (c) `apps/server/src/sandbox/runner/handlers.test.ts` `describe("runner files")` (276): extend
  "maps the FileSystem calls and their errors" (277). `withRunner` (52) takes `agentUid: 1000` and
  wraps the FileSystem to record `chown` calls. An atomic write, a plain write, a recursive
  `makeDirectory` and a copy each chown their new paths to 1000, and a write under `stateDir` does
  not. Fails on `main`. Extend "streams files in and out with seqs, writing atomically" (334) with
  the same assertion on close.

**Verify.** `vp test run apps/web/src/components/BranchToolbar.logic.test.ts
packages/client-runtime/src/state/threadDetail.test.ts apps/server/src/sandbox/runner/handlers.test.ts`;
`vp run typecheck` for `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web`,
`apps/mobile`; `vp run check:changed`. Captures: the branch toolbar of a waiting cloud thread
before and after; Changes after a restore before and after, without refocus. Transcript:
`docker exec <machine> stat -c %U` on a file written from the web editor shows the agent user.

**Reviewer checks.**

- (a) A cloud thread never sends a host-path `cwd` to `vcs.status` or `listRefs`.
- (b) The new input is in the one shared derivation, so web and mobile both get it.
- (c) The runner's own state and bundle stay root-owned. Check that no server caller writes a
  secret through these methods into the agent's tree.
- Surfaces: web and mobile (a, b), desktop through web; providers and contracts unchanged except
  one pure helper; docs none.

### 2.43 `feat(contracts,server,web): let admins set the team cap per driver`

This PR adds an optional `runningCap` to each driver's settings, beside `size`, editable in Settings
→ Cloud → Compute. On Docker the default stays `max(1, floor(vCPUs / 4))`. A cap edit takes effect
on the next admission without rebuilding the driver, and a raised cap admits waiters at once. It is
its own PR because 2.40's load test sets it.

- **Needs:** M1. **Unblocks:** 2.40.
- **Files:**
  - `packages/contracts/src/settings.ts` `DockerSandboxDriver` (1202–1210): add `/** Machines
    running at once; absent: the driver's default. */ runningCap: Schema.optionalKey(PositiveInt)`
    (baseSchemas.ts 32). The patch schema (~1766–1780) takes it through `SandboxDriverInstance`.
  - `apps/server/src/sandbox/compute/ComputeDriverRegistry.ts`:
    - The service (30–40) gains `readonly runningCap: (driverId) => Effect.Effect<number,
      ComputeDriverNotConfiguredError | ServerSettingsError>`. Under the lock, after `sync`, it
      returns `entry.config.runningCap ?? entry.driver.capabilities.defaultRunningCap`.
    - `sync` (83–98): when the only difference is `runningCap`, it replaces `entry.config` and keeps
      the instance. That means comparing with `runningCap` taken from the old config.
  - `SandboxAdmission.ts` `snapshot` (64–73): `cap` comes from `registry.runningCap(driverId)`,
    still `orElseSucceed(() => Infinity)` for a removed driver.
  - `SandboxOverview.ts` `driverHealth` (68–72): `runningCap` comes from the registry, passed in by
    `read`.
  - `SandboxLifecycleWorker.ts` `makeSweep`: fork a second `Stream.runForEach` on
    `ServerSettingsService.subscribeChanges` (subscribed before the first sweep, so no change is
    lost) that calls `due.invalidate`, beside the domain-event one (80–84). A raised cap then admits
    on the next tick.
  - Test fakes implement `runningCap` as the real registry does: read
    `ServerSettingsService.getSettings` and return `config.runningCap ??
    capabilities.defaultRunningCap`. They are `ComputeDriverTesting.ts` (139) and
    SandboxLifecycle.test.ts's registry (142).
  - Web:
    - `CloudSettings.logic.ts` `dockerDriverFormError` (9–26) takes `runningCap: string`: empty is
      the default, otherwise a whole number of 1 or more ("Enter a whole number of machines, 1 or
      more.").
    - `CloudSettings.tsx` `DockerDriverFormRow` (406) adds a "Machines at once" input beside size,
      with the placeholder "Default: a quarter of the host's vCPUs". `onSave` (436–444) adds
      `runningCap` when it is set.
    - The `cloud-caps` row (337–354) appends "(set by an admin)" when the driver config has
      `runningCap`, else today's "(a quarter of the host's vCPUs)".
  - Mobile: the Limits row (SettingsMachinesRouteScreen.tsx ~84–95) already reads `runningCap`
    from Overview. No change.
- **Types and services:** `DockerSandboxDriver.runningCap`, `ComputeDriverRegistry.runningCap`.
- **Commands and events:** none. **Migrations:** none (settings JSON).
- **Proposed gap answers.**
  - Lowering the cap stops nothing that runs. New starts queue until the count drops.
  - `defaultRunningCap` keeps its name.
  - The member cap and machine hours stay Later.

**Tests.**

- `ComputeDriverRegistry.test.ts`: extend "reuses a driver until its config changes, then closes the
  old one" (42). A `runningCap`-only update keeps the same instance, closes nothing, and
  `registry.runningCap` returns the new value.
- `SandboxLifecycle.test.ts`: in the "sandbox admission" layer (`layerAdmissionTest(1)`, 128), add
  "raising the cap admits a waiting machine on the next sweep". It provisions two machines, sees
  `team-cap`, raises `runningCap` through settings, runs the sweep, and asserts `admission: null`
  as "two threads at one free slot admit one" (1388) does.
- `CloudSettings.logic.test.ts`: add rows to the `dockerDriverFormError` table for an empty cap,
  `"0"`, `"2.5"` and `"30"`.
- `SandboxOverview.test.ts`: extend "counts machines by state and reads health, caps and the image
  from the drivers" (34) with a configured cap.

**Verify.**

- `vp test run` on the four files.
- `vp run typecheck` for `packages/contracts`, `apps/server` and `apps/web`.
- `vp run check:changed`.
- Before and after captures of Compute's driver form and the caps row.
- A runtime transcript: at cap 1 a second machine waits; editing the cap to 2 admits it without a
  restart and without failing the first machine's calls.

**Reviewer checks.**

- A cap edit does not rebuild the driver; check the registry test's `closed` list.
- The sweep wakes on a settings change.
- The 2.25 allowlist includes `runningCap` (whichever lands second adds it).
- `defaultRunningCap` callers are now only the registry.
- Surfaces: the web form; mobile and Overview are read-only; contracts.

### 2.44 (new) `feat(server): read pull requests with the team's GitHub App where it is installed`

On a server with the GitHub App's ID and key, the PR list and PR panel read repositories the App
is installed on with a read-only installation token. A Pair Cloud server with only the App then
shows PRs; G1 needed the server's own sign-in for that (decision #3, accepted). Writes keep
today's credentials (D9). Its own PR because it changes which credential a read uses, and 2.21's
guide depends on the answer.

- **Needs:** nothing. **Unblocks:** 2.21 (the guide's "Pull requests" text and App permissions).
- **Files:**
  - `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.ts`:
    - Service (58) gains `readTokenFor({ repository }) => Effect<InstallationToken, GitHubAppInstallationError>`.
      It is not tied to a sandbox: cache key `repository`, its own `Ref`, never touched by
      `revoke` (324).
    - `READ_TOKEN_PERMISSIONS = { contents: "read", metadata: "read", pull_requests: "read", checks: "read", statuses: "read" }`
      beside `INSTALLATION_TOKEN_PERMISSIONS` (30). `mint` (207) takes the permission set as a
      parameter.
    - Caching matches `tokenFor` (254): refresh 5 minutes before expiry, one mint per repository
      under `mintLocks`.
    - A `not-installed` answer is remembered per repository for `NOT_INSTALLED_TTL = Duration.minutes(5)`
      (**proposed**), so a repository the App does not cover costs one lookup per 5 minutes, not
      two requests per read.
    - GitHub's 422 for a permission the installation lacks becomes `reason: "failed"`, detail
      "The GitHub App lacks a permission Pair asks for (Checks or Commit statuses read)."
  - Add `apps/server/src/pullRequest/pullRequestAppReads.ts`: `withAppReads(api, { host, repository }, tokens)`,
    a wrapper in the shape of `withRateLimitBackoff` (PullRequestService.ts 455). Only read methods
    are wrapped: `getViewer`, `listChangeRequests`, `listChangeRequestsAcross`,
    `listChangeRequestStats`, `getChangeRequest`, `getChangeRequestPreview`,
    `getChangeRequestChecks`, `getChangeRequestSummary`, `getChangeRequestStack`,
    `getChangeRequestWatchFingerprint`, `getChangeRequestActivity`, `getReviewThreadComments`,
    `getViewerPermissions`, `getDiff`, `getDiffFilePaths`, `getDiffFileContents`,
    `getFilesViewed`, `getFileStats`, `getFileRevisions` (the reads in `wrapped`, 508–626).
    `setFilesViewed`, `runAction`, `updateChangeRequest`, `comment` and every other write pass
    through untouched, as do `getRoutingIdentity`, `withVerifiedCredential` and the pickers
    that serve write dialogs (`listReviewerCandidates`, `listLabelCandidates`,
    `listRepositoryLabels`, `searchRepositoryAuthors`). Each wrapped call:
    1. Runs as is when the host is not `github.com`, or `PinnedGitHubCredential`
       (GitHubRequestPolicy.ts 28) or `ActingSourceControlCredential`
       (ActingSourceControlCredential.ts 15) is already set. So a verified routing account from
       `withRoutingCredential` (PullRequestService.ts 1597) still wins.
    2. Otherwise it runs as is first, with today's chain. When that fails with `missing-tool`,
       `unauthenticated`, `not-found` or `forbidden`, `tokens.configured` (104) is true and
       `readTokenFor({ repository })` succeeds, it runs again with `PinnedGitHubCredential` as
       `{ host, token, credentialFingerprint, source: "installation" }`.
    3. On any `GitHubAppInstallationError` it keeps the first error.
    4. A call naming any other repository (a cross-repository search, line stats, a routed
       reference `requireProject` rewrote) runs as is: the token is scoped to one repository.
       (Landed order: the sign-in first, the App second. App-first would show a signed-in server's
       panel the bot's read-only permissions and refuse its writes, because a client pins the
       signed-in account only when it routes between environments, pullRequestRouting.ts 343.)
  - `apps/server/src/pullRequest/PullRequestService.ts`:
    - Both `SupportedProject` sites (950, 1027) wrap
      `withAppReads(withRateLimitBackoff(api, host, rateLimits), { host, repository }, tokens)`.
    - `viewerFlights` (1113): when `getViewer` fails for `github.com` with a missing or refused
      credential, retry once under the App for the first project on that host whose repository
      the App covers. The viewer is then the App's bot login (GitHub's GraphQL `viewer`, which
      `getRoutingIdentity` already falls back to on a 403, GitHubPullRequestApi.ts 959). The flight key gains the host's
      repositories.
    - `routing` (1625) and `routingIdentity` (1575) stay unwrapped. A bot account is no
      identity to route by, and the client then reads from the source environment
      (pullRequestRouting.ts 359).
    - The layer needs `GitHubAppInstallationTokens`; server.ts provides the shared instance (807),
      and `layerPullRequestService` (440) must sit above it.
  - `packages/source-control-github/src/server/GitHubCredentials.ts`: `GitHubCredentialSource`
    (32) gains `"installation"`.
  - `GitHubPullRequestProvider.ts` `REPOSITORY_ACCESS_HINTS` (141) gains `installation: "The
    team's GitHub App can't see it. Install the App on this repository, or sign the server in
    under Settings → Source Control."`
  - Docs: `docs/user/source-control.md` "Pushing from cloud threads" step 1 (52–56), the
    installation-token App, adds **Checks** and **Commit statuses** read-only, and
    `docs/user/cloud.md` "Pushing and pull requests" (131–133) says PR reads use it.
    `docs/user/team.md` "Set up the GitHub App" step 3 (101–102) is the device-flow sign-in App,
    which the guides present as a separate App; it stays unchanged (landed).
- **Types and services:** `GitHubAppInstallationTokens.readTokenFor`; `GitHubCredentialSource`
  `"installation"`; `withAppReads`.
- **Commands and events:** none.
- **Migrations:** none.
- **Proposed gap answers.**
  - Order (07 open question 1 recommended the App first). **Landed the other way:** the server's
    own sign-in reads first, and the App serves only what it cannot (see step 2 above). With no
    sign-in, the App serves everything it covers.
  - With only the App, the viewer is the App's bot. **All**, the default on web
    (pullRequestListPreferences.ts 42) and mobile (pullRequestList.ts 19), shows every PR.
    **Authored** and **Reviewing** come back empty, and the panel offers no write actions,
    because the bot's token is read-only. The guide says so. Using the requesting member's
    `githubLogin` (persistence/Members.ts 73) as the viewer is a follow-up when a team asks.
  - The read token never reaches a machine. It lives in the server's process only.

**Tests.**

- `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.test.ts`:
  - Extend "mints a one-repository token with a JWT the App's key signed, and caches it" (104) with
    a `readTokenFor` half. The request body carries `READ_TOKEN_PERMISSIONS`. A second call sends
    nothing. `revoke(sandboxA)` leaves it cached.
  - New case "remembers a repository the App is not installed on for five minutes": the second
    call sends nothing, and after `TestClock.adjust("5 minutes")` the third asks again.
- `apps/server/src/pullRequest/PullRequestService.test.ts`, near "tries another workspace on the
  same host for the viewer" (1003):
  - New case "reads repositories the GitHub App covers with its token when the server has no
    sign-in". The fake provider's `getViewer` fails unauthenticated unless pinned. Its reads record
    `yield* PinnedGitHubCredential`. A fake `GitHubAppInstallationTokens` covers `org/a` only. The
    list returns `org/a`'s PRs with `source: "installation"` on every read, the provider is
    `configured: true`, `org/b` is listed unreadable, and a `comment` on `org/a` runs with no pin.
  - New case "reads with the server's own sign-in, and keeps a verified account's pin over the
    App's": a signed-in list never asks the App, and a read through `withRoutingCredential` with an
    `expectedAccountId` sees the verified credential and keeps its not-found.

**Verify.** `vp test run apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.test.ts apps/server/src/pullRequest/PullRequestService.test.ts`;
`vp run typecheck` for `@t3tools/source-control-github` and `t3`; `vp run check:changed`.
Client pass (test-t3-app) on the VM with Settings → Source Control signed out and the App key set:
the PR list shows `rutvikchandla3/pair-cloud-test`'s PRs, and the panel opens with checks. Capture
both. The App first needs Checks and Commit statuses read-only; GitHub asks the installation to
accept the new permissions.

**Reviewer checks.**

- No write method is wrapped; a write under a read-only token would fail, but must never be tried.
- An existing pin or acting credential is never replaced.
- The negative cache cannot hide a fresh installation for more than 5 minutes.
- Nothing logs a token; the read cache is separate from the sandbox cache `revoke` clears.
- Hit every surface: providers (GitHub only; other forges unchanged, say so); clients (none: the
  list contract is unchanged, web and mobile read `configured` as today); connection modes (reads
  run on the server, so local, relay and tunnel all see them); docs (cloud.md, team.md).

### 2.45 (new) `fix(server,web): confine reads and host tools on cloud-only servers`

This PR closes the 06 §10 rows that read or reach the server without running an agent. They are
`filesystem:read`, device and preview tools, environment links, text generation, provider probes,
and Claude's member sign-in. The invite text then says what a member can reach (D15). It is separate
from 2.22 so the critical path isn't held by a dozen read-side files, and so the trust text is
written once against the finished state.

- **Needs:** 2.22, 2.24. **Unblocks:** G2's member-trust checks.
- **Files:**
  - `filesystem:read` is confined to machines, project checkouts and the checkpoint mirror:
    - `WorkspaceFileSystem.ts` `readFile` (366), `resolveReadTarget` (280) and `metadataForPath`
      (204) refuse absolute and `~` paths outside a known workspace on cloud-only.
    - `WorkspaceEntries.ts` `browse` (373) refuses outside known workspaces.
    - `AssetAccess.ts` `issueAssetUrl` (530) refuses absolute (550) and `~/` (604–607) media on
      cloud-only.
  - Device tools: on cloud-only, `DeviceService.ts` drops `LocalDeviceHost.layer` (1638;
    `LocalDeviceHost.make` 260), so only admin-configured SSH and EAS hosts remain.
    `McpDeviceToolkit.test.ts` (511, `hostId: "local"`) gains the refusal row.
  - Preview: `previewOpen` and the other preview RPCs refuse, `PortScanner.ts` is not started, and
    `serverBrowser` (ServerEnvironment.ts 278) is omitted on cloud-only.
  - `t3_environment_link` (`mcp/toolkits/orchestrator/tools.ts`) is admin-only on cloud-only
    (proposed: only there).
  - Text generation (`textGeneration/*`, e.g. `ClaudeTextGeneration.ts` 250 `cwd`) runs in an empty
    temp directory with no tools, project MCP or hooks on cloud-only, for Claude, Codex, Grok,
    OpenCode and Antigravity.
  - Provider probes with a project `cwd` (`ProviderAuthService.ts`) are skipped on cloud-only.
  - Claude: the member terminal sign-in is hidden on `cloudLaunch` environments. Settings → Team
    asks for a setup token or API key.
  - D15: `TRUST_WARNING` (InviteMemberDialog.tsx 34–35) branches on `cloudLaunch`. It says members
    can prompt any thread and reach its provider credential and git token, and can't run commands
    on the server. `docs/user/team.md` (9–15) gets the same split.
- **Types and services:** reuse `CloudOnly.refuseLocalHost` and `CLOUD_ONLY_MESSAGE`.
- **Commands and events:** none. **Migrations:** none.
- **Proposed gap answer.** `t3_environment_link` is admin-only only on cloud-only.

**Tests.** Add a refusal row in each module's existing test, for example
WorkspaceFileSystem.test.ts beside 207, McpDeviceToolkit.test.ts beside 511, and one text-generation
test asserting the temp `cwd`. The trust text gets a capture, not a test.

**Verify.**

- `vp test run` on the touched tests.
- `vp run typecheck` for `apps/server` and `apps/web`.
- `vp run check:changed`.
- `test-t3-app` pass on a cloud-only dev server: the invite dialog capture, a member reading an
  absolute path refused, and the device picker showing no local host.

**Reviewer checks.**

- Every remaining 06 §10 row is closed or explicitly mapped elsewhere.
- Admin and owner provider logins still work.
- The trust text matches the code, with no promise stronger than the refusals.
- Surfaces: Settings, the MCP tools and the mobile Team screen all read the same capability.

### 2.46 (new) `feat(server): run review-guide investigations on cloud threads in their machine`

Review-guide investigations on a cloud thread fail today with
`cloudInvestigationUnsupported` (`packages/provider-core/src/server/textGenerationOperations.ts`
43). Commit `dc9a23b9d` moved commit and PR text generation to the server, and set the pattern.
This row runs the investigation with the machine's workspace host and the sandbox env
(`SandboxSettings.env`, settings.ts 1216), per provider: `ClaudeTextGeneration.ts` (198) and
`CodexTextGeneration.ts` (212) each decide whether their investigation can use a remote cwd, or
keep the clear refusal. **Needs:** M1. Spec when scheduled. It is provider-shaped, so it needs one
decision per adapter, and it is not a G2 step.

### 2.47 (new) `fix(web,server): keep a managed Codex account's provider instance through sign-in`

G1 lost the provider instance midway through adding a managed ChatGPT account from the web: "This
provider instance is no longer available." (`ProviderAuthService.getController`,
`apps/server/src/provider/ProviderAuthService.ts` 85–100, message at 97). Diagnose first.
Reproduce with the web add flow (`AddCodexAccountDialog.createAccount`, 52) against a worktree dev
server. Two messages are near-identical: the server's (ProviderAuthService.ts 96) and the panel's
empty state (`ProviderSettingsPanel.tsx` 1099, "…on this device."), so first check which fired.
Check whether the add writes settings that rebuild the provider registry, and so drop the
controller, before the sign-in completes. Two leads from the code, unconfirmed: `createAccount` in
`AddCodexAccountDialog.tsx` (52) patches the whole `providerInstances` map spread from the client's
view (61–62), so any other settings write built from an older map drops the new instance, and G1
found the account gone from settings afterwards; or sign-in begins before
`ProviderInstanceRegistry` has built the new instance, so `getController` finds nothing. Fix it
with a failing test in the owning service's test. **Needs:** M1. **Unblocks:** G2 step 13 (a managed Codex turn), so schedule it early in M2.

Diagnosed from code only; the root cause is not confirmed. The second lead does not hold for
**Add provider**: the dialog mounts sign-in only once the instance's provider snapshot has `setup`,
and snapshots come only from instances the registry has built. A watcher reload after the create
also yields an equal config, so the instance is not rebuilt. The first lead matches both symptoms,
because a whole `providerInstances` map without the account deletes it from settings and the
registry. The add dialog and onboarding's mode switch now send `create` and `upsert` mutations, so
no web code writes the whole map. Reproduce in a real client to confirm.

## M2 integrated pass

One run on `pair-cloud-pass` (GCE project `vm-provider`, zone `asia-south1-a`, e2-standard-8,
Ubuntu 24.04 x86_64) after the last M2 wave, by the primary agent. It follows the install guide
(2.21), [test-t3-app](../../../../.agents/skills/test-t3-app/SKILL.md) and
[test-t3-mobile](../../../../.agents/skills/test-t3-mobile/SKILL.md). It installs from 2.36's
release, never from `~/pair`. Subagents do not start their own servers. Reach the VM with
`gcloud compute ssh pair-cloud-pass --project vm-provider --zone asia-south1-a`.

0. **Before.** Stop G1's dev server: find the owner of :5733 with `sudo ss -ltnp`, confirm its
   `/proc/<pid>/cwd` is `~/pair`, and SIGTERM that PID only. Keep `~/.t3/dev`; the release
   uses `~/.t3`. Two releases exist: `V1` (this run) and `V2` (step 10).
1. **Install and start.**
   `BASE=https://github.com/rutvikchandla3/pair/releases/download; curl -fsSL "$BASE/v$V1/install.sh" | T3CODE_VERSION=$V1 T3CODE_RELEASE_BASE_URL=$BASE sh`.
   Check the archive against `SHA256SUMS`. Write `~/.t3/service.env` with `T3CODE_CLOUD_ONLY=1`,
   `T3CODE_RELEASE_BASE_URL=$BASE`, `T3CODE_GITHUB_APP_CLIENT_ID=<pair-cloud-test-d548's client id>`
   and the public origin (2.34) set to the VM's tailnet URL. Run `t3 service install`, then
   `t3 service status`. Install gVisor and register `runsc` with Docker; add the user to `docker`.
   `t3 pair` mints a link for the Mac browser. Passes when the server is cloud-only and
   `cloudLaunch` is true in the environment's capabilities (capture), and Settings → Cloud →
   **Test** reports gVisor. In Settings → Cloud → Compute, set the team cap to 6, above the VM's
   default 2 (2.43). Save the App ID and key (App ID 5668078). Invite a second member with
   `t3 member invite Teammate --github <login>`.
2. **Desktop beside its local server (Mac).** The Mac's Pair desktop connects to the VM over
   Tailscale. A local and a worktree thread each run a Replay turn, a terminal, a diff and a
   restore. Passes when local work is unchanged, Pair Cloud is not an Auto balance or
   machine-picker choice for local modes, and the desktop's own Settings has no Cloud (capture).
3. **Cloud from a local project (Mac, Credentials).** On a local clone of
   `rutvikchandla3/pair-cloud-test`, pick **Cloud** on a pushed branch. Run a Haiku turn, a
   terminal, a side chat and the diff, then **Commit, push & create PR**. The PR opens as the
   App's bot. Then clear the App ID in Settings → Source Control: `makeSourceFor`
   (GitCredentialService.ts 123) picks the App whenever one is configured. Set only the member's
   token (**Use a token instead**) and create a second PR, which opens as the member. Restore the
   App ID after. Passes when the resolver routes to the matching Pair Cloud project and both PRs
   open.
4. **Unpushed branch (Mac).** Pick **Cloud** on a local-only branch, then on one ahead of its
   pushed copy. Passes on "Push <branch> first" (`branch-not-pushed`), and a warning before send on
   the second.
5. **Private repo (Mac).** With no GitHub credential and the App ID cleared, add the private repo
   as a Pair Cloud project. Then restore the App and add it again, and push from a session. Passes
   on "Connect GitHub to clone private repos", then a clone and a push.
6. **Teammate (Phone).** The second member joins on the web app, then on the phone (`vp run
   mobile:install ios` if the dev client is stale). Each opens the session, prompts it, queues
   behind a running turn and uses **Steer now**.
7. **Phone across servers (Phone, Mac).** From the phone, drive a local thread through the Mac,
   then start a cloud session on a Pair Cloud project and one on a Mac project. Both launch on
   Pair Cloud, and a plain push arrives on Pair's app build.
8. **Sleep, wake, lost disk (Mac).** Leave a session idle past the idle deadline, read files and
   Changes while it sleeps, then send. Then `docker rm -f <its container>` (the name from
   `docker ps`, never a pattern) and send. Passes when it sleeps on time and wakes on send, asleep
   reads come from the snapshot, and the disk is rebuilt from the mirror. Record the video here:
   Send → first token, and sleep → wake.
9. **Automations.** A scheduled task fires; `curl -X POST <full webhook URL>` from the VM fires the
   webhook. Each launches a cloud session.
10. **Drain and upgrade.** Start a long Replay turn, drain (2.37), send a new prompt (it waits),
    then `t3 update $V2` (the base comes from `service.env`). Passes when the new turn waits and
    starts after the restart, the running one finishes or continues, and `t3 --version` prints `V2`.
11. **Restore.** Stop the service, take a `sqlite3 .backup` of `~/.t3/userdata/statev2.sqlite`,
    start one more machine, stop, put the backup back, and start with restore mode (2.38). Passes
    when the machine started after the backup is stopped and listed for admins, and none is
    destroyed.
12. **Numbers (Mac for R1).** On the VM: `git -C ~/pair worktree add ~/pair-bench v$V2`, `vp i`
    there, then `vp run bench:runner --load --runner-dir ~/.t3/runtime/versions/$V2/runner` (bench
    only, against the release's own runner tree). Then `git -C ~/pair worktree remove ~/pair-bench`.
    On the Mac: 2.41's R1 procedure. Also measure on the release: first token on a ready cloud
    session vs a local worktree thread (p50 within 300 ms), Send → runner connected (p50 under
    5 s), and asleep → first token (p50 under 20 s, p95 under 45 s), ten sends each.
13. **Managed Codex (Credentials).** A managed Codex turn on its cheapest model streams on a
    machine.

Evidence (redact pairing links, startup URLs and tokens from all of it):

- Before and after captures of the composer's Cloud item on a local project, the desktop's
  settings without Cloud, and Settings → Cloud on Pair Cloud, on web, desktop and mobile.
- Step 8's video.
- The load-test, R1 and latency tables.
- The release page link and the `install.sh` transcript.
- The short runtime transcripts of the server-only PRs: the launch gate, restore mode, drain and
  lanes.

Record the run in progress.md's M2 section. Stop only the processes this run started, by the PIDs it
captured. Stop the VM when idle (`gcloud compute instances stop`), never delete it.
