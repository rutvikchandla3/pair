# M1 Cloud threads on Docker: implementation specs

Status: implementation plan, 2026-11-06. Nothing here is built. Read [README](./README.md) first
for the shared names, the proposed gap answers and what the code checks changed, and
[M0](./m0-seam.md) for the seam every row here builds on. The design is in docs
[02](../02-workspace-host.md)–[08](../08-clients-and-contracts.md); the PR list is
[10 §2](../10-delivery-plan.md#m1-cloud-threads-on-docker).

Each PR follows one template: what it makes true, Needs and Unblocks, Files, Types and services,
Commands and events, Migrations, Tests, Verify, Reviewer checks. Line numbers are from `feat/pair`
on 2026-11-06; re-read the symbol before editing. Where a spec says **proposed**, it fills a gap the
design docs left open; a reviewer can overrule it in that PR without changing any other row.

Exit criteria, sizes and the integrated pass are in [10 §1](../10-delivery-plan.md#1-summary) and
[10 §4](../10-delivery-plan.md#m1); the last section here turns the pass into steps.

## Build order

Waves respect every Needs below; rows in one wave can be built in parallel. M0 must be complete
before wave 7 (1.11 is the first PR that registers a sandbox host). 0.11 must have landed before 1.2.

| Wave | PRs                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 1.1 runner contracts, 1.2 sandbox contracts, 1.20 base image, 1.27 GitHub App key, 1.30 mirror store                                              |
| 2    | 1.3 projections, 1.36 settings contracts, 1.6 runner core, 1.22 CLI pin check, 1.32 mirror reader                                                 |
| 3    | 1.4 ComputeDriver, 1.10 coarse operations, 1.37 client-runtime                                                                                    |
| 4    | 1.5 sandbox decisions and effects, 1.14 Docker driver                                                                                             |
| 5    | 1.7 runner route and hub, 1.19 reconciler and boot deadlines                                                                                      |
| 6    | 1.8 resume and flow control, 1.9 runner bundle, 1.15 Docker runner routes                                                                         |
| 7    | 1.11 SandboxWorkspaceHost, 1.13 forwards, 1.21 image publish, 1.44 latency benchmark                                                              |
| 8    | 1.12 sessions on sandbox hosts, 1.23 base image pull, 1.25 process environments, 1.31 mirror sync                                                 |
| 9    | 1.16 cloud launch, 1.26 provider credentials, 1.28 git credentials, 1.33 stopped reads, 1.34 attachments                                          |
| 10   | 1.17 shared sandboxes, 1.24 setup scripts, 1.28a owner's GitHub, 1.29 revocation, 1.38 web Cloud mode, 1.42 MCP and CLI, 1.43 machine-failed push |
| 11   | 1.18 admission, 1.35 push and PR, 1.39 web header and menus                                                                                       |
| 12   | 1.40 Settings → Cloud                                                                                                                             |
| 13   | 1.41 mobile                                                                                                                                       |
| 14   | 1.45 the cloud guide, then the [integrated pass](#m1-integrated-pass)                                                                             |

The critical path is 1.2 → 1.36 → 1.4 → 1.5 → 1.7 → 1.8 → 1.11 → 1.12 → 1.16 → 1.17 → 1.18 →
1.40 → 1.41. The runner track (1.1, 1.6, 1.8–1.13) and the driver track (1.2–1.5, 1.14, 1.19) meet
at 1.7 and again at 1.16.

| PR    | Needs (final)                            |
| ----- | ---------------------------------------- |
| 1.1   | 0.1                                      |
| 1.2   | 0.1, 0.11                                |
| 1.3   | 1.2                                      |
| 1.4   | 1.2, 1.36                                |
| 1.5   | 1.3, 1.4                                 |
| 1.6   | 1.1                                      |
| 1.7   | 1.1, 1.5, 1.6                            |
| 1.8   | 1.6, 1.7                                 |
| 1.9   | 1.6, 1.7                                 |
| 1.10  | 1.1, 1.6                                 |
| 1.11  | M0, 1.8, 1.10                            |
| 1.12  | 1.9, 1.11, 1.13                          |
| 1.13  | 1.7, 1.8                                 |
| 1.14  | 1.4                                      |
| 1.15  | 1.7, 1.14, 1.36                          |
| 1.16  | 0.11, 1.5, 1.7, 1.12, 1.14               |
| 1.17  | 1.16                                     |
| 1.18  | 1.17                                     |
| 1.19  | 1.5, 1.14                                |
| 1.20  | —                                        |
| 1.21  | 1.9, 1.20                                |
| 1.22  | 1.20                                     |
| 1.23  | 1.2, 1.14, 1.21                          |
| 1.24  | 1.11, 1.16                               |
| 1.25  | 1.3, 1.11, 1.36                          |
| 1.26  | 1.12, 1.13, 1.25                         |
| 1.27  | —                                        |
| 1.28  | 1.13, 1.20, 1.25, 1.27                   |
| 1.28a | 1.28                                     |
| 1.29  | 1.19, 1.28                               |
| 1.30  | 0.1                                      |
| 1.31  | 1.10, 1.11, 1.30                         |
| 1.32  | 1.30                                     |
| 1.33  | 1.11, 1.31, 1.32                         |
| 1.34  | 1.12                                     |
| 1.35  | 1.28, 1.28a, 1.31                        |
| 1.36  | 1.2                                      |
| 1.37  | 1.2, 1.36                                |
| 1.38  | 1.16, 1.37                               |
| 1.39  | 1.37, 1.38                               |
| 1.40  | 1.14, 1.16, 1.18, 1.23, 1.25, 1.30, 1.36 |
| 1.41  | 1.28a, 1.37, 1.38, 1.40                  |
| 1.42  | 1.16, 1.37                               |
| 1.43  | 1.16                                     |
| 1.44  | 1.8, 1.9                                 |
| 1.45  | 1.38–1.42                                |

## What the code changed in 10 §2

10 §2 already carries the changes the verification found (1.5a folded into 1.5, 0.13 into 1.37,
1.36 before 1.4, 1.18 after 1.17, 1.33 redefined). Drafting each PR against the code found more.
The [track notes](#track-notes) below give the evidence; in short:

- **Order.** 1.9 needs 1.7, because the bundle routes authenticate with 1.7's grants and mount in
  its route module. 1.32 lands before 1.31. 1.24 needs 1.16, 1.25 needs 1.3 and 1.36, 1.26 needs
  1.12. 1.40 needs 1.16, 1.18, 1.23 and 1.30, because the Test button boots a runner and the
  Overview shows caps, the base image and the mirror size. 1.41 needs 1.38 and 1.40.
- **Protocol.** 1.1 adds `process.release`, `pty.release` and `ops.search.refresh`, and drops the
  wire `processGroup` option (the runner gives every spawn its own group). 1.6 owns the sequence
  basics and the runner's lint fence, which leaves `mcp/` open for `t3 acp-mcp-bridge`. 1.7's
  `426` covers the protocol version; 1.9 adds the build check.
- **Shared code instead of copies.** 1.10 moves the git half of checkpoint capture out of
  `orchestration-v2/` into `checkpointing/CheckpointCapture.ts`, which the server and the runner
  both call, and moves the `ps` table read out of `terminal/Manager.ts`. 1.11 adds the server-side
  branches that call the coarse operations, and a small `KnownWorkspaces` edit (a sandbox checkout
  never shows in the server's `git worktree list`).
- **Launch.** A cloud launch is three commits (`thread.create`, `sandbox.provision`,
  `message.dispatch` with `defer_start`), as today's launch already commits thread and message
  separately. `cloud` joins only the launch input in 1.16; MCP gets it in 1.42 (with its evals) and
  scheduled tasks in 2.18. Boot deadlines move to 1.19. The M1 record leaves out `imageBuildId`
  and the lifetime fields until M2 and M3 add them.
- **Credentials.** 1.24 fixes script paths in the terminal manager, one point for setup, settle and
  client-started scripts. 1.28 lands the whole credential order (App, the owner's connected
  account, refusal), since `MemberGitHub.credentialFor` exists; 1.28a adds the pasted token and a
  small team migration (`MemberGitHubSource`). The fork warning is a banner derived from state.
- **Data.** 1.31 drops a deleted thread's mirror refs (moved from 1.19). The head-context record
  moves to 2.9, since nothing reads it while M1's Docker sandboxes stop only when settled, so no
  `090_SandboxMirror` table. 1.33 also stops status polling and PR discovery from failing against
  a stopped sandbox. 1.35 drops the branch sync after push.
- **Surfaces.** 1.36 is `contracts,server`: sensitive env entries must be redacted in the same PR.
  `cloudAvailability` lives in `packages/shared` because the server uses it too (1.42). 1.40 is
  `server,web` and adds `sandbox.overview` and `sandbox.checkDriver`. 1.45 also updates
  `pair-features.md` and `decisions.md`.
- **Image and CI.** 1.20 owns the image entrypoint and moves Codex `RELEASES` into a leaf module;
  1.21 adds the release jobs to 1.20's workflow; 1.14 adds its own Docker CI workflow rather than
  editing upstream's; 1.23 adds an optional `baseImage` to the sandbox record.

Reconciled across tracks while assembling this page: `host.info` is an `Effect` (0.1), so the
sandbox host returns a constant one; the attach command id includes the runner boot id
(`sandbox-attached:<id>:<generation>:<runnerBootId>`, 1.7), so a runner restart inside a generation
attaches again; `RunnerHub.expectCheck` is added for 1.40's Test machine; the Docker volume takes
its container's name (1.14), replacing P1's `pair-<sandboxId>`; the `git-credential` forward is one
socket per sandbox (terminals and scripts push too), while MCP forwards stay per provider session.

## Track notes

Each track's drafting notes, kept whole because its PR specs refer to them: the PR-list
changes it found and the gap answers it proposed. The summary above is the short version.

### Runner core (1.1, 1.6, 1.8, 1.9, 1.44)

Owner docs: [03 Runner](../03-runner.md) (all), [02 Workspace host](../02-workspace-host.md) §2, §5.
Effect facts from the vendored source (`.repos/effect/packages/effect/src/rpc/`, `socket/`,
`.repos/effect/packages/platform/node/src/NodeWS.ts`), re-read for this draft.

### PR-list changes

- **1.6 / 1.8 split of sequence numbers.** 1.6 stamps every output byte with its `StreamSeq`,
  serves `fromSeq` from the handle buffer, and ignores an already-applied write `seq` (03 §10 puts
  "seq dedup; ordering; `wait` after last byte" in the handler tests). 1.8 adds everything that
  only matters once a socket can drop: the window, buffer bounds and pause, the sandbox cap, the
  server's resubscribe and resend, writer fibers, the lease and boot ids. No row moves.
- **1.7 / 1.8 lease boundary.** 1.7's draft (`m1-hub.md`) already runs the server-side lease
  fiber and emits `lost("lease-expired")`. 1.8 adds the runner's mirror of it, the resumable
  wrappers that fail on it, and the rule 1.7 relies on for its attach ids: a runner that drops its
  handles (lease expiry or a new `serverBootId`) mints a new `runnerBootId`.
- **The lint fence is 1.6's, without `**/mcp/**`.** 1.10's draft adds the same override with
  `**/mcp/**`; the runner's `bin.ts` must import `mcp/AcpMcpStdioBridge.ts` for the `t3
  acp-mcp-bridge` fast path, which imports only `effect` and `@t3tools/shared`. One override, in
  1.6; 1.10 drops its copy.
- **The shared window helper lands in 1.8, not 1.6.** `RpcTest.makeClient` skips any `Protocol`
  (`RpcTest.ts:28-53` builds `makeNoSerialization` on both sides), so 1.6's tests cannot exercise a
  window; 1.8 owns the `Socket.make` pair that can.
- **1.9 Needs 1.7 as well as 1.6.** The bundle routes accept "enrollment secret or sandbox token",
  which `RunnerGrants` (1.7) owns, they mount in 1.7's `RunnerRoute.ts`, and 1.9 adds the build
  comparison to 1.7's 426 branch. No delay on the critical path: 1.12 already waits on
  1.11 → 1.8 → 1.7.
- **1.1 adds `process.release` and `pty.release`** to 03 §4.2's catalog (what a server-side scope
  close sends) and drops a wire-level `processGroup` option, since the runner groups every spawn.

### Runner hub, coarse operations and forwards (1.7, 1.10, 1.13, 1.15)

Specs for the server side of the runner (hub, coarse operations, forwards, Docker routes). They
follow [03](../03-runner.md) §2.2, §3, §5–§8, §11; [06](../06-credentials-and-security.md) §5, §7;
[02](../02-workspace-host.md) §5; [07](../07-access-and-data.md) §1, §4–§6.

### PR-list changes

- **1.7's 426 is protocol-only; 1.9 adds the build comparison.** `runnerBuildId` exists only once
  1.9 hashes the bundle, and 1.9 Needs only 1.6. Making 1.7 wait for 1.9 puts the bundle on the
  critical path. 1.7 answers 426 on a protocol mismatch; 1.9 adds `runnerBuildId !==
  RunnerBundle.runnerBuildId` to the same branch (one line in `RunnerRoute.ts`).
- **`sandbox.runner.attached` id names the runner boot (proposed):**
  `sandbox-attached:<sandboxId>:<generation>:<runnerBootId>`, not `…:<generation>`. With the
  first draft's id, a runner that restarts inside a generation (crash, OOM) attaches again under the same
  id, its receipt drops the command, and `runnerLostAt` never clears. Pair rule, owned by 1.8's
  lease: a runner that kills its groups at lease expiry also mints a new `runnerBootId`, so each boot
  id attaches once and is lost at most once. 1.5's decider takes `attached` in `ready` as "clear
  `runnerLostAt`".
- **"Reconnecting to machine" has no wire field (proposed: defer to M2).** 04 §1's 2 s label needs
  connection status on the client, and no M1 row adds it. A blip shorter than the lease is invisible
  in M1; a lost runner is the `sandbox.runner.lost` event, which clients already see through
  `sandbox.updated`. 1.7 keeps status server-side.
- **1.10's `checkpoint.capture` splits `CheckpointServiceV2.capture`.** The service lives in
  `orchestration-v2/` (fenced from the runner) and mixes server-only work (checkpoint ids from
  `IdAllocatorV2`, the in-memory `withWorkspaceLock`) with git work. 1.10 moves the git half into a
  new `checkpointing/CheckpointCapture.ts` that both the service and the runner call. This is the
  "split the service, never copy" case of 03 §4.6, and it is a pure refactor for local threads.
- **1.1 must declare `ops.search.refresh`** with the other `RunnerOps*` schemas (1.10 lists the
  shapes it needs). If 1.1 merged without them, 1.10 adds them and bumps `RUNNER_PROTOCOL_VERSION`.
- **Small additions to other rows, no reorder.** 1.9's bundle step asserts the runner bundle
  holds no module from `orchestration-v2/`, `persistence/`, `auth/` or `Adapters/` (the lint fence
  sees only direct imports), and its bootstrap fetches over `ws+unix:` with `curl --unix-socket`.
  1.19's reconciler dispatches `sandbox.runner.lost` for a `ready` sandbox whose runner does not
  return within the lease after a server restart (the hub's memory is empty then). 1.16's clone
  and setup processes carry `T3CODE_THREAD_ID`, which the git credential forward reads.

### Sandbox host, sessions and credentials (1.11, 1.12, 1.24, 1.25, 1.26, 1.34)

Owner sections: [02](../02-workspace-host.md) §2, §3, §4, §6 PRs 9 and 10, §7;
[03](../03-runner.md) §4, §7; [05](../05-team-images.md) §5; [06](../06-credentials-and-security.md)
§2, §3, §6, §7; [07](../07-access-and-data.md) §6. Paths follow README P1 (sandbox layout), P5
(Replay) and P6 (registered hosts only).

### PR-list changes

- **1.11 carries the server-side consumers of the coarse operations.** 1.10 adds the runner
  handlers and the `RunnerOps*` schemas (Needs 1.6 only, no sandbox host exists yet). The branches
  that call them (`WorkspaceEntries` list, search, browse and refresh; `CheckpointServiceV2`
  baseline and capture) can only be exercised once a host with `invoke` exists, so they land with
  `SandboxWorkspaceHost` and its loopback test. `processes.table` and `ports.listeners` need no
  consumer change: 0.5 and 0.10 already read them from the host.
- **1.11 makes a small edit to `KnownWorkspaces`.** 02 §6 says it needs none, but `contains`
  accepts a thread worktree only when `git worktree list` of the server-side `project.workspaceRoot`
  names it (`apps/server/src/workspace/KnownWorkspaces.ts:105-131`), which a sandbox checkout never
  is. One branch for registered sandbox roots fixes it.
- **1.12 and 1.25 land in either order.** 1.12 starts sandbox processes on `host.info.environment`
  (1.11's allowlist base), which is enough for Replay; 1.25 swaps those three call sites to
  `forProcess`. Claude and Codex need the account credential from 1.26 for a real turn, so the M1
  "Claude and Codex turn" check waits for 1.26, not 1.12.
- **1.25 Needs 1.3 and 1.36 too** (10 lists only 1.11): it reads the sandbox record's `projectId`
  and `ServerSettings.sandbox.env`. Both land earlier anyway, so the graph does not move.
- **1.26 Needs 1.12 too** (10 lists 1.13 and 1.25): it edits the sandbox branches 1.12 adds.
- **1.24 also fixes scripts started from web and mobile.** Both clients build
  `T3CODE_PROJECT_ROOT` from the server's `project.workspaceRoot`
  (`apps/web/src/components/terminal/useThreadTerminalActions.ts:104`,
  `apps/mobile/src/features/threads/ThreadRouteScreen.tsx:774`). The fix is server-side, in the
  terminal manager, so it covers setup, settle and client-started scripts in one place.
- **The "Local only" model-picker reason ships with 1.38 (web) and 1.41 (mobile).** 1.26 is
  server-only; it adds the shared pure check both pickers call.

Names assumed from M0 (if 0.1 named them differently, follow 0.1): `SANDBOX_ROOT = "/t3-sandbox"`
and `sandboxIdFromPath(path): SandboxId | undefined` in `WorkspaceHost.ts`; `ServerEndpoint
{ name: "mcp" | "codex-token" | "git-credential", ownerKey: string, localAddress: string }` (the local
host returns `localAddress`, 0.6); `WorkspaceHostTesting.layerFromContext` and `layerRecording`.

### Lifecycle in orchestration (1.2, 1.3, 1.5, 1.16, 1.17, 1.18)

Drafted 2026-11-06 against `feat/pair-impl-plan`. Line numbers are from that branch.

### PR-list changes

- **Launch is three idempotent commits, not one (proposed).** `ThreadLaunchService.launch` already
  commits `thread.create` (`ThreadLaunchService.ts:948`) and then `message.dispatch` with
  `defer_start` (`:999`) as two commands. A cloud launch puts `sandbox.provision` between them, on
  the new thread's stream, with id `${commandId}:sandbox`. It sets the thread's `sandboxId` and
  creates the record in one commit. Giving `thread.create` (a client command) a server-only sandbox
  field would widen what clients can send. The run still waits in `preparing`, and a replayed
  launch resumes by receipts as today.
- **The `cloud` launch member lands in 1.16, and only in the launch input (proposed).** The shared
  union `OrchestrationV2ThreadLaunchWorkspaceStrategy` also types `delegated_task.request`,
  scheduled tasks and MCP (`orchestrationV2.ts:3488`, `scheduledTask.ts:235,274`,
  `mcp/toolkits/project/tools.ts:142`). Adding `cloud` there would put it in a persisted scheduled
  task and in model-facing MCP text before anything handles it. 1.16 adds a launch-only union for
  `OrchestrationV2ThreadLaunchInput.workspaceStrategy`; 1.42 moves MCP to it (with evals) and 2.18
  moves scheduled tasks. 08 §2's "only the inputs need `cloud`" still holds.
- **Boot deadlines go to 1.19, not 1.5.** 1.5 has no runner yet (1.7), so a deadline would fire on
  every test sandbox. 1.19 builds `SandboxLifecycleWorker` with the settle stop and both deadlines.
  Until 1.19, a sandbox that never says hello stays `provisioning`; dev only.
- **Client sandbox commands are routed by the intake (proposed).** They carry the thread the user
  acts from and the `sandboxId`. `ThreadMessageIntake.dispatchCommand` reads the record and
  dispatches with `threadId` set to `ownerThreadId`, so the receipt and events land on the owner's
  stream (04 §1). 1.5 owns this.
- **`imageBuildId`, `sessionStartedAt` and `lastActiveAt` are left out of the M1 record.** No M1
  code reads them; M2 (2.1, 2.3) and M3 (3.8) add them as `optionalKey`, which older readers
  ignore.

### Compute driver and base image (1.4, 1.14, 1.19, 1.20, 1.21, 1.22, 1.23)

Status: draft for `docs/product/cloud/implementation/`. All seven PRs are complete.

### PR-list changes

- **1.17 and 1.19 both edit the `thread.delete` arm** (`Orchestrator.ts`, the `plans` array). 1.19
  owns "no other user: destroy", 1.17 "others remain: hand over". Either order works; no new Needs.
- **1.20 creates `.github/workflows/sandbox-image.yml`** with the pull-request build (05 §9 1.1 asks
  for PR CI); 1.21 adds the release jobs to the same file.
- **1.20 owns `infra/sandbox-image/pair-bootstrap.sh`**, the image entrypoint 03 §2.1 describes. 1.9
  owns the bundle endpoints it calls. Until 1.9 lands the image proves its CLIs only.
- **1.20 moves Codex `RELEASES` to a leaf module** `apps/server/src/provider/codexReleases.ts`
  (exported as `CODEX_RELEASES`), so a Node script reads it without the server's import graph.
- **1.14 adds its own workflow**, `.github/workflows/sandbox-docker.yml`, for the real-daemon
  contract suite, instead of a job in upstream's `ci.yml` (decision 14).
- **1.23 adds `baseImage` (optionalKey) to `OrchestrationV2Sandbox` and `sandbox.created`.** If 1.2
  has not merged, fold the field into 1.2.
- **1.14's private-network helper runs from the base image**, which has `iptables` only from 1.20.
  Not a hard dependency: until then `health` reports the block as not applied.
- **Doc corrections these specs make** (each marked proposed below): the Docker volume is named like
  its container, `pair-<installId8>-<sandboxId>-g<generation>` (04 §7 and P1 say `pair-<sandboxId>`);
  one bridge network per install with inter-container traffic off, not one per sandbox (06 §8; 04 §7
  says `pair-sandboxes`); Docker delivers the bootstrap as a file written into the container layer,
  not onto the volume (04 §7); `ComputeDriverError` drops `detail` (effect-services rule); P3 is
  refined so a source-run server also tries the published image.

### Git credentials and data (1.27, 1.28, 1.28a, 1.29, 1.30–1.33, 1.35)

Owner sections: 06 §2, §5, §7; 07 §1, §3, §6, §9, §10; 08 §2 (D1), §4. Every path below was read on
`feat/pair-impl-plan`. Shared names follow [README](./README.md#shared-names).

### PR-list changes

- **1.28 owns the `git-credential` forward's server target, not the forward.** 1.13 opens the
  forward and splices it to a target; 1.28 adds the target, `GitCredentialService.answer`. 1.13
  must expose a hook for it (a `RunnerForwards` target map keyed by `ForwardName`), or 1.28 edits
  `RunnerForwards.ts` in one line. Named here so the two PRs agree.
- **1.28a needs one team migration (proposed).** `TeamMemberGitHub.source` (08 §2) must come from
  the member row: `toTeamMember` (`apps/server/src/team/TeamMembers.ts:84`) is synchronous over
  `MemberRecord`, so it can't ask the secret store which kind of credential exists. Add
  `members.github_source TEXT` in `0NN_MemberGitHubSource` (next free id at merge, P8). This is
  not a sandbox table; it is the smallest change that makes the source visible.
- **1.29's fork warning is a composer banner derived from state, not a step in the fork flow.**
  It reads the thread's `sandboxId`, its owner and the sandbox's `ownerMemberId`, all on the wire
  after 1.2, so every way of forking (web, mobile, MCP, CLI) gets it without touching the fork
  commands. The mobile half joins 1.41.
- **1.28 already pushes with a connected account.** `MemberGitHub.credentialFor` exists today,
  so the full order (App, then owner, then refusal) lands in 1.28. 1.28a only adds the pasted
  token behind the same `credentialFor`, plus its RPCs and UI; `GitCredentialService` does not
  change there.
- **The head-context record moves from 1.31 to 2.9.** It serves PR discovery of a sleeping
  thread. In M1 a Docker sandbox stops only when every attached thread is settled or archived; the
  minute sweep reads unsettled threads, and the rarer per-thread refresh or settled backfill of a
  stopped thread skips it and keeps the last known link (1.33). So nothing needs the record before
  M2. `090_SandboxMirror` is not needed.
- **1.31 drops a deleted thread's mirror refs** (a `ThreadDeletion` effect). 07 §10 #10 put that
  beside sandbox destruction in 1.19; it belongs with the code that writes those refs.
- **1.32 lands before 1.31** (07 §10 #4: the reader is independent of the sync). 1.32 then reads
  only refs that 1.31 writes, so its tests seed the mirror by `git fetch` from a fixture repo.
- **1.33 also quiets status polling and PR discovery for a stopped sandbox.** With no wake on read
  in M1, `VcsStatusBroadcaster` and `ThreadPullRequestService` would otherwise log a failure every
  poll. Its terminal change is small: a stopped sandbox's PTYs already exit when the runner drains
  (1.10/1.11); 1.33 only stops the two spawn paths from trying again.
- **1.35 drops "sync the branch to the mirror after push".** A push doesn't move the local branch,
  and 1.31 syncs the branch at every capture. The only reader of a fresher mirror branch is the
  head context, which moves to 2.9 with it.

### New gap answers (proposed)

- **G1. Helper identity.** The helper tells the server which thread it runs for through
  `T3CODE_THREAD_ID`. Claude and Codex agents already carry it for port crediting
  (`PortScanner.ts:70`); 1.28 adds it to every other sandbox process (terminals, setup scripts)
  and 1.35 to UI pushes. The server accepts it only if that thread is bound to the asking sandbox.
  A process with none gets the sandbox's owning thread's answer. `/proc` makes a finer check moot
  (06 §2).
- **G2. Which host.** M1 answers for `github.com` only: the App sign-in, MemberGitHub and the
  pasted token are all `github.com` today (`APP_SIGN_IN.hosts`, `MemberGitHub.ts:70`). A GHES
  or other-host remote gets `unsupported-host` from the helper and `cloud-push-unsupported-host`
  from a UI push (1.35).
- **G3. App failures fall through.** If the App key is set but the repo has no installation (404),
  or GitHub refuses the JWT (401), the server logs it and tries the owner's credential. The audit
  event records which source answered. A bad key never blocks a member who has their own GitHub.
- **G4. The agent's `gh` uses the same credential as git.** 07 §3 says "never the owner's GitHub
  token" for `gh pr create`; that predates D1. Under D1 the owner's credential _is_ the agent's
  git credential when no App key is set, so the shim serves whatever the helper would. 07 §3's
  row should say "the thread's git credential".
- **G5. Stopped reads label.** "As of turn N" is the `appRunOrdinal` of the newest `ready`
  checkpoint among the threads sharing that checkout whose ref the mirror holds (1.33); clients
  derive the same number from thread detail, so no result field is added.
- **G6. Error for writes to a stopped cloud thread.** A new `SandboxAsleep` tagged error in
  `packages/contracts/src/sandbox.ts` (08 §1 lists it), `{ sandboxId, state }`. On the wire it
  rides the existing `ProjectWriteFileError` (`failure: "operation_failed"` plus an optional
  `sandboxId`), so old clients decode it. 2.8 reuses it.
- **G7. No runner-side credential cache.** The server caches installation tokens per sandbox and
  repo; the runner keeps nothing (1.28). 06 §2's "runner memory cache" row should say "server
  memory".
- **G8. Git-token audit lives one day in the event log, longer in the server log.** Events are
  pruned after a day (`RETAINED_EVENT_HISTORY`,
  `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:42`), so 1.29 also writes one
  structured log line per event. A durable audit log stays out of M1 (10 §8).
- **G9. Mirror import checks with `index-pack --strict`, not `fetch` + `git fsck`** (1.30, with
  the git 2.43.0 transcript). 07 §1's "check the new objects with `git fsck`" should say so.
- **G10. Mirror path is `<base64url(projectId)>.git`** because `ProjectId` is any trimmed string.
- **G11. Upstream files reach sandbox code through `Context.Reference`s with no-op defaults**
  (`MirrorHooks`, `CheckpointDiffPlacement`, `SandboxGitHooks`), as `PinnedGitHubCredential` does
  (`packages/source-control-github/src/server/GitHubRequestPolicy.ts:28`). The upstream edit is
  one `yield*`, layer requirement lists and existing tests don't change, and local threads take
  the default. `server.ts` provides the real ones; a test there asserts it (a forgotten provide
  would silently skip cloud behavior).

### Client surfaces (1.36–1.43, 1.45)

Owner sections: 08 (all), 01 §3, §5, §6, 04 §1 states table. Verified against the code on
`feat/pair-impl-plan`. Line numbers are as of that branch.

### PR-list changes

- **1.36 becomes `feat(contracts,server)` and Needs 1.2.** It uses `ComputeDriverId` and
  `SandboxSize` from `sandbox.ts` (1.2). And once `ServerSettings` carries a sensitive env entry
  the server stores and streams it, so the secret lifecycle (`mapSettingsSecrets` in
  `apps/server/src/settingsSecrets.ts`) must learn the new env groups in the same PR, or a hand
  edit leaks values in `ServerConfig.settings` and `settingsUpdated`.
- **`SandboxEnvEntry` is not a new schema (proposed).** The env fields reuse
  `ProviderInstanceEnvironment` (`providerInstance.ts`). It already stores a secret reference in a
  layout older builds decode, carries `valueRedacted`, is walked by the one secret lifecycle, and the
  web editor `ProviderEnvironmentSection` already edits it.
- **`cloudAvailability` lives in `packages/shared/src/sandbox.ts`, not client-runtime.** The server's
  `orchestrator_capabilities` (1.42) applies the same rule, and the server does not depend on
  client-runtime. 1.37 still owns it. 1.37 also takes 08 §8's "Project defaults" row
  (`newThreadPrefersCloud` beside `resolveNewThreadEnvMode`, which returns the contract
  `ThreadEnvMode` and must not gain `cloud`), and a small overload of `createEnvironmentRpcCommand`.
- **1.2's shell summary gains `ownerMemberId` (proposed, for 1.2's owner).** Sleep and Discard are
  owner-or-admin on the sandbox's owner, which can differ from the viewed thread's owner (a fork by
  another member). Without it clients can only approximate (1.37).
- **1.38 carries the client-runtime `prepareCloud` bootstrap** (`StartThreadBootstrap` →
  `launchThread` with `{ type: "cloud" }`), which mobile reuses. So **1.41 Needs 1.38** (and, for the
  machines screen, **1.40**).
- **1.40 becomes `feat(server,web)` and Needs 1.16, 1.18, 1.23, 1.30** besides 1.14, 1.25, 1.36: the
  Test button boots a machine and waits for its runner, read-only caps are 1.18's defaults, and
  Overview shows the base image (1.23) and mirror size (1.30). It adds `sandbox.overview` and
  `sandbox.checkDriver`, and asks 1.7's owner for `RunnerHub.expectCheck`. It also carries the
  project rows of Settings → Projects ("Allow cloud threads", Cloud as default, project env), which
  08 §4 lists for M1 and no row owns.
- **1.16 types `t3_thread_launch`'s `workspaceStrategy` with 0.11's three-member
  `OrchestrationV2RunWorkspacePreparation`,** so the `cloud` member reaches models only in 1.42,
  with its evals and the `agent-context-increase` budget review.
- **`create_threads` gets no cloud key in M1 (proposed).** It has no workspace input at all; cloud
  fan-out uses `delegate_task` `isolation: "cloud"` or `t3_thread_launch`, as worktree fan-out does.
  08 §4's "Start in cloud" row should drop it. 1.42 also covers `t3_thread_read`'s machine summary.
- **1.45 also applies 10 §5's M1 product-doc rows** (`pair-features.md`, `decisions.md`). User-doc
  edits that a feature makes stale ride that feature's PR (1.27, 1.28a, 1.42, 1.43).

## PR specs

### 1.1 `feat(contracts): add the runner protocol under @t3tools/contracts/runner`

Makes the runner wire a typed contract: every RPC of 03 §4.2 as an `Rpc.make`, one
`RunnerRpcGroup`, and the coarse-op schemas by name, exported only through a subpath so no client
bundle grows. Its own PR because 1.6, 1.7, 1.8, 1.10 and 1.13 all build on these exact types.

- **Needs:** 0.1 (the row's stated base; nothing here imports server code). **Unblocks:** 1.6,
  1.7, 1.10, 1.13.
- **Files:**
  - add `packages/contracts/src/runner.ts`: the whole protocol (below).
  - add `packages/contracts/src/runner.test.ts`: codec round trips.
  - change `packages/contracts/package.json` `exports`: add `"./runner": { "types":
    "./src/runner.ts", "import": "./src/runner.ts" }`, beside `./settings` and `./relay`.
  - Not `src/index.ts`. `relay.ts` is the precedent: subpath-only, absent from the barrel
    (`index.ts` exports `relayClient.ts` and `settings.ts`, not `relay.ts`).

**Types, services and RPCs.**

```ts
// packages/contracts/src/runner.ts
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CheckpointRef } from "./baseSchemas.ts";
import {
  ProjectEntriesFailure,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "./project.ts";
import { DiscoveredLocalServer } from "./preview.ts";
import { ResourceMonitorProcessTableEntry } from "./resourceTelemetry.ts";
import { OrchestrationV2CheckpointFileSummary } from "./orchestrationV2.ts";

export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const RunnerHandleId = TrimmedNonEmptyString.pipe(Schema.brand("RunnerHandleId"));
/** Offset within one stream: bytes for fds and files, UTF-16 units for PTY text. */
export const StreamSeq = NonNegativeInt;
export const RunnerLimits = Schema.Struct({
  windowBytes: NonNegativeInt,
  windowChunks: NonNegativeInt, // 256 KiB, 16
  handleBufferBytes: NonNegativeInt,
  ptyBufferBytes: NonNegativeInt, // 4 MiB, 1 MiB
  sandboxBufferBytes: NonNegativeInt, // 64 MiB
});
export const RunnerHelloInput = Schema.Struct({
  protocolVersion: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  serverBootId: TrimmedNonEmptyString,
  leaseMs: NonNegativeInt,
  limits: RunnerLimits,
  sandboxToken: Schema.optionalKey(Schema.Redacted(Schema.String)), // enrollment only
});
export const RunnerHandleState = Schema.Struct({
  handle: RunnerHandleId,
  /** Next seq per output stream: "fd:1", "fd:2", "pty". Inputs: last applied seq per "in:<fd>". */
  next: Schema.Record(Schema.String, StreamSeq),
});
export const RunnerInfo = Schema.Struct({
  runnerBootId: TrimmedNonEmptyString,
  runnerBuildId: TrimmedNonEmptyString,
  protocolVersion: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  arch: Schema.Literals(["x64", "arm64"]),
  cpus: NonNegativeInt,
  memoryBytes: NonNegativeInt,
  handles: Schema.Array(RunnerHandleState),
});
export class RunnerLostError extends Schema.TaggedError<RunnerLostError>()("RunnerLostError", {
  reason: Schema.Literals([
    "lease-expired",
    "runner-restarted",
    "server-restarted",
    "drained",
    "resume-behind-buffer",
  ]),
  handle: Schema.optionalKey(RunnerHandleId),
}) {}
/** A failed syscall, carried as Effect's PlatformError fields so the host rebuilds one losslessly. */
export class RunnerSystemError extends Schema.TaggedError<RunnerSystemError>()(
  "RunnerSystemError",
  {
    method: Schema.String,
    reason: Schema.String /* SystemErrorReason literal */,
    path: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    errno: Schema.optionalKey(Schema.String),
  },
) {}
export const RunnerCallError = Schema.Union([RunnerLostError, RunnerSystemError]);
```

Errors use `Schema.TaggedError`, as the rest of `packages/contracts` does (`acpRegistry.ts:330`).
The catalog, every entry `Rpc.make(name, …)`
with `error: RunnerCallError` unless noted:

| Rpc const                                                    | Name                                      | Payload                                                                                                                                                                                                           | Success                                                                                                                                                                                | Stream    |
| ------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `RunnerHelloRpc`                                             | `runner.hello`                            | `RunnerHelloInput`                                                                                                                                                                                                | `RunnerInfo`                                                                                                                                                                           |           |
| `RunnerEventsRpc`                                            | `runner.events`                           | `{}`                                                                                                                                                                                                              | `RunnerEvent` (union below)                                                                                                                                                            | yes       |
| `RunnerDrainRpc`                                             | `runner.drain`                            | `{ graceMs }`                                                                                                                                                                                                     | `{}`                                                                                                                                                                                   |           |
| `RunnerProcessSpawnRpc`                                      | `process.spawn`                           | `{ command, args, cwd, env: Record, uid?, gid?, stdin, stdout, stderr: Literals(["pipe","ignore"]), extraFds: Array({ fd: Int >= 4, direction: Literals(["input","output"]) }), killSignal?, forceKillAfterMs? }` | `{ handle, pid }`                                                                                                                                                                      |           |
| `RunnerProcessOutputRpc`                                     | `process.output`                          | `{ handle, fd, fromSeq }`                                                                                                                                                                                         | `{ seq, data: Uint8Array }`                                                                                                                                                            | yes       |
| `RunnerProcessWriteRpc`                                      | `process.write`                           | `{ handle, fd, seq, data: Uint8Array }`                                                                                                                                                                           | `{ appliedThrough: StreamSeq }`                                                                                                                                                        |           |
| `RunnerProcessCloseInputRpc`                                 | `process.closeInput`                      | `{ handle, fd, seq }`                                                                                                                                                                                             | `{}`                                                                                                                                                                                   |           |
| `RunnerProcessSignalRpc`                                     | `process.signal`                          | `{ handle, signal, group: Boolean }`                                                                                                                                                                              | `{}`                                                                                                                                                                                   |           |
| `RunnerProcessWaitRpc`                                       | `process.wait`                            | `{ handle }`                                                                                                                                                                                                      | `{ exitCode: NullOr(Int), signal: NullOr(String) }`                                                                                                                                    |           |
| `RunnerProcessReleaseRpc`                                    | `process.release`                         | `{ handle }`                                                                                                                                                                                                      | `{}` (idempotent)                                                                                                                                                                      |           |
| `RunnerProcessRunRpc`                                        | `process.run`                             | `{ command, args, cwd, env, uid?, gid?, stdin?: Uint8Array, timeoutMs?, maxOutputBytes?, outputMode? }` (`ProcessRunInput`, `processRunner.ts:19`)                                                                | `{ stdout, stderr: Uint8Array, exitCode: NullOr(Int), signal: NullOr(String), timedOut, stdoutTruncated, stderrTruncated }` (the server decodes text and sets the `InvalidUtf8` flags) |           |
| `RunnerProcessRunStreamRpc`                                  | `process.runStream`                       | same payload                                                                                                                                                                                                      | `Union(output {fd, data}, exit {...})`                                                                                                                                                 | yes       |
| `RunnerPtyOpenRpc`                                           | `pty.open`                                | `PtySpawnInput` fields (`shell, args?, cwd, cols, rows`) + `env: Record`, `uid?`, `gid?`                                                                                                                          | `{ handle, pid }`                                                                                                                                                                      |           |
| `RunnerPtyOutputRpc`                                         | `pty.output`                              | `{ handle, fromSeq }`                                                                                                                                                                                             | `{ seq, data: String }`                                                                                                                                                                | yes       |
| `RunnerPtyInputRpc`                                          | `pty.input`                               | `{ handle, seq, data: String }`                                                                                                                                                                                   | `{ appliedThrough }`                                                                                                                                                                   |           |
| `RunnerPtyResizeRpc`                                         | `pty.resize`                              | `{ handle, seq, cols, rows }`                                                                                                                                                                                     | `{ appliedThrough }`                                                                                                                                                                   |           |
| `RunnerPtySignalRpc`                                         | `pty.signal`                              | `{ handle, seq, signal }`                                                                                                                                                                                         | `{ appliedThrough }`                                                                                                                                                                   |           |
| `RunnerPtyWaitRpc`                                           | `pty.wait`                                | `{ handle }`                                                                                                                                                                                                      | `{ exitCode, signal: NullOr(Int) }` (`PtyExitEvent`)                                                                                                                                   |           |
| `RunnerPtyReleaseRpc`                                        | `pty.release`                             | `{ handle }`                                                                                                                                                                                                      | `{}` (idempotent)                                                                                                                                                                      |           |
| `RunnerFs*Rpc` (13)                                          | `fs.stat` … `fs.makeTempDirectory`        | one struct per Effect `FileSystem` method's options; `readFile` adds `offset?`, `maxBytes`; `writeFile` adds `atomic?`                                                                                            | the method's result; `stat` returns `File.Info` with `mtime` as epoch ms                                                                                                               |           |
| `RunnerFsReadStreamRpc`                                      | `fs.readStream`                           | `{ path, offset?, chunkBytes? }`                                                                                                                                                                                  | `{ seq, data: Uint8Array }`                                                                                                                                                            | yes       |
| `RunnerFsWriteOpenRpc` / `…WriteChunkRpc` / `…WriteCloseRpc` | `fs.writeStream.open`, `.chunk`, `.close` | `{ path, atomic? }` / `{ handle, seq, data }` / `{ handle }`                                                                                                                                                      | `{ handle }` / `{ appliedThrough }` / `{}`                                                                                                                                             |           |
| `RunnerFsWatchRpc`                                           | `fs.watch`                                | `{ path, recursive }`                                                                                                                                                                                             | `Array({ _tag: Literals(["Create","Update","Remove"]), path })`                                                                                                                        | yes       |
| `RunnerForwardOpenRpc`                                       | `forward.open`                            | `{ name: Literals(["mcp","codex-token","git-credential"]), ownerKey }`                                                                                                                                            | `{ forwardId, address }`                                                                                                                                                               |           |
| `RunnerForwardCloseRpc`                                      | `forward.close`                           | `{ forwardId }`                                                                                                                                                                                                   | `{}`                                                                                                                                                                                   |           |
| `RunnerTcpReadRpc` / `WriteRpc` / `CloseRpc`                 | `tcp.read`, `tcp.write`, `tcp.close`      | `{ connectionId, fromSeq }` / `{ connectionId, seq, data }` / `{ connectionId }`                                                                                                                                  | as `process.output` / `.write`                                                                                                                                                         | read: yes |

`process.release` and `pty.release` are new against 03 §4.2: they are what a server-side scope
close sends, so a handle's group dies and its buffers are freed without waiting for exit
(**proposed**). There is no `processGroup` option on the wire: the runner puts every spawn in its
own group behind a watcher (1.6), which is 02's `"kill-on-close"` for every process. fd 3 is the
watcher's pipe, so extra fds start at 4 (**proposed**; no thread-scoped caller passes extra fds once
Claude's own watcher is replaced, and `headlessChrome.ts` is server-scoped). `uid`/`gid` exist
because the runner is root and agents run as `t3` (D3); Effect's `ChildProcess` has no uid option,
so the runner applies them with `setpriv` (1.6). `tcp.connect` is M2 (03 §11 #10) and stays out. `forward.open` is "call, scoped" in 03: the scope
lives on the server (1.13 closes with `forward.close` in a finalizer); no RPC is scoped.
`RunnerEvent = Union(forward.accepted { forwardId, connectionId }, ports.changed {},
resource.pressure { bufferedBytes, pausedHandles }, handle.exited { handle })`.

Coarse ops, names and payload shapes only. 1.10 owns the handlers; these shapes are the ones its
draft (in `m1-hub.md`) settled, so both PRs agree. Payloads reuse existing client contracts, so a
result is what `ws.ts` returns today:

| Rpc                             | Name                     | Payload                             | Success                                   | Stream         |
| ------------------------------- | ------------------------ | ----------------------------------- | ----------------------------------------- | -------------- |
| `RunnerOpsSearchEntriesRpc`     | `ops.search.entries`     | `ProjectSearchEntriesInput`         | `ProjectSearchEntriesResult`              |                |
| `RunnerOpsSearchContentsRpc`    | `ops.search.contents`    | `ProjectSearchContentsInput`        | `ProjectSearchContentsResult`             |                |
| `RunnerOpsSearchRefreshRpc`     | `ops.search.refresh`     | `{ cwd }`                           | `{}`                                      |                |
| `RunnerOpsEntriesBrowseRpc`     | `ops.entries.browse`     | `ProjectListEntriesInput`           | `ProjectListEntriesResult`                |                |
| `RunnerOpsProcessesTableRpc`    | `ops.processes.table`    | `{}`                                | `Array(ResourceMonitorProcessTableEntry)` | yes, on change |
| `RunnerOpsPortsListenersRpc`    | `ops.ports.listeners`    | `{ configuredUrls: Array(String) }` | `Array(DiscoveredLocalServer)`            | yes, on change |
| `RunnerOpsCheckpointCaptureRpc` | `ops.checkpoint.capture` | `RunnerOpsCheckpointCaptureInput`   | `RunnerOpsCheckpointCaptureResult`        |                |

```ts
export const RunnerOpsCheckpointCaptureInput = Schema.Union([
  Schema.TaggedStruct("baseline", { cwd: Schema.String, checkpointRef: CheckpointRef }),
  Schema.TaggedStruct("turn", {
    cwd: Schema.String,
    checkpointRef: CheckpointRef,
    previousCheckpointRef: CheckpointRef,
  }),
]);
export const RunnerOpsCheckpointCaptureResult = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "error"]),
  commitOid: Schema.NullOr(Schema.String), // 1.31's bundle prerequisite
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  warnings: Schema.Array(
    Schema.Literals([
      "capture-failed",
      "previous-ref-lookup-failed",
      "authored-paths-failed",
      "diff-summary-failed",
    ]),
  ),
});
export class RunnerOpsError extends Schema.TaggedError<RunnerOpsError>()("RunnerOpsError", {
  operation: Schema.Literals([
    "search.entries",
    "search.contents",
    "entries.browse",
    "search.refresh",
    "processes.table",
    "ports.listeners",
    "checkpoint.capture",
  ]),
  failure: Schema.Union([ProjectEntriesFailure, Schema.Literal("failed")]),
}) {}
```

A `"turn"` capture is one call for capture, the previous-ref lookup and the file summary (decision
2, 02 §5). All coarse ops take `error: Schema.Union([RunnerCallError, RunnerOpsError])`.

```ts
export const RunnerOpsRpcGroup = RpcGroup.make(/* the seven ops.* Rpcs */);
export const RunnerCoreRpcGroup = RpcGroup.make(
  RunnerHelloRpc,
  RunnerEventsRpc,
  RunnerDrainRpc /* process.*, pty.*, fs.*, forward.*, tcp.* */,
);
export const RunnerRpcGroup = RunnerCoreRpcGroup.merge(RunnerOpsRpcGroup); // const, as WsRpcGroup (rpc.ts:2136)
```

The two halves are separate so 1.6 provides `RunnerCoreRpcGroup.toLayer` and 1.10's `opsLayer.ts`
provides `RunnerOpsRpcGroup.toLayer`; until 1.10 lands, 1.6 serves the ops with a one-line layer
that fails `RunnerOpsError { failure: "failed" }`. Every string `name` is a `RUNNER_METHODS` const, as `WS_METHODS` is in
`rpc.ts:655`.

**Tests.** New `packages/contracts/src/runner.test.ts` (no existing file covers this module). Plain
`it` (03 §10 "Codec"): for one representative payload and success of every Rpc, `encode` then
`decode` through `SchemaBinary.toCodec(schema)` equals the input (a table over the group's
`requests`, so a new Rpc without a fixture fails the test). Assert `Uint8Array` data survives
byte-exact (include `0x00` and `0xff`), PTY text with a 4-byte code point survives, and a
`sandboxToken` decodes to `Redacted`. Frame cap: encode a `process.output` chunk with 256 KiB data
through `RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })`'s parser and see
it accepted, and 2× that rejected with `MaxBufferSizeExceeded`.

**Verify.** `vp test run packages/contracts/src/runner.test.ts`; `vp run typecheck` (contracts);
`vp run check:changed`. Confirm `apps/web` and `apps/mobile` do not import the subpath (knip and a
grep in the PR body).

**Reviewer checks.**

- No `export * from "./runner.ts"` in `index.ts`; nothing in web or mobile imports it.
- Every byte payload is `Schema.Uint8Array` (raw in SchemaBinary), never base64 strings.
- No thread ids anywhere on the wire: payloads carry cwds, handles and an opaque `ownerKey` (03 §1).
- `process.spawn.env` is the full environment; there is no "inherit" flag (03 §4.3).
- `runner.ts` imports only schemas, never server code; the coarse-op schemas reuse existing
  client RPC schemas instead of copying them.

### 1.2 `feat(contracts): add the sandbox record, thread sandboxId and sandbox commands`

Puts every sandbox shape on the wire at once, so 1.3, 1.5 and the client rows (1.37) build on fixed
names. Nothing sends them yet; the server only routes the new command types to the thread they name
and rejects them as unsupported until 1.5.

- **Needs:** 0.1 (row order only; no code dependency), 0.11 (`OrchestrationV2RunWorkspacePreparation`
  exists for the compatibility test). **Unblocks:** 1.3, 1.4, 1.5, 1.37.
- **Files:**
  - add `packages/contracts/src/sandbox.ts`: ids, literals, failure; exported from `index.ts`.
    1.36 needs `ComputeDriverId`, `ComputeDriverKind` and `SandboxSize` too; whichever of 1.2 and
    1.36 merges first adds the file with those three.
  - change `packages/contracts/src/index.ts`: `export * from "./sandbox.ts";` after `orchestrationV2.ts`.
  - change `packages/contracts/src/orchestrationV2.ts`: `OrchestrationV2Sandbox` (+ `Json`),
    `OrchestrationV2AppThread.sandboxId` (:445, and `OrchestrationV2AppThreadJson` :2340 inherits
    it), `OrchestrationV2ThreadShellSandbox` and `OrchestrationV2ThreadShell.sandbox` (:2127, and
    `…ShellJson` :2802), `OrchestrationV2ThreadProjection.sandbox` (:2066), `sandbox.updated` in
    `OrchestrationV2DomainEvent` (:1918) and `OrchestrationV2DomainEventJson` (:2849), the four
    client commands in `OrchestrationV2Command` (:2997), the internal commands in
    `OrchestrationV2InternalCommand` (:3534), `prepared-run.progress` phases (:3351).
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`: `commandThreadId` (:606) is an
    exhaustive switch with no default; add the sandbox types to the `return command.threadId` arm.
    `dispatchOnce`'s `default` already rejects them (:14130).
  - change `apps/server/src/orchestration-v2/Orchestrator.ts:10696`: the progress title becomes a
    `switch` over the six phases (two lines each).
  - change `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts:135` `commandThreadIds`
    if the type checker reports it non-exhaustive.

**Types, services and RPCs.**

```ts
// sandbox.ts
export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^sbx_[0-9a-f]{20}$/))
  .pipe(Schema.brand("SandboxId"));                 // path-safe: /t3-sandbox/<id>/ (README P1)
export const ComputeDriverId = TrimmedNonEmptyString.pipe(Schema.brand("ComputeDriverId"));
export const ComputeDriverKind = Schema.Literals(["docker"]);
export const SandboxState = Schema.Literals(["provisioning", "ready", "sleeping", "waking", "failed", "destroyed"]);
export const SandboxSize = Schema.Literals(["small", "default", "large"]);
export const SandboxAdmissionReason = Schema.Literals(["team-cap", "member-cap", "rate-limit"]);
export const SandboxSleepReason = Schema.Literals(["idle", "manual", "settled", "archived", "cap-pressure"]);
export const SandboxFailure = Schema.Struct({
  code: TrimmedNonEmptyString,   // open set: "create-failed" | "start-failed" | "boot-timeout" | "lost" | "driver-removed" | "workspace-failed"
  message: Schema.String,
  retryable: Schema.Boolean,
});

// orchestrationV2.ts
export const OrchestrationV2SandboxAdmission = Schema.Struct({ reason: SandboxAdmissionReason, since: Schema.DateTimeUtc });
export const OrchestrationV2Sandbox = Schema.Struct({
  id: SandboxId,
  projectId: ProjectId,
  ownerThreadId: ThreadId,                 // stream and outbox key; changes only by sandbox.adopt
  ownerMemberId: Schema.NullOr(MemberId),  // null on solo servers, like thread ownerId (proposed)
  driverId: ComputeDriverId,
  size: SandboxSize,
  state: SandboxState,
  generation: NonNegativeInt,
  driverRef: Schema.NullOr(Schema.String),
  admission: Schema.NullOr(OrchestrationV2SandboxAdmission),
  runnerLostAt: Schema.NullOr(Schema.DateTimeUtc),
  sleepReason: Schema.NullOr(SandboxSleepReason),
  failure: Schema.NullOr(SandboxFailure),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export const OrchestrationV2SandboxJson = OrchestrationV2Sandbox.mapFields((f) => ({ ...f,
  admission: Schema.NullOr(OrchestrationV2SandboxAdmission.mapFields((a) => ({ ...a, since: Schema.DateTimeUtcFromString }))),
  runnerLostAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString, updatedAt: Schema.DateTimeUtcFromString }));

// OrchestrationV2AppThread: absent on local threads; old clients drop the key.
sandboxId: Schema.optionalKey(SandboxId),

export const OrchestrationV2ThreadShellSandbox = Schema.Struct({
  state: ForwardCompatibleNullable(SandboxState),   // a later state shows "Machine status unknown"
  ownerThreadId: ThreadId,                          // "Shares the machine of …", owner-or-admin atoms (proposed)
  admission: Schema.optionalKey(Schema.Struct({ reason: ForwardCompatibleNullable(SandboxAdmissionReason), since: IsoDateTime })),
  runnerConnected: Schema.optionalKey(Schema.Boolean),
  failureCode: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
});
// OrchestrationV2ThreadShell: sandboxId: Schema.optionalKey(SandboxId),
//                             sandbox: Schema.optionalKey(OrchestrationV2ThreadShellSandbox)
// OrchestrationV2ThreadProjection: sandbox: Schema.optionalKey(OrchestrationV2Sandbox)
```

The shell summary uses `IsoDateTime` (a string) so `…ShellJson` needs no mapping. `ownerThreadId`
is new against 08 §2; without it a side chat's client can't show whose machine it shares or check
owner-or-admin on the owning thread. The shell also gets `sandboxId` (new against 08 §2) so server code that
scans shells, such as restore safety (1.17), can group threads by machine without reading details.

**Commands, events and effects.** Declared here, decided in 1.5, 1.16 and 1.17.

| Type                                           | Union                    | Payload (all have `commandId`, `threadId`)                              |
| ---------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `sandbox.wake`, `.sleep`, `.retry`, `.discard` | `OrchestrationV2Command` | `sandboxId`, `actorId?: MemberId`                                       |
| `sandbox.provision`                            | internal                 | `sandboxId`, `projectId`, `driverId`, `size`                            |
| `sandbox.admit`                                | internal                 | `sandboxId`, `generation`                                               |
| `sandbox.created`                              | internal                 | `sandboxId`, `generation`, `driverRef`                                  |
| `sandbox.runner.attached`                      | internal                 | `sandboxId`, `generation`, `runnerBootId: TrimmedNonEmptyString`        |
| `sandbox.runner.lost`                          | internal                 | `sandboxId`, `generation`, `runnerBootId`                               |
| `sandbox.stopped`, `sandbox.destroyed`         | internal                 | `sandboxId`, `generation`                                               |
| `sandbox.failed`                               | internal                 | `sandboxId`, `generation`, `failure: SandboxFailure`                    |
| `sandbox.auto-sleep`                           | internal                 | `sandboxId`, `snapshotAt: Schema.DateTimeUtc` (as `thread.auto-settle`) |
| `sandbox.adopt`                                | internal                 | `sandboxId`, `previousOwnerThreadId: ThreadId`                          |

`sandbox.recycle` is M2 (2.3) and is not declared. One event: `{ ...OrchestrationV2EventBase.fields,
type: "sandbox.updated", payload: OrchestrationV2Sandbox }`, `threadId` = `ownerThreadId`; the Json
union gets the same member with `OrchestrationV2SandboxJson`. `prepared-run.progress.phase` becomes
`["worktree", "setup", "sandbox-admission", "sandbox-start", "clone"]`, titled "Waiting for a
machine", "Starting machine", "Cloning repository"; cloud setup reuses `setup` ("Running setup
script"). The phase only sets the "Preparing workspace" item's title (`Orchestrator.ts:10665-10700`),
so clients need no change, and old clients never decode commands.

**Migrations.** None.

**Tests.** Extend `packages/contracts/src/orchestrationV2.test.ts` with one `describe("cloud
threads on older clients")`, following `auth.test.ts:26` (freeze the old vocabulary in the test):

- A cloud run's `workspacePreparation` `{ type: "worktree", baseRef, branch }` encodes and decodes
  with a frozen three-member union written out in the test (0.11's freeze, reused).
- `OrchestrationV2ThreadShellJson` with a `sandbox` summary decodes through a frozen pre-cloud shell,
  `OrchestrationV2ThreadShellJson.mapFields(({ sandbox: _s, ...rest }) => rest)`, to the same value
  minus `sandbox`; same for `OrchestrationV2AppThreadJson` without `sandboxId`.
- A summary with `state: "hibernating"` decodes on the new schema to `state: null`.
- A `sandbox.updated` stream item decodes through `OrchestrationV2ThreadStreamItem` as `event`, and
  `isKnownOrchestrationV2EventType("sandbox.updated")` is true.
- `SandboxId` refuses `../x` and uppercase hex. (The server mints ids in 1.16, `sandboxIdForLaunch`.)

**Verify.** `vp test run packages/contracts/src/orchestrationV2.test.ts`; `vp run typecheck` (contracts
and server change); `vp run check:changed`.

**Reviewer checks.**

- Every new key on an existing struct is `optionalKey`; no strict literal grew except the progress
  phase (a command, which clients never decode).
- `sandbox.updated` is in both the domain union and the Json union, or the event store can't read
  it back (`OrchestrationEventStore.ts:181`).
- `OrchestrationV2InternalCommand` stays unexported; only the four user commands are in the client
  union.
- `SandboxId` ends in `Id`, so `orchestrationV2IdTable.ts` interns `sandboxId` and `ownerThreadId`
  by key on compact-id snapshots; both peers apply that rule, so no change there.
- No `ThreadEnvMode`, project or run literal mentions `cloud`.

### 1.3 `feat(server): project sandboxes and record sandbox usage intervals`

Gives the sandbox record, its thread membership and its machine-time ledger durable tables, and
shows the summary on every attached thread's shell. Its own PR because it is the only schema change
of the lifecycle track, and 1.5's decisions read these rows.

- **Needs:** 1.2. **Unblocks:** 1.5, 1.17, 1.18, 1.19, 2.17 (usage reads).
- **Files:**
  - add `apps/server/src/persistence/Migrations/088_SandboxProjections.ts`; register `[88,
    "SandboxProjections", Migration0088]` after `[87, "MemberPushDevices", …]` in
    `apps/server/src/persistence/Migrations.ts:183`.
  - add `apps/server/src/sandbox/lifecycle/SandboxProjection.ts`: the projector steps and reads as
    plain Effect functions over `SqlClient.SqlClient`, plus the pure `usageIntervalChange`.
  - change `apps/server/src/orchestration-v2/ProjectionStore.ts`:
    - `apply` (:2133): a `case "sandbox.updated"` arm calling `applySandboxUpdated`; in the
      `thread.*` arm (:2147, after the upsert at :2224) one call to `applySandboxMembership`.
    - `applyToProjection` (:864, exhaustive): `case "sandbox.updated": return { ...projection,
      sandbox: event.payload }`, without `base`, so a machine change never reorders the sidebar.
    - `ProjectionStoreV2Shape` (:474): `getSandbox`, `listSandboxThreads`, `getSandboxIdsForThreads`
      wrappers (one line each over the module above), so the orchestrator keeps reading through
      `projectionStore`.
    - shell reads: `decodeShellSnapshot` (:7242) loads the sandboxes of its thread rows in one
      query and passes `sandbox` into `shellFromState` (:1988), which also copies `thread.sandboxId`; `threadShellFromProjection` (:1624)
      reads `projection.sandbox`. Both call `sandboxShellSummary(record)`.
    - thread detail reads (`getThreadProjection` and the bounded snapshot) set `sandbox` from the
      thread's `sandboxId` for every attached thread, not only the owner.
  - change `apps/server/src/orchestration-v2/ShellStream.ts:494` `toShellApplicationEvent`: keep
    `sandboxId` on a `sandbox.updated` entry; and `apps/server/src/ws.ts:1228` `projectShellItems`:
    expand such an entry into one entry per attached live thread (`listSandboxThreads`) before
    `coalesceShellApplicationEvents`, so side chats and forks get their shell re-sent (08 §2).

**Types, services and RPCs.**

```ts
// sandbox/lifecycle/SandboxProjection.ts
export interface SandboxThreadRow { readonly threadId: ThreadId; readonly attachedAt: DateTime.Utc; readonly archived: boolean }
export const applySandboxUpdated: (event: Extract<OrchestrationV2DomainEvent, { type: "sandbox.updated" }>)
  => Effect.Effect<void, SqlError, SqlClient.SqlClient>;
export const applySandboxMembership: (thread: OrchestrationV2AppThread, at: DateTime.Utc)
  => Effect.Effect<void, SqlError, SqlClient.SqlClient>;
export const getSandbox: (id: SandboxId) => Effect.Effect<OrchestrationV2Sandbox | null, ProjectionStoreError, SqlClient.SqlClient>;
export const getSandboxes: (ids: ReadonlyArray<SandboxId>) => Effect.Effect<ReadonlyMap<SandboxId, OrchestrationV2Sandbox>, …>;
/** Live (not deleted) threads using the sandbox, oldest first: attached_at, then thread_id. */
export const listSandboxThreads: (id: SandboxId) => Effect.Effect<ReadonlyArray<SandboxThreadRow>, …>;
export const sandboxShellSummary: (record: OrchestrationV2Sandbox) => OrchestrationV2ThreadShellSandbox;

/** "Billed" = provisioning, waking or ready with no admission (04 §4 "running"). */
export const isBilled = (s: OrchestrationV2Sandbox) =>
  s.admission === null && (s.state === "ready" || s.state === "provisioning" || s.state === "waking");
export type UsageIntervalChange =
  | { readonly close: boolean; readonly open: null }
  | { readonly close: boolean; readonly open: { threadId: ThreadId; memberId: MemberId | null; driverId: ComputeDriverId; size: SandboxSize } };
export const usageIntervalChange: (open: OpenInterval | null, next: OrchestrationV2Sandbox) => UsageIntervalChange;
```

`usageIntervalChange` closes the open row when the record stops being billed or when its owner
thread, owner member or size changes (adopt, reassign), and opens a row when the record is billed
and no row stays open. Every boundary uses `event.occurredAt`, so a replayed event writes nothing
new (the upsert finds the same state). `sandboxShellSummary` sets `runnerConnected` to
`state === "ready" && runnerLostAt === null`; the 2 s live indicator from the hub is 1.7's.

**Commands, events and effects.** None new. The projector consumes `sandbox.updated` and the
existing thread events: a thread payload with `sandboxId` upserts its `sandbox_threads` row
(`archived` from `archivedAt !== null`, `attached_at` kept on conflict), and one with `deletedAt`
set deletes it. Forks and side chats get rows from their `thread.created`, because
`ThreadForkService` spreads the source thread (`ThreadForkService.ts:103`). Delegated children get
one the same way (`makeSubagentChildThread` in `packages/provider-core/src/server/subagentProjection.ts:52`
spreads the parent). Provider-native subagent threads (`isProviderNativeSubagentThread`) inherit
`sandboxId` too but get no row: they never prompt, and their work is their parent's turn.

**Migrations.** `088_SandboxProjections.ts`:

```sql
CREATE TABLE IF NOT EXISTS orchestration_v2_projection_sandboxes (
  sandbox_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_thread_id TEXT NOT NULL,
  owner_member_id TEXT, driver_id TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL,
  admission_since TEXT, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_owner_thread ON orchestration_v2_projection_sandboxes (owner_thread_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_state_driver ON orchestration_v2_projection_sandboxes (state, driver_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_admission ON orchestration_v2_projection_sandboxes (admission_since)
  WHERE admission_since IS NOT NULL;
CREATE TABLE IF NOT EXISTS orchestration_v2_projection_sandbox_threads (
  sandbox_id TEXT NOT NULL, thread_id TEXT NOT NULL, attached_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sandbox_id, thread_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_sandbox_threads_thread ON orchestration_v2_projection_sandbox_threads (thread_id);
CREATE TABLE IF NOT EXISTS sandbox_usage_intervals (
  interval_id INTEGER PRIMARY KEY AUTOINCREMENT, sandbox_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  member_id TEXT, driver_id TEXT NOT NULL, size TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_usage_open ON sandbox_usage_intervals (sandbox_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sandbox_usage_member ON sandbox_usage_intervals (member_id, started_at);
```

No `sandbox_id` column on `orchestration_v2_projection_threads` (proposed): the
thread payload already carries `sandboxId`, and `sandbox_threads` indexes thread to sandbox, so a
column would be a second copy with its own write path. The ledger has no `orchestration_v2_`
prefix because it is not rebuilt from events (they are pruned after a day, 04 §1); like
`082_ThreadMemberState` it is a durable table. Nothing deletes from it in M1.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxProjection.test.ts` (new; no existing table covers the
  rule): `usageIntervalChange` as an `it.each` table: provisioning → open; admission set → close;
  ready → nothing; adopt (owner thread changes) → close and open; failed, sleeping, destroyed →
  close; a replayed identical record → nothing.
- `apps/server/src/orchestration-v2/ProjectionStore.test.ts`, inside `it.layer(layerTest)
  ("ProjectionStoreV2", …)` (:2659), one `it.effect("projects sandboxes, their threads and usage
  intervals")`: apply `thread.created` with `sandboxId`, a fork's `thread.created`, `sandbox.updated`
  (provisioning, then ready, then failed), `thread.archived` on the fork, `thread.deleted` on the
  owner; assert the row, `listSandboxThreads` order and `archived`, one closed interval, and that
  `getShellSnapshot` shows the summary on both threads. Applying the same events twice changes
  nothing.
- `ProjectionStore.test.ts` "SQL projection keeps background thread updates out of updatedAt"
  (:1629): add `sandbox.updated` to the events that must not move `updatedAt`.
- `apps/server/src/orchestration-v2/ShellStream.test.ts`: extend the `toShellApplicationEvent`
  case with a `sandbox.updated` entry keeping `sandboxId`.
- No migration test: the SQL is additive DDL, `Migrations.test.ts` already guards the manifest
  order, and the projection case above runs against the migrated schema.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle/SandboxProjection.test.ts
apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/ShellStream.test.ts`;
`vp run typecheck`; `vp run check:changed`. No runtime surface yet.

**Reviewer checks.**

- `sandbox.updated` never goes through `base` in `applyToProjection`, and the SQL arm writes no
  thread `updated_at`: machine state must not reorder threads.
- Membership comes only from thread payloads, never from a counter on the sandbox row.
- At most one open interval per sandbox (the partial unique index), and every boundary uses the
  event's `occurredAt`, not the clock, so replay is a no-op.
- The shell snapshot loads sandboxes in one batched query, not one per thread (perf rule).
- `projectShellItems` expands a sandbox event to live threads only, and dedupes through the
  existing coalescing.

### 1.4 `feat(server): add the ComputeDriver service, driver instances, fake driver and contract suite`

Makes "a compute driver" one typed value the lifecycle code can call, looked up by the instance id
in `ServerSettings.sandbox.drivers`, with a fake for orchestration tests and one contract suite every
real driver must pass. Its own PR because 1.5 (effects), 1.14 (Docker) and later vendor drivers all
build on the interface and the fake, and none of them should define it.

- **Needs:** 1.2 (`SandboxId`, `SandboxSize`, `ComputeDriverId`, `ComputeDriverKind`), 1.36
  (`ServerSettings.sandbox.drivers`). **Unblocks:** 1.5, 1.14, 1.19, 2.5, 5.4.
- **Files:**
  - add `apps/server/src/sandbox/compute/ComputeDriver.ts`: `ComputeDriver` tag, `ComputeCapabilities`,
    `SandboxBootstrap`, `BackendSandbox`, `ComputeDriverError`, `sandboxBackendName`, `sandboxTags`,
    `parseSandboxTags`.
  - add `apps/server/src/sandbox/compute/ComputeDriverRegistry.ts`: the registry, keyed by
    `ComputeDriverId`, built from settings on demand.
  - add `apps/server/src/sandbox/compute/ComputeDriverTesting.ts`: `FakeComputeDriver` and
    `answerFromMemory` (an in-memory backend that answers the fake's queue).
  - add `apps/server/src/sandbox/compute/computeDriverContract.ts`: `computeDriverContract` and the
    stand-in-runner server it uses.
  - add `apps/server/src/sandbox/compute/ComputeDriverRegistry.test.ts`,
    `apps/server/src/sandbox/compute/ComputeDriverTesting.test.ts` (runs the contract on the fake).
  - Not here: wiring into `server.ts`. 1.5 is the first consumer and provides the layer there.

**Types, services and RPCs.** Registry returning driver values, not a `Context.Service` per
instance: instances appear and change with Settings at runtime, and a layer per instance would need
the rebuild loop `ProviderInstanceRegistry.ts` carries (583 lines) for no gain. `ComputeDriver` stays
a `Context.Service` class so the value type reads `ComputeDriver["Service"]`, as
`ProviderAdapterRegistryV2.get` returns `ProviderAdapter.ProviderAdapterV2["Service"]`
(`orchestration-v2/ProviderAdapterRegistry.ts:43`), and so the contract suite can provide one.

```ts
export const ComputeDriverErrorReason = Schema.Literals([
  "not-found",
  "conflict",
  "capacity",
  "quota",
  "rate-limited",
  "auth",
  "invalid-request",
  "unsupported",
  "unavailable",
]);
// 04 §6's `detail` is dropped: effect-services.md forbids copying cause text into attributes.
export class ComputeDriverError extends Schema.TaggedError<ComputeDriverError>()(
  "ComputeDriverError",
  {
    driverId: ComputeDriverId,
    operation: Schema.Literals([
      "create",
      "start",
      "stop",
      "destroy",
      "status",
      "list",
      "deleteImage",
      "health",
    ]),
    reason: ComputeDriverErrorReason,
    retryable: Schema.Boolean,
    retryAfterMs: Schema.optionalKey(NonNegativeInt), // carried now, honored in 2.4
    backendStatus: Schema.optionalKey(Schema.Number), // e.g. the Engine API's HTTP status
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Compute driver ${this.driverId} failed to ${this.operation}: ${this.reason}.`;
  }
}

export interface ComputeCapabilities {
  /* exactly 04 §6, static per driver kind */
}
export interface SandboxBootstrap {
  /* exactly 04 §6 */
}
export type BackendSandboxStatus = "starting" | "running" | "stopped" | "failed" | "missing";
export interface BackendSandbox {
  readonly driverRef: string;
  readonly name: string;
  readonly sandboxId: SandboxId | null;
  readonly status: BackendSandboxStatus;
  readonly createdAt: DateTime.Utc;
}
export interface BaseImageInfo {
  readonly ref: string;
  readonly digest: string;
  readonly version: string | null;
} // 1.23 fills it
export interface ComputeDriverHealth {
  readonly isolation: ComputeCapabilities["isolation"];
  readonly privateNetworkBlock:
    | { readonly applied: true }
    | { readonly applied: false; readonly reason: string };
  readonly baseImage: BaseImageInfo | { readonly missing: string } | null;
}

export class ComputeDriver extends Context.Service<
  ComputeDriver,
  {
    readonly driverId: ComputeDriverId;
    readonly kind: ComputeDriverKind;
    readonly capabilities: ComputeCapabilities;
    readonly create: (input: {
      readonly name: string;
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly image:
        | { readonly type: "build"; readonly imageRef: string }
        | { readonly type: "base" };
      readonly size: SandboxSize;
      readonly tags: Readonly<Record<string, string>>;
      readonly bootstrap: SandboxBootstrap;
    }) => Effect.Effect<
      { readonly driverRef: string; readonly baseImage: BaseImageInfo | null },
      ComputeDriverError
    >;
    readonly start: (
      driverRef: string,
      bootstrap: SandboxBootstrap,
    ) => Effect.Effect<void, ComputeDriverError>;
    readonly stop: (driverRef: string) => Effect.Effect<void, ComputeDriverError>;
    readonly destroy: (driverRef: string) => Effect.Effect<void, ComputeDriverError>;
    readonly status: (driverRef: string) => Effect.Effect<BackendSandbox, ComputeDriverError>;
    readonly list: (
      tags: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<BackendSandbox>, ComputeDriverError>;
    readonly deleteImage: (imageRef: string) => Effect.Effect<void, ComputeDriverError>; // not-found is success
    readonly health: Effect.Effect<ComputeDriverHealth, ComputeDriverError>; // Settings → Cloud Test (1.40)
  }
>()("t3/sandbox/compute/ComputeDriver") {}
// snapshot and buildImage join in M3 (04 §10 #17); nothing calls them in M1, and knip would flag stubs.

export const sandboxBackendName = (
  installId: EnvironmentId,
  sandboxId: SandboxId,
  generation: number,
) => `pair-${installId.slice(0, 8)}-${sandboxId}-g${generation}`;
export const sandboxTags = (i: {
  installId: EnvironmentId;
  sandboxId: SandboxId;
  generation: number;
  driverId: ComputeDriverId;
}) => ({
  "pair.install": i.installId,
  "pair.sandbox": i.sandboxId,
  "pair.generation": String(i.generation),
  "pair.driver": i.driverId,
});

export class ComputeDriverRegistry extends Context.Service<
  ComputeDriverRegistry,
  {
    readonly get: (
      driverId: ComputeDriverId,
    ) => Effect.Effect<ComputeDriver["Service"], ComputeDriverNotConfiguredError>;
    readonly list: Effect.Effect<ReadonlyArray<ComputeDriver["Service"]>>;
  }
>()("t3/sandbox/compute/ComputeDriverRegistry") {}

export type ComputeDriverFactory<K extends ComputeDriverKind> = (
  config: Extract<SandboxDriverInstance, { readonly kind: K }>,
) => Effect.Effect<ComputeDriver["Service"], never, Scope.Scope>;
export const layer = (factories: { readonly [K in ComputeDriverKind]?: ComputeDriverFactory<K> }) =>
  Layer.effect(ComputeDriverRegistry, make(factories)); // needs ServerSettingsService
```

`make` keeps `Ref<Map<ComputeDriverId, { config, driver, scope }>>`. `get` reads
`ServerSettingsService.getSettings` (`serverSettings.ts:322`), finds the instance, and reuses the
cached driver when `Schema.toEquivalence(SandboxDriverInstance)` says the config is unchanged;
otherwise it closes the old entry's `Scope` (the Docker driver's dispatcher lives there; in-flight
calls on it fail `unavailable`, retryable) and builds a new one. Removed instances are closed on the
next `get` or `list`. Reading per call is how it reacts to settings changes; no stream subscription.
`ComputeDriverNotConfiguredError { driverId }` covers a removed instance and a kind with no factory.
Install id is `ServerEnvironmentIdentity.getEnvironmentId` (`environment/ServerEnvironment.ts:52`), a
UUID persisted at `config.environmentIdPath` (`config.ts:169`), per P2. A dev worktree has its own
state dir, so its reconciler never sees the developer's real sandboxes.

**`FakeComputeDriver`** (`ComputeDriverTesting.ts`): every call is offered to a `Queue` with a
`Deferred` the test completes or fails, so the test decides when and how the backend answers.

```ts
export type FakeComputeCall =
  | { readonly _tag: "create"; readonly input: CreateInput; readonly reply: Deferred.Deferred<CreateResult, ComputeDriverError> }
  | { readonly _tag: "start"; readonly driverRef: string; readonly bootstrap: SandboxBootstrap; readonly reply: Deferred.Deferred<void, ComputeDriverError> }
  | { readonly _tag: "stop" | "destroy" | "deleteImage"; readonly ref: string; readonly reply: Deferred.Deferred<void, ComputeDriverError> }
  | { readonly _tag: "status"; readonly driverRef: string; readonly reply: Deferred.Deferred<BackendSandbox, ComputeDriverError> }
  | { readonly _tag: "list"; readonly tags: Readonly<Record<string, string>>; readonly reply: Deferred.Deferred<ReadonlyArray<BackendSandbox>, ComputeDriverError> };
export const make: (driverId?: ComputeDriverId) => Effect.Effect<{ readonly driver: ComputeDriver["Service"]; readonly calls: Queue.Dequeue<FakeComputeCall> }>;
export const layerRegistry: (fake: ComputeDriver["Service"]) => Layer.Layer<ComputeDriverRegistry>; // every id → the fake
export const answerFromMemory: (calls: Queue.Dequeue<FakeComputeCall>) => Effect.Effect<never, never, Scope.Scope>;
```

`answerFromMemory` keeps a map of sandboxes, answers each call, and on create and start "boots" by
posting the bootstrap to `bootstrap.serverUrl` the way the stand-in runner does.

**`computeDriverContract(name, makeDriver)`** registers one `describe` of `it.live` cases (they are
network fixtures). `makeDriver(installId)` returns `Effect<ComputeDriver["Service"], never, Scope>`.
The suite starts a stand-in-runner server on a Unix socket in a temp dir and passes
`serverUrl: "unix:<path>"` in every bootstrap. **Proposed:** the stand-in posts its hello over plain
HTTP, not a WebSocket: the test image then needs only Node, and what is under test is the mount and
the bootstrap, not the runner protocol (1.7 owns that). Hello body: `{ sandboxId, generation,
enroll, marker }`, where `marker` is the content of `/t3-sandbox/<sandboxId>/contract-marker` before
the stand-in writes `g<generation>` there. The server keeps a `Deferred` per `(sandboxId,
generation)`. Cases:

1. Create twice with one name returns one `driverRef`; `list` shows one sandbox.
2. Hello arrives with this generation's `sandboxId` and enrollment secret (bootstrap delivered).
3. Stop, then start generation 2: the second hello reports `marker: "g1"` (disk kept).
4. Stop twice and destroy twice succeed.
5. A second driver with another install id creates a sandbox; `list` with ours excludes it.
6. After destroy, `status` reports `missing` and `list` omits it.

**Tests.** New files, since no compute code exists. `ComputeDriverRegistry.test.ts` (`it.effect`,
`ServerSettingsService.layerTest`, `serverSettings.ts:345`): a config change rebuilds the driver and
closes the old scope; an unchanged config reuses it; a removed id fails
`ComputeDriverNotConfiguredError`. `ComputeDriverTesting.test.ts` runs `computeDriverContract` on
`FakeComputeDriver` plus `answerFromMemory`, which proves the suite and the fake agree.

**Verify.** `vp test run apps/server/src/sandbox/compute`, `vp run typecheck` (server),
`vp run check:changed`. No runtime surface yet.

**Reviewer checks.**

- No `detail` attribute copied from a cause; `retryable` is set at the construction site, not
  derived later from `reason`.
- The registry closes a replaced driver's scope and never caches across a config change.
- Names and tags come only from `sandboxBackendName` and `sandboxTags`; the install id is the
  environment id, not the telemetry id (P2).
- The contract suite uses `Deferred`s and `it.live` only for the socket and backend; no sleeps or
  polling, no per-test timeouts.
- No `snapshot`/`buildImage` stubs; `deleteImage` treats not-found as success.

### 1.5 `feat(server): decide sandbox commands and run driver effects by generation`

Makes every sandbox transition a decided command whose driver call runs as an outbox effect,
bounded at 60 s, replay safe after a crash, and dropped when its generation is stale. It folds the
old 1.5a in, because the bound and the replay-safe list are keyed by the effect types this PR adds.

- **Needs:** 1.3 (rows and reads), 1.4 (`ComputeDriverRegistry`, `ComputeDriverError`,
  `SandboxBootstrap`, `FakeComputeDriver`). **Unblocks:** 1.7 (attach and lost commands exist),
  1.16, 1.17, 1.19.
- **Files:**
  - add `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: pure `decideSandboxCommand`, the
    state table, effect builders, refusal type.
  - add `apps/server/src/sandbox/lifecycle/SandboxEffects.ts`: `SandboxEffects` service with
    `execute` and `reportExhausted`, calling `ComputeDriverRegistry`.
  - add `apps/server/src/sandbox/lifecycle/SandboxBootstrapSource.ts`: `SandboxBootstrapSource`
    service (`forGeneration`) with `layerUnconfigured`, which fails every call; 1.7 replaces it with
    the real enrollment and bundle source. Nothing provisions before 1.16, so nothing hits it.
  - change `apps/server/src/orchestration-v2/EffectOutbox.ts`: one member in
    `OrchestrationEffectRequestV2` (:32), five types in `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`
    (:125).
  - change `apps/server/src/orchestration-v2/EffectWorker.ts`: a `case` in `layerExecutor` (:100)
    delegating to `SandboxEffects.execute`; `boundExecution` (:585) from a ternary to a lookup; one
    call to `reportExhausted` in the terminal-failure branch (:822).
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`: one `case` group in `dispatchOnce`
    (:13738) calling `dispatchSandboxCommand` (a ~30-line helper beside `dispatchPreparedRunRelease`);
    `sandbox.wake`, `sandbox.stopped`, `sandbox.destroyed`, `sandbox.runner.attached` on the no-event
    allow list (:14226); `OrchestratorSandboxCommandMovedError` beside the mode-limit refusals that
    keep no receipt (:14249).
  - change `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`: route `sandbox.*` to the
    owner thread and check owner-or-admin for sleep and discard in `assertTeamPermission` (:57).
  - change `apps/server/src/orchestration-v2/runtimeLayer.ts`: provide `SandboxEffects.layer`,
    `SandboxBootstrapSource.layerUnconfigured` and 1.4's registry to the executor.

**Types, services and RPCs.**

```ts
// SandboxDecisions.ts (pure; the orchestrator gathers the inputs under the owner's lock)
export interface SandboxDecisionInput {
  readonly command: SandboxCommand;                     // Extract<OrchestrationV2ServerCommand, { type: `sandbox.${string}` }>
  readonly record: OrchestrationV2Sandbox | null;
  readonly activeRunThreadIds: ReadonlyArray<ThreadId>; // attached live threads with activeRunId !== null
  readonly now: DateTime.Utc;
}
export type SandboxEffectRequest = Extract<OrchestrationEffectRequestV2, { type: `sandbox.${string}` }>;
export type SandboxDecision =
  | { readonly _tag: "Accept"; readonly next: OrchestrationV2Sandbox; readonly effects: ReadonlyArray<SandboxEffectRequest> }
  | { readonly _tag: "NoOp" }                                  // stale generation, or already there
  | { readonly _tag: "Refuse"; readonly reason: SandboxRefusalReason };
export const SandboxRefusalReason = Schema.Literals(["not-found", "not-owner-thread", "wrong-state", "active-run"]);
export const decideSandboxCommand: (input: SandboxDecisionInput) => SandboxDecision;

// SandboxEffects.ts
export class SandboxEffects extends Context.Service<SandboxEffects, {
  readonly execute: (effect: OrchestrationEffectV2 & { readonly request: SandboxEffectRequest })
    => Effect.Effect<void, SandboxEffectError>;
  /** Called by the worker after the last attempt fails, outside the 60 s bound. */
  readonly reportExhausted: (effect: OrchestrationEffectV2, error: string) => Effect.Effect<void>;
}>()("t3/sandbox/SandboxEffects") {}
export class SandboxEffectError extends Schema.TaggedError<SandboxEffectError>()("SandboxEffectError", {
  sandboxId: SandboxId, operation: Schema.Literals(["create", "start", "stop", "destroy", "status", "report"]),
  retryable: Schema.Boolean, cause: Schema.Defect(),
}) {}
export const layer: Layer.Layer<SandboxEffects, never,
  ComputeDriverRegistry | SandboxBootstrapSource | ProjectionStoreV2 | ThreadManagementService | ServerEnvironment>;
```

The state table `decideSandboxCommand` follows (04 §1; M2 rows are not built):

| Command                   | From                                                                     | Next                                                          | Effects                                        |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------- |
| `sandbox.provision`       | none, or `destroyed`                                                     | `provisioning`, generation +1, `driverRef: null`              | `sandbox.create`                               |
| `sandbox.created`         | `provisioning`, same generation                                          | `driverRef` set                                               | none                                           |
| `sandbox.runner.attached` | `provisioning`/`waking`, same generation; or `ready` with `runnerLostAt` | `ready`, `runnerLostAt: null`, `failure: null`                | none (1.16 adds `sandbox.release-waiters`)     |
| `sandbox.runner.lost`     | `ready`, same generation                                                 | `runnerLostAt: now`                                           | `sandbox.status`                               |
| `sandbox.wake`            | `sleeping`; `failed` and retryable                                       | `waking`, generation +1                                       | `sandbox.start`                                |
| `sandbox.wake`            | `destroyed` ("Start a new machine")                                      | `provisioning`, generation +1, `driverRef: null`              | `sandbox.create`                               |
| `sandbox.retry`           | `failed`                                                                 | `waking` with `driverRef`, else `provisioning`; generation +1 | `sandbox.start` or `sandbox.create`            |
| `sandbox.sleep`           | `ready`, no active run                                                   | `sleeping`, `sleepReason: "manual"`                           | `sandbox.stop`                                 |
| `sandbox.stopped`         | `ready`/`waking`, same generation                                        | `sleeping`                                                    | none                                           |
| `sandbox.discard`         | `failed`, `sleeping`; `ready` with no active run                         | `destroyed`                                                   | `sandbox.stop` (if `ready`), `sandbox.destroy` |
| `sandbox.destroyed`       | not `destroyed`                                                          | `destroyed`                                                   | none                                           |
| `sandbox.failed`          | any but `destroyed`, same generation                                     | `failed`, `failure`                                           | none (1.16 adds release)                       |

`sandbox.wake` on `waking` or `ready`, `sandbox.stopped` on `sleeping`, `sandbox.destroyed` on
`destroyed`, and `sandbox.runner.attached` on `ready` without `runnerLostAt` are `NoOp`, and those
four types join the no-event allow list, so they record an accepted receipt (04 §2). Every other
`NoOp` (a stale generation) is rejected with a receipt; its id carries the generation, so that is
harmless. `sandbox.auto-sleep` and `sandbox.admit` stay unsupported until 1.19 and 1.18.

```ts
// Orchestrator.ts, dispatchOnce: one arm; the helper reads, decides and appends.
case "sandbox.wake": case "sandbox.sleep": case "sandbox.retry": case "sandbox.discard":
case "sandbox.provision": case "sandbox.created": case "sandbox.runner.attached":
case "sandbox.runner.lost": case "sandbox.stopped": case "sandbox.destroyed": case "sandbox.failed":
  yield* dispatchSandboxCommand(command, events, effects);
  break;
```

`dispatchSandboxCommand` reads `projectionStore.getSandbox`, the attached threads' shells for
active runs, and `DateTime.now`; calls `decideSandboxCommand`; appends `sandbox.updated` (`threadId:
next.ownerThreadId`, `updatedAt: now`) and each effect as `{ id: \`effect:${commandId}:${type}\`,
commandId, threadId: next.ownerThreadId, request }`. `Refuse`with`not-owner-thread`fails with`OrchestratorSandboxCommandMovedError`, which the receipt branch rethrows without a receipt, as it
does `OrchestratorThreadAboveModeLimitError`; the intake re-routes once. Other refusals are
`OrchestratorDispatchError`s with a receipt. `sandbox.provision`mints`SandboxId` in 1.16, not here.

**Commands, events and effects.**

```ts
// EffectOutbox.ts, one member; every type is replay safe
Schema.Struct({
  type: Schema.Literals(["sandbox.create", "sandbox.start", "sandbox.stop", "sandbox.destroy", "sandbox.status"]),
  sandboxId: SandboxId,
  generation: NonNegativeInt,
}),

// EffectWorker.ts, boundExecution becomes a lookup (mechanical)
const EFFECT_TIMEOUTS: Partial<Record<OrchestrationEffectRequestV2["type"], Duration.Duration>> = {
  "delegated-tasks.stop": Duration.seconds(30),
  "sandbox.create": Duration.seconds(60), "sandbox.start": Duration.seconds(60),
  "sandbox.stop": Duration.seconds(60), "sandbox.destroy": Duration.seconds(60), "sandbox.status": Duration.seconds(60),
};
// terminal branch (:822): before outbox.fail
if (isSandboxEffect(effect)) yield* sandboxEffects.reportExhausted(effect, error);
```

The executor first reads the record. A request whose `generation` differs from the record's, or
whose sandbox is `destroyed` (except `sandbox.destroy`), succeeds without a driver call. Then:
`create` builds the name `pair-<installId8>-<sandboxId>-g<generation>` (install id from
`ServerEnvironment.getEnvironmentId`, README P2), tags `pair.install`, `pair.sandbox`,
`pair.generation`, gets a bootstrap from `SandboxBootstrapSource.forGeneration`, calls
`driver.create`, and dispatches `sandbox.created` (`sandbox-created:<id>:<generation>`). `start`
calls `driver.start`; the hello marks it ready. `stop` and `destroy` call the driver (not-found is
success) and dispatch `sandbox.stopped` / `sandbox.destroyed` (`sandbox-stopped:<id>:<generation>`,
`sandbox-destroyed:<id>:<generation>`). `status` maps `stopped` to `sandbox.stopped`, `missing` or
`failed` to `sandbox.failed { code: "lost", retryable: true }` (`sandbox-failed:<id>:<generation>:lost`),
and `running` to nothing (the boot deadline in 1.19 covers a runner that never returns). A driver
id missing from settings fails with `driver-removed`, not retryable. Inside one attempt, retryable
`ComputeDriverError`s retry 3 times, 2 s apart (`Schedule.spaced`), well under the bound.
Dispatches go through `ThreadManagementService.dispatch` to `record.ownerThreadId`; a
`OrchestratorCommandPreviouslyRejectedError` on a report counts as delivered.
`reportExhausted` dispatches `sandbox.failed` with id `sandbox-failed:<id>:<generation>:<effectType>`
and `retryable` from the last `ComputeDriverError` (true for a timeout).

Client commands: `ThreadMessageIntake.dispatchCommand` reads the acting thread; refuses unless its
`sandboxId` equals `command.sandboxId`; reads the record; for `sandbox.sleep` and `sandbox.discard`
requires the actor to be an admin, the server owner, or the owner of `ownerThreadId`'s thread
(`ThreadMessageIntakeForbiddenError` with a new reason `machine_not_owner_or_admin`: "Only the
owner or an admin can sleep or discard this machine.");
then dispatches `{ ...command, threadId: record.ownerThreadId }`. Wake and retry are open to every
member (08 §7).

**Migrations.** None.

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts` (new): the state table above as one
  `it.each`, including stale generations, the four allow-listed no-ops, and sleep/discard refused
  with an active run on a side chat.
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts` (new, the decider harness 1.16–1.19
  extend): `ThreadManagementService.layer` over test SQLite as in `ThreadStop.test.ts:55`, plus
  `FakeComputeDriver`, a recording `SandboxBootstrapSource` and the real worker. Cases: provision →
  create answered by the test's `Deferred` → `sandbox.created` stored; a create that fails five
  times stores `sandbox.failed` (drain the worker; the fake fails immediately); a `sandbox.start`
  for generation 1 after a retry moved to generation 2 makes no driver call; `sandbox.runner.lost`
  then status `missing` → `failed` with `lost`.
- `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2505` ("starts later thread work
  behind a delegated-task stop that never returns"): parameterize over `delegated-tasks.stop` and
  `sandbox.start`, and for the sandbox row assert `reportExhausted` ran once after the timeout
  (a `Deferred` in the fake executor). Waits by `TestClock.adjust`, as the case already does.
- `FoundationPersistence.test.ts:2718` ("requeues $type after process loss"): add the five sandbox
  types to its table.
- `ThreadMessageIntake.test.ts`: extend the `thread.delete` permission case with `sandbox.sleep`
  from a side chat by a non-owner (refused) and by an admin (routed to the owner thread).

**Verify.** `vp test run apps/server/src/sandbox/lifecycle apps/server/src/orchestration-v2/FoundationPersistence.test.ts
-t "delegated-task stop|process loss"`, then `vp run check:changed`. Attach a runtime transcript
from the lifecycle test log: provision, create, created, failed after a hung fake create.

**Reviewer checks.**

- Every sandbox effect type is on the replay-safe list and in `EFFECT_TIMEOUTS`; nothing else
  changed in `boundExecution`'s behavior for other types.
- `reportExhausted` runs after the bounded execution returns, never inside it, and only on the
  last attempt.
- The executor never calls the driver for a stale generation, and every command it sends has a
  deterministic id from the shared list.
- No decision reads the driver or the filesystem; `decideSandboxCommand` is pure and the arm in
  `dispatchOnce` stays one line plus the helper (decision 14).
- Owner-or-admin is checked against the owning thread, not the thread the user clicked from.

### 1.6 `feat(server): add the runner with process, PTY, file and watch handlers`

Adds `t3 runner`: it dials one WebSocket, serves `RunnerRpcGroup` over it, and runs processes,
PTYs, file calls and watches inside the sandbox, with every process group tied to the runner's
life. Its own PR because it is the whole runner side and needs no server route to test (the
in-process client and a test WebSocket server stand in for 1.7).

- **Needs:** 1.1. **Unblocks:** 1.8, 1.9, 1.10.
- **Files:**
  - change `apps/server/src/bin.ts`: one branch beside `acp-mcp-bridge`:
    `else if (command === "runner") { const { runRunnerCli } = await import("./sandbox/runner/bin.ts"); await runRunnerCli(process.argv.slice(3)); }`.
    It skips the `binCli.ts` graph like the other fast paths.
  - add `apps/server/src/sandbox/runner/bin.ts`: the bundle entry (1.9 packs it as `runner.mjs`).
    `export const runRunnerCli(argv)`: `[]` runs `main.ts`; `prefetch` is 1.9's. When it is the
    entrypoint (`isEntrypoint` from `../../entrypoint.ts`), it also dispatches `acp-mcp-bridge`,
    `acp-mcp-call` and `__managed-chatgpt-token` with the same dynamic imports as `src/bin.ts`
    (`mcp/AcpMcpStdioBridge.ts`, `cli/managedChatGptToken.ts`; both import only `effect` and
    `@t3tools/shared`), so agents in the sandbox can spawn `t3 ...` (03 §2.1 table).
  - add `apps/server/src/sandbox/runner/main.ts`: reads config, builds the layer, runs forever.
  - add `apps/server/src/sandbox/runner/RunnerSocketServer.ts`: the one-socket `SocketServer`.
  - add `apps/server/src/sandbox/runner/HandleTable.ts`: handles and their buffers, outside RPC.
  - add `apps/server/src/sandbox/runner/GroupWatcher.ts`: the watcher script and spawn wrapper.
  - add `apps/server/src/sandbox/runner/handlers.ts`: `RunnerCoreRpcGroup.toLayer`, plus the
    placeholder ops layer until 1.10. `forward.*`/`tcp.*` fail with `RunnerSystemError { reason:
    "Unknown", description: "not supported" }` until 1.13 answers them.
  - add `apps/server/src/sandbox/runner/runnerTesting.ts` and
    `apps/server/src/sandbox/runner/handlers.test.ts`, `RunnerSocketServer.test.ts`,
    `runner.live.test.ts`.
  - change `vite.config.ts` (root) `lint.overrides`: the fence (below).

**Types, services and RPCs.**

```ts
// main.ts
export interface RunnerConfig {
  readonly url: string;                 // PAIR_RUNNER_URL; "unix:/p" becomes "ws+unix:/p:/runner/v1/connect"
  readonly sandboxId: string;           // PAIR_SANDBOX_ID
  readonly runnerBuildId: string;       // PAIR_RUNNER_BUILD; also MANIFEST.json beside runner.mjs
  readonly enrollment: Option.Option<Redacted.Redacted<string>>;
}
/** Reads PAIR_RUNNER_ENROLL, else /run/pair-runner/enroll (a driver-mounted file); deletes both. */
export const readRunnerConfig: Effect.Effect<RunnerConfig, RunnerConfigError, FileSystem.FileSystem>;
export const runRunner = (config: RunnerConfig) =>
  Layer.launch(RunnerServerLayer(config)); // NodeRuntime.runMain in bin.ts

// RunnerSocketServer.ts: the SocketServer that RpcServer.layerProtocolSocketServer consumes
export const make = Effect.fn("RunnerSocketServer.make")(function* (config: RunnerConfig) {
  const credential = yield* Ref.make<RunnerCredential>(/* Enroll <secret> or Bearer <file token> */);
  return SocketServer.SocketServer.of({
    address: { _tag: "UnixAddress", path: config.url },
    run: (handler) => dialOnce.pipe(                    // Socket.makeWebSocket(url, { headers })
      Effect.flatMap((socket) => Effect.scoped(handler(withFrameTimer(socket, "45 seconds")))),
      Effect.repeat(redialSchedule),                    // 250 ms doubling, cap 10 s, full jitter
      Effect.andThen(Effect.never)),
  });
});
export const setSandboxToken: (token: Redacted.Redacted<string>) => Effect.Effect<void>; // hello writes it
```

- **Dialer.** Its own `Socket.WebSocketConstructor` over `NodeWS.WebSocket` (re-exported by
  `@effect/platform-node/NodeWS`), not `NodeWS.layerWebSocketConstructor`, because it must pass
  `perMessageDeflate` (off for `ws+unix:` and loopback hosts, on otherwise; 03 §3.1) and capture
  the upgrade response from `ws`'s `unexpected-response` event. It sends 1.7's headers,
  `X-Pair-Runner-Protocol: <RUNNER_PROTOCOL_VERSION>` and `X-Pair-Runner-Build: <runnerBuildId>`.
  On `426` it writes the body's `runnerBuildId` (1.7's `{ protocolVersion, runnerBuildId? }`) to
  `/run/pair-runner/build` and exits 75, so the bootstrap refetches once; on `401` it exits 77,
  which the bootstrap treats as final (**proposed**).
  Keep DeviceHubProxy's no-op `error` listener.
- **Frame timer.** `withFrameTimer` wraps `reader.pull` in `Effect.timeoutOrElse` that closes the
  socket after 45 s without a frame; the server's 15 s ping keeps it fed. `RpcServer` has none
  (03 §4.1). The `makeSocketProtocol` loop then ends, `run` redials, and the one `RpcServer`
  keeps serving: a new socket is a new client id.
- **Credential.** First dial `Authorization: Enroll <secret>`; `runner.hello` with
  `sandboxToken` writes `/run/pair-runner/token` (mode 0600) and swaps the `Ref` to
  `Bearer <token>`. A restarted runner with no enrollment reads that file.

```ts
// HandleTable.ts
export class HandleTable extends Context.Service<
  HandleTable,
  {
    readonly spawn: (
      input: RunnerProcessSpawnInput,
    ) => Effect.Effect<RunnerHandleId, RunnerCallError>;
    readonly openPty: (input: RunnerPtyOpenInput) => Effect.Effect<RunnerHandleId, RunnerCallError>;
    /** Bytes from `fromSeq`; ends after the source's EOF is read. Never holds the handle's scope. */
    readonly output: (
      handle: RunnerHandleId,
      stream: StreamKey,
      fromSeq: number,
    ) => Stream.Stream<OutputChunk, RunnerLostError>;
    readonly write: (
      handle: RunnerHandleId,
      input: InputKey,
      seq: number,
      data: Uint8Array | string,
    ) => Effect.Effect<number /* appliedThrough */, RunnerCallError>;
    readonly wait: (handle: RunnerHandleId) => Effect.Effect<ExitInfo, RunnerLostError>;
    readonly release: (handle: RunnerHandleId) => Effect.Effect<void>;
    readonly drain: (graceMs: number) => Effect.Effect<void>;
    readonly live: Effect.Effect<ReadonlyArray<RunnerHandleState>>;
  }
>()("t3/sandbox/runner/HandleTable") {}
```

Each entry owns a `Scope` forked from the table's layer scope, not from the RPC fiber. That is
the point: `RpcServer` interrupts a dropped client's streams, and nothing in a handler may own a
process or a buffer. The entry holds the Effect `ChildProcessHandle` (or node-pty process), one
`OutputBuffer` per output stream (`Uint8Array` chunks, `baseSeq`, `nextSeq`, `eof`, a `Latch` for
readers), the last applied input `seq` per fd, and an exit `Deferred`. A pump fiber per output
copies the source into its buffer, stamping `seq` as a running byte (or UTF-16) offset; PTY text
is decoded by node-pty already, so chunks never split a code point. In this PR the buffer frees
bytes only below the last `fromSeq` asked for; 1.8 bounds it. Handle ids are
`<runnerBootId>:<n>`, so an id from another boot is unknown and fails `RunnerLostError
("runner-restarted")`.

```ts
// GroupWatcher.ts: CLAUDE_GROUP_WATCH_SCRIPT (ClaudeAdapterV2.ts:359) with a grace and a uid drop.
export const GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 10; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");
export const wrapCommand = (input: {
  command: string;
  args: ReadonlyArray<string>;
  uid?: number;
  gid?: number;
}) =>
  ChildProcess.make(
    "/bin/sh",
    [
      "-c",
      GROUP_WATCH_SCRIPT,
      "t3-group",
      ...(input.uid === undefined
        ? []
        : ["setpriv", `--reuid=${input.uid}`, `--regid=${input.gid}`, "--init-groups", "--"]),
      input.command,
      ...input.args,
    ],
    {
      detached: true, // own group; Effect kills -pid on scope close
      additionalFds: { fd3: { type: "input" } }, // the runner never writes; EOF on its death
      killSignal,
      forceKillAfter: Duration.millis(forceKillAfterMs ?? 2_000),
    },
  );
```

Effect's Node spawner already signals the group (`kill(-pid)`) of a detached child on scope close,
with `forceKillAfter` on the runner (`NodeChildProcessSpawner.ts:670-705`), so `forceKillAfterMs`
needs no new timer. The watcher covers the one case Effect cannot: the runner itself dying. PTYs
use the same script as the shell (`shell: "/bin/sh"`, `args: ["-c", SCRIPT, "t3-group", shell,
...args]`); node-pty does not take extra fds, so the PTY watcher reads a FIFO under
`/run/pair-runner/watch/<handle>` that the runner holds open (**proposed**). `setpriv` is
util-linux, in the Ubuntu base (05 owns the image).

Handlers (`handlers.ts`) decode, call one `HandleTable` or `FileSystem` method, and map errors,
as a `ws.ts` handler does. `fs.*` call the runner's `FileSystem` (`NodeServices`), with
`PlatformError` mapped to `RunnerSystemError` field by field; `fs.readFile` honours `offset` and
`maxBytes`; `fs.writeFile { atomic }` writes `<path>.t3tmp-<rand>` then renames. `fs.watch` is
`FileSystem.watch` batched per 50 ms with `Stream.groupedWithin(…, "50 millis")` and deduped by
path. `process.run` calls the runner's own `ProcessRunner.run` (`processRunner.ts:141`) through
`wrapCommand`, so caps and timeouts are the server's code, not a copy. `runner.hello` stores the
token and answers `RunnerInfo` from `HandleTable.live`, `os.arch()`, `os.cpus().length`,
`os.totalmem()`. `runner.drain` sends SIGTERM to every group, SIGKILL after `graceMs`, and fails
waiters with `drained`. `runner.events` emits `handle.exited` in this PR.

**The lint fence** (root `vite.config.ts`, after the `apps/server/src/**` override, repeating its
paths, because a later override replaces the rule):

```ts
{
  files: ["apps/server/src/sandbox/runner/**"],
  rules: { "eslint/no-restricted-imports": ["error", { paths: [...RESTRICTED_IMPORT_PATHS],
    patterns: [{ group: ["**/orchestration-v2/**", "**/persistence/**", "**/auth/**",
      "**/provider/**", "**/sandbox/runnerHub/**", "@t3tools/provider-*", "@t3tools/provider-*/**"],
      message: "The runner ships into sandboxes: no orchestration, persistence, auth or adapters." }] }] },
},
```

The rule sees direct imports only; 1.9's bundle check catches what a permitted module drags in.

**Tests.** No existing file covers the runner, so new ones under `sandbox/runner/`:

- `handlers.test.ts`, `it.effect` (03 §10 "Runner handlers"): `RpcTest.makeClient(RunnerRpcGroup)`
  provided with `handlers.layer`, `HandleTable.layer`, `NodeServices.layer`, the terminal
  `NodePtyAdapter.layer`, as `auth/RpcAuthorization.test.ts:145` builds its client. Real `/bin/sh`
  children are event-driven, so no clock is involved. Cases: spawn `printf`, read stdout from
  `fromSeq: 0` and again from the middle (same bytes, right seqs); stdin round trip through `cat`;
  a repeated `process.write` seq is ignored (`appliedThrough` unchanged, `cat` echoes once);
  `process.wait` resolves only after the output stream ended (assert the stream's last element
  arrived before the wait's `Deferred` completes); fd 4 output; `release` kills the group (a
  backgrounded `sleep` child reports exit through its own fd closing); PTY echo and resize;
  `fs.*` table against a temp dir, including atomic write and `readFile` cap; `fs.watch` with
  `TestClock.adjust("50 millis")` coalescing two writes into one batch; an unknown handle fails
  `RunnerLostError("runner-restarted")`.
- `RunnerSocketServer.test.ts`, `it.effect`: the frame timer closes a silent socket at 45 s on
  `TestClock.adjust`, `run` redials on the schedule, and a 426 upgrade maps to exit code 75
  (socket built with `Socket.make` from a `Queue`; the constructor is a stub).
- `runner.live.test.ts`, `it.live` (a subprocess fixture): `node src/bin.ts runner` against a test
  `ws` server on an ephemeral port, with the test running `RpcClient.makeProtocolSocket` over the
  accepted socket. It enrolls (asserting the `Enroll` header and that the secret is gone from
  `/proc/<pid>/environ`), spawns `sh -c 'sleep 1000 > "$FIFO"'`, kills the runner by the PID the
  test spawned, and awaits EOF on the FIFO's read end: the watcher killed the group.

**Verify.** `vp test run apps/server/src/sandbox/runner/`; `vp run typecheck` (server);
`vp run check:changed`. Runtime transcript for the PR body: `node apps/server/src/bin.ts runner`
with `PAIR_RUNNER_URL` at the test server, showing hello, a spawn and the group dying on kill.

**Reviewer checks.**

- No handler owns a process, PTY or buffer; all live in `HandleTable` scopes.
- A child's env is exactly the payload's `env`; the runner's own env (with the token) never leaks.
- Every spawn, `process.run` and PTY goes through `GroupWatcher`; nothing is spawned undetached.
- The token is only in memory and `/run/pair-runner/token`; the enrollment secret is deleted from
  env and disk before the first dial.
- The fence override sits after `apps/server/src/**` and keeps its restricted paths.
- The `src/bin.ts` edit is one branch; the runner's extra dispatch lives in `sandbox/runner/bin.ts`.

### 1.7 `feat(server): accept runners on /runner/v1/connect with per-boot sandbox tokens`

Makes a runner able to enroll, authenticate and hold one RPC socket per sandbox, and turns its
first hello and its loss into `sandbox.runner.attached` and `sandbox.runner.lost`. Its own PR
because it is the only new auth surface in M1 and the only place runner facts become commands.

- **Needs:** 1.1 (`RunnerRpcGroup`, `RunnerHelloInput`, `RunnerInfo`, `RunnerLostError`), 1.5 (the
  two internal commands and their deciders), 1.6 (the runner handlers the in-process test runner
  uses). **Unblocks:** 1.8, 1.11, 1.13, 1.15, 1.16, 1.19 (reconciler's lease wait), 1.29 (revoke).
- **Files:**
  - add `apps/server/src/sandbox/runnerHub/RunnerGrants.ts`: repository over
    `sandbox_runner_grants`, shaped like `persistence/AuthPairingLinks.ts` (`Context.Service`,
    `SqlSchema.findOneOption`, errors `PersistenceSqlError | PersistenceDecodeError` from
    `persistence/Errors.ts`).
  - add `apps/server/src/persistence/Migrations/089_SandboxRunnerGrants.ts` (+ `.test.ts`);
    change `apps/server/src/persistence/Migrations.ts`: import `Migration0089` after line 93 and add
    `[89, "SandboxRunnerGrants", Migration0089]` after `[87, …]` (line 183) and 1.3's 88.
  - add `apps/server/src/sandbox/runnerHub/RunnerHub.ts`: the service; status in memory.
  - add `apps/server/src/sandbox/runnerHub/RunnerRoute.ts`: `HttpRouter.add("GET",
    "/runner/v1/connect", …)`; decode headers, call the hub, map errors to 401/426.
  - add `apps/server/src/sandbox/runnerHub/RunnerHubFacts.ts`: a worker in the orchestration
    runtime that turns hub facts into the two commands (keeps the hub free of `Orchestrator`, which
    would cycle: 1.5's executors call `mintEnrollment`).
  - add `apps/server/src/sandbox/runnerHub/RunnerHubTesting.ts`: in-process runner (1.6's
    handlers) joined to the hub by a `Socket.make` pair; `drop()` completes a `Deferred` that
    closes the pair. 1.8 adds stall and drop-after-N-bytes.
  - change `apps/server/src/server.ts`: `RunnerRoute.layer` inside the inner `Layer.mergeAll` of
    `layerMakeRoutes` beside `Ws.layer` (line ~801); `RunnerHub.layer` and `RunnerGrants.layer` by
    `Layer.provideMerge` in `layerRuntimeCoreDependencies` next to `Presence.layer` (line 743).
  - change `apps/server/src/orchestration-v2/runtimeLayer.ts`: add `RunnerHubFacts.layer` beside
    `UsageLimitRecoveryWorker.layer` (line 381).

**Types, services and RPCs.**

```ts
// RunnerHub.ts
export class RunnerAuthError extends Schema.TaggedError<RunnerAuthError>()("RunnerAuthError", {
  reason: Schema.Literals(["missing", "malformed", "unknown", "consumed", "expired", "revoked"]),
}) {} // route: 401, no body detail
export class RunnerProtocolMismatchError extends Schema.TaggedError<RunnerProtocolMismatchError>()(
  "RunnerProtocolMismatchError",
  { expected: Schema.Number, received: Schema.String },
) {} // route: 426
export class RunnerUnavailableError extends Schema.TaggedError<RunnerUnavailableError>()(
  "RunnerUnavailableError",
  { sandboxId: SandboxId },
) {}

export type RunnerConnectionStatus =
  | { readonly _tag: "absent" } // nothing seen this server boot
  | {
      readonly _tag: "connected";
      readonly generation: number;
      readonly runnerBootId: string;
      readonly info: RunnerInfo;
    }
  | { readonly _tag: "reconnecting"; readonly since: DateTime.Utc; readonly runnerBootId: string }
  | { readonly _tag: "lost"; readonly runnerBootId: string };

export type RunnerHubFact =
  | {
      readonly _tag: "attached";
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly runnerBootId: string;
      readonly info: RunnerInfo;
    }
  | {
      readonly _tag: "lost";
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly runnerBootId: string;
      readonly reason: "lease-expired" | "runner-restarted";
    };

export class RunnerHub extends Context.Service<
  RunnerHub,
  {
    readonly mintEnrollment: (
      sandboxId: SandboxId,
      bootGeneration: number,
    ) => Effect.Effect<Redacted.Redacted<string>, RunnerGrantError>;
    /** Waits up to the lease for a connected runner (also for a first hello). */
    readonly connection: (
      sandboxId: SandboxId,
    ) => Effect.Effect<RunnerConnection, RunnerUnavailableError | RunnerLostError>;
    readonly status: (sandboxId: SandboxId) => Stream.Stream<RunnerConnectionStatus>;
    readonly revoke: (sandboxId: SandboxId) => Effect.Effect<void, RunnerGrantError>;
    /** For 1.40's Test machine, which has no thread: a hello for this id completes the Deferred and
     * dispatches nothing. Lands with 1.40, its first caller (proposed there). */
    readonly expectCheck: (
      sandboxId: SandboxId,
    ) => Effect.Effect<Deferred.Deferred<RunnerInfo>, never, Scope.Scope>;
    // Route-only: authenticate before the upgrade, then serve the socket until it ends.
    readonly authenticate: (
      headers: Headers.Headers,
    ) => Effect.Effect<
      RunnerGrant,
      RunnerAuthError | RunnerProtocolMismatchError | RunnerGrantError
    >;
    readonly serve: (
      grant: RunnerGrant,
      socket: Socket.Socket,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly facts: Stream.Stream<RunnerHubFact>; // one consumer: RunnerHubFacts
  }
>()("t3/sandbox/RunnerHub") {}

// RunnerConnection (03 §7) in 1.7 carries only `client` (the typed RpcClient of RunnerRpcGroup)
// and `info`; 1.8 adds the resumable wrappers, 1.10 `ops`, 1.13 `openForward`.
```

- **Headers.** `Authorization: Enroll <secret>` or `Bearer <token>`; `X-Pair-Runner-Protocol`;
  `X-Pair-Runner-Build` (read by 1.9). Protocol mismatch answers `426` with
  `{ protocolVersion, runnerBuildId? }` like `ws.ts`'s 426 (line ~3648).
- **Enroll.** Mint the 32-byte token first, then one statement consumes the secret and stores the
  token hash: `UPDATE sandbox_runner_grants SET enrollment_consumed_at = :now, token_hash = :tokenHash
  WHERE enrollment_hash = :h AND enrollment_consumed_at IS NULL AND revoked_at IS NULL AND
  enrollment_expires_at > :now RETURNING sandbox_id, boot_generation`. No row: `RunnerAuthError`.
  The token goes to the runner in `runner.hello`'s `sandboxToken`, never in an HTTP body.
- **Bearer.** `SELECT … WHERE token_hash = :h AND revoked_at IS NULL`. Hashes are SHA-256 hex via
  `Digest`, as `McpSessionRegistry.hashToken` does (line ~95).
- **Mint.** One transaction: revoke every older generation of the sandbox, then upsert this
  generation's row with a fresh secret hash and `expires = now + 15 min`, keeping a consumed row as
  is. A replayed `sandbox.create`/`.start` re-mints; the driver rewrites the bootstrap, so the old
  secret is harmless (04 §6).
- **Serve.** `RpcClient.makeProtocolSocket({ pingInterval: "15 seconds", pingTimeout: "45 seconds",
  retryPolicy: Schedule.recurs(0) })` over the upgraded socket, with
  `RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 })`. First call `runner.hello({
  protocolVersion, serverBootId, leaseMs: 120_000, limits, sandboxToken })`. `serverBootId` is a
  `randomUUID` made once per hub. The lease and limits are constants in `RunnerHub.ts` (the
  per-driver lease setting of 03 §3.1 waits for a driver that needs another value; **proposed**).
- **One live socket per sandbox.** State is `SynchronizedRef<Map<SandboxId, Entry>>`. A new
  `serve` for a sandbox completes the old entry's `replaced` `Deferred`, which interrupts its fiber
  and closes its socket, before installing itself. `revoke` sets `revoked_at` for all generations
  and completes the same `Deferred`, as `awaitInvalidation` ends a `/ws` socket.
- **Facts.** First hello of a `runnerBootId`: `attached`. A hello whose `runnerBootId` differs from
  the entry's: `lost(old, "runner-restarted")`, then `attached(new)`. Socket end: status
  `reconnecting(since)` and a lease fiber `Effect.sleep(lease)`; a hello in time cancels it; expiry
  sets `lost` and emits `lost(boot, "lease-expired")`. Status is a `SubscriptionRef` per sandbox;
  `status` is its `changes`, published only on change, like `Presence.ts`. Nothing is persisted.

**Commands, events and effects.** `RunnerHubFacts` dispatches through `Orchestrator.dispatch`
(`Orchestrator.ts:398`; internal commands are in `OrchestrationV2ServerCommand`) to the owner
thread's stream, read from 1.3's sandbox projection by `sandboxId`:

- `sandbox.runner.attached { sandboxId, generation, runnerBootId, runnerBuildId, arch, cpus,
  memoryBytes }`, id `sandbox-attached:<sandboxId>:<generation>:<runnerBootId>` (see PR-list changes).
- `sandbox.runner.lost { sandboxId, generation, runnerBootId, reason }`, id
  `sandbox-lost:<sandboxId>:<generation>:<runnerBootId>`.

A fact for a generation older than the projection's is dropped with a log line (04 §1: stale
generations are harmless). Dispatch failures are logged, as `UsageLimitRecoveryWorker` does
(line ~135). No effect, no event of its own: the decider emits `sandbox.updated` (1.5). After a
server restart the hub knows nothing; 1.19's reconciler calls `connection` for each `ready`
sandbox and, on `RunnerUnavailableError`, dispatches `lost` with id
`sandbox-lost:<sandboxId>:<generation>:unattached`.

**Migrations.** `089_SandboxRunnerGrants` (next free id at merge):

```sql
CREATE TABLE IF NOT EXISTS sandbox_runner_grants (
  sandbox_id TEXT NOT NULL,
  boot_generation INTEGER NOT NULL,
  enrollment_hash TEXT NOT NULL UNIQUE,
  enrollment_expires_at TEXT NOT NULL,
  enrollment_consumed_at TEXT,
  token_hash TEXT UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (sandbox_id, boot_generation)
);
```

Rows are deleted with the sandbox by 1.29's destroy effect; until then a revoked row is inert.

**Tests.**

- `089_SandboxRunnerGrants.test.ts`, modeled on `087_MemberPushDevices.test.ts`: reruns cleanly,
  duplicate enrollment hash refused.
- `RunnerGrants.test.ts` (new; no grants table exists): one `it.effect` table over in-memory SQLite:
  consume once then refused; expired after `TestClock.adjust("15 minutes")`; minting generation 2
  revokes generation 1's token; re-mint of an unconsumed generation invalidates the old secret.
- `RunnerHub.test.ts` (new), `it.effect` with `RunnerHubTesting` and the real `RunnerGrants`;
  `Orchestrator` is not involved, the test takes from `facts`: enroll then bearer reconnect yields
  one `attached`; a second connect replaces the first (await the first socket's close `Deferred`);
  `drop()` then `TestClock.adjust("120 seconds")` yields `lost("lease-expired")` and `connection`
  fails with `RunnerLostError`; a reconnect inside the lease yields nothing; a new `runnerBootId`
  yields `lost` then `attached`; `revoke` closes the socket and refuses the next bearer; protocol
  mismatch fails `authenticate`.
- `RunnerHubFacts`: one case in 1.5's sandbox decision tests: an `attached` fact for a
  `provisioning` sandbox stores `sandbox.updated` with `ready` (await the stored event).

**Verify.** `vp test run apps/server/src/sandbox/runnerHub apps/server/src/persistence/Migrations/089_SandboxRunnerGrants.test.ts`;
`vp run typecheck`; `vp run check:changed`. Runtime transcript: `vp run dev`, mint an enrollment
from a test script, `wscat` (or `node src/bin.ts runner` once 1.9 lands) against the server port
(not the Vite port), showing 401 on a reused secret, 426 on a wrong protocol, and the
`sandbox.runner.attached` receipt.

**Reviewer checks.**

- No sandbox secret or hash enters `SessionStore`, the event log or a log line; the token reaches
  the runner only in `runner.hello`.
- Consume-once is one conditional `UPDATE … RETURNING`, not a read then a write.
- The route never runs an RPC server or `RpcAuthorization`; `/ws`, `/api` and `/mcp` accept no
  sandbox token.
- Replacement and revocation close the old socket; nothing keeps two live entries per sandbox.
- `RunnerHub` does not depend on `Orchestrator`; command ids match the shared list (with the
  `runnerBootId` suffix on `attached`).

### 1.8 `feat(server): resume runner streams and bound them with flow control`

Makes a socket blip invisible and a runaway process harmless: output is windowed and lossless
across reconnects, writes apply once, sources pause when buffers fill, and a lease decides when
a drop becomes a process exit. Its own PR because it changes both ends (runner `HandleTable`,
server `RunnerConnection`) and needs the fault-injection harness that nothing earlier has.

- **Needs:** 1.6 (runner handlers), 1.7 (`RunnerHub`, `RunnerConnection`). **Unblocks:** 1.11,
  1.13, 1.44.
- **Files:**
  - add `packages/shared/src/rpcOutputWindow.ts` and its subpath in `packages/shared/package.json`
    (`"./rpcOutputWindow"`), with `rpcOutputWindow.test.ts`.
  - change `apps/server/src/terminal/OutputProtocol.ts`: `withTerminalOutputWindow` becomes a
    three-line call of the shared helper with today's limits and JSON sizing. No behavior change.
  - change `apps/server/src/terminal/OutputProtocol.test.ts`: the `"terminal output window"`
    describe moves to the shared test; keep one row here proving the terminal wiring.
  - change `apps/server/src/sandbox/runner/HandleTable.ts`: retention tail, pause, sandbox cap,
    lease, server boot ids, `stats`.
  - change `apps/server/src/sandbox/runner/main.ts`: wrap the runner's `RpcServer.Protocol` with
    the window for every `stream: true` method of `RunnerRpcGroup`.
  - change `packages/shared/src/PtyAdapter.ts` (`PtyProcess`: optional `pause?(): void`,
    `resume?(): void`) and `apps/server/src/terminal/NodePtyAdapter.ts` (`NodePtyProcess`
    delegates to node-pty's `pause`/`resume`). Optional, so fakes are untouched.
  - change `apps/server/src/sandbox/runnerHub/RunnerHub.ts` (1.7's): lease timer, boot-id
    handling, resumable output and writer fibers in `RunnerConnection`.
  - change `apps/server/src/sandbox/runnerHub/RunnerHubTesting.ts`: faults on the socket pair.
  - add `apps/server/src/sandbox/runnerHub/RunnerResume.test.ts`.

**Types, services and RPCs.**

```ts
// packages/shared/src/rpcOutputWindow.ts
export interface OutputWindowOptions {
  readonly isWindowed: (tag: string) => boolean;
  readonly maxChunks: number;
  readonly maxBytes: number;
  readonly sizeOf: (chunk: RpcMessage.ResponseChunkEncoded) => number;
}
export function withOutputWindow(
  protocol: RpcServer.Protocol["Service"],
  options: OutputWindowOptions,
): RpcServer.Protocol["Service"]; // today's withTerminalOutputWindow body, parameterized
/** With SchemaBinary, RpcServer has already encoded a chunk's values to one Uint8Array
 *  (`rpcCodecs.encodeChunk`, RpcServer.ts:550), so this is the frame's payload length. */
export const encodedChunkBytes = (chunk: RpcMessage.ResponseChunkEncoded): number =>
  (chunk.values as unknown) instanceof Uint8Array
    ? (chunk.values as unknown as Uint8Array).byteLength + ENVELOPE_BYTES
    : jsonBytes(chunk);
```

`ResponseChunkEncoded.values` is typed as an array (`RpcMessage.ts:265-268`), but under
SchemaBinary it arrives as the encoded `Uint8Array`; the shared test pins that, so an Effect
upgrade that changes it fails loudly instead of silently counting JSON.

The runner wraps with `{ isWindowed: (tag) => RUNNER_STREAM_TAGS.has(tag), maxChunks: 16,
maxBytes: 256 * 1024, sizeOf: encodedChunkBytes }`, where `RUNNER_STREAM_TAGS` is derived from
`RunnerRpcGroup.requests` (each Rpc whose success is a stream schema), so a new stream method is
windowed without a list edit. The terminal keeps `sizeOf: (c) => byteLength(JSON.stringify(c))`.

Runner side, `HandleTable` rules (03 §4.5):

- **Retention tail.** A buffer keeps unsent bytes plus the last `windowBytes + 2 × 64 KiB` of sent
  bytes. Proof sketch for the reviewer: `RpcServer` pulls the next chunk only after an ack (real or
  synthesized by the window), and the window holds at most `maxBytes` plus one chunk unacked, so
  the server can be missing at most that much. Data bytes never exceed encoded bytes. A
  `fromSeq` below the tail fails `RunnerLostError("resume-behind-buffer")` (03 §5: a bug).
- **Batching.** `output` takes everything buffered, up to 64 KiB, per element.
- **Pause at source.** When unsent bytes reach `handleBufferBytes` (fd) or `ptyBufferBytes`, the
  pump stops pulling the child's stdout `Stream` (Effect's Node readable stops reading the pipe,
  so the child blocks on `write`) or calls `pty.pause()`. It resumes below half.
- **Sandbox cap.** A table-wide counter; at `sandboxBufferBytes` every pump pauses until it drops
  below half. `runner.events` emits `resource.pressure` on each transition.
- **Limits come from `runner.hello`** (`RunnerLimits`), so tests pass tiny values.
- `stats: Effect<{ bufferedBytes, highWater, pausedHandles, pausedMs }>` feeds 1.44's metrics.

```ts
// RunnerHub.ts additions (1.7 owns the file, its lease constant and its lease fiber)
/** hello.serverBootId = `${serverBootId}:${leaseEpoch}`; the epoch bumps on lease expiry (proposed),
 *  so a runner whose own timer has not fired yet still drops the handles the hub already failed. */
// RunnerConnection (03 §7), resumable:
//   output(handle, stream): tracks nextSeq; on a transport error awaits the next connection
//   and resubscribes from nextSeq, trimming any overlap; RunnerLostError ends it.
//   writer(handle, input): one fiber, Queue capped at 1 MiB (offer suspends), takes all,
//   sends { seq: ++n, data }, awaits appliedThrough >= n; on a transport error resends n.
```

- **Lease, both sides.** 1.7 runs the hub's lease fiber and emits `lost("lease-expired")`; this PR
  makes expiry fail every pending resumable wrapper with `RunnerLostError("lease-expired")` and
  bump the epoch. The runner starts the same timer from its last hello's `leaseMs` on socket close
  and, on expiry, kills every group (SIGTERM, SIGKILL after 10 s), drops the handles and mints a
  new `runnerBootId`, so 1.7's `sandbox-attached:…:<runnerBootId>` id attaches each boot once.
- **Boot ids.** A hello whose `serverBootId` differs from the runner's last one makes the runner
  kill every handle of the old id, and mint a new `runnerBootId`, before it answers, so
  `RunnerInfo.handles` is empty (server restart, or a lease the server expired first). A `RunnerInfo.runnerBootId` that differs from
  the hub's last one fails the old handles with `runner-restarted` (1.7 dispatches `lost`).
- **PTY writes** stay synchronous (`PtyProcess.write`): they enqueue on the writer fiber past the
  cap rather than block, since terminal input is human-sized (**proposed**).

**Commands, events and effects.** None new. This PR only changes when 1.7's
`sandbox.runner.lost` fires (lease expiry). No effect waits on a socket.

**Tests.**

- `packages/shared/src/rpcOutputWindow.test.ts`: the existing `it.effect.each` window table from
  `OutputProtocol.test.ts:18-145`, moved and parameterized, plus rows for a 64 KiB `Uint8Array`
  chunk under `layerSchemaBinary` (one chunk fills a 64 KiB window, and the count is the binary
  length, not a JSON length). Same `TestClock.adjust(0)` and `Deferred` style as today.
- `RunnerResume.test.ts`, `it.effect`: the server `RpcClient.makeProtocolSocket` (never-retry
  `retryPolicy`) and the runner's real `RpcServer` joined by `RunnerHubTesting.socketPair()`:
  two `Socket.make` sockets over `Queue`s, whose suspended `pull` fails with `SocketCloseError`
  when either side closes. Faults are `Deferred`s and a `Latch` the test controls:
  `dropNow`, `dropAfterBytes(n)`, `stallReader`, `halfOpen` (writes vanish, nothing closes).
  The runner's `SocketServer` in tests takes sockets from a `Queue` the test feeds. Cases (03
  §10): mid-chunk drop resumes with bytes delivered equal to bytes written and no duplicates (a
  child writes a numbered 1 MiB pattern); drop during write resend applies each write once; drop
  during `hello`; stalled reader pauses the source at `handleBufferBytes` (await `stats` reporting
  the pause through a `Deferred` the table completes on transition, with limits of 64 KiB);
  sandbox cap pauses two handles at once; a half-open socket replaced by a new connect resumes;
  lease expiry on `TestClock.adjust("120 seconds")` fails handles with `lease-expired`, ends
  `RunnerHub.status` in `lost`, and kills the runner's groups; a new `serverBootId` kills old
  handles before hello answers; a `fromSeq` behind the tail fails `resume-behind-buffer`.
  Children are real `/bin/sh` processes, event-driven. No sleeps, no polling, no timeouts.

**Verify.** `vp test run packages/shared/src/rpcOutputWindow.test.ts
apps/server/src/terminal/OutputProtocol.test.ts apps/server/src/sandbox/`; `vp run typecheck`
(shared, server); `vp run check:changed`. Runtime transcript: a `yes` piped through a runner
whose socket the test server stalls, showing the pause and the resume byte count.

**Reviewer checks.**

- `withTerminalOutputWindow` behaves exactly as before (same limits, same JSON sizing).
- The runner never evicts unacked bytes; the only loss path is `RunnerLostError`.
- The lease timer is in one place per side and uses `Effect.sleep`, so tests drive it by
  `TestClock`; nothing reads `Date.now()`.
- Each input has one writer fiber; nothing sends two writes for one fd concurrently.
- `process.wait` still resolves only after every output stream delivered its last byte, across a
  resume.
- `RpcClient.makeProtocolSocket` gets a `retryPolicy` that never retries; reconnects come from
  the runner redialing, never from the server reusing a dead socket.

### 1.9 `build(server): pack the runner bundle, serve it by runnerBuildId, add t3 runner prefetch`

Makes the runner something a sandbox can obtain: a second `vp pack` output with its native
modules and an unsplit history worker, a content id, two download routes, the bootstrap script
that installs it, a dev bundle built from source (with Replay), and `t3 runner prefetch` for image
builds. Its own PR because it is build and delivery, not protocol.

- **Needs:** 1.6 (the entry), 1.7 (the bundle routes authenticate with `RunnerGrants`; see
  PR-list note below). **Unblocks:** 1.12, 1.14 (mount), 1.21, 1.44, 05's image builds.
- **PR-list change:** add 1.7 to Needs. The routes take "enrollment secret or sandbox token", and
  1.7 owns both. It costs nothing on the critical path: 1.12 already waits on 1.11 → 1.8 → 1.7.
- **Files:**
  - change `apps/server/vite.config.ts`: `pack` becomes an array (as `apps/desktop/vite.config.ts`
    does). Element 1 is today's object unchanged. Unless `packExecutable`, two more elements
    with `outDir: runnerOutDir` (`process.env.T3CODE_RUNNER_OUT_DIR ?? "dist/runner"`),
    `clean: false`, `sourcemap: false`, `outputOptions: { codeSplitting: false }`, the same
    `deps` and `define`, one entry each: `src/sandbox/runner/bin.ts` → `runner.mjs`, and
    `src/claude-history-worker.ts` → `claude-history-worker.mjs` (one unsplit entry per element,
    since a single chunk needs a single input). `T3CODE_RUNNER_DEV=1` adds a fourth,
    `scripts/dev-replay-agent.ts` → `replay/dev-replay-agent.mjs`. `T3CODE_PACK_RUNNER_ONLY=1`
    drops element 1, for the dev build. The runner elements must not set `clean: true`, or they
    would wipe `dist/` built by element 1.
  - change `apps/server/scripts/cli.ts`: a `build-runner --out <dir> [--dev]` command (pack with
    the env above, stage externals, write the shim and manifest, tar and hash); `build` calls it
    with `--out dist/runner` after `build:bundle`.
  - add `apps/server/src/sandbox/runnerHub/RunnerBundle.ts`: service and route handlers.
  - add `apps/server/src/sandbox/runnerHub/runnerBootstrap.ts`: `RUNNER_BOOTSTRAP_SCRIPT`.
  - add `apps/server/src/sandbox/runner/prefetch.ts`; change `sandbox/runner/bin.ts` (`prefetch`).
  - change `apps/server/src/sandbox/runnerHub/RunnerRoute.ts` (1.7's): mount the two routes
    behind `RunnerGrants`, and add `runnerBuildId !== (yield* RunnerBundle.current).runnerBuildId`
    to the connect route's 426 branch, which 1.7 left protocol-only. `server.ts` needs no second line: 1.7's `RunnerRoute.layer` is already
    in `layerMakeRoutes` (`server.ts:780-801`).
  - add tests: `RunnerBundle.test.ts`, `runnerBootstrap.live.test.ts`.

**Bundle contents** (`dist/runner/`, the same tree in `<stateDir>/runner/<runnerBuildId>/`):

| Path                                                                                                                                       | From                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner.mjs`                                                                                                                               | `src/sandbox/runner/bin.ts`, unsplit; the runner plus the three `t3` fast paths                                                                                                                                                                                                                 |
| `claude-history-worker.mjs`                                                                                                                | `src/claude-history-worker.ts`, unsplit, Claude Agent SDK bundled                                                                                                                                                                                                                               |
| `t3`                                                                                                                                       | `#!/bin/sh\nexec node "$(dirname "$0")/runner.mjs" "$@"`, mode 0755                                                                                                                                                                                                                             |
| `node_modules/node-pty/`                                                                                                                   | with `prebuilds/linux-x64` and `prebuilds/linux-arm64` only                                                                                                                                                                                                                                     |
| `node_modules/@ff-labs/fff-node/`, `@ff-labs/fff-bin-linux-{x64,arm64}-{gnu,musl}/` and their runtime deps                                 | staged, below                                                                                                                                                                                                                                                                                   |
| `MANIFEST.json`                                                                                                                            | `{ runnerBuildId, protocolVersion: RUNNER_PROTOCOL_VERSION, node: engines.node, builtFrom: "release" \| "source" }`                                                                                                                                                                             |
| `replay/dev-replay-agent.mjs`, `replay/dev-replay/*.ndjson`, `src/orchestration-v2/testkit/fixtures/<scenario>/registry_transcript.ndjson` | `--dev` only (P5). The copy list comes from the agent's exported `SCENARIOS`, at the same relative paths, because the agent resolves `new URL(scenario.file, import.meta.url)` with `FIXTURES = "../src/orchestration-v2/testkit/fixtures"` (`dev-replay-agent.ts:40-65`). No edit to the agent |

Externals are staged the way `stageRuntimeExternals` in `scripts/build-cli-archive.ts:134-228`
stages the CLI archive's: a temp `package.json` with `node-pty` and `@ff-labs/fff-node` at the
server's versions plus `resolveFffNativeDependencies("linux", "universal", v)`, a workspace from
`createStageWorkspaceConfig({ platform: "linux", arch: "universal", … })` (both exported from
`scripts/build-desktop-artifact.ts:1404,1578`; linux gives `libc: ["glibc"]`), `nodeLinker:
hoisted`, `vp install --prod`, then the same removals, and node-pty prebuilds other than the two
linux ones. On a source-run server this install is cached by the sha256 of `pnpm-lock.yaml` in
`<stateDir>/runner/externals-<hash>/`, so it touches the network once per lockfile.

`runnerBuildId` = sha256 hex over the tree, excluding `MANIFEST.json`: one line per file,
`<relative path>\0<0755|0644>\0<sha256 of contents>\n`, sorted by path. Releases and dev use the
same function, in `build-runner`. The tarball (`<id>.tar.gz`, plain `tar -czf -C dir .`, which
both GNU tar and bsdtar accept) need not be reproducible: the `.sha256` route serves its digest.

After packing, `build-runner` fails when `runner.mjs` has a `//#region` marker under
`src/orchestration-v2/`, `src/persistence/` or `src/auth/`, or under `src/provider/` other than
`provider/CodexManagedTokenProtocol.ts` (which the `__managed-chatgpt-token` fast path needs) (the scan
`findInlinedExternalPackages` in `scripts/lib/cli-external-packages.ts` already does for
packages), or when the tree exceeds 25 MB. This catches what the 1.6 lint fence cannot: a
permitted module that drags a fenced one in.

**Types, services and RPCs.**

```ts
export interface RunnerBundleInfo {
  readonly runnerBuildId: string;
  readonly directory: string; // what Docker bind-mounts read-only at /opt/pair-runner/<id>
  readonly tarballPath: string;
  readonly tarballSha256: string;
}
export class RunnerBundleUnavailableError extends Schema.TaggedError<RunnerBundleUnavailableError>()(
  "RunnerBundleUnavailableError",
  {
    reason: Schema.Literals(["single-executable", "build-failed"]),
    detail: Schema.optional(Schema.String),
  },
) {}

export class RunnerBundle extends Context.Service<
  RunnerBundle,
  {
    /** Released: dist/runner beside this module. From source: built once per process (P7). */
    readonly current: Effect.Effect<RunnerBundleInfo, RunnerBundleUnavailableError>;
  }
>()("t3/sandbox/RunnerBundle") {}

export const make = Effect.fn("RunnerBundle.make")(function* () {
  const fromSource = import.meta.url.endsWith(".ts"); // same test as runClaudeWorker
  const current = yield* Effect.cached(fromSource ? buildFromSource : readReleased);
  return RunnerBundle.of({ current });
});
```

- **Released.** `new URL("./runner/", import.meta.url)`, as `runClaudeWorker` finds
  `./claude-history-worker.mjs` (`ClaudeAdapterV2.ts:1104-1116`); reads `MANIFEST.json`; tars once
  into `<stateDir>/runner/<id>.tar.gz` on first use. A single executable (`HostProcess.IsExecutable`)
  has no tree: `single-executable`, which Settings → Cloud's Test button (1.40) shows.
- **From source.** Spawns `node apps/server/scripts/cli.ts build-runner --dev --out
  <stateDir>/runner/.staging-<uuid>`, hashes, renames to `<stateDir>/runner/<id>/` (or discards
  the staging dir when that id exists). Only the first caller per process pays; later callers
  wait on the cached effect.
- **Routes**, beside `connect` in 1.7's `RunnerRoute.ts`, each behind `RunnerGrants`' "enrollment
  secret or sandbox token" check (the secret is not consumed by a download):
  `GET /runner/v1/bundle/<id>.tar.gz` streams `tarballPath` with `HttpServerResponse.file`;
  `GET /runner/v1/bundle/<id>.sha256` answers `<sha256>  <id>.tar.gz`. Any other id answers 404
  with `X-Pair-Runner-Build: <current id>`: the server serves its own build only.

**Bootstrap** (`RUNNER_BOOTSTRAP_SCRIPT`, about 40 lines of POSIX `sh`, mirroring
`cloud/pinnedRuntime.ts`; it cannot import it, since no Node code is there yet):

```sh
set -eu
root="${PAIR_RUNNER_ROOT:-/opt/pair-runner}"; id="$PAIR_RUNNER_BUILD"
present() { [ -f "$root/$1/MANIFEST.json" ] && grep -q "\"runnerBuildId\": *\"$1\"" "$root/$1/MANIFEST.json"; }
fetch() {  # $1 id: staging dir, sha256 check, sentinel, atomic rename
  s="$root/.staging-$$"; rm -rf "$s"; mkdir -p "$s"
  curl -fsS --speed-limit 1 --speed-time 60 $CURL_TARGET -H "Authorization: $AUTH" "$BASE/runner/v1/bundle/$1.sha256" > "$s/sum"
  curl -fsS --speed-limit 1 --speed-time 60 $CURL_TARGET -H "Authorization: $AUTH" -o "$s/$1.tar.gz" "$BASE/runner/v1/bundle/$1.tar.gz"
  (cd "$s" && sha256sum -c sum) && tar -xzf "$s/$1.tar.gz" -C "$s" && rm "$s/$1.tar.gz" "$s/sum"
  printf %s "$1" > "$s/.install-complete"; mv "$s" "$root/$1"
}
# BASE/CURL_TARGET from PAIR_RUNNER_URL (ws[s]:// -> http[s]://; unix:/p -> --unix-socket /p http://localhost);
# AUTH = "Enroll $PAIR_RUNNER_ENROLL" (or the mounted file), else "Bearer $(cat /run/pair-runner/token)".
present "$id" || fetch "$id"
set +e; node "$root/$id/runner.mjs" runner; code=$?; set -e
[ "$code" = 75 ] || exit "$code"                      # 75: the server answered 426
id="$(cat /run/pair-runner/build)"; present "$id" || fetch "$id"; exec node "$root/$id/runner.mjs" runner
```

A Docker mount satisfies `present` by construction (`MANIFEST.json` holds the id). The runner
writes `/run/pair-runner/build` from the 426's `X-Pair-Runner-Build` header (1.6's dialer). A
second 75 is a plain failure: there is no loop. `runner.mjs` checks `process.versions.node`
against the manifest's range first and exits 78 with a message (05 owns Node in the image).

`t3 runner prefetch <runnerBuildId>` (`sandbox/runner/prefetch.ts`, for 05's image builds, where
the bundle's `t3` is on `PATH`): when its own `MANIFEST.json` has that id, copy its own tree to
`/opt/pair-runner/<id>` with the sentinel (no network); else the same fetch in Node with
`fetch`, `node:crypto` and `tar`, authenticated with `/run/pair-runner/token`, through a staging
dir and rename.

**Tests.**

- `RunnerBundle.test.ts`, `it.effect`, new (no existing module): the tree hash is stable across
  file order, changes with content and with the exec bit, and ignores `MANIFEST.json`; the routes
  answer 401 without a grant, 404 plus the header for a foreign id, and stream the file and its
  digest for the current id (with `RunnerBundle.layerTest` over a temp tree and a stub grant).
- `runnerBootstrap.live.test.ts`, `it.live` (subprocess fixture): runs `RUNNER_BOOTSTRAP_SCRIPT`
  with `sh` against a test HTTP server and a temp `root` (the script reads `PAIR_RUNNER_ROOT` when
  set, for this test): fetches and installs once; a present tree skips the download; a bad digest
  leaves no tree and no sentinel; a fake `runner.mjs` exiting 75 then 0 triggers exactly one
  refetch.
- No test runs `vp pack`. `build-runner`'s checks run in the release build and in CI's server
  build job.

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerBundle.test.ts
apps/server/src/sandbox/runnerHub/runnerBootstrap.live.test.ts`; `vp run typecheck` (server);
`vp run check:changed`. By hand once: `node apps/server/scripts/cli.ts build-runner --dev --out
<tmp>`, list the tree and its size, then in `docker run --rm -v <tmp>:/opt/pair-runner/<id>:ro
node:24` on linux x64 and arm64 check that `node-pty` spawns a shell and `@ff-labs/fff-node`
loads from that tree (03 open question 1), and that `runner.mjs runner` with an unreachable
`PAIR_RUNNER_URL` starts and redials. Attach the tree
listing, the size and that transcript.

**Reviewer checks.**

- Element 1 of `pack` is byte-for-byte today's config; the SEA path (`packExecutable`) builds no
  runner.
- `claude-history-worker.mjs` in the runner tree imports nothing outside itself.
- `runnerBuildId` is computed in one place and the bundle route serves only the current id.
- The bootstrap never runs an unverified tarball and never leaves a half tree under the id.
- The enrollment secret is not consumed by a bundle download and appears in no URL.
- The dev bundle's Replay files sit at the agent's own relative paths; the agent is unedited.

### 1.10 `feat(server): run search, process table, port listing and checkpoint capture in the runner`

Adds decision 2's coarse operations: a runner-local layer that runs existing server services
against the sandbox's own disk, one `ops.*` handler per operation, and the typed client the server
calls. It also adds `search.refresh` and runs a turn's capture and file summary as one call. Its own
PR because it is the only place server services are built inside the sandbox, and the fence that
keeps that set small lands with it.

- **Needs:** 1.6 (runner handler set and `RpcTest` harness), 1.1 (op schemas, listed below),
  0.1 (`LocalWorkspaceHost`, `WorkspaceHosts`; already under 1.1).
  **Unblocks:** 1.11 (`invoke = connection.ops`), 1.31 (`commitOid` for bundle prerequisites),
  1.33 (live files ride `search.*`).
- **Files:**
  - add `apps/server/src/sandbox/runner/opsLayer.ts`: the runner-local layer (below).
  - add `apps/server/src/sandbox/runner/handlers/ops.ts` (+ `.test.ts`): one handler per op,
    merged into 1.6's handler set.
  - add `apps/server/src/sandbox/runnerHub/RunnerOpsClient.ts`: builds `CoarseOperations` from
    the connection's `RpcClient`; 1.7's `RunnerConnection` gains `ops`.
  - add `apps/server/src/checkpointing/CheckpointCapture.ts`: the git half of
    `CheckpointServiceV2.capture` and `.captureBaseline`, moved, not copied.
  - change `apps/server/src/orchestration-v2/CheckpointService.ts`: `captureBaseline` and
    `capture` keep the lock, ids and `makeCheckpoint`, and call `CheckpointCapture`; warnings it
    returns are logged here with `scopeId`, as today.
  - change `apps/server/src/vcs/VcsDriver.ts:52` and `GitVcsDriver.ts:902`: `captureCheckpoint`
    returns the commit oid it already computes for `update-ref`;
    `checkpointing/CheckpointStore.ts:50` passes it through. Callers that ignore it compile as is.
  - add `apps/server/src/terminal/processTable.ts`: move `resolvePosixPsCommand`,
    `posixProcessTableSnapshot` and `parsePosixProcessTable` out of `terminal/Manager.ts`
    (lines ~774-823); `Manager.ts` imports them. Returns `ResourceMonitorProcessTableEntry[]`, which
    `processTableSnapshotFromProcesses` (Manager.ts:721) already consumes.
  - move `apps/server/src/auth/serverInternalPaths.ts` to `apps/server/src/workspace/serverInternalPaths.ts`
    and update its three importers (`vcs/GitVcsDriverCore.ts:53`, `workspace/WorkspaceFileSystem.ts`,
    `assets/AssetAccess.ts`). It is the one fenced module the runner's graph reaches today
    (`GitVcsDriver.ts` imports `GitVcsDriverCore.ts`).
  - change `apps/server/src/workspace/WorkspaceEntries.ts`: export `entriesFailureOf(error):
    ProjectEntriesFailure`, the `failure` half of `projectEntriesFailureContext` moved from
    `ws.ts:529`, so the runner maps errors with the same table.
  - add to `apps/server/src/workspaceHost/WorkspaceHost.ts`: the `CoarseOperations` interface, and
    `WorkspaceHosts.layerLocalOnly` in `WorkspaceHosts.ts` (below).
  - change `vite.config.ts`: an override for `apps/server/src/sandbox/runner/**` with
    `eslint/no-restricted-imports` patterns `**/orchestration-v2/**`, `**/persistence/**`,
    `**/auth/**`, `**/provider/**`, `**/mcp/**` (the fence of 03 §2.1).

**Types, services and RPCs.** Schemas in `packages/contracts/src/runner.ts` (1.1 declares them;
listed so both PRs agree). Payloads reuse the existing client contracts, so a result is byte-for-byte
what `ws.ts` returns today.

| RPC                      | Payload                           | Success                                   | Kind              | Service method it calls                                                                                 |
| ------------------------ | --------------------------------- | ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `ops.search.entries`     | `ProjectSearchEntriesInput`       | `ProjectSearchEntriesResult`              | call              | `WorkspaceEntries.search` (`workspace/WorkspaceEntries.ts:105`)                                         |
| `ops.search.contents`    | `ProjectSearchContentsInput`      | `ProjectSearchContentsResult`             | call              | `WorkspaceEntries.searchContents` (:111)                                                                |
| `ops.entries.browse`     | `ProjectListEntriesInput`         | `ProjectListEntriesResult`                | call              | `WorkspaceEntries.list` (:102). `WorkspaceEntries.browse` is the server's folder picker and stays local |
| `ops.search.refresh`     | `{ cwd }`                         | `void`                                    | call              | `WorkspaceEntries.refresh` (:114)                                                                       |
| `ops.processes.table`    | `{}`                              | `Array(ResourceMonitorProcessTableEntry)` | stream, on change | `processTable.readPosixProcessTable`                                                                    |
| `ops.ports.listeners`    | `{ configuredUrls }`              | `Array(DiscoveredLocalServer)`            | stream, on change | `PortDiscovery.scan` then `.subscribe` (`preview/PortScanner.ts:33-42`)                                 |
| `ops.checkpoint.capture` | `RunnerOpsCheckpointCaptureInput` | `RunnerOpsCheckpointCaptureResult`        | call              | `CheckpointCapture.captureBaseline` / `.captureTurn`                                                    |

```ts
// packages/contracts/src/runner.ts
export const RunnerOpsCheckpointCaptureInput = Schema.Union([
  Schema.TaggedStruct("baseline", { cwd: Schema.String, checkpointRef: CheckpointRef }),
  Schema.TaggedStruct("turn", { cwd: Schema.String, checkpointRef: CheckpointRef, previousCheckpointRef: CheckpointRef }),
]);
export const RunnerOpsCheckpointCaptureResult = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "error"]),
  commitOid: Schema.NullOr(Schema.String),           // for 1.31's bundle prerequisites (07 §1)
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  warnings: Schema.Array(Schema.Literals(["capture-failed", "previous-ref-lookup-failed", "authored-paths-failed", "diff-summary-failed"])),
});
export class RunnerOpsError extends Schema.TaggedError<RunnerOpsError>()("RunnerOpsError", {
  operation: Schema.Literals(["search.entries", "search.contents", "entries.browse", "search.refresh",
    "processes.table", "ports.listeners", "checkpoint.capture"]),
  failure: Schema.Union([ProjectEntriesFailure, Schema.Literal("failed")]),
}) {} // contracts cannot import server error classes; the category is what clients see anyway

// apps/server/src/checkpointing/CheckpointCapture.ts (plain Effect.fn functions, no new service)
export const captureBaseline: (input: { cwd: string; checkpointRef: CheckpointRef }) =>
  Effect.Effect<{ status: "ready" | "missing"; commitOid: string | null }, CheckpointStoreError, CheckpointStore.CheckpointStore>;
export const captureTurn: (input: { cwd: string; checkpointRef: CheckpointRef; previousCheckpointRef: CheckpointRef }) =>
  Effect.Effect<typeof RunnerOpsCheckpointCaptureResult.Type, never, CheckpointStore.CheckpointStore>;

// apps/server/src/workspaceHost/WorkspaceHost.ts
export interface CoarseOperations {
  readonly searchEntries: (input: ProjectSearchEntriesInput) => Effect.Effect<ProjectSearchEntriesResult, CoarseOperationError>;
  readonly searchContents: (input: ProjectSearchContentsInput) => Effect.Effect<ProjectSearchContentsResult, CoarseOperationError>;
  readonly listEntries: (input: ProjectListEntriesInput) => Effect.Effect<ProjectListEntriesResult, CoarseOperationError>;
  readonly refreshSearch: (cwd: string) => Effect.Effect<void>;          // failures logged, as WorkspaceEntries.refresh
  readonly processTable: Effect.Effect<ReadonlyArray<ResourceMonitorProcessTableEntry>, CoarseOperationError>;
  readonly portListeners: (configuredUrls: ReadonlyArray<string>) =>
    Stream.Stream<ReadonlyArray<DiscoveredLocalServer>, CoarseOperationError>;
  readonly checkpointCapture: (input: RunnerOpsCheckpointCaptureInput) =>
    Effect.Effect<RunnerOpsCheckpointCaptureResult, CoarseOperationError>;
}
export type CoarseOperationError = RunnerOpsError | RunnerLostError;
```

- **Runner-local layer** (`opsLayer.ts`): `LocalWorkspaceHost` plus `WorkspaceHosts.layerLocalOnly`
  (every path is local: inside the sandbox `/t3-sandbox/<id>/` is local disk, and 1.11's
  reserved-root routing would otherwise fail closed there), `ProcessRunner.layer`,
  `VcsProcess.layer`, `VcsDriverRegistry.layer` + `VcsProjectConfig.layer`, `CheckpointStore.layer`,
  `WorkspaceEntries.layer` (brings `WorkspaceSearchIndexMap` and `VcsProcess`), `PortScanner.layer`
  with `FetchHttpClient.layer`, on `NodeServices.layer`. No `ServerConfig`, no settings, no SQL.
  Built once at runner start; the handlers close over it.
- **Handlers** decode, call one method, encode, as `ws.ts` handlers do. Errors map with
  `entriesFailureOf`; anything else is `failure: "failed"`.
- **Streams.** `processes.table` reads `ps` every second only while subscribed, on the runner,
  and emits when the sorted entries change (`Equal`), so an idle sandbox sends nothing.
  `ports.listeners` emits `scan`'s snapshot, then each `subscribe` callback. These are snapshots, not
  byte streams: 1.8's seq resume does not apply; after a drop the client resubscribes and gets a full
  snapshot. `RunnerOpsClient.processTable` keeps the latest snapshot in a `SubscriptionRef` per
  connection, started on first read, so the terminal manager's 1 s poll costs no round trip.
- **Server call points for 1.11** (one branch each, inside the existing lock or method):
  `WorkspaceEntries.search/searchContents/list/refresh` (`WorkspaceEntries.ts` per method),
  `CheckpointServiceV2.captureBaseline/capture` inside `withWorkspaceLock` (`CheckpointService.ts:243`),
  the terminal manager's per-host `processes.table` (0.5), and per-host `PortDiscovery` (0.10).
  The branch is `host.kind === "sandbox" ? host.invoke.x(input) : today's call`. The server keeps
  the in-memory lock around the op (07 §1), so a sandbox capture and a restore never overlap.
- **Fence.** The lint fence covers direct imports. 1.9's bundle step must also assert the runner
  bundle's module list has no `orchestration-v2/`, `persistence/`, `auth/` or `Adapters/` path
  (transitive check). Rule for a service whose layer or module drags a fenced module in: split the
  service so the needed half lives outside the fenced folder (as `CheckpointCapture` and
  `serverInternalPaths` above); never copy code into `sandbox/runner/`.

**Commands, events and effects.** None. `checkpoint.capture` runs inside the existing
`checkpoint.capture` outbox effect (`CheckpointCaptureService`), which 1.31 extends.

**Tests.**

- `orchestration-v2/CheckpointService.test.ts` "skips unsupported baseline and turn checkpoints
  without swallowing capture failures" stays green unchanged: it guards the split. 0.3's op-count
  assertions on capture stay equal (the oid return adds no git call).
- `vcs/GitVcsDriver.test.ts`: extend "checkpoint capture keeps LF files that core.safecrlf would
  refuse to commit" (line 319) to assert the returned oid equals `rev-parse <ref>`.
- `sandbox/runner/handlers/ops.test.ts` (new; no runner op tests exist): `it.effect` with
  `RpcTest.makeClient(RunnerRpcGroup)` over the real handlers and `opsLayer` on a temp git repo:
  a `turn` capture returns the ref's oid and the edited file in `files`; a `baseline` with an
  existing ref is a no-op; `search.refresh` after writing a file makes `search.entries` find it;
  `processes.table` emits once for two identical reads (`TestClock.adjust("1 second")` twice).
  `it.live` only for the temp repo's git subprocesses, as `CheckpointStore.test.ts` does.
- A codec row in 1.1's round-trip table for each new schema (SchemaBinary, frame under 256 KiB
  for a 25,000-entry search result; it fails here first if a result needs chunking).

**Verify.** `vp test run apps/server/src/sandbox/runner apps/server/src/orchestration-v2/CheckpointService.test.ts apps/server/src/vcs/GitVcsDriver.test.ts apps/server/src/terminal/Manager.test.ts`;
`vp run typecheck` (contracts and server); `vp run check:changed`. No runtime surface until 1.11.

**Reviewer checks.**

- `CheckpointCapture` is moved code: `CheckpointServiceV2` behaves the same for local threads
  (same statuses, same warning logs, same git call count).
- Ops carry a cwd, never a thread id, and nothing in the runner keys state by thread.
- `WorkspaceHosts.layerLocalOnly` is used only in `opsLayer.ts`.
- Nothing under `sandbox/runner/` imports a fenced folder, directly or through the bundle graph.
- Stream ops send nothing while unchanged.

### 1.11 `feat(server): add SandboxWorkspaceHost and sandbox root registration`

Makes a registered sandbox a real `WorkspaceHost`: every member maps onto one `RunnerConnection`
call, `forPath` reaches it while the runner's boot is live, and the existing checkpoint suites pass
through an in-memory runner. Its own PR because it is the first host that is not local, and the
loopback host is the test bed for 1.12, 1.24 and 1.34.

- **Needs:** M0 (0.1–0.10: every caller already resolves a host), 1.8 (resumable `RunnerConnection`),
  1.10 (`ops.*` handlers and schemas). **Unblocks:** 1.12, 1.16, 1.24, 1.25, 1.33, 1.34, 1.44.
- **Files:**
  - add `apps/server/src/workspaceHost/SandboxWorkspaceHost.ts`: `make(sandboxId, connection)`.
  - change `apps/server/src/workspaceHost/WorkspaceHost.ts`: add the optional `invoke?:
    CoarseOperations` member (absent on the local host, see below) and `isRunnerLost(error)`.
  - change `apps/server/src/workspaceHost/WorkspaceHosts.ts`: `register` stores `root → host` in a
    `Map` and removes it on scope close; `forPath` checks registered roots before the reserved-root
    fail-closed rule.
  - change `apps/server/src/workspaceHost/WorkspaceHostTesting.ts`: add `layerLoopback`.
  - add `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.ts` with only the pure
    `sandboxBaseEnvironment(info: RunnerInfo): Record<string, string>` (1.25 adds the service).
  - change `apps/server/src/sandbox/runnerHub/RunnerHub.ts` (from 1.7): on the first `hello` of a
    `runnerBootId`, `hosts.register(`${SANDBOX_ROOT}/${sandboxId}`, SandboxWorkspaceHost.make(...))`
    inside that boot's channel scope. The scope closes on lease expiry, a new boot, `revoke` or
    drain, so `forPath` then fails closed with `WorkspaceHostUnavailableError { sandboxId }` (P6). A
    socket blip inside the lease keeps the registration; calls wait on the resumed connection.
  - change `packages/contracts/src/runner.ts` (from 1.1): `RunnerInfo` gains the agent user's
    facts, **proposed**: `agent: { uid, homeDirectory, shell }`, `tmpDirectory`, `bundleDirectory`
    (`/opt/pair-runner/<runnerBuildId>`), `imageEnvironment: Record<string,string>` (the image's
    `ENV` minus `PAIR_*`, read by the runner at boot). `RunnerConnection` (03 §7) gains `readonly
    info: RunnerInfo`.
  - change `apps/server/src/workspace/KnownWorkspaces.ts` `contains`: a `realPath` under a
    registered sandbox root passes when it lies within a non-deleted thread's `worktreePath` under
    the same root (reuse the existing thread query at :94-103; skip the `listWorktreePaths` check).
  - change `apps/server/src/workspace/WorkspaceEntries.ts` (`browse`, `list`, `search`,
    `searchContents`, `refresh`) and `apps/server/src/orchestration-v2/CheckpointService.ts`
    (`captureBaseline` :250, `capture`): when `host.invoke` is present, call it and return; the
    server keeps `withWorkspaceLock` (:244) around the call (07 §1).

**Types, services and RPCs.**

```ts
// workspaceHost/WorkspaceHost.ts (additions)
export interface CoarseOperations {          // payloads and results are 1.10's RunnerOps* schemas
  readonly entries: {
    readonly browse: (input: RunnerOpsEntriesBrowseInput) => Effect.Effect<RunnerOpsEntriesBrowseResult, WorkspaceHostError>;
    readonly list: (input: RunnerOpsSearchListInput) => Effect.Effect<ProjectListEntriesResult, WorkspaceHostError>;
    readonly search: (input: RunnerOpsSearchEntriesInput) => Effect.Effect<RunnerOpsSearchEntriesResult, WorkspaceHostError>;
    readonly searchContents: (input: RunnerOpsSearchContentsInput) => Effect.Effect<RunnerOpsSearchContentsResult, WorkspaceHostError>;
    readonly refresh: (cwd: string) => Effect.Effect<void, WorkspaceHostError>;
  };
  readonly checkpoint: {
    readonly captureBaseline: (input: RunnerOpsCheckpointBaselineInput) => Effect.Effect<void, WorkspaceHostError>;
    readonly capture: (input: RunnerOpsCheckpointCaptureInput) => Effect.Effect<RunnerOpsCheckpointCaptureResult, WorkspaceHostError>;
  };
}
// Local host leaves `invoke` undefined: inside the runner, the same consumers run their local code
// path against the runner's LocalWorkspaceHost, so an op can never call itself.
export const isRunnerLost = (error: PlatformError.PlatformError): boolean => /* cause is RunnerLostError */;

// workspaceHost/SandboxWorkspaceHost.ts
export const make = Effect.fn("SandboxWorkspaceHost.make")(function* (
  sandboxId: SandboxId,
  connection: RunnerConnection,
): Effect.fn.Return<WorkspaceHost, never, Scope.Scope> { /* … */ });
```

Member mapping (one runner call each; errors become `PlatformError` with `_tag: "BadResource"` and
the `RunnerLostError` as `cause` when the boot is gone, else the runner's own reason):

| Member                                                  | Runner call                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `kind`                                            | —                                                                   | `sandboxId`, `"sandbox"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `info`                                                  | `connection.info`                                                   | `platform: "linux"`, `architecture: info.arch`, `homeDirectory`/`shell`/`userId` from `info.agent`, `tmpDirectory`, `executablePath: <bundleDirectory>/t3`, `environment`: `sandboxBaseEnvironment(info)` (allowlist plus image env; 1.25 adds the team and project layers at spawn). Fixed per boot, so a new boot is a new host. 0.1 types `info` as an `Effect`, so the sandbox host returns `Effect.succeed(...)`; 0.1 left out `shell` and `tmpDirectory`, so this PR adds them to `WorkspaceHostInfo` only where 1.12 reads them.                                                                                                                                          |
| `spawner`                                               | `connection.spawn`                                                  | `ChildProcessSpawner.make(spawn)`. `StandardCommand` only; `PipedCommand` fails `badArgument` (no thread code pipes). `extendEnv` extends `info.environment`, never `process.env`. `killSignal` and `forceKillAfter` go in the spawn frame (runner escalates). `detached`/`processGroup: "kill-on-close"` map to the frame's process-group flag. Handle built with `ChildProcessSpawner.makeHandle` from `RunnerProcess`: `stdout`/`stderr`/`getOutputFd` are `process.output` streams, `stdin`/`getInputFd` are sinks on the writer fiber, `exitCode` is `process.wait`, `kill` is `process.signal`, `unref` is a no-op returning a no-op `Reref`. `pid` is the in-sandbox pid. |
| `fileSystem`                                            | `connection.fs`                                                     | `FileSystem.make({...})` so `exists`, `glob`, `stream`, `sink` derive. `open` with flag `r` returns a read-only `File` whose `seek`/`read`/`readAlloc` are ranged `fs.readFile { offset, maxBytes }` calls (Claude's task-output tail needs it, 1.12); other flags, `chown` and `link` fail `PlatformError` "unsupported" (02 open question 4). `watch` is `connection.watch`.                                                                                                                                                                                                                                                                                                   |
| `files.readNoFollow`, `writeNoFollow`, `realPathNative` | `fs.readFile` / `fs.writeFile` with `noFollow: true`, `fs.realPath` | the runner applies `O_NOFOLLOW` on its own disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pty`                                                   | `connection.openPty`                                                | `PtyAdapter.spawn` is not scoped: each PTY opens in `Scope.fork(hostScope)`, closed on `onExit` or host scope close. `write`/`resize`/`kill` enqueue on the PTY writer fiber (sync interface).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agentScope`                                            | —                                                                   | identity wrap: `AgentScope`'s `defaultValue` (the sandbox is its own scope, 02 §1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `processes.signalGroup`                                 | `process.signal` with `group: true` by pid                          | never signals a server pid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `processes.table`                                       | `ops.processes.table` stream                                        | latest element in a `SubscriptionRef` held in the host scope; the member reads it (first value awaited)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ports.listeners`                                       | `ops.ports.listeners` stream                                        | same as above; `ports.connect` stays M2 (fails "unsupported")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exposeServerEndpoint`                                  | `connection.openForward(endpoint.name, endpoint.ownerKey)`          | scoped; returns the in-sandbox address (1.13 serves the target)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `invoke`                                                | `connection.ops.*`                                                  | one call each                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

VCS detection on sandbox paths: `VcsDriverRegistry.detect` re-validates every hit with 3+
`exists` calls (`apps/server/src/vcs/VcsDriverRegistry.ts:122-133`, `:157-173`), so on a sandbox
path the cache saves nothing. 1.11 adds no per-host cache: a cache that skips validation changes
behavior, and 1.10's coarse baseline and capture run detection inside the runner. What remains on
the server (local status, PR discovery) is measured by 1.44 at 75 ms RTT; if `vcs.localStatus`
passes 300 ms it joins the coarse list (02 §5), not a cache.

`forPath` rules: normalize with `path.posix.resolve` before matching (so
`/t3-sandbox/a/../b` cannot reach `b` via `a`), then longest registered root prefix, then the
reserved root fails closed, else local. **Proposed:** `register` accepts any absolute root, not only
`/t3-sandbox/<id>`, so tests register a temp dir without root privileges; only `RunnerHub` and
tests call it.

**Commands, events and effects.** None. Registration is in memory; attach and loss stay 1.7's.

**Tests.**

- `workspaceHost/WorkspaceHosts.test.ts` (from 0.1), extend the routing cases: a registered root
  routes to the registered host; after the registration scope closes, the same path fails with
  `WorkspaceHostUnavailableError`; `..` segments do not escape a root.
- `workspaceHost/SandboxWorkspaceHost.test.ts` (new; no existing file covers a remote host), all on
  `layerLoopback`: interrupting `spawner.string(...)` kills the process (await the runner-side exit
  `Deferred` from 1.8's in-process runner); closing a spawn scope applies `forceKillAfter` on the
  runner side (`TestClock.adjust`); a dropped boot (`RunnerHubTesting` fault `Deferred`, lease
  expiry on `TestClock.adjust`) fails `exitCode` with `isRunnerLost`; `fs.watch` finalizer
  unsubscribes; a PTY round-trips and its scope closes on exit.
- `checkpointing/CheckpointStore.test.ts` and `orchestration-v2/CheckpointService.test.ts`: turn
  the top-level `it.layer(layerTest)` into one `describe.each([["local", layerTest], ["loopback",
  layerLoopbackTest]])`, so capture, diff, summaries and restore run once more through the loopback
  host (02 §7). `layerLoopbackTest` registers the test's temp root.
- `workspace/KnownWorkspaces` cases (extend the existing test file if 0.4 added one, else the one
  `contains` case lives in `WorkspaceEntries.test.ts`): a thread worktree under a registered root
  passes; another sandbox's path under the reserved root fails.
- `layerLoopback`: every call encoded with the `RunnerRpcGroup` SchemaBinary codec and served by
  `RunnerHubTesting`'s in-process runner over its socket pair, backed by `LocalWorkspaceHost`;
  optional per-frame delay through `TestClock`.

**Verify.** `vp test run apps/server/src/workspaceHost apps/server/src/checkpointing/CheckpointStore.test.ts
apps/server/src/orchestration-v2/CheckpointService.test.ts apps/server/src/workspace`, then
`vp run check:changed`, `vp run typecheck` (contracts and server change). Runtime transcript: a
dev server with the Docker driver (1.14) and a loopback-only check is enough here; the first real
sandbox run is 1.16's.

**Reviewer checks.**

- No `process.env`, `HostProcess` or server `FileSystem` read inside `SandboxWorkspaceHost.ts`;
  the base env is `info.environment` only.
- Unregistered `/t3-sandbox/<id>/…` never falls back to local, and `..` cannot hop roots.
- The host's lifetime is one runner boot: a new `runnerBootId` replaces the registration, never
  reuses handles.
- `invoke` is absent on `LocalWorkspaceHost`, so the runner's own consumers never loop.
- Server-side `withWorkspaceLock` still wraps coarse checkpoint calls.
- `stderr` and extra fds are drained or exposed, never left to fill the runner's buffer silently.

### 1.12 `feat(server): run ACP (Replay), Codex and Claude sessions on sandbox hosts`

Provider sessions whose `runtimePolicy.cwd` is a sandbox path run their CLI in the sandbox: Replay
first (the free test path, P5), then Codex, then Claude. Every other adapter refuses a sandbox cwd
with one typed error. Its own PR because it is the adapter half of 02 §6 PR 10; the host itself is
1.11.

- **Needs:** 1.9 (bundle with the unsplit `claude-history-worker.mjs`, `t3` shim, dev Replay agent),
  1.11 (host), 1.13 (forwards). **Unblocks:** 1.16, 1.26, 1.34.
- **Files:**
  - change `apps/server/src/orchestration-v2/ProviderSessionManager.ts` `open` (the `stat(cwd)`
    block at :2126-2137): resolve the host once; on a sandbox host, refuse drivers that are not
    cloud-ready with `ProviderCloudUnsupportedError` (declared beside `ProviderWorkspaceMissingError`
    in the same file), and after `Scope.fork(sessionScopes)` open the `mcp` forward in the session
    scope and record it with `mcpSessions.useEndpoint(threadId, url)` (below).
  - change `packages/provider-core/src/server/McpProviderSessions.ts`: add `useEndpoint(threadId,
    endpoint): Effect<void, never, Scope>`; `read` returns the stored config with `endpoint`
    replaced while the scope is open. One map. Claude, Codex and ACP then pick the forward address
    up with no adapter edit (they read `mcpSessions.read`, e.g. `CodexAdapterV2.ts:1725`).
  - change `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: `ClaudeAgentSdkQueryOpenInput`
    (:541), `ClaudeAgentSdkSessionForkInput` (:686) and `ClaudeAgentSdkSubagentLookupInput` (:694)
    carry the session's `host`. In `layerQueryRunner.open` (:1148): `agentScope` is `host.agentScope`
    (identity on sandbox, so `agentScope.wrap` at :1204 is a no-op), and the default spawn at
    :1232-1252 becomes `host.kind === "local" ? today : makeSandboxClaudeProcess(host, ...)`.
    `forkSession` (:1559), `subagentLaunchToolUseId` (:1623) and both `resolveSettings` calls
    (`resolveBypassAvailability` :4885, `resolveSubagentPromptCacheTtl` :4919) run through
    `runClaudeWorker` on the host when it is a sandbox; settings files (`remote-settings.json`,
    `settings.json`) are read with `host.fileSystem` from the sandbox home.
  - add `apps/server/src/sandbox/providers/ClaudeSandboxProcess.ts`: `makeSandboxClaudeProcess`, the
    SDK `SpawnedProcess` built from a host `ChildProcessHandle`.
  - change `apps/server/src/claudeHistoryWorker.ts`: add `getSubagentMessages` and `resolveSettings`
    methods (options schema gains `agentId`, `limit`, `cwd`, `settingSources`,
    `serverManagedSettings`; `resolveSettings` takes `-` as its session id).
  - change `apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts`: `tailClaudeTaskOutput`
    takes an optional `changes: Stream<void>`; when given, `pause` waits for the next change or
    `stop` instead of the 250 ms timer. The adapter (:9410) passes `host.fileSystem.watch(root,
    { recursive: true })` on sandbox hosts and reads through `host.fileSystem` (whose `open` 1.11
    serves as a ranged read). `claudeTaskOutputRoot` (:17) takes the uid from `host.info.userId`,
    not `process.getuid()`.
  - change `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` `openSession` (:1738) and
    `layerAppServerClientFactory.open` (:1594): on a sandbox host, spawn with `host.spawner` and
    `host.agentScope`, `command: "codex"` (the image's pinned CLI, 05 §1, not the server's
    `binaryPath`), and `CODEX_HOME = /t3-sandbox/<id>/homes/<instanceId>` created with
    `host.fileSystem.makeDirectory(..., { recursive: true })` at open (P1). No shadow overlay: there
    is no shared home in the sandbox to link, and an `auth.json` must never be written there
    (decision 10), so `materializeCodexShadowHome` (CodexHomeLayout.ts:350) does not run for
    sandbox sessions. Instance creation (:1665) is unchanged.
  - change `apps/server/src/provider/CodexManagedRuntime.ts` `resolve`: add `resolveFor(host)`. On a
    sandbox host the auth command is `<dirname(host.info.executablePath)>/t3 __managed-chatgpt-token
    <forward socket> <instance> <environment> <profile key>`, where the socket is
    `host.exposeServerEndpoint({ name: "codex-token", ownerKey: providerSessionId, localAddress:
    brokerEndpoint })` (06 §3: only the socket argument and the command change);
    `installation.acquire()` and the server-side shadow home are skipped.
  - change `packages/provider-acp/src/server/adapter.ts` at :6879 and :6960: provide
    `host.spawner` and `host.agentScope` instead of the captured `childProcessSpawner` and
    `agentScope` (the one-identifier swap 0.6 prepared). Change
    `packages/provider-acp/src/server/AcpSessionRuntime.ts` (:1381): pass `linuxCgroupController:
    null` when the host is a sandbox (the cgroup read of `/proc/self/cgroup` is the server's).
  - change `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts` `resolve` (local
    source, :1828): on a sandbox host skip `resolveExecutable`/`validateLocalExecutable` (server PATH
    checks) and map Replay to `node <dirname(executablePath)>/replay/dev-replay-agent.mjs`.

How the ACP packages see the host: through the accessor 0.6 added to `ProviderHost`
(`packages/provider-core/src/server/ProviderHost.ts`); the packages cannot import `apps/server`. If
0.6 added none, add `workspaceHost(cwd)` there returning a structural subset (`kind`, `info`,
`spawner`, `agentScope`, `exposeServerEndpoint`) declared in provider-core.

**Types, services and RPCs.**

```ts
// orchestration-v2/ProviderSessionManager.ts
export class ProviderCloudUnsupportedError extends Schema.TaggedError<ProviderCloudUnsupportedError>()(
  "ProviderCloudUnsupportedError",
  { threadId: ThreadId, driver: ProviderDriverKind },
) {
  override get message() {
    return `${this.driver} is not supported in cloud yet. Pick Claude or Codex.`;
  }
}
// Cloud-ready in M1: claudeAgent, codex, and acpRegistry only for DEV_REPLAY_INSTANCE_ID
// (ProviderInstanceRegistryHydration.ts:83). Everything else (Cursor, Muse, OpenCode, Pi, Grok,
// Kiro, fx, Antigravity, other ACP agents) is refused here, before any adapter code runs.

// sandbox/providers/ClaudeSandboxProcess.ts
export const makeSandboxClaudeProcess =
  (input: {
    readonly host: WorkspaceHost;
    readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
    readonly onStderr: (text: string) => void;
  }) =>
  (options: ClaudeSpawnOptions): ClaudeSpawnedProcess => {
    /* … */
  };
```

Bridge rules (02 §7): `command` is replaced by the image's `claude` (the SDK computes it from the
server's `pathToClaudeCodeExecutable`; args are kept, a leading server-side script path dropped);
the spawn sets the group flag so the runner's watcher kills the CLI's group on exit, as
`spawnClaudeProcessGroup` (:369) does locally. `stdout` is a Node `Readable` whose `read()` pulls the
next chunk from `handle.stdout`, so a slow SDK pauses the runner's pipe (03 §4.5). `stdin` is a
`Writable` feeding `handle.stdin` through the writer fiber. `stderr` is always drained into
`onStderr`. `"exit"` fires only after `handle.stderr` has ended and `handle.exitCode` resolved,
which keeps today's "stderr drained before exit" guarantee (:1236). `kill(signal)` is
`handle.kill({ killSignal })`; the SDK's `AbortSignal` calls it too.

History worker on a sandbox host: `runClaudeWorker` (:1097) spawns `node
<dirname(host.info.executablePath)>/claude-history-worker.mjs <method> <sessionId> <json>` with
`host.spawner` and the session's environment (`CLAUDE_CONFIG_DIR` = the sandbox home). The
in-process branch (`usesHostConfig`) is local only.

Claude home in the sandbox: `CLAUDE_CONFIG_DIR = /t3-sandbox/<id>/homes/<instanceId>` (P1), made
at open. The server-side instance home (user `settings.json`, skills) does not reach the sandbox in
M1; project `.claude/` files come with the repo. Say so in 1.45's guide.

**Commands, events and effects.** None new. A refused open fails the existing
`provider-turn.start` path, which records the run failure with the error's message.

**Tests.**

- `orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts`, describe "Claude CLI process"
  (:534): run "reports the CLI's root refusal when it exits before answering" (:602) and "keeps
  other startup stderr out of the turn failure" (:610) once more with a loopback host (one
  `describe.each`), which proves stderr-before-exit through the bridge. Add one case there for
  backpressure: the fake CLI writes 8 MiB, the test reads slowly, the runner-side source pauses
  (assert the in-process runner's paused count), all bytes arrive once.
- Same file, "forks a session stored under the instance's own CLAUDE_CONFIG_DIR" (:78): add a
  loopback row asserting the worker ran through the host spawner (recording host counts one spawn).
- `orchestration-v2/Adapters/ClaudeTaskOutputTail.test.ts` describe `tailClaudeTaskOutput` (:24):
  one case with `changes` from a `Queue`; offering a change delivers the appended text, completing
  `stop` performs the final read. No timer is advanced.
- `orchestration-v2/Adapters/CodexAdapterV2.test.ts`: a sandbox-host open spawns `codex` with
  `CODEX_HOME` under the sandbox root, writes no `auth.json` (recording host), and, for a managed
  runtime, puts the forward socket and the bundle `t3` in the launch args.
- `orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`: Replay on a loopback host spawns
  through the host and creates no cgroup lease.
- `ProviderSessionManager` tests: a sandbox cwd with a Cursor instance fails with
  `ProviderCloudUnsupportedError` before the adapter's `openSession` is called.

**Verify.** `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`, `vp run check:changed`,
`vp run typecheck`. Runtime transcript: on a dev server with the Docker driver, one Replay turn in a
sandbox (free), then once 1.26 lands one Haiku turn and one Codex turn on the cheapest model.

**Reviewer checks.**

- Local sessions take exactly today's path: `spawnClaudeProcessGroup`, the in-process SDK calls,
  the shadow home, the cgroup lease.
- No server path reaches a sandbox process: binary paths, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, the
  worker path and the auth command are all sandbox paths.
- No credential file is written in the sandbox (no `auth.json`, no copied Claude login).
- The SDK never sees `"exit"` before `stderr` ends; the bridge never buffers stdout without bound.
- Forwards are opened in the provider session's scope, so they close with the session.
- Verify the pinned SDK does not `existsSync` the executable in a way the command swap breaks.

### 1.13 `feat(server): forward MCP, the Codex token broker and git credentials over the runner`

Gives agents in a sandbox the three server endpoints they call back today, through named forwards
on the runner socket, each with a server-side check: MCP as a bearer-checking HTTP proxy pinned to
`/mcp`, the Codex broker as a frame-checking proxy, and the git credential helper with a seam 1.28
fills. Its own PR because it is the sandbox's whole path back into the server.

- **Needs:** 1.7 (connection), 1.8 (seq and window rules the forwarded TCP bytes use).
  **Unblocks:** 1.12 (sessions on sandbox hosts get working endpoints), 1.26 (managed Codex in
  cloud), 1.28 (fills `GitCredentialService`), 3.17 (git proxy reuses forwards).
- **Files:**
  - add `apps/server/src/sandbox/runner/handlers/forwards.ts` (+ `.test.ts`): `forward.open`
    (scoped listener: `127.0.0.1:0` for `mcp`, a Unix socket in `/run/pair-runner/` for the
    others), accepts pushed on `runner.events` as `forward.accepted { forwardId, connectionId }`,
    and `tcp.read`/`tcp.write`/`tcp.close` for accepted connections (03 §4.2, M1 part).
  - add `apps/server/src/sandbox/runner/gitCredentialHelper.ts`: the `t3 runner git-credential
    <get|store|erase>` entry (a fast path in 1.6's `sandbox/runner/bin.ts`). Reads git's
    `key=value` stdin, sends one JSON line, prints `username`, `password` and
    `password_expiry_utc`.
  - add `apps/server/src/sandbox/runnerHub/RunnerForwards.ts` (+ `.test.ts`): the server side.
  - add `apps/server/src/sandbox/credentials/GitCredentialService.ts`: the tag and `layerNone`
    (answers `null`); 1.28 adds the real `layer` and server.ts switches to it.
  - change `apps/server/src/workspaceHost/WorkspaceHost.ts`: `ServerEndpoint` type (below).
  - change `apps/server/src/mcp/McpSessionRegistry.ts`: expose the `endpoint` it already computes
    (line ~88) as `readonly endpoint: string` on the shape, so the proxy targets the same address.
  - change `packages/contracts/src/runner.ts`: `RunnerForwardName`, `RunnerGitCredentialRequest`,
    `RunnerGitCredentialResponse` (if 1.1 did not declare them).
  - change `apps/server/src/server.ts`: `RunnerForwards.layer`, `GitCredentialService.layerNone`
    beside 1.7's `RunnerHub.layer`.

**Types, services and RPCs.**

```ts
// packages/contracts/src/runner.ts
export const RunnerForwardName = Schema.Literals(["mcp", "codex-token", "git-credential"]);
export const RunnerGitCredentialRequest = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literals(["get", "store", "erase"]),
  protocol: Schema.String,
  host: Schema.String,
  path: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId), // from T3CODE_THREAD_ID in the helper's env
});
export const RunnerGitCredentialResponse = Schema.Struct({
  version: Schema.Literal(1),
  credential: Schema.NullOr(
    Schema.Struct({
      username: Schema.String,
      password: Schema.Redacted(Schema.String),
      expiresAt: Schema.DateTimeUtc,
    }),
  ),
});

// apps/server/src/workspaceHost/WorkspaceHost.ts (proposed shape for 02's ServerEndpoint)
export interface ServerEndpoint {
  readonly name: "mcp" | "codex-token";
  readonly address: string; // today's local address; the local host returns it unchanged
  readonly ownerKey: string; // mcp: the McpSessionRegistry providerSessionId; codex-token: the instance id
}
// SandboxWorkspaceHost.exposeServerEndpoint = RunnerForwards.open(sandboxId, name, ownerKey) (1.11 wires it).

// apps/server/src/sandbox/runnerHub/RunnerForwards.ts
export class RunnerForwards extends Context.Service<
  RunnerForwards,
  {
    /** Opens a named forward in the sandbox; closing the scope closes the listener. Returns the in-sandbox address. */
    readonly open: (input: {
      readonly sandboxId: SandboxId;
      readonly name: "mcp" | "codex-token";
      readonly ownerKey: string;
    }) => Effect.Effect<string, RunnerUnavailableError | RunnerLostError, Scope.Scope>;
    /** Opened by RunnerHub on every attach, for the connection's lifetime, at /run/pair-runner/git-credential.sock. */
    readonly openGitCredential: (
      sandboxId: SandboxId,
    ) => Effect.Effect<void, RunnerLostError, Scope.Scope>;
  }
>()("t3/sandbox/RunnerForwards") {}

// pure checks, table-tested
export const mcpForwardAllows = (
  scope: McpThreadInvocationScope | undefined,
  ownerKey: string,
  pathname: string,
) => pathname === "/mcp" && scope !== undefined && scope.thread.providerSessionId === ownerKey;
export const codexForwardAllows = (request: CodexManagedTokenProtocol.Request, ownerKey: string) =>
  request.instanceId === ownerKey;

// apps/server/src/sandbox/credentials/GitCredentialService.ts
export class GitCredentialService extends Context.Service<
  GitCredentialService,
  {
    readonly answer: (input: {
      readonly sandboxId: SandboxId;
      readonly threadId: ThreadId;
      readonly protocol: string;
      readonly host: string;
      readonly path: string | undefined;
    }) => Effect.Effect<RunnerGitCredentialResponse["credential"], GitCredentialError>;
  }
>()("t3/sandbox/credentials/GitCredentialService") {}
export const layerNone = Layer.succeed(
  GitCredentialService,
  GitCredentialService.of({ answer: () => Effect.succeed(null) }),
);
```

- **`mcp`.** Each accepted connection becomes a Node `Duplex` over `tcp.read`/`tcp.write` and is
  handed to a never-listening `http.Server` with `server.emit("connection", duplex)`. The handler
  reads `Authorization: Bearer`, calls `McpSessionRegistry.resolve`, and forwards only when
  `mcpForwardAllows`, streaming request and response (SSE) to `registry.endpoint` with
  `http.request`. Otherwise `401` (or `404` for any other path), and the target is never called.
  The `ownerKey` check implies the sandbox binding: the server opened the forward on this
  sandbox's socket for that provider session, and session ids are unique, so no projection read is
  needed per request. Member API tokens and `mcp-client` sessions never resolve in the registry.
  The path pin matters: the target listener also serves `/api`, whose auth depends on the bind host,
  not the peer (`EnvironmentAuthPolicy.ts`).
- **`codex-token`.** Read one frame with `CodexManagedTokenProtocol.readFrame(socket,
  REQUEST_BYTES, SOCKET_IDLE_MS)`, decode `Request`, require `codexForwardAllows`, then connect to
  `CodexManagedTokenBroker.endpoint`, write the frame and pipe one response frame back (at most
  `RESPONSE_BYTES`). The broker still checks the environment id and profile key
  (`CodexManagedTokenBroker.ts:146-154`). `ownerKey` is the provider instance id because one Codex
  app-server serves every thread of an instance (`CodexAdapterV2.ts:1422`). The command Codex runs
  is the bundle's `t3` with the forward's socket as its first argument (1.12 and 1.26 build it from
  `host.info.executablePath`).
- **`git-credential`.** One listener per sandbox at a fixed path, so git's helper finds it without
  per-process env. The server decodes `RunnerGitCredentialRequest`; `store` and `erase` answer
  `credential: null` and do nothing (the server mints, nothing is stored). For `get`, the thread is
  `threadId`, or the sandbox's `ownerThreadId` when absent (**proposed**: terminals and scripts
  carry no `T3CODE_THREAD_ID`; 06 §2 already treats a terminal as reaching every thread's
  credentials). A thread not in 1.3's `sandbox_threads` for this sandbox answers `null` without
  calling the service. 1.28's service checks the remote, mints and caches until 5 minutes before
  expiry (the cache sits on the server, since each helper is a fresh process). The preparation
  fiber's clone (P4) and setup script run with `T3CODE_THREAD_ID` set (1.16).

**Commands, events and effects.** None. Audit events for minted git tokens are 1.28's (06 §7).

**Tests.**

- `RunnerForwards.test.ts` (new): an `it` table over `mcpForwardAllows` (own session token on
  `/mcp`; another session's token; unresolved token; own token on `/api/orchestration`) and
  `codexForwardAllows` (own instance; sibling instance); one `it` for git: an unbound thread gets
  `null` and a recording `GitCredentialService` sees no call. Then one `it.live` (network fixture,
  loopback only) through `RunnerHubTesting`: a real HTTP request to the sandbox-side `mcp` address
  reaches a test `/mcp` route with the right bearer and is refused with the wrong one; a frame on
  the `codex-token` socket reaches a fake broker socket. No sleeps: await the fake target's
  `Deferred`.
- `sandbox/runner/handlers/forwards.test.ts` (new): `RpcTest.makeClient` against the handler:
  closing `forward.open`'s scope removes the listener (connect refused) and ends its accepts;
  `tcp.write` seq dedup follows 1.8's rule.
- `gitCredentialHelper`: one `it` table that parses git's stdin (`protocol`, `host`, `path`, blank
  line terminator) and prints the response with `password_expiry_utc`.

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerForwards.test.ts apps/server/src/sandbox/runner`;
`vp run typecheck`; `vp run check:changed`. Runtime transcript after 1.11: a Replay turn on a
Docker sandbox calls an MCP tool (proxy log line with the session id, never the token), and
`git ls-remote` in the sandbox terminal prints the helper's `null` answer until 1.28.

**Reviewer checks.**

- The sandbox never names a target: every forward's target is fixed by its name on the server.
- The MCP proxy forwards only `/mcp`, only with a bearer whose `providerSessionId` is the
  forward's `ownerKey`, and logs neither the bearer nor bodies.
- The Codex proxy refuses before connecting to the broker; frame size limits match the protocol.
- No credential is written to the sandbox's disk; the git answer lives only in the helper's stdout.
- Forward scopes close with the provider session (MCP), the app-server (Codex) or the runner
  connection (git), so a session's address stops working when it ends.

### 1.14 `feat(server): add the Docker compute driver with isolation detection`

Gives the server a real backend: Docker on the server's machine or on another host, with limits, a
network that cannot reach private ranges, no Docker socket inside, and an honest report of what
isolation the daemon offers. Its own PR because it is the first driver to pass 1.4's contract suite
and needs its own Linux CI job.

- **Needs:** 1.4. **Unblocks:** 1.15 (socket route), 1.16, 1.19, 1.23, 1.40 (Test button reads
  `health`).
- **Files:**
  - add `apps/server/src/sandbox/compute/DockerEngineApi.ts`: a thin typed client for the Engine API
    v1.41 (Docker 20.10+), `parseDockerHost`, `mapEngineError`, a one-file ustar writer for the
    archive endpoint (no tar library in the repo).
  - add `apps/server/src/sandbox/compute/DockerComputeDriver.ts`: `make(config)` (the registry
    factory for `kind: "docker"`), `containerCreateBody`, `isolationFromInfo`, `egressScript`.
  - add `apps/server/src/sandbox/compute/DockerComputeDriver.test.ts` (unit) and
    `DockerComputeDriver.contract.test.ts` (real daemon).
  - add `apps/server/src/sandbox/compute/testdata/stand-in-runner/` (`Dockerfile`,
    `stand-in-runner.mjs`): the contract image.
  - add `.github/workflows/sandbox-docker.yml`: the Linux job that runs the contract suite. A new
    workflow, not a job in upstream's `ci.yml` (decision 14).
  - change the registry wiring 1.5 adds in `server.ts`: `ComputeDriverRegistry.layer({ docker:
    DockerComputeDriver.make })`. If 1.14 lands first, only its tests use the factory.

**Docker client.** The repo has no Docker library (no `dockerode`; the vendored
`.repos/alchemy-effect/packages/docker/src/Docker.ts` shells out to the `docker` CLI, which would
make the CLI a server prerequisite and parse text). Smallest: the Engine HTTP API through the
server's own Effect HTTP client on `node:http`. `NodeHttpClient.makeAgent({ socketPath })` (or the
TLS `ca`/`cert`/`key`) plus `NodeHttpClient.makeNodeHttp` (effect 4.1.2,
`.repos/effect/packages/platform/node/src/NodeHttpClient.ts:672`, `:716`) gives a Unix-socket
`HttpClient`; the agents live in the driver's registry scope. Not undici: the CLI bundle keeps
undici external, and the single executable can only `import` builtins.

`parseDockerHost(config.dockerHost ?? env.DOCKER_HOST)`, env from `HostProcess.Environment`:

- unset: the first existing of `$XDG_RUNTIME_DIR/docker.sock` (rootless), `/var/run/docker.sock`,
  `~/.docker/run/docker.sock` (Docker Desktop). `local: true`.
- `unix://<path>`: that socket, `local: true`.
- `tcp://h:p`: `http://h:p`; with `DOCKER_TLS_VERIFY=1`, `https://` and `ca.pem`, `cert.pem`,
  `key.pem` from `DOCKER_CERT_PATH` in `connect`. `local: false`.
- `ssh://...`: `unsupported`; `health` says "Forward the socket with `ssh -NL <local.sock>:/var/run/docker.sock`
  and use `unix://`". Docker contexts are not read. **Proposed** (M1 scope).

**Names, labels, limits.** Install id and names come from 1.4 (`sandboxBackendName`, `sandboxTags`).

- Container `pair-<installId8>-<sandboxId>-g<generation>`; it is the `driverRef`. Labels: the four
  `pair.*` tags plus `pair.size`. The name keeps its create generation for the container's life; the
  record's `generation` is authoritative.
- Volume: the same name as its container, created first with the same labels, mounted at
  `/t3-sandbox/<sandboxId>` (P1). `start` reuses the container, so the disk survives stop and start;
  only a `create` (first provision, or a retry with no disk) makes a new generation's container and
  volume. A stray from a lost create report then owns its own volume, and `destroy(driverRef)` can
  never remove the disk a newer container uses. 04 §7 and P1 say `pair-<sandboxId>`; this corrects
  both. The install prefix keeps two servers on one daemon apart.
- Sizes: `small` 2 vCPU/4 GB, `default` 4/8, `large` 8/16, clamped to `NCPU`/`MemTotal` from
  `/info`. `NanoCpus`, `Memory`, `MemorySwap = Memory`, `PidsLimit: 4096`.

```ts
export const containerCreateBody = (input: {
  readonly image: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly sandboxId: SandboxId;
  readonly volume: string;
  readonly network: string;
  readonly limits: { readonly nanoCpus: number; readonly memoryBytes: number };
  readonly runtime: "runc" | "runsc";
  readonly local: Option.Option<{
    readonly serverSocketDir: string;
    readonly bundle: Option.Option<{ readonly runnerBuildId: string; readonly path: string }>;
  }>;
}) => ({
  Image: input.image,
  Labels: input.labels,
  Env: [], // nothing from the bootstrap: env shows in `docker inspect` (03 §2.2)
  HostConfig: {
    Runtime: input.runtime,
    NetworkMode: input.network,
    Privileged: false,
    CapDrop: ["NET_RAW", "MKNOD"], // Docker's default set otherwise; sudo and apt need the rest
    // no `no-new-privileges` (breaks sudo, 06 §9); default seccomp and AppArmor profiles
    NanoCpus: input.limits.nanoCpus,
    Memory: input.limits.memoryBytes,
    MemorySwap: input.limits.memoryBytes,
    PidsLimit: 4096,
    RestartPolicy: { Name: "no" }, // a restart cannot re-enroll: the secret is gone
    Tmpfs: { "/run/pair-runner": "rw,nosuid,nodev,noexec,mode=0700,size=16m" },
    Mounts: [
      { Type: "volume", Source: input.volume, Target: `/t3-sandbox/${input.sandboxId}` },
      // local daemon only; never /var/run/docker.sock
      // { Type: "bind", Source: serverSocketDir, Target: "/run/pair-server" }
      // { Type: "bind", Source: bundle.path, Target: `/opt/pair-runner/${bundle.runnerBuildId}`, ReadOnly: true }
    ],
  },
});
```

The server socket is mounted by **directory**, so a server restart's new socket inode is visible in
old containers. 1.15 supplies the directory and 1.9 the bundle path through the driver's options
(`Option.none()` until they land); when `bootstrap.serverUrl` is `unix:<hostPath>`, the driver
rewrites it to `unix:/run/pair-server/<basename>`. A bundle mount is fixed at create, so after a
server upgrade the old path no longer matches `PAIR_RUNNER_BUILD` and the bootstrap fetches, the
normal path (03 §2.2).

**Bootstrap delivery.** Env is fixed at create and visible in `docker inspect`, so neither create
nor start puts the bootstrap in env. Both write `/etc/pair-runner/bootstrap.env` (mode 0600; the
four `PAIR_*` names) and `/etc/pair-runner/generation` into the container with
`PUT /containers/{id}/archive`, which works on created and stopped containers, then start it. The
image's entrypoint reads and deletes the file (1.20). The file is in the container layer, not on the
volume, and holds a one-use, 15-minute secret (04 §6). This replaces 04 §7's "writes the bootstrap
to the volume". `start` on a running container reads `/etc/pair-runner/generation`: equal to the
bootstrap's generation is success (a replay); otherwise stop, write, start.

**Operations.** Every call is idempotent: `create` makes the volume, then the container (409:
inspect by name; matching `pair.sandbox` and `pair.generation` labels is success, else `conflict`),
writes the bootstrap and starts (304 is success). `stop` is `POST /stop?t=10` (the runner's 10 s
drain grace; 304 success; 404 `not-found`). `destroy` force-removes the container and the volume of
the same name (404 success; 409 on the volume `conflict`, retryable). `status` inspects (`running`/`restarting`/`paused` → `running`;
`created`/`exited` → `stopped`; `dead`/`removing` → `failed`; 404 → `missing`). `list` filters
containers and volumes by label `pair.install=<id>` (plus any other tags); a volume with no
container is listed `stopped` under its volume name, so the reconciler can remove it. `deleteImage`
is `DELETE /images/{ref}` (404 success, 409 `conflict`). Until 1.23, `{ type: "base" }` means
`sandbox.baseImage ?? "t3-sandbox:dev"`, which must already exist on the daemon (`not-found`
otherwise); 1.23 replaces this with resolution and a pull. Transient errors (`unavailable`) retry
inside the call with EAS's `TRANSIENT_RETRY` (`device/EasDeviceHost.ts:135`).

`mapEngineError`: connection refused or missing socket → `unavailable`, retryable; `EACCES` on the
socket → `auth` ("the server's user cannot use the Docker socket"); 400 `invalid-request`; 404
`not-found`; 409 `conflict`; 5xx mentioning no space → `capacity`; other 5xx `unavailable`, retryable.

**Network and the private-range block (proposed).** One bridge network per install, not per
sandbox: `pair-<installId8>`, bridge name `pair-<installId8>` (13 characters), options
`com.docker.network.bridge.enable_icc=false`, IPv6 off, labeled. Per-sandbox networks each take a
pool from Docker's default address pools (about 30), and stopped sandboxes keep theirs, so a team
hits "could not find an available, non-overlapping IPv4 address pool" near 30 machines. ICC off
blocks sandbox-to-sandbox traffic as separate networks would. This changes 06 §8's Docker row and
04 §7's `pair-sandboxes`.

Rules go in through the Docker API, never by running `iptables` on the server's machine (which
works the same for a remote `DOCKER_HOST` and needs no root for the server): a helper container from
the base image (1.20 adds `iptables`) with `NetworkMode: "host"`, `CapAdd: ["NET_ADMIN", "NET_RAW"]`,
`Runtime: "runc"`, `AutoRemove`, label `pair.role=egress`, runs `egressScript(...)` and exits. It is
the only container with `NET_ADMIN`, and it runs a fixed script, never agent code.

```ts
export const egressScript = (input: {
  readonly chain: string; // "PAIR-<installId8>"
  readonly subnet: string; // from the network's IPAM config
  readonly bridge: string;
  readonly allow: ReadonlyArray<{ readonly host: string; readonly port: number }>; // remote runnerUrl only
}) => string;
// Picks iptables-legacy or iptables-nft by which one holds DOCKER-USER, then idempotently:
//  DOCKER-USER -s <subnet> -j <chain>; <chain>: ESTABLISHED,RELATED RETURN; ACCEPT each allow
//  (resolved with getent inside the helper); DROP 10/8, 172.16/12, 192.168/16, 100.64/10,
//  169.254/16 (metadata), 0/8, 198.18/15, 224/4; RETURN.
//  INPUT -i <bridge> -j <chain>-in; <chain>-in: ESTABLISHED,RELATED RETURN; DROP (the host itself).
```

Container DNS still works: the embedded resolver forwards from the daemon, not through FORWARD.
The block is ensured on the first `create` of each server process, by every `health` call, and by
each reconciler pass (1.19), so a remote host that flushed its firewall is fixed within 10 minutes.
**When rules cannot be written** (no `DOCKER-USER` chain because Docker uses its nftables firewall
backend, the daemon refuses the helper, or rootless or Docker Desktop behave differently, all
unverified), sandboxes still start and `health.privateNetworkBlock` is `{ applied: false, reason }`.
1.40 shows "Private network block: not applied" with the reason beside the isolation warning, so
Settings never claims a block it does not keep (06 §8).

**Isolation detection.** `isolationFromInfo(GET /info)`: `Runtimes` has `runsc` → create with
`Runtime: "runsc"` and report `gvisor` (**proposed**: use gVisor whenever the daemon offers it);
else `SecurityOptions` has `name=rootless` → `rootless-container`; else `container`. `health`
reports it; 1.40 warns for `container`. `capabilities` are static: `persistentDisk: true`,
`memoryOnStop: false`, `snapshot: false` (until 3.4), `imageBuild: "snapshot"`, `maxSessionMs: null`,
`diskRetentionDays: null`, `isolation: "container"` (the floor; `health` has the detected value),
`egressRules: "none"` (allowlists are 3.18), `nestedDocker: false`, `regions: []`, the three sizes.

**Tests.**

- `DockerComputeDriver.test.ts`, `it.effect`, no daemon. Table tests for the security invariants
  and parsing: `containerCreateBody` (no Docker socket and no other bind on a remote host, both binds
  on a local one, bundle read-only, `Privileged: false`, `CapDrop`, no `PAIR_*` in `Env`, `runsc`
  when offered), `parseDockerHost` (each form, `ssh://` unsupported), `mapEngineError` (status →
  reason and `retryable`), `isolationFromInfo`, `egressScript` for one subnet with and without an
  allow. Driver behavior against a fake Engine API (`HttpClient.make` answering from a map): a
  create replayed after a 409 returns the same `driverRef`; `start` on a running container with the
  same generation does not stop it, and with an older one stops, writes and starts.
- `DockerComputeDriver.contract.test.ts`: `describe.runIf(process.env.T3_TEST_DOCKER === "1")` (a
  platform gate, which the skip lint allows) runs `computeDriverContract` on the local daemon with
  `sandbox.baseImage: "t3-sandbox-contract:test"`, plus one Docker-only `it.live`: the stand-in
  reports that a TCP connect to the bridge gateway (where the test listens) and to 169.254.169.254
  fails while the public route works. Awaits the hello `Deferred`s only.
- The stand-in image: `FROM node:24-bookworm-slim`, `apt-get install -y iptables tini`, `COPY
  stand-in-runner.mjs`, `ENTRYPOINT ["tini", "--", "node", "/stand-in-runner.mjs"]`.
- `sandbox-docker.yml`: on pull requests touching `apps/server/src/sandbox/**` or
  `infra/sandbox-image/**`, and on push to `main`; `ubuntu-24.04` (GitHub-hosted, Docker present);
  setup with `./.github/actions/setup-ci-deps`, `docker build -t t3-sandbox-contract:test
  apps/server/src/sandbox/compute/testdata/stand-in-runner`, then `T3_TEST_DOCKER=1 vp test run
  apps/server/src/sandbox/compute/DockerComputeDriver.contract.test.ts`.

**Verify.** `vp test run apps/server/src/sandbox/compute`, the same with `T3_TEST_DOCKER=1` on a
Linux machine with Docker, `vp run check:changed`. Runtime transcript for the PR: `docker ps -a
--filter label=pair.install=<id>`, `docker inspect` of one container showing mounts, caps and no
socket, `iptables -S PAIR-<id8>` from the host, and the `health` result.

**Reviewer checks.**

- No path ever binds `/var/run/docker.sock` or any socket but the runner directory; nothing from the
  bootstrap appears in `Env` or labels.
- Every Engine call is idempotent in the way the table above says; 304 and 404 are handled per
  operation, not globally.
- The helper container is the only one with `NET_ADMIN` or host networking, and it runs a fixed
  script built from validated inputs (subnet, bridge name and allow list are parsed, not interpolated
  raw).
- `health` never reports `applied: true` unless the script exited 0 on this pass.
- The HTTP agents are scoped to the driver instance and closed by the registry on a config
  change.
- `start` cannot restart a healthy runner of the same generation (the generation marker check).

### 1.15 `feat(server): give Docker runners a Unix socket route and a DOCKER_HOST runner URL`

Decides, per Docker driver instance, how its sandboxes reach the server (03 §3.2 as code), and
adds the runner-only Unix socket listener a local Docker host bind-mounts. Its own PR because it is
the second HTTP listener the server has ever had, and the only code that knows the server's own
reachability from a container.

- **Needs:** 1.7 (`RunnerRoute.layer`), 1.14 (the driver that mounts and passes the URL), 1.36
  (`DockerSandboxDriver.dockerHost`, `.runnerUrl`). **Unblocks:** 1.16 (a launched sandbox can
  attach), 1.40 (Test button reports the route), 1.44 (benchmarks on the socket route).
- **Files:**
  - add `apps/server/src/sandbox/runnerHub/RunnerEndpoint.ts` (+ `.test.ts`): `chooseRunnerRoute`
    (pure) and the `RunnerEndpoint` service that resolves a plan and lazily opens the socket.
  - change `apps/server/src/server.ts`: `RunnerEndpoint.layer` by `Layer.provideMerge` next to
    1.7's `RunnerHub.layer`. Nothing else: the listener is not in `layerMakeRoutes`.
  - change 1.14's `apps/server/src/sandbox/compute/DockerComputeDriver.ts`: take
    `serverUrl` and bind mounts from `RunnerEndpoint.planFor(driver)` instead of computing them.
  - change 1.9's bootstrap script (`sandbox/runner/bootstrap.sh`): a `ws+unix:` URL fetches with
    `curl --unix-socket <path> http://localhost/runner/v1/bundle/…` (normally unused: the local
    Docker driver also mounts the bundle).

**Types, services and RPCs.**

```ts
// RunnerEndpoint.ts
export const RUNNER_SOCKET_CONTAINER_DIR = "/run/pair-host";
export const RUNNER_SOCKET_NAME = "runner.sock";

export interface RunnerDialPlan {
  readonly serverUrl: string; // what SandboxBootstrap.serverUrl carries (04 §6)
  readonly mounts: ReadonlyArray<{ readonly hostPath: string; readonly containerPath: string; readonly readOnly: true }>;
}
export class RunnerRouteError extends Schema.TaggedError<RunnerRouteError>()("RunnerRouteError", {
  driverId: ComputeDriverId,
  reason: Schema.Literals(["runner-url-required", "unsupported-platform", "socket-path-too-long"]),
}) {} // 1.5 turns it into a non-retryable `sandbox.failed`; 1.40 shows it on Test

export const chooseRunnerRoute: (input: {
  readonly driver: DockerSandboxDriver;
  readonly serverPlatform: NodeJS.Platform;
  readonly serverPort: number;
  readonly hostSocketDir: string; // <stateDir>/sandbox/runner-socket
}) => Result.Result<{ readonly _tag: "unix" } | { readonly _tag: "url"; readonly url: string }, RunnerRouteError["reason"]>;

export class RunnerEndpoint extends Context.Service<RunnerEndpoint, {
  /** Opens the Unix listener on first use of a "unix" plan; it lives as long as the server. */
  readonly planFor: (driver: DockerSandboxDriver) => Effect.Effect<RunnerDialPlan, RunnerRouteError>;
}>()("t3/sandbox/RunnerEndpoint") {}
```

| `runnerUrl` | `dockerHost`                     | Server platform | Plan                                                                                                                                      |
| ----------- | -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| set         | any                              | any             | `url`: the admin's value, `http(s)` mapped to `ws(s)`, `/runner/v1/connect` appended when the path is empty                               |
| unset       | unset or `unix://…`              | `linux`         | `unix`: `ws+unix:///run/pair-host/runner.sock:/runner/v1/connect`, mount `<stateDir>/sandbox/runner-socket` read-only at `/run/pair-host` |
| unset       | unset or `unix://…`              | `darwin`        | `url`: `ws://host.docker.internal:<serverPort>/runner/v1/connect` (Docker Desktop)                                                        |
| unset       | `tcp://`, `ssh://`, `http(s)://` | any             | `runner-url-required`: a remote host cannot mount the server's disk (04 §7)                                                               |
| unset       | unset                            | `win32`         | `unsupported-platform` (Windows team servers are out of M1)                                                                               |

- **The listener.** On the first `unix` plan, `RunnerEndpoint` creates
  `<stateDir>/sandbox/runner-socket/` with mode 0700, unlinks a stale `runner.sock`, and builds
  `HttpRouter.serve(RunnerRoute.layer).pipe(Layer.provide(NodeHttpServer.layer(() =>
  NodeHttp.createServer(), { path: socketPath, websocket: { perMessageDeflate: false } })))` with
  `Layer.buildWithScope` into the service's own scope (`NodeHttpServer.Options` extends
  `Net.ListenOptions`, so `path` is supported). It serves the runner routes only (1.9 adds the
  bundle route to the same layer); no `/api`, `/ws` or `/mcp`. Lazy, so a server without a local
  Docker driver opens nothing (decision 7).
- **Mount the directory, not the socket.** A file bind mount pins the inode; after a server restart
  recreates `runner.sock`, existing containers would keep a dead socket and never reconnect.
  Mounting the directory read-only lets them see the new socket and keeps the sandbox from
  replacing it.
- **Path length.** Unix socket paths cap near 104 bytes; a longer `socketPath` fails with
  `socket-path-too-long`, and Settings suggests `runnerUrl` (the same limit
  `CodexManagedTokenBroker.ts:23` checks).
- **Auth is unchanged.** The socket carries the same `/runner/v1/connect` with sandbox tokens:
  the token, not the socket, tells sandboxes apart (06 §7). Compression is off on this route
  (03 §3.1).
- **Port for `host.docker.internal`** comes from `HttpServer.address`, as `McpSessionRegistry`
  reads it, so it is the real listening port. In dev that is the server port, never Vite's (Vite
  proxies only `/api`, `/ws`, `/oauth`, `/.well-known`).

**Commands, events and effects.** None new. 1.5's `sandbox.create` and `sandbox.start` executors
call `planFor` before the driver; a `RunnerRouteError` fails the effect as non-retryable.

**Tests.**

- `RunnerEndpoint.test.ts` (new): an `it` table over `chooseRunnerRoute` with the five rows above
  and the path-length case.
- One `it.live` (network fixture): `planFor` on a temp state dir opens the socket; a WebSocket
  upgrade to `/runner/v1/connect` over `ws+unix:` with a bad bearer gets `401` from the real
  `RunnerRoute`; any `/api` path on the same socket gets `404`; a second `planFor` reuses
  the listener (one socket file, same inode).

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerEndpoint.test.ts`;
`vp run check:changed`. Runtime transcript on Linux with Docker: `vp run dev` with a local Docker
driver, start a cloud thread, show `docker inspect` mounts (`runner-socket` directory, read-only),
the `sandbox.runner.attached` receipt, then restart the dev server (by its tracked PID) and show the
same container's runner reattaching through the recreated socket. On macOS, one transcript with
Docker Desktop through `host.docker.internal` (confirms a loopback-bound desktop server is
reachable there).

**Reviewer checks.**

- The Unix listener serves only runner routes and never opens unless a `unix` plan is requested.
- Containers mount the socket directory read-only, never the socket file or the state directory.
- A remote `DOCKER_HOST` without `runnerUrl` fails clearly instead of guessing an address.
- No URL is baked from `VITE_*` or the Vite port; the port comes from the live `HttpServer`.

### 1.16 `feat(server): launch cloud threads from the cloud launch input and release them on runner hello`

Makes "start in Cloud" work end to end on the server: the launch provisions a sandbox, the first
run waits in `preparing`, the runner's hello makes the sandbox `ready`, the checkout is cloned and
set up through the sandbox's workspace host, and the run is released. Runs keep `worktree`, so old
clients decode them; placement lives only on the thread's `sandboxId`.

- **Needs:** 0.11 (run preparation union), 1.5 (decisions and effects), 1.7 (hello dispatches
  `sandbox.runner.attached`), 1.12 (sessions run on sandbox hosts), 1.14 (a real driver).
  **Unblocks:** 1.17, 1.38, 1.42, 1.43, 1.24 (cloud setup paths build on this flow).
- **Files:**
  - change `packages/contracts/src/orchestrationV2.ts`: `OrchestrationV2ThreadLaunchCloudStrategy`
    and `OrchestrationV2ThreadLaunchInputWorkspaceStrategy`, used only by
    `OrchestrationV2ThreadLaunchInput.workspaceStrategy` (:3803).
  - change `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: the hand-written
    `ThreadLaunchWorkspaceStrategy` (:58) gains the cloud member; `launch` (:840) takes the cloud
    branch; `PreparationInput` (:113) gains `sandboxId?`; `prepareInBackground` (:299) calls
    `CloudPreparation` for the checkout and keeps the shared metadata, rename, setup, release and
    failure code; `scheduleRunPreparation` (:1140) passes `thread.sandboxId`; `retryPreparation`
    (:1127) retries a failed sandbox first.
  - add `apps/server/src/sandbox/lifecycle/CloudPreparation.ts`: `resolveCloudLaunch`,
    `awaitSandboxReady`, `checkoutInSandbox`, `sandboxIdForLaunch`.
  - add `sandbox.release-waiters` to `EffectOutbox.ts` (member, replay-safe list, 60 s entry) and
    its executor to `SandboxEffects.ts`; `SandboxDecisions.ts` enqueues it on `ready` and `failed`
    and gains `decideCloudPrompt`.
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`: in the `message.dispatch` arm
    (:13892), before `dispatchMessage`, one call to `gateCloudMessage` (a helper next to
    `dispatchSandboxCommand`).
  - change `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts`:
    `reconcileProjection` (:206) skips `preparing` runs on threads with a `sandboxId`; `recover`
    (:906) re-arms the skipped runs that carry `workspacePreparation`.
  - change `apps/server/src/vcs/GitVcsDriver.ts`, `GitVcsDriverCore.ts` and
    `apps/server/src/git/GitWorkflowService.ts`: `readRemoteUrl` and `cloneRepository`, two thin
    git calls routed by `cwd` like the rest (0.3).

**Types, services and RPCs.**

```ts
// orchestrationV2.ts (launch input only; runs, defer_start, MCP, delegation and scheduled tasks keep the old union)
export const OrchestrationV2ThreadLaunchCloudStrategy = Schema.Struct({
  type: Schema.Literal("cloud"),
  baseRef: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});
export const OrchestrationV2ThreadLaunchInputWorkspaceStrategy = Schema.Union([
  ...OrchestrationV2ThreadLaunchWorkspaceStrategy.members, OrchestrationV2ThreadLaunchCloudStrategy,
]);

// CloudPreparation.ts
export class CloudLaunchError extends Schema.TaggedError<CloudLaunchError>()("CloudLaunchError", {
  projectId: ProjectId,
  reason: Schema.Literals(["no-driver", "project-disallowed", "no-origin", "base-ref-missing", "sandbox-failed"]),
  failureCode: Schema.optional(Schema.String),
}) { /* message per reason; "base-ref-missing": `Push ${baseRef} first.` */ }

/** Deterministic, so a replayed launch provisions the same sandbox: "sbx_" + sha256(commandId)[0..20]. */
export const sandboxIdForLaunch: (commandId: CommandId) => SandboxId;
export const resolveCloudLaunch: (projectId: ProjectId) => Effect.Effect<
  { readonly driverId: ComputeDriverId; readonly size: SandboxSize }, CloudLaunchError, ServerSettings.ServerSettingsService>;
/** Resolves on `ready`; fails on `failed` or `destroyed`. Reads the owner's stream from a sequence taken before the record read. */
export const awaitSandboxReady: (input: {
  readonly sandboxId: SandboxId;
  readonly onWaiting: (phase: "sandbox-admission" | "sandbox-start") => Effect.Effect<void>;
}) => Effect.Effect<OrchestrationV2Sandbox, CloudLaunchError, ThreadManagement.ThreadManagementService>;
/** Clone or fetch, then `git worktree add`, all through the sandbox's host. */
export const checkoutInSandbox: (input: {
  readonly sandboxId: SandboxId; readonly projectRoot: string; readonly baseRef: string;
  readonly branch: string; readonly existingWorktreePath: string | null;
}) => Effect.Effect<{ readonly worktreePath: string; readonly branch: string },
  CloudLaunchError | GitCommandError, GitWorkflow.GitWorkflowService>;
// All three are Effect.fn("CloudPreparation.<name>").
```

**The launch.** `launch` checks the cloud strategy before anything is created
(`resolveCloudLaunch`: `ServerSettings.sandbox` present, the project's `sandboxAllowed` not false,
driver = `sandbox.defaultDriverId ?? drivers[0].id`, size = the driver's `size ?? "default"`), then
commits three idempotent commands, as worktree launches already commit two:

1. `thread.create` with `branch: null, worktreePath: null` (unchanged).
2. `sandbox.provision` (`${commandId}:sandbox`, id from `sandboxIdForLaunch`) on the new thread:
   the decider sets the thread's `sandboxId` with a `thread.metadata-updated` event, writes
   `sandbox.updated` (`provisioning`, generation 1) and enqueues `sandbox.create`.
3. `message.dispatch` with `defer_start` and `workspaceStrategy: { type: "worktree", baseRef,
   branch }`. The run is `preparing` and records `worktree` (decision 7).

Then `schedulePreparation` runs with `sandboxId` set. In `prepareInBackground`, where a worktree
launch creates its worktree (:386–:475, `createWorktree` at :443), the cloud branch does:

1. `awaitSandboxReady`, sending `prepared-run.progress` `sandbox-admission` while `admission` is
   set and `sandbox-start` otherwise (ids `${commandId}:progress:<phase>`).
2. Progress `clone`, then `checkoutInSandbox` (README P4): read `origin`'s URL on the server from
   `project.workspaceRoot` (`readRemoteUrl`; none fails with `no-origin`); clone into
   `/t3-sandbox/<id>/repos/<host>/<owner>/<name>` (README P1; `repos/<projectId>` when the URL does
   not parse) if absent, else `git fetch origin`; `origin/<baseRef>` missing fails with
   `base-ref-missing`; `git worktree add -b <branch> /t3-sandbox/<id>/worktrees/<slug>
   origin/<baseRef>`, or from `origin/<branch>` when that exists (a new machine for a pushed
   thread). The branch is the requested one or the temporary name, as today. Git
   credentials are whatever the host's git commands get (1.13, 1.28); this PR adds none.
3. The shared code continues: `thread.metadata.update` with the sandbox `worktreePath`, the
   temporary-branch rename, the setup script through `setupScripts.runForThread` (1.24 gives it
   sandbox paths), and `prepared-run.release`.

`generateBranchNameFor` (:343) runs with `cwd: project.workspaceRoot` for a cloud thread
(**proposed**): text generation spawns a local CLI, and the message is all it reads. The rename
itself runs in the sandbox. The failure cleanup (:703) removes the worktree with `cwd` set to the
sandbox clone, not `project.workspaceRoot`. Any failure goes through `failPreparedRun`, so the run
fails with `workspace_preparation_failed` and the thread shows `CloudLaunchError`'s message.

**Later prompts.** `gateCloudMessage` runs only for a thread with `sandboxId`. If the sandbox is
`ready`, nothing changes. Otherwise a `start_immediately` or `queue_after_active` send becomes
`defer_start` without a strategy (the run waits in `preparing`; queueing behind an active run is
unchanged). On the owning thread, the same commit applies `decideSandboxCommand` for a wake:
`sleeping` or retryable `failed` → `waking` + `sandbox.start`; `destroyed` → `provisioning`,
generation +1 + `sandbox.create` ("Start a new machine"). The disk is new after `destroyed`, so that
send's `defer_start` carries `{ type: "worktree", baseRef: <the thread's first run's baseRef>,
branch: thread.branch }`, and `release-waiters` re-arms its checkout. Unpushed work is gone, as
discard says; M2 (2.13) rebuilds from the mirror instead. On any other attached thread the send is
refused with "The machine is not running." until 1.17 adds `sandbox.request-wake`.

**Commands, events and effects.** `sandbox.release-waiters { sandboxId, generation }` is enqueued
by the commit that records `ready` or `failed`. Its executor lists the sandbox's live threads and,
for each `preparing` run with no `workspacePreparation`, dispatches `prepared-run.release` or, on
`failed`, `prepared-run.fail` with the sandbox failure, both with id
`sandbox-release:<runId>:<generation>`. On `ready`, a run that has `workspacePreparation` gets
`threadLaunch.prepareRun({ commandId: sandbox-rearm:<runId>:<generation>, … })`, which does nothing
when a fiber already prepares that run: `reservePreparation` (:779) is keyed by run id when there
is one (**proposed**, a two-line change; today it is keyed by command id, so two callers with
different command ids could prepare one run twice). A run waiting on `failed` with a strategy is
failed by its fiber, or by the re-armed one after a restart. `prepared-run.retry` (`retryPreparation`) on a cloud thread whose
sandbox is `failed` first dispatches `sandbox.retry` (`${commandId}:sandbox-retry`) to the owner,
then `prepareRun`, which reuses the recorded worktree when the disk kept it (`reuse` at :1150).

**Retry and delegation read `sandboxId`.** `scheduleRunPreparation` passes `thread.sandboxId` into
`PreparationInput`, so a retried cloud run never builds a local worktree. A delegated child already
inherits the parent's `sandboxId` (`makeSubagentChildThread` spreads the parent;
`Orchestrator.ts:8404` only clears `branch` and `worktreePath` for a strategy), so with no strategy
it shares the parent's checkout and sandbox, and with `worktree` its `prepareRun`
(`OrchestratorMcpService.ts:2523`) takes the cloud branch and adds a worktree in the same sandbox.
No code changes at :8404; a test pins the behavior.

**Recovery.** `reconcileProjection` leaves a `preparing` run on a thread with `sandboxId` alone.
`recover` then `forkParked`s `threadLaunch.prepareRun({ commandId: \`sandbox-rearm:${runId}\`,
threadId, runId })`for those with`workspacePreparation` (`prepareRun`already skips the rest);
runs without one are released by the durable`sandbox.release-waiters`. This adds a
`ThreadLaunchService` dependency to the recovery layer; neither depends on the other today.

**Migrations.** None.

**Tests.**

- `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:503` ("recovers $0 work
  after restart"): add a `preparing-cloud` scenario (the thread has `sandboxId`): the run stays
  `preparing` and the recording `ThreadLaunchService` fake receives one `prepareRun` with
  `sandbox-rearm:<runId>`.
- `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`, using its harness (:133) with the
  partial git mock and `WorkspaceHostTesting.layerRecording` for the sandbox root, plus 1.5's
  `FakeComputeDriver`:
  - "launches a cloud thread and releases it on runner hello": launch → assert `sandbox.updated`
    `provisioning` and a `preparing` run whose `workspacePreparation.type` is `worktree`; answer the
    fake create; dispatch `sandbox.runner.attached` (what the hub sends); await the stored
    `run.updated` with `starting`; assert clone, `worktree add` under `/t3-sandbox/<id>/worktrees/`
    and the thread's `worktreePath`.
  - Fail paths as one `it.effect.each`: create fails five times; `no-origin`; `base-ref-missing`;
    project `sandboxAllowed: false` (refused before `thread.create`). Each asserts the run's
    `failed` status with `workspace_preparation_failed`, or the launch error.
  - A replayed launch with the same `commandId` provisions nothing new (same `sandboxId`, one
    `sandbox.create`).
- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`: a prompt to the owner of a
  `sleeping` sandbox stores `waking` and a `preparing` run in one commit; the hello releases it via
  `release-waiters`; a delegated `worktree` task of a cloud parent gets a worktree in the sandbox.
- `packages/contracts/src/orchestrationV2.test.ts` "cloud threads on older clients": the run a cloud
  launch records decodes with the frozen union (this is the case 1.2 set up).

**Verify.** `vp test run apps/server/src/orchestration-v2/ThreadLaunchService.test.ts
apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts apps/server/src/sandbox/lifecycle`,
`vp run typecheck`, `vp run check:changed`. Runtime: on a dev server with Docker and the Replay
provider, launch through `orchestration.launchThread` with `{ type: "cloud", baseRef: "main" }` and
attach the transcript of stored events from `sandbox.updated provisioning` to the first token. UI
arrives in 1.38; the integrated `test-t3-app` pass runs there.

**Reviewer checks.**

- No run record, `defer_start`, MCP schema or scheduled task can carry `cloud`; only the launch
  input does.
- The preparation fiber takes its stream sequence before reading the record, so a `ready` that lands
  in between is not missed.
- Every command the flow sends has a deterministic id; a replayed launch reuses the sandbox.
- Recovery never cancels a cloud `preparing` run and re-arms each at most once per restart.
- Text generation never runs with a sandbox `cwd` on the server.

### 1.17 `feat(server): share a cloud thread's sandbox with its side chats and forks`

Lets side chats, forks and delegated children of a cloud thread prompt, wake and outlive its owner,
as they share a worktree today. Ownership moves to the oldest remaining thread when the owner is
deleted, and the sandbox is destroyed only when no thread uses it.

- **Needs:** 1.16 (cloud threads, `gateCloudMessage`, `release-waiters`). **Unblocks:** 1.18 (both
  edit dispatch), 1.19 (delete and archive rules build on the hand-over).
- **Files:**
  - change `apps/server/src/orchestration-v2/EffectOutbox.ts`: `sandbox.request-wake` and
    `sandbox.hand-over` members; both on the replay-safe list and in `EFFECT_TIMEOUTS`.
  - change `apps/server/src/sandbox/lifecycle/SandboxEffects.ts`: their executors.
  - change `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: `decideSandboxCommand` handles
    `sandbox.adopt`; new pure `planSandboxOnDelete` and `sandboxOwnerMemberChange`.
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`: `gateCloudMessage` enqueues
    `sandbox.request-wake` on a non-owner instead of refusing; the `thread.delete` arm (:13789)
    appends `planSandboxOnDelete`'s events and effects after the existing plans; the
    `thread.owner.set` path appends `sandbox.updated` when the thread owns a sandbox; `sandbox.adopt`
    joins the sandbox arm.
  - change `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts:47`: skip other threads
    whose shell `sandboxId` differs from this thread's (07 §2): different machines never share a
    path, and the check then reads no sleeping sandbox's disk.

**Types, services and RPCs.**

```ts
// SandboxDecisions.ts
/** Live attached threads other than those being deleted, oldest first (1.3's order). */
export const planSandboxOnDelete: (input: {
  readonly record: OrchestrationV2Sandbox;
  readonly deletedThreadIds: ReadonlySet<ThreadId>;   // the thread and the side chats deleted with it
  readonly remaining: ReadonlyArray<SandboxThreadRow>;
  readonly now: DateTime.Utc;
}) =>
  | { readonly _tag: "Untouched" }                     // a non-owner was deleted
  | { readonly _tag: "Destroy"; readonly next: OrchestrationV2Sandbox; readonly effects: ReadonlyArray<SandboxEffectRequest> }
  | { readonly _tag: "HandOver"; readonly effect: SandboxEffectRequest };

// EffectOutbox.ts
Schema.Struct({ type: Schema.Literal("sandbox.request-wake"), sandboxId: SandboxId, generation: NonNegativeInt }),
Schema.Struct({ type: Schema.Literal("sandbox.hand-over"), sandboxId: SandboxId }),
```

**Commands, events and effects.**

- **A prompt on an attached thread.** `gateCloudMessage` on a thread that is not the owner, with
  the sandbox not `ready`, turns the send into `defer_start` (as on the owner) and enqueues
  `sandbox.request-wake { sandboxId, generation }` on that thread's own queue. Its executor
  dispatches `sandbox.wake` to `record.ownerThreadId` with id
  `sandbox-wake:<sandboxId>:<ownerThreadId>:<generation>`. Many prompts in one generation make one
  wake; a wake that lands on `waking` or `ready` is the allow-listed no-op. If the wake is refused
  with `OrchestratorSandboxCommandMovedError` (an adopt moved the owner), the effect fails, the
  outbox retries, and the next attempt reads the new owner, so the id names it. On `destroyed`, the same
  wake provisions a new machine (1.5's `destroyed` row). `release-waiters` (1.16) already walks every attached thread.
- **Delete.** In the `thread.delete` arm, after `planDeletion` for the thread and its side chats,
  if the thread has a `sandboxId`: read the record and `listSandboxThreads`, then
  `planSandboxOnDelete`. Owner deleted and nobody left: `destroyed` now, with `sandbox.stop` (if
  `ready`) and `sandbox.destroy`. Owner deleted with others left: enqueue `sandbox.hand-over` on the
  owner's queue, where FIFO order runs it after every sandbox effect already queued there. A
  non-owner's delete changes nothing on the record; the projector drops its membership row.
- **Hand-over executor.** Reads the record; if `ownerThreadId` is no longer the effect's thread, it
  is done. Otherwise it takes the oldest live attached thread and dispatches `sandbox.adopt {
  sandboxId, previousOwnerThreadId }` there with id `sandbox-adopt:<sandboxId>:<oldOwnerThreadId>`.
  The adopt decider refuses with `OrchestratorSandboxCommandMovedError` (no receipt) if that thread
  was deleted meanwhile or the record's owner is no longer `previousOwnerThreadId`, so the executor
  can try the next thread with the same id. With no thread left it runs the destroy path itself
  (the same code as `sandbox.destroy`) and reports `sandbox.destroyed` on the old owner's stream.
- **Adopt.** `ownerThreadId` becomes the adopting thread, `ownerMemberId` its `ownerId ?? null`,
  and `sandbox.updated` is written on the new owner's stream; the usage interval closes and reopens
  for the new owner (1.3). From then on the sandbox's effects queue on that thread.
- **Only forks adopt.** Deleting a thread deletes its live side chats in the same commit
  (`liveSideChatIds`, `Orchestrator.ts:1563`), so the remaining set holds forks, their side chats
  and delegated children, never the deleted owner's side chats. Native subagent threads have no
  membership row (1.3).
- **Archive** changes nothing on the record (ownership stays; 1.19 uses archive for its stop rule).
- **Reassign.** `thread.owner.set` on the owning thread appends `sandbox.updated` with the new
  `ownerMemberId` in the same commit (`sandboxOwnerMemberChange`); on any other thread nothing.
- **During a hand-over**, client commands routed to a deleted owner are refused without a receipt
  (the moved error) and the intake re-reads the owner once; internal senders retry through the
  outbox.

**Migrations.** None.

**Tests.** All in `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts` (1.5's harness),
waiting by draining the effect worker and awaiting stored events:

- "two side-chat prompts make one wake": a sleeping sandbox owned by A, side chats B and C prompt;
  drain; assert exactly one stored `sandbox.updated` with `waking` on A's stream and one
  `sandbox.start` effect; dispatch `sandbox.runner.attached`; drain; both runs are `starting`.
- "delete hands over to a fork after queued effects": A owns, fork F attached; enqueue a
  `sandbox.stop` on A (fake driver holds it on a `Deferred`), delete A; assert `sandbox.hand-over`
  stays pending behind the stop; complete the stop; drain; F owns the record and the next effect
  lands on F's queue. Variant row: F deleted before the hand-over runs → destroy.
- "deleting the last thread destroys": A alone, delete → `destroyed` and `sandbox.destroy` in the
  delete commit.
- "a replayed hand-over picks the same thread": run the executor twice; one adopt receipt.
- `ThreadDeletion.test.ts`: none; the sandbox step is outside `planThreadDeletion`.
- `CheckpointRestoreSafety.test.ts`: extend the shared-worktree table with a row where another
  thread on a different `sandboxId` has an overlapping path string and the restore is isolated.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle apps/server/src/orchestration-v2/CheckpointRestoreSafety.test.ts`,
`vp run check:changed`. Runtime transcript: on a dev server with Docker, start a side chat on a
cloud thread, let the sandbox stop (1.19) or `sandbox.sleep` it, prompt the side chat, and attach
the stored `sandbox.updated` sequence on the owner's stream.

**Reviewer checks.**

- Every hop is an outbox effect with a deterministic id; no executor holds a lock across threads.
- The adopt and wake ids name the owner, because a receipt only matches its own thread.
- The hand-over is on the old owner's queue, behind its queued sandbox effects, never on the new
  owner's.
- Refusals that a sender must resend (moved owner, deleted candidate) record no receipt; all
  others do.
- Restore safety compares sandbox ids before any `realPath`.

### 1.18 `feat(server): queue cloud threads at the team cap and start rate`

Stops a team from running more sandboxes than its Docker host can hold, or starting more than 10 a
minute, by queueing rather than refusing: a sandbox past a limit waits with `admission`, and the
lifecycle worker admits waiters in order as slots and tokens free up. Thread locks don't serialize
counts across threads, so slot-taking commands also take one process-wide admission lock.

- **Needs:** 1.17 (both edit `dispatchWithReceipt`; this one wraps the result of 1.17's version).
  **Unblocks:** 1.40 (read-only caps), 2.1 (cap pressure), 2.17 (editable caps).
- **Files:**
  - add `apps/server/src/sandbox/lifecycle/SandboxAdmission.ts`: the lock, the counts and the
    start-rate bucket.
  - add `apps/server/src/sandbox/lifecycle/SandboxLifecycleWorker.ts` with only the admission sweep,
    registered on `Scheduler` like `UsageLimitRecoveryWorker.ts:153`. 1.19 adds the settle stop and
    boot deadlines to the same worker; whichever of 1.18 and 1.19 lands first creates the file.
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`: `dispatchWithReceipt` (:14396) wraps
    its existing body in the admission lock for slot-taking commands; `dispatchSandboxCommand` and
    `gateCloudMessage` pass an admission snapshot into the decider and take a token on accept;
    `sandbox.admit` joins the sandbox arm.
  - change `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: an `admission` input and the
    `sandbox.admit` row.
  - change `apps/server/src/sandbox/compute/ComputeDriver.ts` (1.4): `ComputeCapabilities`
    gains `defaultRunningCap: number` (**proposed**; Docker computes `max(1, floor(NCPU / 4))` from
    the daemon's `/info` when the layer is built, hosted drivers 20, the fake driver takes it as an
    option).
  - change `apps/server/src/orchestration-v2/runtimeLayer.ts` and the orchestrator test harness
    (`ProviderReplayHarness`): provide `SandboxAdmission.layer`.

**Types, services and RPCs.**

```ts
// SandboxAdmission.ts
export const STARTS_PER_MINUTE = 10;              // 04 §4, D5; no member cap in M1
export interface AdmissionSnapshot {
  readonly running: number;                       // sandboxes on this driver: ready, or provisioning/waking without admission
  readonly cap: number;                           // driver.capabilities.defaultRunningCap
  readonly startAvailable: boolean;               // the bucket holds a token now
}
export class SandboxAdmission extends Context.Service<SandboxAdmission, {
  /** Process-wide; always taken before any thread lock. Not reentrant. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Only under withLock. Counts from the sandbox projection, so a shared sandbox counts once. */
  readonly snapshot: (driverId: ComputeDriverId) => Effect.Effect<AdmissionSnapshot, ProjectionStoreError>;
  /** Only under withLock, after an accepted decision that starts a machine. */
  readonly takeStart: Effect.Effect<void>;
  /** For the sweep: when the next token frees, or null when the bucket is full. */
  readonly nextStartAt: Effect.Effect<DateTime.Utc | null>;
}>()("t3/sandbox/SandboxAdmission") {}
export const layer: Layer.Layer<SandboxAdmission, never,
  ProjectionStore.ProjectionStoreV2 | ComputeDriverRegistry.ComputeDriverRegistry>;
```

The bucket is in memory: 10 tokens, one back every 6 s, read from `Clock`, so tests drive it with
`TestClock.adjust`. A restart refills it, which is fine for a spend guard. Caps are per driver
instance, because each Docker host is finite; with one driver, as in M1, that is the team cap.
Defaults come from code and the driver, not settings or flags (**proposed**: the row says "server
config", but no knob is needed until 2.17 makes caps editable; 1.40 shows the same values
read-only).

**Commands, events and effects.**

```ts
// dispatchWithReceipt: the existing body becomes dispatchWithThreadLocks; admission goes outside it.
const dispatchWithReceipt = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
  return yield* (yield* takesSandboxSlot(command))
    ? admission.withLock(dispatchWithThreadLocks(command))
    : dispatchWithThreadLocks(command);
});
```

`takesSandboxSlot` is true for `sandbox.provision`, `sandbox.wake`, `sandbox.retry`,
`sandbox.admit`, and for `message.dispatch` on a thread whose shell has a `sandboxId` (one
unlocked shell read, as the dispatch-mode check already does at :14211). The lock is held for one
decision and commit, so a prompt on a cloud thread costs one uncontended semaphore. No decision
dispatches a nested command, so the order admission → parent → thread → side chats never inverts.

In the decider, any accepted transition into `provisioning` or `waking` first checks the snapshot:
`running >= cap` sets `admission: { reason: "team-cap", since: now }`; no token sets `reason:
"rate-limit"`. Either way the state is still `provisioning` or `waking`, the generation still
bumps, and no driver effect is enqueued. Otherwise the effect is enqueued and the arm calls
`takeStart`. A waiting run shows progress `sandbox-admission` (1.16), and the shell summary carries
`admission`, so clients say "Waiting for a machine".

`sandbox.admit { sandboxId, generation }` is accepted only for a record in `provisioning` or
`waking` with `admission` set and the same generation, and only when the snapshot has a slot and a
token. It clears `admission` and enqueues `sandbox.create` (no `driverRef`) or `sandbox.start`.
Refused otherwise, with a receipt, so the sweep sends a fresh id each time:
`server:sandbox-admit:<sandboxId>:<generation>:<uuid>`, as `thread.auto-settle` does.

**The sweep.** `SandboxLifecycleWorker` registers `"sandbox-lifecycle"` on `Scheduler` (5 s ticks,
no overlap, after activation). Each tick reads waiters (`admission_since IS NOT NULL`, oldest
first, 1.3's index), and for each driver dispatches `sandbox.admit` for as many waiters as
`cap - running` and the bucket allow, in `admission.since` order, stopping at the first refusal.
With no waiter it returns at once. A `DueHint` (`apps/server/src/scheduling/DueHint.ts`, used at `UsageLimitRecoveryWorker.ts:95`) keeps `nextStartAt` so a
rate-limited queue is not re-read on every tick, as that worker does. Cap
pressure (sleeping idle machines early) needs idle tracking and is M2 (2.1).

**Migrations.** None (1.3's `idx_sandboxes_admission` serves the sweep).

**Tests.**

- `apps/server/src/sandbox/lifecycle/SandboxLifecycle.test.ts`:
  - "two threads at one free slot admit one": fake driver with `defaultRunningCap: 1`; launch two
    cloud threads concurrently (`Effect.all(..., { concurrency: 2 })`); assert one `sandbox.create`
    and one record with `admission.reason === "team-cap"`. Discard the first; run the sweep once
    (call the worker's sweep effect directly, no scheduler); assert the second's `sandbox.create`.
  - "a shared sandbox counts once": a cloud thread and two side chats, cap 2; a second cloud thread
    is admitted.
  - "the eleventh start in a minute waits": under `it.effect` (TestClock), eleven provisions with a
    large cap; the eleventh has `rate-limit`; `TestClock.adjust("6 seconds")`, sweep, admitted.
- `apps/server/src/sandbox/lifecycle/SandboxDecisions.test.ts`: rows for the admission snapshot
  (full cap, no token, `sandbox.admit` with a stale generation).
- No test asserts lock ordering by timing; the concurrent-launch case is the race proof, since
  without the lock both decisions see a free slot.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle`, `vp run typecheck`,
`vp run check:changed`. Runtime transcript: a dev server whose Docker driver reports a cap of 1,
two cloud launches, the second showing `admission` until the first is discarded.

**Reviewer checks.**

- The admission lock is outermost and taken in exactly one place; nothing acquires it while holding
  a thread lock.
- Counts come from `orchestration_v2_projection_sandboxes`, read under the lock, so a shared sandbox
  counts once and an uncertain create (`provisioning`, no admission) counts until resolved.
- Waiters are admitted strictly in `admission.since` order per driver.
- Admit refusals use a fresh command id; deterministic ids are only for reports that must dedupe.
- No member cap and no new setting: `member-cap` stays declared and unused until 2.17.

### 1.19 `feat(server): reconcile sandboxes, stop Docker sandboxes on settle or archive, destroy them with their threads`

Closes the three ways a Docker machine leaks: a crash between the record and the backend, a thread
nobody uses any more, and a deleted thread. Its own PR because it adds two scheduler workers and
the delete rule, none of which launch needs to work.

- **Needs:** 1.5 (decisions, effects, `FakeComputeDriver` harness), 1.14 (`list` by label).
  **Ordering with 1.17:** both edit the thread-delete arm. 1.19 owns "no other user: destroy"; 1.17
  adds "others remain: hand over". If 1.19 merges first, an owner deleted while a fork still attaches
  enqueues nothing until 1.17 lands (a window on `main` only, never in a release).
  **Unblocks:** 1.29 (revoke on stop and destroy), 2.1 (the worker grows idle sleep).
- **Files:**
  - add `apps/server/src/sandbox/lifecycle/SandboxReconciler.ts`: `pairBackends`,
    `planReconciliation`, `layer` (Scheduler registration).
  - add `apps/server/src/sandbox/lifecycle/SandboxLifecycleWorker.ts`: the M1 worker (settle-and-
    archive stop, boot deadlines) with a `DueHint`; 2.1 extends it.
  - change `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts` (1.5): `decideAutoSleep` with the
    M1 rule, `planSandboxOnThreadDelete`, and the `boot-timeout` arm of `sandbox.failed` if 1.5 left
    it out.
  - change `apps/server/src/orchestration-v2/Orchestrator.ts`, the `thread.delete` arm (the `plans`
    array after `planDeletion`, ~`:13833`): append `planSandboxOnThreadDelete` effects. One call, no
    other upstream edit. `ThreadDeletion.ts` stays untouched.
  - change `server.ts` where 1.5 provides the lifecycle layers: add both workers' layers.
  - add `SandboxReconciler.test.ts`, `SandboxLifecycleWorker.test.ts`; extend
    `SandboxDecisions.test.ts` (1.5).

**Types, services and RPCs.**

```ts
export type ReconcileAction =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "ReportStopped" }                                  // sandbox.stopped
  | { readonly _tag: "ReportLost"; readonly retryable: boolean }        // sandbox.failed, code "lost"
  | { readonly _tag: "ReportCreated"; readonly driverRef: string }      // sandbox.created
  | { readonly _tag: "StopBackend" }
  | { readonly _tag: "DestroyBackend" };
export const pairBackends: (
  records: ReadonlyArray<OrchestrationV2Sandbox>, backends: ReadonlyArray<BackendSandbox>, installId: EnvironmentId,
) => ReadonlyArray<{ readonly record: OrchestrationV2Sandbox | null; readonly backend: BackendSandbox | null }>;
export const planReconciliation: (
  record: OrchestrationV2Sandbox | null, backend: BackendSandbox | null, now: DateTime.Utc,
) => ReconcileAction;
```

`pairBackends` matches a backend to a record by `driverRef`, or, for a record with no `driverRef`,
by `sandboxBackendName(installId, id, generation)`. A backend whose sandbox has a record with a
different `driverRef` is a stray and pairs with `null`. A live record with no backend pairs with
`null` (missing).

| Record                                         | Backend                            | Action                                                                          |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `ready`, `waking`, `provisioning`              | `running`, `starting`              | Keep (lease and boot deadline handle the rest)                                  |
| `ready`                                        | `stopped`                          | ReportStopped                                                                   |
| `ready`, `waking`                              | missing, `failed`                  | ReportLost, retryable                                                           |
| `waking`, `provisioning` with `driverRef`      | `stopped`                          | Keep (effect in flight; the boot deadline catches it)                           |
| `sleeping`                                     | `running`, `starting`              | StopBackend                                                                     |
| `sleeping`                                     | missing                            | ReportLost, not retryable (**proposed**: the disk is gone; Discard starts over) |
| `provisioning`, no `driverRef`                 | found by name                      | ReportCreated with the found ref                                                |
| `provisioning`, no `driverRef`                 | missing                            | Keep (the requeued create is idempotent)                                        |
| `failed`, retryable                            | `running`                          | StopBackend (keep the disk for Retry)                                           |
| `failed` not retryable, `destroyed`, or `null` | exists, created over 5 minutes ago | DestroyBackend                                                                  |
| `null`                                         | created under 5 minutes ago        | Keep (a create may be in flight)                                                |

Executing: `ReportCreated` dispatches with `sandbox-created:<id>:<generation>`, the id the effect
uses, so a receipt drops the duplicate. `ReportStopped` and `ReportLost` are guarded commands the
reconciler may resend, so they take `server:sandbox-reconcile:<sandboxId>:<uuid>` and carry
`generation`; the decider refuses a changed state or generation. `StopBackend` runs under
`ThreadCommandExecutor.withLock(ownerThreadId)` (`orchestration-v2/ThreadCommandExecutor.ts`, the
lock `dispatchWithReceipt` takes), re-reads the record, and stops only if it is still `sleeping` or
`failed`, so it cannot race a wake that just committed. Driver calls are bounded at 60 s; a failure
logs and leaves the row for the next pass.

```ts
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const nextRunAt = yield* Ref.make(0);
    yield* scheduler.register(
      "sandbox-reconciler",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < (yield* Ref.get(nextRunAt))) return;
        yield* Ref.set(nextRunAt, now + 10 * 60_000);
        yield* reconcileOnce(); // Effect.fn("SandboxReconciler.reconcileOnce")
      }),
    );
  }),
);
```

`Scheduler.register` runs only after startup recovery (`forkParked`, `scheduling/Scheduler.ts:52`),
so the first pass follows `reconcileAfterProcessLoss`'s requeue, as 04 §5 requires, then every 10
minutes on the 5 s tick. `reconcileOnce` walks `ComputeDriverRegistry.list`; per driver it calls
`list({ "pair.install": installId })`, reads that driver's records that are not `destroyed` plus
the records of every listed backend, pairs, plans and executes, then calls `driver.health` (which
re-ensures Docker's private-network block, 1.14). Records of a driver no longer configured are
logged and skipped. The reads are local SQL on 1.3's tables; `ProjectionStore.ts` is not edited.

**Lifecycle worker (M1).** Registers `"sandbox-lifecycle"`, shaped like `UsageLimitRecoveryWorker`
(`orchestration-v2/UsageLimitRecoveryWorker.ts:91-145`): a `DueHint`
(`scheduling/DueHint.ts`) invalidated by `sandbox.updated`, `thread.settled`, `thread.unsettled`,
`thread.archived`, `thread.unarchived`, `thread.deleted` and `run.updated` from
`orchestrator.streamDomainEvents`. Each sweep:

- **Settle-and-archive stop.** Candidates: `ready` sandboxes whose driver kind is `docker`, where
  every live attached thread (1.3's `sandbox_threads`) is archived or settled on the shared row
  (`settledOverride === "settled"`; other members' personal state never counts), and none has an
  active run (`preparing | queued | starting | running | waiting`, the list `ThreadDeletion.ts`
  cancels). Dispatch `sandbox.auto-sleep` with `server:sandbox-auto-sleep:<sandboxId>:<uuid>` and
  `reason: "archived"` when all are archived, else `"settled"`.
- **Boot deadlines.** `provisioning` with no `admission` past `updatedAt + 10 min`, `waking` past
  `updatedAt + 5 min`: dispatch `sandbox.failed` (`server:sandbox-deadline:<sandboxId>:<uuid>`,
  `generation`, `failure: { code: "boot-timeout", message: "The machine did not connect in time.",
  retryable: true }`). **Proposed:** `updatedAt` is the clock start; only `sandbox.created` moves it
  during a boot, by seconds, and `sandbox.admit` moves it when a waiter is admitted, which is right.
- Then `due.record(readVersion, nextDeadlineMs ?? Infinity, nowMs)`.

**Commands, events and effects.** No new types (1.2 declares them). Decider rules this PR adds in
`SandboxDecisions.ts`:

- `sandbox.auto-sleep`: accepted only if the sandbox is `ready`, the command's rule still holds when
  re-read under the owner's lock, and the driver kind is `docker`. Accepting writes `sandbox.updated`
  with `state: "sleeping"`, `sleepReason`, and enqueues `sandbox.stop`. The record says `sleeping`
  from the decision, so a prompt that arrives before the stop runs wakes through the owner's FIFO
  queue (stop, then start) instead of starting a turn on a machine about to stop. `sandbox.stopped`
  then only confirms.
- `sandbox.failed` with `boot-timeout`: accepted only in `provisioning`/`waking` at that generation;
  enqueues `sandbox.stop` and `sandbox.release-waiters` with the failure.
- `planSandboxOnThreadDelete({ deletedThreadIds, sandbox, liveAttachedThreadIds, commandId })`: if
  the deleted set contains the owner and every live attached thread is in the deleted set (the owner
  plus the side chats deleted in the same command, `liveSideChatIds`), enqueue `sandbox.destroy`
  (`effect:<commandId>:sandbox.destroy`, `{ sandboxId, generation }`) on the owner's queue beside
  `ThreadDeletion.ts`'s cleanup effects. A deleted non-owner enqueues nothing. Project removal needs
  no code: `ProjectService.deleteChildThreads` (`project/ProjectService.ts:459`) dispatches
  `thread.delete` for every active and archived thread first.
- The `sandbox.destroy` executor's `sandbox.destroyed` report must be accepted on a deleted owner
  thread (most thread commands refuse `deletedAt !== null`).

**Tests.**

- `SandboxReconciler.test.ts`: `planReconciliation` and `pairBackends` as one table with a row per
  line above, including the stray and the clock edge at 5 minutes. One `it.effect` for the cadence:
  with `Scheduler.layer` as `Scheduler.test.ts` sets it up and `FakeComputeDriver`, take the first
  `list` call from the queue after activation, `TestClock.adjust("9 minutes")` and assert the queue
  is empty, `adjust("1 minute")` and take the second. One case through the orchestrator harness:
  a `provisioning` record with no `driverRef` and a listed backend of the expected name produces a
  persisted `sandbox.updated` with that `driverRef`, and a second pass adds no event (receipt).
- `SandboxLifecycleWorker.test.ts`, like `UsageLimitRecoveryWorker.test.ts:19`: settling the owner
  and archiving its fork dispatches one `sandbox.auto-sleep` (await the persisted `sandbox.updated`
  with `sleeping`, then drain the worker and take the fake's `stop`); unsettling one first dispatches
  nothing; a boot deadline fires after `TestClock.adjust("10 minutes")` and not before.
- `SandboxDecisions.test.ts` (1.5): rows for `planSandboxOnThreadDelete` (owner alone; owner with a
  side chat deleted in the same command; owner with a live fork; non-owner; no sandbox) and for the
  auto-sleep refusal when an attached thread has an active run. One orchestrator case: deleting the
  owner, then draining the effect worker, calls the fake's `destroy` and persists `destroyed` on the
  deleted thread's stream. No project-removal test: it is the same `thread.delete` path.

**Verify.** `vp test run apps/server/src/sandbox/lifecycle`, `vp run check:changed`. Runtime
transcript on a dev server with Docker: start a cloud thread, settle it and show `docker ps -a`
stopped; kill the server mid-create, restart and show `sandbox.created` recovered; delete the thread
and show the container and volume gone; leave a hand-made `pair.install=<id>` container 5 minutes
and show it removed on the next pass.

**Reviewer checks.**

- The reconciler never acts on a backend without our install tag, and never destroys one created
  under 5 minutes ago.
- `StopBackend` re-reads the record under the owner's lock; nothing else in the reconciler holds
  the lock while dispatching.
- Guarded commands from workers use fresh ids; only `sandbox-created:<id>:<generation>` is
  deterministic.
- `auto-sleep` commits `sleeping` at decision time, and the "settled" read is the shared thread row.
- Deleting the owner with its side chats destroys; a live fork prevents it (until 1.17 hands over).

### 1.20 `build(sandbox-image): add the Ubuntu base image with pinned Claude and Codex`

Defines the machine every M1 sandbox boots from: Ubuntu 24.04, Node, git and `gh`, Claude Code and
Codex at pinned versions, the `t3` user with passwordless `sudo`, `tini` as PID 1 and the bootstrap
that starts the runner. Its own PR, and buildable from day one, because it touches no server
behavior.

- **Needs:** none. **Unblocks:** 1.21, 1.22, 1.23, 1.28 (`gh` shim), 3.13; 1.14's egress helper
  uses its `iptables`.
- **Files:**
  - add `infra/sandbox-image/provision.sh`: the single definition of the base (05 §1). Runs as root
    on stock Ubuntu 24.04, for the Dockerfile now and as M5's first build step later.
  - add `infra/sandbox-image/Dockerfile`: two targets, `base` and `with-runner` (1.21).
  - add `infra/sandbox-image/pair-bootstrap.sh`: the entrypoint script 03 §2.1 describes.
  - add `infra/sandbox-image/versions.env`: Node and `gh` versions with per-arch SHA-256.
  - add `infra/sandbox-image/providers/package.json` and `package-lock.json`: the exact Claude Code
    pin with integrity hashes. Outside the pnpm workspace: `pnpm-workspace.yaml` globs `infra/*`, and
    `infra/sandbox-image/` has no `package.json`, so pnpm skips it.
  - add `apps/server/src/provider/codexReleases.ts`: `CODEX_RELEASES` and `CodexReleaseAsset`, moved
    out of `CodexInstallation.ts:53-105` with no other change; `CodexInstallation.ts` imports them. A
    leaf module with no imports, so a Node script can read it without the server's graph.
  - add `apps/server/scripts/sandbox-image.ts` (effect/cli, like `scripts/migrate-dev-db.ts`):
    `context <dir>` assembles a build context, `build` (P3, below). 1.22 adds `check-providers`.
  - add `apps/server/scripts/sandbox-image.test.ts`.
  - change root `package.json` scripts: `"sandbox-image:build": "node apps/server/scripts/sandbox-image.ts build"`
    (beside `migrate-dev-db`, line 14).
  - add `.github/workflows/sandbox-image.yml` with the pull-request job only; 1.21 adds release.

**`provision.sh`** (bash, `set -euo pipefail`, reads `versions.env` and `codex.env` beside it,
arch from `dpkg --print-architecture`):

1. `apt-get install --no-install-recommends` the 05 §1 table: `ca-certificates curl openssh-client
   openssh-server sudo tini locales procps less unzip tmux vim git git-lfs ripgrep fd-find jq
   build-essential pkg-config python3 python3-venv python3-pip`, plus `iptables` (1.14's helper)
   and `xz-utils`. `openssh-server` is installed, not enabled (M4). Clear apt lists.
2. Node 24 LTS from the nodejs.org tarball, SHA-256 checked against `versions.env`, into
   `/usr/local`; `corepack enable`. `gh` the same way from its release tarball. Node satisfies
   `engines.node` (`^22.16 || ^23.11 || >=24.10`, `apps/server/package.json`).
3. Codex: download `CODEX_URL_<ARCH>`, check `CODEX_SHA256_<ARCH>`, extract to
   `/opt/codex/<version>/`, require `codex-package.json` with `entrypoint: "bin/codex"` (the layout
   `CodexInstallation.ts:222-234` checks), link `/usr/local/bin/codex`. The musl build runs on glibc.
4. Claude Code: `npm ci --omit=dev --prefix /opt/pair-providers` from the lockfile, link
   `/usr/local/bin/claude`. Whether current versions need an install script is unverified; the PR
   checks `claude --version` as `t3` either way.
5. User: delete Ubuntu 24.04's stock `ubuntu` user first (it holds uid 1000), then `useradd -m -u
   1000 -s /bin/bash t3`; `/etc/sudoers.d/t3` (`t3 ALL=(ALL) NOPASSWD:ALL`, 0440, checked with
   `visudo -c`) (D3).
6. `/home/t3/.npm-global` owned by `t3` and set as its npm prefix; `/etc/profile.d/pair.sh` puts
   `/home/t3/.npm-global/bin` first on `PATH`. The runner's spawn environment (1.25) uses the same
   `PATH`.
7. `install -d -m 0700 /etc/pair-runner` (1.14 writes the bootstrap file there), `install -d -m 0755
   /opt/pair-runner /t3-sandbox`.
8. Write `/etc/pair-image.json`: `{ "pairVersion", "providers": { "claudeAgent": "<v>", "codex": "<v>" } }`.
   The provider keys are the model manifest's `driver` values, so 1.22 and M3's build manifests read
   them directly.

**`Dockerfile`:**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04@sha256:<pinned> AS base
ARG PAIR_VERSION=dev
COPY . /tmp/pair-image/
RUN PAIR_VERSION="$PAIR_VERSION" /tmp/pair-image/provision.sh && rm -rf /tmp/pair-image
COPY pair-bootstrap.sh /usr/local/bin/pair-bootstrap
LABEL org.opencontainers.image.version="$PAIR_VERSION"
# -g: signal the whole group, since pair-bootstrap runs the runner as a child (exit 75 retry)
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/pair-bootstrap"]

FROM base AS with-runner
COPY --from=runner . /opt/pair-runner/
```

`with-runner` takes a named build context (`--build-context runner=<dir>` holding
`<runnerBuildId>/`), so pull-request builds and dev builds need no bundle.

**`pair-bootstrap.sh`** (POSIX `sh`, about 40 lines, mirrors `cloud/pinnedRuntime.ts`'s
staging-directory install, SHA-256 check and `.install-complete` sentinel):

1. If `/etc/pair-runner/bootstrap.env` exists (Docker, 1.14), source it and delete it. Otherwise the
   four `PAIR_*` values come from env (vendors). Require all four.
2. `install -d -o t3 -g t3 /t3-sandbox/$PAIR_SANDBOX_ID` (a fresh volume is root-owned).
3. Bundle dir `/opt/pair-runner/$PAIR_RUNNER_BUILD`: present if it holds `MANIFEST.json` (a bind
   mount from the server, 1.14) or `.install-complete` (cached or fetched). Else fetch
   `GET /runner/v1/bundle/<id>.tar.gz` and `.sha256` with `Authorization: Bearer $PAIR_RUNNER_ENROLL`
   (`curl --unix-socket` for a `unix:` URL), into a staging dir, verify, extract, write the sentinel,
   rename. A stalled download fails after 60 s (`curl --speed-time`).
4. Run `"$dir/t3" runner` as a child. On exit 75 (build mismatch, 03 §2.2), read the server's build
   id the runner wrote to `/run/pair-runner/server-build`, fetch it once and run again; then exit
   with the runner's code.

The endpoints it calls are 1.9's; until 1.9 lands the image is testable for its CLIs only.

**`sandbox-image.ts`:**

```ts
// context <dir>: copy infra/sandbox-image/ into <dir> and write <dir>/codex.env from CODEX_RELEASES
//   ("linux-x64" → AMD64, "linux-arm64" → ARM64: CODEX_VERSION, CODEX_URL_*, CODEX_SHA256_*).
// build [--tag t3-sandbox:dev]: context into a temp dir, then
//   `docker build --target base --build-arg PAIR_VERSION=dev -t <tag> <dir>` for the host arch (P3).
const codexEnv: (releases: typeof CODEX_RELEASES) => string; // pure; fails if either Linux entry is missing
```

**Tests.** `apps/server/scripts/sandbox-image.test.ts`: `codexEnv` maps both Linux entries and
fails when one is missing (the case that breaks when someone edits `CODEX_RELEASES`). The image
itself is proved by the workflow's smoke step, not a unit test.

**`.github/workflows/sandbox-image.yml` (pull-request part).** `on: pull_request: paths:
[infra/sandbox-image/**, apps/server/src/provider/codexReleases.ts, apps/server/scripts/sandbox-image.ts]`.
Matrix on native runners (`ubuntu-24.04`, `ubuntu-24.04-arm`), no QEMU: setup deps, `node
apps/server/scripts/sandbox-image.ts context "$RUNNER_TEMP/ctx"`, `docker buildx build --target base
--load -t t3-sandbox:ci`, then smoke as `t3`: `docker run --rm --user t3 --entrypoint bash
t3-sandbox:ci -lc 'claude --version && codex --version && node --version && gh --version && sudo -n
true'`, and compare the reported Claude and Codex versions with `/etc/pair-image.json`. No push.

**Verify.** `vp test run apps/server/scripts/sandbox-image.test.ts`; `vp run sandbox-image:build`
on a Linux or macOS machine with Docker, then the smoke command above; `vp run check:changed`. Attach
the CI log of both architectures (05 §9 1.1's proof).

**Reviewer checks.**

- Every download is pinned and checked by SHA-256 or npm integrity; nothing is fetched unpinned
  (`apt` packages excepted, from Ubuntu's archive).
- `CodexInstallation.ts` changes only by importing the moved table; managed Codex behavior is
  identical.
- uid 1000 is `t3` (the stock `ubuntu` user removed), and `sudo -n true` works as `t3`.
- The bootstrap deletes the bootstrap file before anything else runs and never logs the secret.
- No credential, token or `.npmrc` lands in any layer.

### 1.21 `ci: publish the base sandbox image to the GHCR of the repo running the workflow`

On each release tag, publishes `t3-sandbox:<version>` for amd64 and arm64, with that release's
runner bundle cached by `runnerBuildId`, to `ghcr.io/<owner of the running repo>/t3-sandbox`, so a
fork publishes its own unchanged (decision 15, D6). Its own PR because it needs repository
permissions and a release dry run, and touches no code.

- **Needs:** 1.9 (`dist/runner/` and its `MANIFEST.json`), 1.20 (the image and its PR workflow).
  **Unblocks:** 1.23 (an image to pull for a released version).
- **Files:**
  - change `.github/workflows/sandbox-image.yml` (from 1.20): add the release trigger and three jobs.
    Separate from upstream's `release.yml`, whose jobs only run for `pingdotgg/t3code`
    (`release.yml:52`, `if: github.repository == 'pingdotgg/t3code'`).
  - change `docs/operations/release.md`: a short "Sandbox base image" section (what the workflow
    publishes, that version tags are never re-pushed, and the one-time package visibility step).

**Workflow.**

```yaml
on:
  push:
    tags: ["v*.*.*", "!v*-nightly.*", "!v*-preview.*"] # the same filter as release.yml
  workflow_dispatch: { inputs: { version: { required: true, type: string } } } # fork dry runs
  pull_request: { paths: [...] } # 1.20's build-only job, unchanged
permissions: { contents: read, packages: write }
concurrency: { group: "sandbox-image-${{ github.ref }}", cancel-in-progress: false }
env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/t3-sandbox # lowercased in a step; GHCR rejects capitals
```

1. `bundle` (`ubuntu-24.04`): check out the tag; fail unless `apps/server/package.json`'s `version`
   equals the tag without `v` (the server pulls by that exact string, 1.23); set up deps; `vp run
   --filter t3 build:bundle`; read `runnerBuildId` from `apps/server/dist/runner/MANIFEST.json`;
   upload `dist/runner/` as the artifact `runner/<runnerBuildId>/`. One bundle serves both
   architectures: it carries node-pty's `linux-x64` and `linux-arm64` prebuilds (03 §2.1).
2. `image` (matrix: `amd64` on `ubuntu-24.04`, `arm64` on `ubuntu-24.04-arm`; native runners, no
   QEMU): download the artifact; `node apps/server/scripts/sandbox-image.ts context "$CTX"`;
   `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`; `docker buildx build --target with-runner
   --build-context runner=<artifact dir> --build-arg PAIR_VERSION=<v> --platform linux/<arch>
   --cache-from type=gha,scope=<arch> --cache-to type=gha,mode=max,scope=<arch> --label
   org.opencontainers.image.source=https://github.com/${{ github.repository }} --label
   t3.runner-build=<runnerBuildId> --output type=image,name=$IMAGE,push-by-digest=true,name-canonical=true,push=true`;
   run 1.20's smoke on the pushed digest; upload the digest.
3. `manifest`: refuse if `$IMAGE:<v>` already exists (`docker buildx imagetools inspect` succeeds:
   version tags are never re-pushed, 05 §1); then `docker buildx imagetools create -t $IMAGE:<v>
   <both digests>`, and print the index digest to the job summary. No `latest` tag: the server pulls
   exact versions only.

`workflow_dispatch` with a version that is not a tag builds the checked-out ref and pushes
`$IMAGE:<v>-dryrun.<run id>`, so a fork can prove the pipeline (05 §9 1.2's proof) without taking a
real version tag. The buildx GHA cache keeps provider layers between releases; the runner layer is
last, so a release that bumps no provider rebuilds only it.

**Package visibility.** A package first pushed from Actions is linked to the repository through the
`org.opencontainers.image.source` label. Whether it becomes public without a manual step is
unverified; `release.md` tells the maintainer to set it public once after the first push, since a
private package makes every pull from a team server fail with `auth`.

**Tests.** None in code; it is a workflow. Proof is the dry run on a fork.

**Verify.** `actionlint` on the workflow if available; a `workflow_dispatch` dry run on a fork
pushing `t3-sandbox:<v>-dryrun.<id>`; then on any machine `docker pull ghcr.io/<owner>/t3-sandbox:<v>-dryrun.<id>`
for both architectures and the smoke command. Attach the run link and `docker buildx imagetools
inspect` output.

**Reviewer checks.**

- The image name derives from `github.repository_owner`, lowercased; nothing names Pair's owner or
  upstream's.
- The tag's version must equal the server package version, and an existing tag is never
  overwritten.
- `packages: write` is the only extra permission; no secret beyond `GITHUB_TOKEN`.
- The runner layer comes last, and the bundle directory is named by `runnerBuildId`.

### 1.22 `ci: fail a release whose pinned provider CLIs are unsupported`

Makes it impossible to publish a base image whose Claude Code or Codex is not `supported` by the
model manifest bundled with the same server version, because a cloud thread uses the image's CLI,
never the server's (05 §1 "Fitting how the server checks providers today"). Its own PR because it is
a check, separate from building or publishing.

- **Needs:** 1.20 (the pins and `codexReleases.ts`). **Unblocks:** nothing; 1.21 runs it when both
  are in.
- **Files:**
  - change `apps/server/scripts/sandbox-image.ts`: add `readProviderPins`, `checkProviderPins` and the
    `check-providers [--version <v>]` command.
  - change `apps/server/scripts/sandbox-image.test.ts`: the table below.
  - change `.github/workflows/sandbox-image.yml`: run `check-providers` first in the pull-request job
    and in the release `bundle` job (before anything is pushed), with `--version` from the tag.

**Types, services and RPCs.**

```ts
export interface ProviderPins { readonly claudeAgent: string; readonly codex: string } // manifest driver ids
export const readProviderPins: Effect.Effect<ProviderPins, PlatformError, FileSystem.FileSystem | Path.Path>;
// claudeAgent: the exact version of @anthropic-ai/claude-code in infra/sandbox-image/providers/package.json
//   (must equal the lockfile's resolved version; a range is an error).
// codex: CODEX_RELEASES["linux-x64"].version, which must equal the linux-arm64 entry's.
export const checkProviderPins = (
  pins: ProviderPins,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  pairVersion: string,
): ReadonlyArray<{ readonly driver: keyof ProviderPins; readonly version: string; readonly status: string }> =>
  (["claudeAgent", "codex"] as const).flatMap((driver) => {
    const status = resolveProviderCompatibility(policies, ProviderDriverKind.make(driver), pins[driver], pairVersion)?.status ?? "no policy";
    return status === "supported" ? [] : [{ driver, version: pins[driver], status }];
  });
```

It grades with the server's own `resolveProviderCompatibility`
(`provider/providerCompatibility.ts:57`) against `BUNDLED_MODEL_MANIFEST.compatibility`
(`provider/ModelManifest.ts:104`, field at `:70`), passing the release version explicitly instead of
the default `packageJson.version`. Only `supported` passes: `graceful` fails too, since an image is
pinned for a whole release. A missing policy for a driver fails ("no policy"), so a manifest that
drops Claude or Codex cannot ship an image silently. `check-providers` prints each failure and exits

1. The same versions are what 1.20 writes to `/etc/pair-image.json`, so the label a sandbox shows
   and the version checked here cannot drift.

**Tests.** Extend `sandbox-image.test.ts` (1.20) with one table for `checkProviderPins` over a small
inline policy list: supported pins pass; an old Claude pin graded `unsupported` fails; `graceful`
fails; a driver with no policy fails; a `t3CodeRange` that excludes the version fails. Plus one
`it.effect` that runs `readProviderPins` on the repo and checks against `BUNDLED_MODEL_MANIFEST`
with the server's own version, so a pull request that narrows a manifest range or bumps a pin out of
range fails the server's normal test job, not only a release.

**Verify.** `vp test run apps/server/scripts/sandbox-image.test.ts`; `node
apps/server/scripts/sandbox-image.ts check-providers`; temporarily set an old Claude pin and see it
exit 1 (the proof 05 §9 1.3 asks for); `vp run check:changed`.

**Reviewer checks.**

- The check calls `resolveProviderCompatibility`; it does not reimplement range matching.
- `graceful` and "no policy" fail.
- The release job runs it before any build or push step.
- Pins are read from the same files the image build reads, never copied into the script.

### 1.23 `feat(server): pull the base image matching the exact server version, with a sandbox.baseImage override, shown as Pair base`

Makes the Docker driver boot from a known image: `sandbox.baseImage` when an admin sets it,
otherwise the image published for this exact server version, otherwise (from source) the local dev
build. It records the image's digest on the sandbox and labels it "Pair base <version>". Its own PR
because it needs a published image (1.21) and changes what `create` boots, which 1.14 left as a
placeholder.

- **Needs:** 1.14, 1.21 (and 1.2 for the record field). **Unblocks:** 1.40 (Test shows the image),
  1.39 (header label), 3.8 (builds replace the base).
- **Files:**
  - add `apps/server/src/sandbox/image/SandboxBaseImage.ts`: `DEFAULT_BASE_IMAGE_REPOSITORY`,
    `baseImageCandidates`, `ensureBaseImage`, `baseImageMissingHint`.
  - add `apps/server/src/sandbox/image/SandboxBaseImage.test.ts`.
  - change `apps/server/src/sandbox/compute/DockerComputeDriver.ts`: replace 1.14's placeholder
    (`sandbox.baseImage ?? "t3-sandbox:dev"`, required to exist locally) with a per-driver image state
    and a background pull; `create` returns `baseImage`; `health.baseImage` reports it.
  - change `apps/server/src/sandbox/compute/ComputeDriver.ts`: `ComputeDriverError` gains
    `image: optionalKey({ ref, state: "pulling" | "missing" })`; `ComputeDriverHealth.baseImage`
    becomes `BaseImageInfo | { pulling: string } | { missing: string; hint: string } | null`.
  - change `packages/contracts/src/orchestrationV2.ts`: `OrchestrationV2Sandbox` and the
    `sandbox.created` internal command gain `baseImage: Schema.optionalKey(SandboxBaseImageInfo)`;
    the decider in `SandboxDecisions.ts` copies it onto the record.
  - change `packages/contracts/src/sandbox.ts`: `SandboxBaseImageInfo` and `sandboxImageLabel`, a
    small derived helper both clients use (1.39, 1.41).
  - change `apps/server/src/sandbox/compute/DockerComputeDriver.test.ts` and the contracts test
    beside `sandbox.ts`.

**Types, services and RPCs.** A plain module, not a service: only the Docker driver resolves a base
image this way (a hosted vendor resolves its own template).

```ts
// proposed: one constant, the canonical Pair repository's GHCR (1.21 publishes there).
export const DEFAULT_BASE_IMAGE_REPOSITORY = "ghcr.io/<pair owner>/t3-sandbox";

export type BaseImageCandidate = { readonly ref: string; readonly pull: boolean };
export const baseImageCandidates = (input: {
  readonly override: string | undefined;   // ServerSettings.sandbox.baseImage
  readonly version: string;                // packageJson.version, as ServerEnvironment.ts:216 reports it
  readonly fromSource: boolean;            // import.meta.url.endsWith(".ts"), as ClaudeAdapterV2.ts:1104
}): ReadonlyArray<BaseImageCandidate> =>
  input.override !== undefined ? [{ ref: input.override, pull: true }]
  : [
      ...(input.fromSource ? [{ ref: "t3-sandbox:dev", pull: false }] : []),
      { ref: `${DEFAULT_BASE_IMAGE_REPOSITORY}:${input.version}`, pull: true },
    ];

export const ensureBaseImage: (
  api: DockerEngineApi, candidates: ReadonlyArray<BaseImageCandidate>,
) => Effect.Effect<BaseImageInfo, BaseImageMissingError>;
// For each candidate: GET /images/{ref}/json; present → { ref, digest: RepoDigests[0] ?? Id, version:
// Config.Labels["org.opencontainers.image.version"] ?? null, id: Id }. Then the first pullable one:
// POST /images/create?fromImage=&tag= (anonymous), read the progress stream to its end, fail on an
// `error` line, inspect. Nothing found → BaseImageMissingError { refs, fromSource }.

// packages/contracts/src/sandbox.ts
export const SandboxBaseImageInfo = Schema.Struct({ ref: TrimmedNonEmptyString, digest: TrimmedNonEmptyString, version: Schema.NullOr(TrimmedNonEmptyString) });
export const sandboxImageLabel = (sandbox: Pick<OrchestrationV2Sandbox, "imageBuildId" | "baseImage">): string | null =>
  sandbox.imageBuildId !== null ? null            // M3: the build's own label
  : sandbox.baseImage === undefined ? "Pair base"
  : sandbox.baseImage.version !== null ? `Pair base ${sandbox.baseImage.version}`
  : `Base image ${sandbox.baseImage.ref}`;        // an override without Pair's version label
```

**Proposed: P3 refined.** P3 sends a source-run server to `sandbox.baseImage` or `t3-sandbox:dev`
only. But teams run Pair from a checkout today (decision 15), so every M1 server is "from source",
and the published image would go unused. So a source-run server tries the local `t3-sandbox:dev`
first (a developer's own build wins), then the published `<repository>:<version>`. A checkout of a
release tag has that exact version; a checkout of `main` reports the last release's version, whose
image still works because the runner bundle is fetched at boot anyway (03 §2.2). `t3-sandbox:dev` is
never pulled.

**Proposed: the default repository is one constant.** The server cannot learn which fork it was
cloned from, and a pack-time stamp would not reach teams running from a checkout. A fork that
publishes its own image sets `sandbox.baseImage` or edits this one line.

**Pulling never runs inside an effect.** A pull takes minutes and sandbox effects are bounded at
60 s. The driver keeps `Ref<"idle" | { pulling: string } | { ready: BaseImageInfo } | { missing:
BaseImageMissingError }>` in its registry scope and forks `ensureBaseImage` (once at a time,
`Semaphore`) when the driver is built and on every `health` call after `missing`. The driver is
built by the reconciler's startup pass (1.19), by Settings' Test button (1.40), or by the first
launch, so the pull starts when an admin enables Docker. `create` with `{ type: "base" }`:

- `ready`: create from the image **id**, so a sandbox boots exactly what was resolved, and return
  `baseImage: { ref, digest, version }`.
- `pulling`: fail `ComputeDriverError { reason: "unavailable", retryable: true, image: { ref, state:
  "pulling" } }`. After the outbox's attempts the sandbox fails retryable, and 1.5's failure mapping
  says "The machine image is still downloading. Retry in a few minutes."
- `missing`: fail `retryable: false` with `image.state: "missing"`; `baseImageMissingHint` gives
  "Run `vp run sandbox-image:build`, or set Base image in Settings → Cloud." from source, and
  "Could not pull <ref>. Check that the package is public, or set Base image in Settings → Cloud."
  for a released server.

The image is resolved again only when the driver is rebuilt (a settings change) or the server
restarts (a new version); version tags are never re-pushed (05 §1). A private registry in
`sandbox.baseImage` must be pulled on the Docker host beforehand: the Engine API does not use the
host's `docker login`, and M1 sends no registry credentials (found locally, it works). On a remote
`DOCKER_HOST` the pull runs on that daemon.

**Commands, events and effects.** `sandbox.created` carries `baseImage` from the create result; the
decider writes it into the record with the same `sandbox.updated`. Old clients ignore the extra key
(`Schema.Struct` drops unknown keys, 08 §2). No new command or effect.

**Tests.**

- `SandboxBaseImage.test.ts`: `baseImageCandidates` table (override only; released: the version tag;
  from source: dev, then the version tag; dev never pullable). `ensureBaseImage` against 1.14's fake
  Engine API: a local candidate wins without a pull; an absent one pulls once and inspects; an
  `error` line in the pull stream fails `BaseImageMissingError`.
- `DockerComputeDriver.test.ts` (extend): with the pull's response held on a `Deferred`, `create`
  fails `image.state: "pulling"`; completing the `Deferred` and creating again uses the image id
  and returns `baseImage`. A failed pull makes `health.baseImage` `missing` with the from-source hint.
- The contracts test beside `sandbox.ts`: one table for `sandboxImageLabel` (no `baseImage`, a Pair
  version, an override without a version, a team build). This is 05 §9 1.4's "test on the derived
  label".

**Verify.** `vp test run apps/server/src/sandbox/image apps/server/src/sandbox/compute packages/contracts/src/sandbox.test.ts`;
`vp run typecheck` (contracts and server); `vp run check:changed`. Runtime transcript: on a host
without the image, enable Docker, show `health.baseImage` as `{ pulling }`, then
`Pair base <version>` and `docker images --digests`; start a cloud thread and show the record's
`baseImage.digest` equal to the image's. From a checkout with no published image and no dev build,
show the hint, run `vp run sandbox-image:build`, and show `Pair base dev`.

**Reviewer checks.**

- No pull or `docker build` runs inside a sandbox effect or holds a thread lock.
- `create` uses the resolved image id, not a tag that could resolve differently later.
- `t3-sandbox:dev` is never pulled, and only a source-run server considers it.
- The new contract fields are `optionalKey`; nothing persisted that old clients decode strictly
  changes shape.
- The hint names `vp run sandbox-image:build` only for a source-run server.

### 1.24 `feat(server): run cloud setup scripts with sandbox paths`

A project script that runs in a sandbox sees sandbox paths: `T3CODE_PROJECT_ROOT` is the sandbox
clone, `T3CODE_WORKTREE_PATH` the thread's checkout, and `T3CODE_SANDBOX=1` (README decision 9,
05 §5). Setup scripts already run in the sandbox once terminals go through the host (0.5, 1.11);
only their environment was wrong.

- **Needs:** 1.11. **Unblocks:** 1.16 (its preparation runs the setup script through the host, P4).
- **Files:**
  - add `apps/server/src/sandbox/scripts/sandboxScriptEnvironment.ts`: the one function below.
  - change `apps/server/src/terminal/Manager.ts`, the start path where
    `createTerminalSpawnEnv(baseEnv, session.runtimeEnv, ...)` builds the PTY env (:2440): when the
    session's host is a sandbox, pass `yield* sandboxScriptEnvironment(host, session.cwd,
    session.runtimeEnv)` instead of `session.runtimeEnv`.
  - no change to `apps/server/src/project/ProjectSetupScriptRunner.ts` (:435-443) or
    `packages/shared/src/projectScripts.ts` `projectScriptRuntimeEnv` (:40). 05 §5 put the edit in
    the runner, but web and mobile build the same env on the client from the server's
    `project.workspaceRoot` (see PR-list changes), and settle scripts (`trigger: "settle"`) share
    the path. The terminal manager is the one point all of them pass.

**Types, services and RPCs.**

```ts
// sandbox/scripts/sandboxScriptEnvironment.ts
/** Points script paths into the sandbox. The clone is the worktree's git common dir's parent. */
export const sandboxScriptEnvironment = Effect.fn("sandboxScriptEnvironment")(function* (
  host: WorkspaceHost,
  cwd: string,
  runtimeEnv: Record<string, string> | null | undefined,
): Effect.fn.Return<Record<string, string>, never> {
  const env = { ...runtimeEnv, T3CODE_SANDBOX: "1" };
  if (env.T3CODE_PROJECT_ROOT === undefined) return env; // a plain terminal, not a script
  const commonDir = yield* host.spawner
    .string(
      ChildProcess.make("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd,
      }),
    )
    .pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ""),
    );
  const root = commonDir.endsWith("/.git")
    ? path.posix.dirname(commonDir)
    : (env.T3CODE_WORKTREE_PATH ?? cwd);
  return { ...env, T3CODE_PROJECT_ROOT: root };
});
```

Asking git on the host (one trip, only when a script opens) gives the right answer for M1's
thread-start clone (`/t3-sandbox/<id>/repos/<host>/<owner>/<name>`, P1) and for M3's image clone
moved to the same place, without the terminal manager knowing the layout. A checkout that is not a
git worktree falls back to the worktree path. `T3CODE_WORKTREE_PATH` needs no rewrite: every caller
already passes the thread's `worktreePath`, which is a sandbox path for a cloud thread.

**Commands, events and effects.** None.

**Tests.**

- `apps/server/src/terminal/Manager.test.ts`, beside "filters app runtime env variables from
  terminal sessions" (:1838): one case on `layerLoopback` with a temp repo and a `git worktree`
  under the registered root. Opening a terminal there with `T3CODE_PROJECT_ROOT=/server/path`
  spawns the PTY (fake `PtyAdapter` served by the loopback runner) with `T3CODE_PROJECT_ROOT` = the
  repo, `T3CODE_WORKTREE_PATH` unchanged and `T3CODE_SANDBOX=1`. A second assertion in the same
  case: a local terminal's env is untouched. This is the lowest layer that fails on `main`; the
  `ProjectSetupScriptRunner` tests need no new case because the runner's input is unchanged.

**Verify.** `vp test run apps/server/src/terminal/Manager.test.ts`, `vp run check:changed`. Runtime
transcript: a cloud thread on a dev server whose project setup script is `env | grep T3CODE_`, as
the setup panel shows it.

**Reviewer checks.**

- Local terminals take no new call and their env is byte-for-byte today's.
- The rewrite only runs for sandbox hosts and only adds or replaces `T3CODE_*` names.
- `git rev-parse` runs through the sandbox host, never on the server.
- Web and mobile need no change and still show the right paths.

### 1.25 `feat(server): build sandbox process environments from an allowlist and cloud env`

Every process the server starts in a sandbox gets one environment: the image's allowlisted base,
then the team's cloud env, then the project's, then Pair's own names. Secret references resolve on
the server at spawn; an unreadable one fails the spawn with today's message. Reserved names cannot
be set (06 §6). Its own PR because it is the only place cloud env is read, and 1.26 and 1.40
build on it.

- **Needs:** 1.11 (`sandboxBaseEnvironment`, the host), 1.36 (`ServerSettings.sandbox.env`,
  `SandboxEnvEntry`), 1.3 (the sandbox record's `projectId`). **Unblocks:** 1.26, 1.40.
- **Files:**
  - change `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.ts`: the service below;
    `sandboxBaseEnvironment` (from 1.11) gets its final allowlist.
  - change `packages/contracts/src/sandbox.ts`: `SANDBOX_RESERVED_ENV_NAMES`,
    `SANDBOX_RESERVED_ENV_PREFIXES` and `isReservedSandboxEnvName(name)` (a small derived helper;
    1.40's form uses it too).
  - change `packages/contracts/src/settings.ts`: `ProjectSettingsOverrides` (:1065) gains
    `sandboxEnv: Schema.optionalKey(Schema.Array(SandboxEnvEntry))`, added to the `satisfies`
    union beside `providerInstances` (:1095) because no same-named `ServerSettings` key exists
    (**proposed**, same special case as `sandboxAllowed` and `defaultsToCloud`).
    `ServerSettingsOperation` (:1493) gains `"use-reserved-sandbox-env"`, reported with the existing
    `environmentVariable` field of `ServerSettingsError` (:1517).
  - change `apps/server/src/serverSettings.ts`, the write path before `persistSettingsSecrets`
    (:1287): refuse a team or project entry whose name is reserved.
  - change `apps/server/src/terminal/Manager.ts`, the same start path 1.24 edits (:2440): on a
    sandbox host, `baseEnv` is `yield* sandboxEnv.forProcess(host)` instead of
    `host.info.environment`. Terminals and scripts then get the layers; `runtimeEnv` (Pair's
    `T3CODE_*`) is still applied last by `createTerminalSpawnEnv`.
  - change the three sandbox branches 1.12 adds (Claude `layerQueryRunner.open`, Codex
    `layerAppServerClientFactory.open`, the ACP spawn): their base is `forProcess(host)`, with the
    adapter's own names (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CLAUDE_CODE_ENTRYPOINT`,
    `T3CODE_THREAD_ID`, 1.26's credential) spread after it.
  - Server-run git and coarse ops keep `host.info.environment` only (no team env, no secret
    reads per git call).

**Types, services and RPCs.**

```ts
// sandbox/credentials/SandboxProcessEnvironment.ts
export class SandboxEnvironmentError extends Schema.TaggedError<SandboxEnvironmentError>()(
  "SandboxEnvironmentError",
  { sandboxId: SandboxId, cause: Schema.Defect() },   // wraps SettingsSecretUnresolvedError; message is its message
) {}

export class SandboxProcessEnvironment extends Context.Service<
  SandboxProcessEnvironment,
  {
    /** Base, team, project; secrets resolved now. Pair's names are the caller's, spread after. */
    readonly forProcess: (host: WorkspaceHost) => Effect.Effect<Record<string, string>, SandboxEnvironmentError>;
  }
>()("t3/sandbox/SandboxProcessEnvironment") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver; // packages/secret-provider-core
  const sandboxes = yield* /* 1.3's sandbox projection read */;
  const forProcess = Effect.fn("SandboxProcessEnvironment.forProcess")(function* (host) {
    const { projectId } = yield* sandboxes.get(SandboxId.make(host.id));
    const current = yield* settings.getSettings;
    const team = current.sandbox?.env ?? [];
    const project = current.projectSettingsOverrides[projectId]?.sandboxEnv ?? [];
    const layered = yield* resolveEntries(secrets, [...team, ...project]); // later wins
    return { ...host.info.environment, ...layered };
  });
  return SandboxProcessEnvironment.of({ forProcess });
});
export const layer = Layer.effect(SandboxProcessEnvironment, make);
```

`resolveEntries` drops reserved names (defense in depth; writes already refuse them), reads every
reference in one `secrets.read` call and fails with `SettingsSecretUnresolvedError`
(`apps/server/src/secrets/settingsSecretValue.ts:27`, "Could not read the credential from the secret
provider …") when a value comes back `undefined` or blank, so a process never starts without a
variable the admin set. `sensitive` changes nothing here; it drives redaction on the settings wire
(1.36) and value masking (M2).

Allowlist base (`sandboxBaseEnvironment`): `PATH` = `<bundleDirectory>:` + the image's `PATH` (so
`t3` resolves for ACP bridges and the Codex auth command, 03 §8), `HOME` and `SHELL` from
`info.agent`, `USER=t3` (D3), `LANG` from the image or `C.UTF-8`, `TERM=xterm-256color`, plus the
image's other `ENV` entries that are not reserved. Nothing from the server's `process.env`, ever.

Reserved names (06 §6, one table in `sandbox.ts`): `PATH HOME USER SHELL PWD`; prefixes `T3CODE_`,
`T3_` and, **proposed**, `PAIR_` (the bootstrap names); the provider list
`CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
CLAUDE_CONFIG_DIR OPENAI_API_KEY OPENAI_BASE_URL CODEX_HOME CURSOR_API_KEY XAI_API_KEY KIRO_API_KEY`;
git: prefixes `GIT_AUTHOR_`, `GIT_COMMITTER_`, `GIT_CONFIG_`, names `GIT_ASKPASS GH_TOKEN
GITHUB_TOKEN SSH_AUTH_SOCK`.

**Commands, events and effects.** None. Values resolve per process start; changes apply to new
processes only (06 §6), so nothing is pushed to running sandboxes.

**Tests.**

- `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.test.ts` (new service): one
  table-driven `it.effect` for precedence (image < team < project; a reserved team name never
  appears; `PATH` starts with the bundle dir), one for a secret reference the fake resolver cannot
  read (fails with the existing message), using a fake `SecretResolver` and a fixed
  `ServerSettings`. No server `process.env` value appears in the result (seed one in the test).
- `apps/server/src/serverSettings.test.ts`, beside the `use-disallowed-provider` refusals (:2523):
  a team entry `GH_TOKEN` and a project entry `T3CODE_X` are refused with
  `use-reserved-sandbox-env`.

**Verify.** `vp test run apps/server/src/sandbox/credentials apps/server/src/serverSettings.test.ts`,
`vp run check:changed`, `vp run typecheck` (contracts change). Runtime transcript: a cloud
thread's terminal running `env | sort` with one team variable, one project override and one
1Password reference, and the same terminal after locking 1Password (the open fails with the
message).

**Reviewer checks.**

- The server's `process.env` never reaches a sandbox spawn (grep the sandbox paths for it).
- Pair's names are spread last at every call site, so no layer can shadow them.
- Secrets resolve once per process start, never per git call.
- Reserved names are refused on write and dropped at spawn.
- Sensitive plain values stay redacted on the settings wire, as provider instance env values are.

### 1.26 `feat(server): give cloud threads their account's headless credential`

A provider process in a sandbox gets exactly its thread's instance credential, in memory, by a
headless mechanism: a Claude setup token or API key, managed Codex through the broker forward, or
an OpenAI API key. An account that only has a login stored on the server is "Local only" and is
refused before anything starts (06 §3). Server-only; the picker shows the same answer from a shared
pure function (1.38, 1.41).

- **Needs:** 1.13 (`codex-token` forward), 1.25 (`forProcess`), 1.12 (sandbox branches).
  **Unblocks:** the M1 Claude and Codex turn checks, 1.38 and 1.41 (picker reason).
- **Files:**
  - add `packages/shared/src/sandboxCredentials.ts` (subpath `./sandboxCredentials` in
    `packages/shared/package.json`, beside `./projectScripts` at :166): `sandboxCredentialSupport`.
    Pure: it reads only the driver, `config.setupMode` and the environment entry **names**, which
    clients already receive (values are redacted on the wire).
  - change `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.ts`: add
    `forProviderSession`.
  - change `apps/server/src/orchestration-v2/ProviderSessionManager.ts` `open`, right after 1.12's
    cloud-ready check: `LocalOnly` fails with `ProviderCloudLocalOnlyError`.
  - change the Claude and Codex sandbox branches from 1.12 to use `forProviderSession` (instead of
    `forProcess`), and the ACP Replay branch to keep `forProcess`.
  - change `apps/server/src/provider/CodexManagedRuntime.ts` `resolveFor(host)` (from 1.12): keep
    today's strip of `ACCESS_TOKEN`, `T3CODE_CODEX_LAUNCH_ARGS`, `OPENAI_API_KEY`,
    `OPENAI_BASE_URL` (:119-124) on the sandbox env too.
  - change `apps/server/src/terminal/Manager.ts` `resolveProviderInstanceEnvironment` (:1481): for a
    sandbox session, a terminal opened with a `providerInstanceId` gets `forProviderSession` and the
    same `LocalOnly` refusal (as `TerminalProviderEnvironmentError`), never the server-side resolver.

**Types, services and RPCs.**

```ts
// packages/shared/src/sandboxCredentials.ts
export type SandboxCredentialSupport =
  | { readonly _tag: "Ready"; readonly mechanism:
        "claude-setup-token" | "claude-api-key" | "codex-managed" | "codex-api-key" | "none" }
  | { readonly _tag: "LocalOnly"; readonly reason: string }
  | { readonly _tag: "Unsupported" };                       // 1.12's not-cloud-ready drivers
export const sandboxCredentialSupport = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}): SandboxCredentialSupport => { /* table below */ };

// sandbox/credentials/SandboxProcessEnvironment.ts (addition)
readonly forProviderSession: (input: {
  readonly host: WorkspaceHost;
  readonly instanceId: ProviderInstanceId;
}) => Effect.Effect<Record<string, string>, SandboxEnvironmentError | ProviderCloudLocalOnlyError>;
// = forProcess(host) ⊕ the instance's non-reserved env entries ⊕ the one credential name below,
//   all secret references resolved in the same batch as the layers.

// orchestration-v2/ProviderSessionManager.ts
export class ProviderCloudLocalOnlyError extends Schema.TaggedError<ProviderCloudLocalOnlyError>()(
  "ProviderCloudLocalOnlyError",
  { threadId: ThreadId, instanceId: ProviderInstanceId, reason: Schema.String },
) { override get message() { return this.reason; } }
```

| Account (instance)                                                                                                                                   | Decided by   | Process gets                                                                                                             | Command                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, env has `CLAUDE_CODE_OAUTH_TOKEN` (a member's `sk-ant-oat…` from `claude setup-token`, `MemberProviderAccounts.ts:58-64`, or an admin entry) | name present | `CLAUDE_CODE_OAUTH_TOKEN` only (D2: Settings already warns the agent can read it)                                        | the image's `claude`                                                                                                                                   |
| Claude, env has `ANTHROPIC_API_KEY`                                                                                                                  | name present | `ANTHROPIC_API_KEY` only                                                                                                 | same                                                                                                                                                   |
| Claude, neither (login in the instance home, incl. the admin default using the server's `~/.claude`)                                                 | —            | nothing: **Local only**, "Claude signs in on this server only. Add a setup token or API key to use it in cloud."         | refused                                                                                                                                                |
| Codex, `setupMode: "managed"`                                                                                                                        | config       | no key; `OPENAI_API_KEY`/`OPENAI_BASE_URL` stripped                                                                      | `-c model_provider=…auth={command="<bundle>/t3", args=["__managed-chatgpt-token", <forward socket>, <instance>, <environment>, <profile key>]}` (1.12) |
| Codex, env has `OPENAI_API_KEY` (unmanaged)                                                                                                          | name present | `OPENAI_API_KEY` and, when set, `OPENAI_BASE_URL`                                                                        | the image's `codex`; confirm the pinned CLI uses the env key without `codex login` in 1.22's check                                                     |
| Codex, neither (the server's `~/.codex/auth.json`)                                                                                                   | —            | **Local only**, "This Codex account signs in on this server only. Use a managed ChatGPT account or an API key in cloud." | refused                                                                                                                                                |
| Replay (dev)                                                                                                                                         | instance id  | nothing                                                                                                                  | 1.12                                                                                                                                                   |
| Any other driver                                                                                                                                     | 1.12's check | —                                                                                                                        | `Unsupported`                                                                                                                                          |

`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and Bedrock or Vertex variables are not headless
mechanisms in M1 (06 §3 says they wait for a decision); an instance that has only those is Local
only. The instance's `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are reserved and replaced by the sandbox
homes (1.12), so no server path or login file follows the account.

Where "Local only" is decided and shown: the server refuses in `ProviderSessionManager.open`, which
every path reaches (launch, a model switch mid-thread, MCP and CLI launches, retries). 1.16's cloud
preparation calls the same function before provisioning so a launch is refused before a sandbox
boots, not after. Clients call `sandboxCredentialSupport` for the model-picker reason in cloud
context: web passes it through `getModelDisabledReason`
(`apps/web/src/components/chat/ModelPickerContent.tsx:401`) in 1.38, mobile in 1.41.

Shared sandboxes (06 §2): a Codex app-server is one process per provider session
(`CodexAdapterV2.ts:1754`, `clientFactory.open` in `openSession`), started with its instance's
credential; the threads it serves get their own `GIT_AUTHOR_*` and `T3CODE_THREAD_ID` through
per-thread `shell_environment_policy.set` (:1422-1430), and their MCP token in the per-thread
JSON-RPC config. So "one credential per process" means one per provider instance per session: two
threads on the same instance in one sandbox carry the same token, threads on different instances
never see each other's in their env, and any agent there can still read a sibling's from `/proc`.
1.13's `codex-token` forward checks the broker request's instance against the forward's
`ownerKey` session.

Audit (06 §7): log the mechanism and instance id (never a value) as attributes on the existing
session-open span. The persisted "credential source" event is left to 1.29 with git token audit.

**Commands, events and effects.** None. The refusal fails `provider-turn.start` like any open error.

**Tests.**

- `packages/shared/src/sandboxCredentials.test.ts` (new pure module): one table test over the rows
  above, including an admin Claude instance with a secret-reference token (`Ready`) and an empty
  environment (`LocalOnly`).
- `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.test.ts` (from 1.25): extend the
  table with `forProviderSession` rows: only the credential name and non-reserved instance entries
  appear; a team entry named like a credential cannot exist (refused on write) and an instance's
  `CLAUDE_CONFIG_DIR` is dropped.
- `ProviderSessionManager` tests (the file 1.12 extends): a Local-only Claude instance on a
  loopback cwd fails with `ProviderCloudLocalOnlyError` and the adapter's `openSession` is never
  called.
- `apps/server/src/provider/CodexManagedRuntime.test.ts`: `resolveFor` a loopback host; the
  launch args name the forward socket and the bundle `t3`, and the env has no `OPENAI_API_KEY`.
  (If 1.12 already added this case, extend it with the env assertion instead.)

**Verify.** `vp test run packages/shared/src/sandboxCredentials.test.ts
apps/server/src/sandbox/credentials apps/server/src/orchestration-v2/ProviderSessionManager.test.ts`,
`vp run check:changed`, `vp run typecheck`. Runtime transcript on a dev server with Docker: one
Haiku turn with a member's setup token, one Codex turn on a managed account (cheapest model), and
the refusal text for the default Claude instance; `cat /proc/<claude pid>/environ` inside the
sandbox shows only the one credential.

**Reviewer checks.**

- No credential is written to the sandbox's disk; only env at spawn and the broker over the forward.
- One instance's credential never reaches another instance's process.
- Local-only refusal happens before any sandbox process starts, on every entry path.
- Managed Codex still strips the OpenAI env names on sandbox hosts.
- The shared helper reads names only, so it works on redacted client settings.

### 1.27 `feat(server): store the team's GitHub App ID and private key under Source Control`

Adds two GitHub-only settings, the App ID and its private key, and a row to set them. Nothing reads
them until 1.28. Its own PR because it is pure settings plumbing with no sandbox dependency and can
land any time.

- **Needs:** none. **Unblocks:** 1.28.
- **Files:**
  - change `packages/source-control-github/src/shared/definition.ts`: `settings` (line 54) gains
    `appId` and `appPrivateKey` beside `hostCredentialSettingsFields`.
  - add `apps/web/src/components/settings/GitHubAppKeySettings.tsx`: the row.
  - change `apps/web/src/components/settings/SourceControlSettings.tsx`: `hostSettingsPanel`
    (line 391) renders `<GitHubAppKeySettings>` after `SourceControlTokenSettings` when
    `item.kind === "github"`. One line plus the import.
  - change `apps/server/src/serverSettings.test.ts`: one more value in an existing case.
  - change `docs/user/source-control.md`: a short "Cloud threads: GitHub App key" section, in 1.28
    (when it does something), not here.

**Types, services and RPCs.**

```ts
// packages/source-control-github/src/shared/definition.ts
export const settings = makeProviderSettingsSchema({
  ...hostCredentialSettingsFields,
  /** The App's numeric ID, from its settings page. github.com only in M1. */
  appId: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  /** The App's private key, PEM as GitHub downloads it (PKCS#1). Kept in the secret store. */
  appPrivateKey: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    secretSetting,
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
```

`secretSettingsFields` picks `appPrivateKey` up, so `SOURCE_CONTROL_HOST_SECRET_FIELDS`
(`apps/server/src/sourceControl/sourceControlHostSecrets.ts:15`) moves it into the secret store,
`redactServerSettingsForClient` (`apps/server/src/serverSettings.ts:142`) sends clients only
"configured", and a secret provider reference (1Password) works as for `tokens`. No new RPC: the
row saves through `serverEnvironment.updateSettings`, as `SourceControlTokenSettings.tsx:40` does.
Writing it needs `AuthSettingsWriteScope` (`apps/server/src/auth/RpcAuthorization.ts:92`), the
bar every server setting has.

The row: "GitHub App for cloud threads". App ID input; private key as a `SecretSourceInput`
(multi-line paste accepted, `configured` when the redacted value is non-empty, as
`SourceControlTokenSettings.tsx:130`); **Remove** clears both. One line of help: "Cloud threads
push with one-hour tokens for each repository the App is installed on. Without it, members push
with their own GitHub." The App needs `contents: write`, `pull_requests: write`, `metadata: read`.

**Tests.** Extend `serverSettings.test.ts` "uses the same secret lifecycle for provider config,
environment, host tokens, and quota keys" (line 1382): add `appPrivateKey: "github-app-key"` to
`sourceControlHosts.github` and to `values`. That proves storage, redaction and echo-back in one
row. No UI test (a form with no logic).

**Verify.** `vp test run apps/server/src/serverSettings.test.ts`, `vp run typecheck` (contracts
consumers through the definition), `vp run check:changed`. `test-t3-app`: Settings → Source
Control → GitHub, paste a key, reload, see "configured", remove it. Before/after captures of the
GitHub section on web and desktop.

**Reviewer checks.**

- The key never appears in `settings.json`, the client snapshot or a log (the test asserts the
  first two).
- Both fields are `hidden` for the generic form; the GitHub panel is the only place they show.
- Old clients decode `ServerSettings` unchanged: new keys are inside a provider settings record
  that `Schema.Struct` strips.
- No App ID or key is read anywhere yet; knip stays green because the schema is exported.

### 1.28 `feat(server): push from sandboxes with one-hour GitHub App tokens`

Answers git inside a sandbox with the narrowest credential the server can mint: a one-hour
installation token for the thread's repo when the App key is set, else the thread owner's
connected GitHub account, else a refusal. Adds the helper, the `gh` shim and the committer. Its own
PR because it is the server side of the `git-credential` forward and needs nothing from the data
track.

- **Needs:** 1.13 (the forward), 1.20 (the image carries the helper config and shim), 1.25 (the
  sandbox process environment it adds the committer to), 1.27 (the key). **Unblocks:** 1.28a,
  1.29, 1.35.
- **Files:**
  - add `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.ts`: JWT, installation
    lookup, mint, cache.
  - add `apps/server/src/sandbox/credentials/GitCredentialService.ts`: scope check and order.
  - add `apps/server/src/sandbox/runner/gitCredentialCommand.ts`: `t3 runner git-credential get`
    and `t3 runner git-credential token` (for the shim), registered in the runner `bin.ts` from 1.9.
  - change `packages/contracts/src/runner.ts` (from 1.1): `RunnerGitCredentialRequest`,
    `RunnerGitCredentialAnswer`.
  - change `apps/server/src/sandbox/runnerHub/RunnerForwards.ts` (from 1.13): the
    `git-credential` target calls `GitCredentialService.answer` (one line if 1.13 left a target map).
  - change `apps/server/src/sandbox/credentials/SandboxProcessEnvironment.ts` (from 1.25):
    `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, and `T3CODE_THREAD_ID` for every sandbox process,
    terminals and setup scripts included (agents already carry it, `PortScanner.ts:70`).
  - change `infra/sandbox-image/provision.sh` (from 1.20): write `/etc/gitconfig`
    (`credential.helper = !t3 runner git-credential`, `credential.useHttpPath = true`,
    `url."https://github.com/".insteadOf = git@github.com:` and `ssh://git@github.com/`), and
    install `infra/sandbox-image/gh-shim.sh` as `/usr/local/bin/gh` ahead of the real
    `/usr/bin/gh`. **1.20 names these two files**; 1.28 fills them if 1.20 left stubs.
  - change `docs/user/source-control.md`: the App key section (what it does, the three
    permissions, that without it members push with their own GitHub).

**Types, services and RPCs.**

```ts
// packages/contracts/src/runner.ts: one JSON line each way on the forward's socket
export const RunnerGitCredentialRequest = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId), // the helper's T3CODE_THREAD_ID
  protocol: Schema.Literal("https"),
  host: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString, // "owner/name.git", from credential.useHttpPath
});
export const RunnerGitCredentialAnswer = Schema.Union([
  Schema.TaggedStruct("Credential", {
    username: Schema.String,
    password: Schema.String,
    expiresAt: Schema.NullOr(IsoDateTime),
  }),
  Schema.TaggedStruct("Refused", {
    code: Schema.Literals(["github-credential-missing", "not-this-repository", "unsupported-host"]),
    message: Schema.String,
  }),
]);

// sandbox/credentials/GitHubAppInstallationTokens.ts
export class GitHubAppInstallationError extends Schema.TaggedError<GitHubAppInstallationError>()(
  "GitHubAppInstallationError",
  {
    repository: Schema.String,
    reason: Schema.Literals(["not-installed", "key-rejected", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface InstallationToken {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
  readonly repository: string; // "owner/name", lower case
  readonly permissions: Readonly<Record<string, string>>;
}

export class GitHubAppInstallationTokens extends Context.Service<
  GitHubAppInstallationTokens,
  {
    /** False when the App ID or key is unset; callers skip to the owner's credential. */
    readonly configured: Effect.Effect<boolean>;
    /** Cached per (sandboxId, repository) until 5 minutes before expiry. */
    readonly tokenFor: (input: {
      readonly sandboxId: SandboxId;
      readonly repository: string;
    }) => Effect.Effect<InstallationToken, GitHubAppInstallationError>;
    /** Drops this sandbox's cached tokens and returns them, for 1.29's revocation. */
    readonly forget: (sandboxId: SandboxId) => Effect.Effect<ReadonlyArray<InstallationToken>>;
  }
>()("t3/sandbox/credentials/GitHubAppInstallationTokens") {}
export const layer = Layer.effect(GitHubAppInstallationTokens, make).pipe(
  Layer.provide(Signature.layerWebCrypto), // effect/crypto/Signature, for Jwt.sign
);

// sandbox/credentials/GitCredentialService.ts
export type GitCredentialSource = "app-installation" | "member-account" | "member-token";

export class GitCredentialService extends Context.Service<
  GitCredentialService,
  {
    readonly answer: (input: {
      readonly sandboxId: SandboxId;
      readonly threadId: ThreadId | undefined;
      readonly host: string;
      readonly path: string;
    }) => Effect.Effect<RunnerGitCredentialAnswer>;
    /** The order without minting, for a UI push's pre-check (1.35) and clients' "can push". */
    readonly sourceFor: (threadId: ThreadId) => Effect.Effect<Option.Option<GitCredentialSource>>;
  }
>()("t3/sandbox/credentials/GitCredentialService") {}
```

The few lines a reviewer must see:

```ts
// GitHubAppInstallationTokens.tokenFor, on a cache miss
const settings = yield * sourceControlHost.settings.getWithSecrets("github"); // ServerSourceControlHost.ts:24
// GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); Jwk.importPkcs8 wants PKCS#8.
const pkcs8 = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }); // node:crypto
const key = yield * Jwk.importPkcs8(Redacted.make(pkcs8), "RS256");
const jwt = yield * Jwt.sign(AppClaims, { iat: now - 60, exp: now + 540, iss: appId }, key);
// GET /repos/{owner}/{name}/installation (404 → not-installed), then
// POST /app/installations/{id}/access_tokens
//   { repositories: [name], permissions: { contents: "write", metadata: "read", pull_requests: "write" } }
```

Requests use `HttpClient` directly with `Authorization: Bearer <jwt>`, as
`GitHubDeviceFlow.viewer` does (`packages/source-control-github/src/server/GitHubDeviceFlow.ts:261`),
with a 15 s timeout. The cache is a `Ref<Map<string, InstallationToken>>` keyed
`<sandboxId>\0<repository>`; per-sandbox keys make 1.29's revocation exact and cost one mint per
sandbox per repo per hour. A `Semaphore` per key stops two git calls from minting twice.

`GitCredentialService.answer`, in order:

1. `host` must be `github.com` (G2), else `Refused unsupported-host` ("Pushing from cloud
   supports github.com only, for now").
2. Thread: `threadId` if given, else the sandbox's `ownerThreadId`; it must have
   `sandboxId === input.sandboxId` (`ProjectionStoreV2.getThread`,
   `apps/server/src/orchestration-v2/ProjectionStore.ts:576`), else `Refused not-this-repository`.
3. Repository: the project's identity from `RepositoryIdentityResolver.resolve(project.workspaceRoot)`
   (`apps/server/src/project/RepositoryIdentityResolver.ts:30`), `owner/name`. `path` (minus
   `.git`, lower case) must equal it, or be a fork of it: one `GET /repos/{path}`, sent with the credential the
   order below picks for the project repo, whose `parent.full_name` is the project repo; cached
   per sandbox boot. Else `not-this-repository`.
4. Source: if `configured`, `tokenFor` → `Credential { username: "x-access-token", ... }`. On
   `not-installed` or `key-rejected`, log and fall through (G3).
5. Owner: `MemberGitHub.credentialFor(thread.ownerId)` (`apps/server/src/team/MemberGitHub.ts:62`)
   → `Credential { username: "x-access-token", password, expiresAt: null }`. 1.28a makes this
   also return a pasted token; this file does not change.
6. Else `Refused github-credential-missing` ("Connect GitHub to push: Settings → Team, your row").

No runner-side cache (**proposed**, G7): 06 §2's table says "runner memory cache", but owner
credentials differ per thread, and one cache on the server makes revocation one call. 06 §2's
row should say "server memory". Git asks the helper per operation; the hop is a local socket plus
one runner round trip.

**The helper and the shim.** `gitCredentialCommand.ts` reads git's `key=value` stdin; for `get`
it sends one request line to `/run/pair-runner/git-credential.sock` (the forward 1.13 opens once
per runner, not per provider session, since terminals and scripts push too) and prints
`username=`/`password=`. For `Refused` it prints `quit=1` and writes the message to stderr, so git
neither prompts nor tries another helper, and the agent reads "Connect GitHub to push". `store` and
`erase` exit 0 and do nothing. `token` mode (for the shim) resolves `owner/name` from
`git remote get-url origin` in its cwd and prints only the password. The shim:

```sh
#!/bin/sh
# infra/sandbox-image/gh-shim.sh → /usr/local/bin/gh
GH_TOKEN="$(t3 runner git-credential token --host "${GH_HOST:-github.com}")" || exit 1
export GH_TOKEN
exec /usr/bin/gh "$@"
```

**Committer.** `SandboxProcessEnvironment` sets `GIT_COMMITTER_NAME`/`_EMAIL` from the server's
`git config --global user.name`/`user.email`, read once through the local host at layer build,
falling back to `GitVcsDriver`'s checkpoint committer ("T3 Code",
`t3code@users.noreply.github.com`, `apps/server/src/vcs/GitVcsDriver.ts:924`). `GIT_AUTHOR_*`
stays per thread as today (`ProviderAdapter.ts:68`); terminals get no author (06 §5). The image's
gitconfig sets no `user.name`.

**Tests.**

- New `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.test.ts` (no existing
  file covers App JWTs): a fake `HttpClient` layer (the pattern in
  `packages/source-control-github/src/server/GitHubAppSignIn.test.ts`) and a PKCS#1 test key
  generated with `node:crypto` in the test. Cases: the JWT verifies with the public key and names
  `iss`; the mint request carries `repositories: [name]` and the three permissions and never
  `workflows`; a second call inside the window makes no request; after `TestClock.adjust(56
  minutes)` it mints again; 404 maps to `not-installed`.
- New `GitCredentialService.test.ts`, one table: App answers; App `not-installed` falls to member
  account; no App and no account → `github-credential-missing`; a thread of another sandbox →
  `not-this-repository`; `other/repo` → `not-this-repository`; a fork whose parent is the project
  → answered; `gitlab.com` → `unsupported-host`. Fakes for `GitHubAppInstallationTokens`,
  `MemberGitHub` (`apps/server/src/team/MemberGitHub.testkit.ts`) and a projection seeded with two
  sandboxes. This is the "git helper answers only the thread's remote" test 10 §4 asks for.
- `gitCredentialCommand.test.ts`: stdin parsing and `quit=1` on refusal, against an in-memory
  socket pair from `RunnerHubTesting.ts` (1.6).

**Verify.** `vp test run apps/server/src/sandbox/credentials`, `vp run check:changed`. Runtime
transcript on the PR: a Docker sandbox with the App key set runs `git push` and `gh pr view`, and
the server log shows one mint per repo per hour. Then the same with the key removed and the
owner connected.

**Reviewer checks.**

- No token is ever written to disk in the sandbox: no `credential.helper store`, no `GH_TOKEN` in
  any spawn environment (only the shim's own exec), nothing in `/etc/gitconfig` but the helper.
- `answer` never trusts `threadId` alone: the thread must be bound to the asking sandbox, which
  comes from the authenticated runner socket, never from the request.
- Permissions exclude `workflows` (06 §5), and `repositories` names exactly one repo.
- Every outcome is an `Answer`; a GitHub outage is `Refused` with a message, never a hung helper
  (15 s timeouts on both calls, under the forward's own bound).
- The key is read through `getWithSecrets`, so a 1Password reference works, and it is never
  logged (it stays `Redacted` until `createPrivateKey`).

### 1.28a `feat(server,web): push cloud threads with the owner's own GitHub when no App key is set`

Lets a member paste a GitHub token (fine-grained, or `gh auth token` output) on their own row in
Settings → Team, so their cloud threads push without a GitHub App at all (D1). Adds the contract,
the store, the two RPCs, the web row and the "Connect GitHub to push" banner. Mobile is 1.41.

- **Needs:** 1.28 (the order already asks `MemberGitHub.credentialFor`). **Unblocks:** 1.41, 1.35's
  error mapping.
- **Files:**
  - change `packages/contracts/src/team.ts`: `TeamMemberGitHub.source` (line 27).
  - change `packages/contracts/src/rpc.ts`: `WS_METHODS.teamGitHubTokenSet`/`Clear` beside
    `teamGitHubDisconnect` (line 582), two `Rpc.make`s beside `WsTeamGitHubDisconnectRpc` (line
    2066), and the group list (line 2150).
  - change `packages/contracts/src/clientRpcPermissions.ts`: both in `CLIENT_GUARDED_RPC_SCOPES`
    (line 81 pattern).
  - change `packages/contracts/src/git.ts`: `GitManagerError` (line 401) gains
    `code: Schema.optionalKey(TrimmedNonEmptyString)`, a string so later codes decode on this
    release's clients; `"github-credential-missing"` is the first.
  - add `apps/server/src/persistence/Migrations/0NN_MemberGitHubSource.ts` and register it in
    `apps/server/src/persistence/Migrations.ts` after `[87, "MemberPushDevices", ...]`.
  - change `apps/server/src/persistence/Members.ts`: `SetMemberGitHubInput` (line 65) and
    `MemberRecord` (line 17) gain `githubSource`; the select (line 131) and the update (line 191)
    carry the fourth column.
  - change `apps/server/src/team/TeamMembers.ts`: `toTeamMember` (line 84) emits `source`;
    `memberGitHubTokenSecretName`; `forgetGitHubToken` (line 242) removes both secrets.
  - change `apps/server/src/team/MemberGitHub.ts`: `setToken`, `clearToken`; `credentialFor` and
    `markDisconnected` learn the token source.
  - change `apps/server/src/ws.ts`: two handlers beside `teamGitHubDisconnect` (line 2480).
  - change `packages/client-runtime/src/state/team.ts`: `setGitHubToken`, `clearGitHubToken`
    commands (line 290 pattern).
  - add `packages/client-runtime/src/state/sandbox.ts` (or extend it if 1.37 landed):
    `cloudPushCredential`.
  - change `apps/web/src/components/team/MemberGitHub.tsx`: `OwnGitHubConnection` (line 61).
  - add `apps/web/src/components/sandbox/cloudPushBanner.tsx`; change
    `apps/web/src/components/ChatView.tsx`: one item in the banner list (line 2620).
  - change `docs/user/team.md`: "Bring your own GitHub token" (what it is used for, that agents
    in your cloud threads can read it until the git proxy, how to remove it).

**Types, services and RPCs.**

```ts
// team.ts. Absent on old servers and on a claimed-but-unproven login.
export const TeamMemberGitHub = Schema.Struct({
  login: TrimmedNonEmptyString,
  connected: Schema.Boolean,
  source: Schema.optionalKey(Schema.Literals(["app", "token"])),
});

// rpc.ts; both act only on the caller's own member and return the updated row
const WsTeamGitHubTokenSetRpc = Rpc.make(WS_METHODS.teamGitHubTokenSet, {
  payload: Schema.Struct({ token: TrimmedNonEmptyString }), // as MemberProviderAccountMutation.token
  success: TeamMember,
  error: Schema.Union([SourceControlSignInError, TeamError, EnvironmentAuthorizationError]),
});
const WsTeamGitHubTokenClearRpc = Rpc.make(WS_METHODS.teamGitHubTokenClear, {
  payload: Schema.Struct({}), success: TeamMember,
  error: Schema.Union([TeamError, EnvironmentAuthorizationError]),
});

// clientRpcPermissions.ts
  // Ownership, not a scope, limits whose token a member can set.
  [WS_METHODS.teamGitHubTokenSet]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamGitHubTokenClear]: AuthOrchestrationOperateScope,

// MemberGitHub.ts: two methods join the service
    /** Checks the token with GitHub (`GET /user`), binds its account, replaces any device-flow session. */
    readonly setToken: (memberId: MemberId, token: Redacted.Redacted<string>)
      => Effect.Effect<TeamMember, SourceControlSignInError | TeamError>;
    /** Deletes the pasted token; unbinds the account only when the token was its source. */
    readonly clearToken: (memberId: MemberId) => Effect.Effect<TeamMember, TeamError>;

// TeamMembers.ts
export const memberGitHubTokenSecretName = (memberId: MemberId) => `github-member-token-${memberId}`;
```

`setToken`: `flow.viewer("github.com", token)` (`GitHubDeviceFlow.ts:261`; needs no client ID).
`null` → `SourceControlSignInError { reason: "failed", detail: "GitHub refused that token." }`. Then
the same "already connected to <name>" check `connect` does (`MemberGitHub.ts:155`), write
`memberGitHubTokenSecretName`, remove the device-flow secret, and `team.setGitHub(memberId,
{ githubUserId, githubLogin, githubConnectedAt: now, githubSource: "token" })`. `connect` passes
`githubSource: "app"`. `credentialFor` (line 286): if the record's source is `token`, return the
stored token with no client-ID check and no refresh; otherwise today's path. `markDisconnected`
removes whichever secret the source names, and `disconnect` (line 250) removes both, so an old
client's **Disconnect** still clears a pasted token. `check` (line 329) then covers a revoked
pasted token for free. The handlers in `ws.ts`:

```ts
[WS_METHODS.teamGitHubTokenSet]: (input) =>
  memberGitHub.setToken(currentSession.memberId, Redacted.make(input.token)),
[WS_METHODS.teamGitHubTokenClear]: () => memberGitHub.clearToken(currentSession.memberId),
```

A pasted token also becomes the member's acting credential for UI pull requests on local threads
(`GitManager.ts` `actingCredentialFor`), exactly as a connected account is. That is intended: one
"your GitHub" per member.

**The credential order** is 1.28's `GitCredentialService.answer`: installation token, then
`credentialFor(thread.ownerId)` (connected account or pasted token), then
`github-credential-missing`. `sourceFor(threadId)` reports which would answer without minting.

**Clients.** `cloudPushCredential` is pure, in client-runtime so mobile (1.41) reuses it:

```ts
export function cloudPushCredential(input: {
  readonly appKeyConfigured: boolean; // settings.sourceControlHosts.github.appPrivateKey !== ""
  readonly owner: TeamMember | undefined;
}): "app" | "owner" | "missing" {
  if (input.appKeyConfigured) return "app";
  return input.owner?.github?.connected === true ? "owner" : "missing";
}
```

- `OwnGitHubConnection` stops returning null when `enabled` is false (line 76). **Connect GitHub**
  shows only when `useTeamGitHub` is true (08 §2); **Use a token instead** always shows on the
  viewer's own row and opens an inline password `Input` with **Save**; with `source: "token"` the
  subtitle reads "Using a token for @login" and the action is **Remove token**. The footer gains
  one sentence: "Agents in your cloud threads can read it." Errors use the existing `role="alert"`
  line.
- The banner (`cloudPushBanner.tsx`, a `ComposerBannerStackItem`, variant `warning`, group
  `thread`): on a thread with `sandboxId` whose `cloudPushCredential` is `missing`. The owner sees
  "Connect GitHub to push" with a link to `/settings/team`; others see "Ask <owner> to connect
  GitHub". Not dismissible: it is a state, and it goes away when the state does.
- A UI push refused for lack of a credential (1.35) fails with `GitManagerError { code:
  "github-credential-missing" }`; clients render the same copy from `code`, never from `detail`.

**Migrations.** `0NN_MemberGitHubSource` (next free id at merge, P8; proposed, see PR-list
changes), idempotent like `085_MemberGitHub.ts`:

```sql
ALTER TABLE members ADD COLUMN github_source TEXT;  -- 'app' | 'token'; NULL when unbound
UPDATE members SET github_source = 'app' WHERE github_connected_at IS NOT NULL;
```

**Tests.**

- Extend `apps/server/src/team/MemberGitHub.test.ts` (harness from `MemberGitHub.testkit.ts:26`,
  whose fake GitHub already answers `/user`): "a pasted token binds its account and serves as the
  credential without the app's client ID" (`harness({ clientId: "" })`); "a refused token binds
  nothing"; "clearing a pasted token unbinds, and clearing with a device-flow session keeps it";
  add a token row to "refuses a GitHub account another member already connected" (line 67).
- Extend `apps/server/src/auth/RpcAuthorization.test.ts` "keeps team management behind
  access:write while the member bundle reads and edits itself" (line 76): both methods are in
  `MEMBER_SCOPES` and guarded (`clientRpcRequiredScopes`).
- Extend `apps/server/src/persistence/Migrations/085_MemberGitHub.test.ts`'s pattern in a new
  `0NN_MemberGitHubSource.test.ts`: a connected row backfills `app`.
- `packages/client-runtime/src/state/sandbox.test.ts`: the three `cloudPushCredential` rows.
- Extend `packages/contracts/src/team.test.ts`: a `TeamMember` with `source` decodes under the
  previous `TeamMemberGitHub` (precedent `auth.test.ts:26`).

**Verify.** `vp test run apps/server/src/team/MemberGitHub.test.ts
apps/server/src/auth/RpcAuthorization.test.ts`, `vp run typecheck`, `vp run check:changed`.
`test-t3-app` on web and desktop with a server that has no `T3CODE_GITHUB_APP_CLIENT_ID`: paste a
test member's fine-grained token, see "Using a token for @login", start a cloud thread, push, then
**Remove token** and see the banner. Before/after captures of the member row and the banner.

**Reviewer checks.**

- The token is write-only: no RPC, stream or log returns it; `TeamMember` carries only `source`.
- Ownership is enforced on the server by `currentSession.memberId`, not by the payload (there is
  no member id in it).
- `credentialFor` for a `token` source works with `enabled === false`; a device-flow session and a
  pasted token never coexist for one member.
- Member removal deletes both secrets (`forgetGitHubToken`), so `retireOrphans` needs no change.
- Consider wrapping `source` in `ForwardCompatibleOptional` (`baseSchemas.ts`) so a later third
  source can't fail the team stream on this release's clients.

### 1.29 `feat(server): revoke sandbox credentials on stop and destroy and audit git tokens`

When a sandbox stops or is destroyed, nothing it was given keeps working: its runner token, its
threads' MCP tokens, its installation tokens. Each git credential the server hands out leaves a
thread event (never the value). Forks that share a teammate's machine say so. Its own PR because
it touches the lifecycle executors (1.5, 1.19) and the credential service (1.28) together.

- **Needs:** 1.19 (stop on settle, destroy with threads), 1.28. **Unblocks:** the M1 pass.
- **Files:**
  - add `apps/server/src/sandbox/credentials/SandboxCredentialRevocation.ts`: one function the
    executors call.
  - change `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` (from 1.5): the `sandbox.stop`
    and `sandbox.destroy` executors call it after the driver accepts.
  - change `apps/server/src/sandbox/credentials/GitHubAppInstallationTokens.ts`: `revoke`.
  - change `apps/server/src/sandbox/credentials/GitCredentialService.ts`: record each answer.
  - change `packages/contracts/src/orchestrationV2.ts`: internal command
    `sandbox.git-credential.record` in `OrchestrationV2InternalCommand` (line 3534), event
    `sandbox.git-credential.issued` in `OrchestrationV2DomainEvent`.
  - change `apps/server/src/sandbox/lifecycle/SandboxDecisions.ts`: `decideGitCredentialRecord`;
    `apps/server/src/orchestration-v2/Orchestrator.ts`: one switch arm; `ProjectionStore.ts`
    `apply`: a no-op case.
  - add `apps/web/src/components/sandbox/sharedMachineBanner.tsx`; change `ChatView.tsx` (one
    item, beside 1.28a's); `packages/client-runtime/src/state/sandbox.ts`: `sharesOtherOwnersMachine`.

**Types, services and RPCs.**

```ts
// SandboxCredentialRevocation.ts: idempotent, so the executor stays replay safe
export const revokeSandboxCredentials = Effect.fn("SandboxCredentials.revoke")(function* (input: {
  readonly sandboxId: SandboxId;
  readonly threadIds: ReadonlyArray<ThreadId>; // every attached thread, from sandbox_threads (1.3)
}) {
  yield* (yield* RunnerHub).revoke(input.sandboxId);      // closes the socket, revokes the generation's grant
  const mcp = yield* McpSessionRegistry;
  yield* Effect.forEach(input.threadIds, mcp.revokeThread, { discard: true }); // McpSessionRegistry.ts:36
  yield* (yield* GitHubAppInstallationTokens).revoke(input.sandboxId);
});

// GitHubAppInstallationTokens: forget, then DELETE /installation/token with each token as its own
// bearer; 5 s each, failures logged and ignored. Stateless 2026 tokens may ignore it (06 §5).
readonly revoke: (sandboxId: SandboxId) => Effect.Effect<void>;
```

What "revoke" means per credential:

| Credential                                | On stop                | On destroy                  | How                                                                                      |
| ----------------------------------------- | ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Runner sandbox token and socket           | Revoked                | Revoked                     | `RunnerHub.revoke` (03 §7). The next boot enrolls afresh.                                |
| MCP thread tokens                         | Revoked                | Revoked                     | `McpSessionRegistry.revokeThread` per attached thread. Waking re-issues at session open. |
| GitHub installation tokens                | Dropped and `DELETE`d  | Same                        | Per-sandbox cache (1.28), so other sandboxes keep theirs.                                |
| Owner's own GitHub token                  | Not revocable by us    | Same                        | It is the member's; it never reached the runner's memory beyond one helper answer.       |
| Provider credentials, Codex broker grants | Die with the processes | Same                        | Sleep keeps no memory (decision 10); the broker forward closes with the socket.          |
| Disks and driver snapshots                | Kept                   | Deleted by `driver.destroy` | 1.14, 1.19.                                                                              |

The executors run `driver.stop`/`driver.destroy`, then `revokeSandboxCredentials`, inside their
60 s `boundExecution` bound. Revocation runs again on a replayed effect and does nothing new.
Archiving one thread of a shared sandbox revokes that thread's MCP tokens only when its provider
session stops, as today.

**Commands, events and effects.**

```ts
// OrchestrationV2InternalCommand
Schema.Struct({
  type: Schema.Literal("sandbox.git-credential.record"),
  commandId: CommandId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  source: Schema.Literals(["app-installation", "member-account", "member-token"]),
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  expiresAt: Schema.NullOr(IsoDateTime),
});
// OrchestrationV2DomainEvent: the same fields minus commandId, as "sandbox.git-credential.issued"
```

- Sent by `GitCredentialService.answer` after a `Credential` answer, to the **asking thread's**
  stream (it is that thread's credential), through `OrchestratorV2.dispatch`
  (`Orchestrator.ts:398`). A failed dispatch is logged; the answer is not withheld.
- Deterministic id, so a cached token makes one event, not one per git call:
  `sandbox-git-credential:<sandboxId>:<generation>:<threadId>:<repository>:<expiresAt|owner>`.
- `decideGitCredentialRecord` accepts only a thread whose `sandboxId` matches; it emits the event
  and no effect. No projection changes. Old clients skip the event type
  (`OrchestrationV2UnknownThreadStreamEvent`, `orchestrationV2.ts:4023`); new clients ignore it
  in M1 (no timeline row).
- Each record also writes `Effect.logInfo("Issued a git credential", { threadId, sandboxId,
  source, repository, expiresAt })`, because events are pruned after a day (G8).

**The fork warning.** `sharesOtherOwnersMachine(thread, sandbox)` is true when the thread has a
`sandboxId` and `sandbox.ownerMemberId !== thread.ownerId`. The banner, on that thread's composer:
"This thread shares <owner>'s machine. Its agent can read the GitHub and provider credentials of
every thread there." Derived from state, so it covers every way a fork is made (web
`useTimelineRewind.ts:188`, mobile `ThreadFeed.tsx:442`, MCP, CLI) without touching the fork
commands. Variant `info`, dismissible per thread for the session. Mobile renders the same
predicate in 1.41.

**Tests.**

- Extend 1.5's sandbox effect tests (the `FakeComputeDriver` suite): "stop revokes the runner
  grant, every attached thread's MCP tokens and the sandbox's installation tokens", with
  `RunnerHub.layerTest`, a real `McpSessionRegistry` (assert `resolve` fails after, as
  `McpSessionRegistry.test.ts:37` does) and a fake `GitHubAppInstallationTokens` recording
  `revoke`. Drain the effect worker; no sleeps. One more row: a replayed `sandbox.destroy` revokes
  again without error.
- Extend `GitHubAppInstallationTokens.test.ts`: `revoke` sends `DELETE /installation/token` with
  the token and empties only that sandbox's entries; a 500 is ignored.
- Extend `GitCredentialService.test.ts`: two answers inside one token's life dispatch one
  `sandbox.git-credential.record` with the same id; the dispatched command never carries the token
  (assert on the encoded JSON).
- Orchestrator decision table in 1.5's `SandboxDecisions` tests: a record for a thread of another
  sandbox is rejected.
- `packages/client-runtime/src/state/sandbox.test.ts`: `sharesOtherOwnersMachine` rows.

**Verify.** `vp test run apps/server/src/sandbox`, `vp run typecheck` (contracts), `vp run
check:changed`. Runtime transcript: push from a Docker sandbox, sleep it, then `git fetch` from
the stopped container's last shell fails because the runner is gone and the next wake mints a new
token (log lines). `test-t3-app`: fork a teammate's cloud thread and capture the banner on web and
desktop.

**Reviewer checks.**

- No credential value reaches the event store, the log line or a span: the event has host, repo,
  permissions and expiry only.
- Revocation is idempotent and inside the executor's bound; a GitHub outage can't hold the
  thread's queue (5 s per `DELETE`, ignored).
- Revocation happens after the driver accepted, so a stop that fails leaves the sandbox usable.
- The record goes to the asking thread's stream, not the owner's, and its id dedupes cached
  answers.
- The fork banner reads only data already on the wire; no new contract field.

### 1.30 `feat(server): keep a bare checkpoint mirror per project`

Adds the mirror store: one bare repo per project on the team server, seeded from the project's
checkout, that accepts a git bundle only after checking every object in it, and is deleted with
the project. Nothing writes to it yet (1.31) or reads it (1.32). Its own PR because it is plain git
plumbing with no sandbox dependency, so it can land during M0.

- **Needs:** 0.1 (the mirror's git runs on the local host through `WorkspaceHosts.forPath`).
  **Unblocks:** 1.31, 1.32.
- **Files:**
  - add `apps/server/src/sandbox/mirror/CheckpointMirror.ts`.
  - add `apps/server/src/sandbox/mirror/CheckpointMirror.test.ts`.
  - change `apps/server/src/project/ProjectService.ts`: `deleteProject` (line 502) calls
    `mirror.remove(projectId)` after the commit, next to `clearProjectSettingsOverrides` (line 517).
  - change `apps/server/src/server.ts`: provide `CheckpointMirror.layer`.

**Types, services and RPCs.**

```ts
export class CheckpointMirrorError extends Schema.TaggedError<CheckpointMirrorError>()(
  "CheckpointMirrorError",
  {
    projectId: ProjectId,
    operation: Schema.Literals(["seed", "import", "delete-refs", "remove"]),
    reason: Schema.Literals(["missing-prerequisite", "invalid-objects", "too-large", "git"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface MirrorRefUpdate {
  readonly source: string; // the ref name inside the bundle
  readonly target: string; // where it lands in the mirror
}

export class CheckpointMirror extends Context.Service<
  CheckpointMirror,
  {
    /** `<stateDir>/sandbox/mirrors/<base64url(projectId)>.git`. Never under /t3-sandbox/. */
    readonly gitDir: (projectId: ProjectId) => string;
    /** Creates and seeds the mirror once; later calls refresh only the seed's origin refs. */
    readonly ensure: (projectId: ProjectId) => Effect.Effect<string, CheckpointMirrorError>;
    /** The oids the mirror holds for these refs; absent refs are left out. */
    readonly tips: (
      projectId: ProjectId,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, CheckpointMirrorError>;
    /** Checks every object strictly, then moves only the named refs. Others in the bundle are ignored. */
    readonly importBundle: (input: {
      readonly projectId: ProjectId;
      readonly bundlePath: string;
      readonly refs: ReadonlyArray<MirrorRefUpdate>;
    }) => Effect.Effect<ReadonlyMap<string, string>, CheckpointMirrorError>;
    readonly deleteRefs: (
      projectId: ProjectId,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<void, CheckpointMirrorError>;
    /** Deletes refs under `refs/t3/sandbox/<threadId>/`. */
    readonly deleteThreadNamespace: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<void, CheckpointMirrorError>;
    readonly remove: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/sandbox/mirror/CheckpointMirror") {}
export const layer = Layer.effect(CheckpointMirror, make);
```

Git runs through `GitVcsDriver.execute` (`apps/server/src/vcs/GitVcsDriver.ts:309`) with `cwd`
set to the bare dir; that path is outside `/t3-sandbox/`, so `forPath` picks the local host.
Writes to one mirror take a per-project `Semaphore` (as `MemberGitHub.refreshLock`). Reads take
none: git's own ref locking is enough for readers.

- **Path.** `base64url(projectId)` (as `sourceControlHostSecretName`,
  `apps/server/src/sourceControl/sourceControlHostSecrets.ts:32`), because `ProjectId` is any
  trimmed string (`packages/contracts/src/baseSchemas.ts:252`) and must not name a path. 07 §1's
  `<projectId>.git` becomes `<base64url(projectId)>.git` (**proposed**). The `sandbox/mirrors`
  folder is created `0700`.
- **Seed.** `git clone --bare --local --template= <workspaceRoot> <dir>.tmp`, then rename. That
  hardlinks objects and copies branches and tags only (07 §1). `--template=` leaves no hooks,
  so `update-ref` can't run a `reference-transaction` hook. Then a local fetch of the checkout's
  remote-tracking refs: `git fetch <workspaceRoot> '+refs/remotes/origin/*:refs/t3/seed/origin/*'`,
  repeated on each `ensure`. A sandbox's first bundle can then name the seed's
  `origin/<baseRef>` as a prerequisite, which a fresh clone from origin has (1.31). A project
  with no git checkout gets `git init --bare --template=`. No `alternates` (07 §1).
- **Import, checked (proposed: `index-pack` instead of `fetch` + `fsck`).** 07 §1 says fetch,
  then `git fsck`. Two facts change that, both re-run here on git 2.43.0: `fetch` from a bundle
  skips `fetch.fsckObjects` (a tree with a `.git` entry lands), and a full `git fsck` walks the
  whole repo on every sync and only _warns_ on `hasDotgit` without `--strict`. So `importBundle`:
  1. reads the v2 header (`# v2 git bundle`, `-<oid>` prerequisites, `<oid> <ref>` lines, a blank
     line); every prerequisite must exist (`git cat-file -e`), else `missing-prerequisite`;
  2. pipes the pack after the header into `git index-pack --strict --fix-thin --stdin` in the
     mirror. `--strict` fsck-checks only this bundle's objects and fails without keeping the pack
     ("fatal: fsck error in packed object" for the `.git` tree), so cost follows the bundle, not
     the repo; a failure is `invalid-objects`;
  3. `git update-ref --stdin` for the requested `refs` only, each to the header's oid. A ref the
     bundle carries but the caller didn't ask for is never written; nothing is pruned.
- **Size cap.** The caller enforces 512 MiB while streaming (1.31); `importBundle` refuses a
  larger file with `too-large` as a second check.
- **Remove.** `fs.remove(dir, { recursive: true })`; a missing dir is success. At layer start, a
  sweep removes mirrors whose project is deleted (a crash between the project commit and
  `remove` leaves one behind).

**Tests.** New `CheckpointMirror.test.ts` (no existing test covers bare repos); real git under
`it.effect` with `NodeServices`, set up like `apps/server/src/checkpointing/CheckpointStore.test.ts:28`.
Cases:

- seeds from a checkout with a branch, a tag and an `origin/main` tracking ref: the mirror has
  `refs/heads/*`, `refs/tags/*` and `refs/t3/seed/origin/main`, and no hooks;
- imports a bundle whose prerequisite the mirror has, writing only the requested target ref;
- refuses a bundle with a prerequisite it lacks (`missing-prerequisite`);
- refuses a bundle with a `.git` tree entry (`invalid-objects`, built with `git mktree` as above)
  and writes no ref;
- ignores a ref in the bundle that wasn't requested;
- `deleteThreadNamespace` deletes only that thread's refs; `remove` deletes the dir and is
  idempotent;
- a project id containing `/` and `..` stays inside `sandbox/mirrors`.
  Extend `apps/server/src/project/ProjectService.deletion.test.ts` "retries a partial project
  deletion without repeating child events or cleanup" (line 127) with a fake `CheckpointMirror`
  that records `remove`: called once per attempt, harmless when repeated.

**Verify.** `vp test run apps/server/src/sandbox/mirror`, `vp run check:changed`. No UI. Runtime
transcript: seed a mirror for a seeded dev project and show `du -sh` before and after (hardlinks
cost nearly nothing).

**Reviewer checks.**

- Every git command on the mirror passes `cwd` = the bare dir and runs on the local host; nothing
  is checked out, and no command reads attributes from a working tree.
- Only `index-pack --strict` admits objects; no code path calls `git fetch <bundle>`.
- Refs move only to targets the caller named; the bundle never chooses where it writes.
- The mirror dir is derived from an encoded id and lives under `stateDir`; tests prove no escape.
- Seeding is atomic (`.tmp` then rename), so a crash never leaves a half-seeded mirror in place.

### 1.31 `feat(server): pull checkpoint bundles into the mirror at capture`

After each capture in a cloud thread, the server pulls that capture's refs and the thread's branch
from the sandbox as a git bundle into the mirror, before `checkpoint.captured` commits, within 15
s. A failed or slow sync never fails the capture: a retry worker owns it. Rollback and thread
deletion drop the matching mirror refs. Its own PR because it is the one place the capture path
learns about sandboxes.

- **Needs:** 1.10 (capture runs in the runner), 1.11 (the sandbox host), 1.30. **Unblocks:**
  1.33, 1.35, M2's snapshot (2.7).
- **Files:**
  - add `apps/server/src/sandbox/mirror/MirrorSync.ts`: bundle, stream, import; and the
    `MirrorHooks` reference the upstream files call.
  - add `apps/server/src/sandbox/mirror/MirrorSyncWorker.ts`: retries, drain, startup reconcile,
    `flush(sandboxId)`.
  - change `apps/server/src/orchestration-v2/CheckpointCaptureService.ts`: one `yield*` between
    `checkpoints.capture` (line 124) and `eventSink.commitCommand` (line 136).
  - change `apps/server/src/orchestration-v2/CheckpointRollbackService.ts`: one `yield*` after
    `deleteStaleRefs` (line 293).
  - change `apps/server/src/orchestration-v2/ThreadDeletion.ts`: one effect beside
    `preview.cleanup` (line 222); its `projection` `Pick` (line 19) gains `checkpoints`.
  - change `apps/server/src/orchestration-v2/EffectOutbox.ts`: request
    `sandbox.mirror.forget-thread` in `OrchestrationEffectRequestV2` (line 105 pattern) and in
    `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS` (line 125); `EffectWorker.ts`: one case (line 519
    pattern).
  - change `apps/server/src/sandbox/lifecycle/SandboxEffects.ts` (1.5): the `sandbox.stop`
    executor calls `MirrorSyncWorker.flush(sandboxId)` before `driver.stop`.
  - change `apps/server/src/server.ts`: provide `MirrorHooks` and the worker.

**Types, services and RPCs.**

```ts
// MirrorSync.ts. A Reference with a no-op default, so the upstream capture and rollback layers
// keep their requirement lists and their tests need nothing new.
export const MirrorHooks = Context.Reference<{
  readonly afterCapture: (input: {
    readonly threadId: ThreadId;
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>; // this effect's, any status
  }) => Effect.Effect<void>;
  readonly afterRollback: (input: {
    readonly threadId: ThreadId;
    readonly scope: OrchestrationV2CheckpointScope;
    readonly deletedRefs: ReadonlyArray<CheckpointRef>;
  }) => Effect.Effect<void>;
}>("t3/sandbox/mirror/MirrorHooks", { defaultValue: () => noopHooks });

export class MirrorSyncError extends Schema.TaggedError<MirrorSyncError>()("MirrorSyncError", {
  threadId: ThreadId,
  reason: Schema.Literals(["timeout", "sandbox-unavailable", "bundle-failed", "import-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class MirrorSync extends Context.Service<
  MirrorSync,
  {
    /** Pulls these refs and the thread's branch. Fails; callers decide what a failure means. */
    readonly sync: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string; // a /t3-sandbox/<id>/ path
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<void, MirrorSyncError>;
  }
>()("t3/sandbox/mirror/MirrorSync") {}

export class MirrorSyncWorker extends Context.Service<
  MirrorSyncWorker,
  {
    readonly enqueue: (threadId: ThreadId) => Effect.Effect<void>;
    /** Syncs every pending thread of this sandbox now; bounded at 15 s; never fails. */
    readonly flush: (sandboxId: SandboxId) => Effect.Effect<void>;
    /** For tests: runs one pass over every pending thread. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/sandbox/mirror/MirrorSyncWorker") {}
```

The upstream edit in `CheckpointCaptureService.execute`:

```ts
      const checkpoint = yield* checkpoints.capture({ ... });
      // Cloud threads only; bounded and never failing, so a local capture is unchanged.
      yield* (yield* MirrorSync.MirrorHooks).afterCapture({
        threadId: input.threadId, scope,
        checkpoints: [threadStartCheckpoint, baselineCheckpoint, checkpoint].filter(isNotNull),
      });
      const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
```

The real `afterCapture`: return at once unless `scope.cwd` is under the reserved root
(`sandboxIdFromPath`, the pure prefix parse 0.1's `forPath` uses; side chats pass no ready
checkpoints, `forceMissing`). Otherwise `sync` the `ready` refs with `Effect.timeout(15
seconds)`; on any failure log it, `enqueue(threadId)`, and return. `afterRollback` calls
`mirror.deleteRefs` and, on failure, logs; a leftover ref is harmless because diffs read refs by
the names the projection holds, and rollback marks those `stale`.

`MirrorSync.sync`, in order:

1. Thread from `ProjectionStoreV2.getThread` (`projectId`, `branch`); `mirror.ensure(projectId)`.
2. Refs to carry: each checkpoint ref under its own name, and `refs/heads/<branch>` →
   `refs/t3/sandbox/<threadId>/branch` (07 §1's table).
3. Prerequisite tiers, from `mirror.tips`: (a) the scope's previous ordinal, the thread's mirror
   branch and `refs/t3/seed/origin/HEAD`; (b) the seed ref alone; (c) none. A missing
   prerequisite fails `bundle create` in the sandbox with `bad object` (07 §1), so on that
   stderr try the next tier.
4. `(yield* hosts.forPath(cwd)).spawner.spawn(git bundle create - <refs> ^<oid>...)` in `cwd`,
   streaming stdout to `<stateDir>/sandbox/tmp/<uuid>.bundle` on the local host, failing past
   512 MiB. The file is removed in a finalizer.
5. `mirror.importBundle` with the mappings from step 2.

`git bundle create` runs as a plain process on the runner (03 §4.6: no new channel). The capture
coarse op (1.10) already returned, so the workspace lock in `CheckpointService.ts:243` is not held
during the sync; side chats sharing the checkout write no refs, so nothing races the bundle.

**The worker.** A `Ref<Set<ThreadId>>` of pending threads and a scoped fiber that runs a pass
every 30 s (`Schedule.spaced`, so tests use `TestClock.adjust`). A pass, per thread: the ready
checkpoint refs from `getCheckpointContext` (`ProjectionStore.ts:705`) minus `mirror.tips`, then
`sync` with those refs; `sandbox-unavailable` (a stopped sandbox,
`WorkspaceHostUnavailableError`) keeps it pending without logging; any other failure logs and
keeps it pending. At start, the worker seeds its set with every thread attached to a sandbox not
`destroyed` (`sandbox_threads`, 1.3), so a restart loses nothing. `flush(sandboxId)` runs a pass
for that sandbox's threads under its own 15 s bound; `sandbox.stop` calls it first, so a sandbox
rarely stops with unsynced checkpoints. Once an hour per mirror, after a successful pass, it runs
`git maintenance run --auto` there (07 §9).

**Commands, events and effects.** No new command or event: the sync happens inside the
`checkpoint.capture` effect, before the commit that writes `checkpoint.captured` and the completed
run. That effect has no bound in `boundExecution` (`EffectWorker.ts:585`); the sync carries its
own 15 s. One new effect on deletion:

```ts
// EffectOutbox.ts
(Schema.Struct({
  type: Schema.Literal("sandbox.mirror.forget-thread"),
  projectId: ProjectId,
  checkpointRefs: Schema.Array(CheckpointRef),
}),
  // ThreadDeletion.ts, only when projection.thread.sandboxId is set
  effects.push({
    id: `effect:${command.commandId}:sandbox.mirror.forget-thread`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "sandbox.mirror.forget-thread",
      projectId: projection.thread.projectId,
      checkpointRefs: projection.checkpoints.map((checkpoint) => checkpoint.ref),
    },
  }));
```

The executor calls `mirror.deleteRefs` and `mirror.deleteThreadNamespace`. Both are idempotent, so
the type joins the replay-safe list. This is 07 §9's "Delete: mirror refs deleted now"; 1.19 keeps
destroying the sandbox itself.

**Not here: the head-context record (PR-list change).** 07 §3's record of what `branchPullRequest`
reads serves discovery of a _sleeping_ thread. In M1 a Docker sandbox stops only when every
attached thread is settled or archived; the minute sweep reads unsettled threads only
(`ThreadPullRequestService.ts:158-163`), and 1.33 makes the per-thread refresh and the settled
backfill skip a stopped thread. It moves to 2.9 with the reader. No `090_SandboxMirror` table.

**Tests.**

- Extend `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` beside "completes a
  side chat run with a missing checkpoint and never touches git" (line 723), with a recording
  `MirrorHooks`: the hook receives this effect's checkpoints and runs before the commit (it sees
  no `checkpoint.captured` row yet); a retried capture of a completed run skips the hook (the
  idempotency guard, lines 74-80), which is why the worker exists.
- New `apps/server/src/sandbox/mirror/MirrorSync.test.ts` on the loopback host
  (`WorkspaceHostTesting.layerLoopback`, 1.11) over two real repos (a "sandbox" clone and a
  seeded mirror): first sync carries only new objects when the seed prerequisite exists; a
  missing prerequisite falls back a tier (07 §10 #3); refs outside the request are ignored; the
  branch lands under `refs/t3/sandbox/<threadId>/branch`; the 512 MiB cap (set low in the test)
  fails as `bundle-failed` and leaves no temp file.
- New `MirrorSyncWorker.test.ts`: a failed sync is retried after `TestClock.adjust(30 seconds)`
  and leaves the set; `sandbox-unavailable` stays pending; `flush` syncs only that sandbox;
  startup seeding from a fake `sandbox_threads` reader. All waits are `drain` or `TestClock`.
- Extend `CheckpointRollbackService.test.ts` (the describe holding line 638): a rollback with
  stale checkpoints calls `afterRollback` with exactly their refs (07 §10 #3, "a rollback
  prunes").
- Extend `apps/server/src/orchestration-v2/ThreadDeletion.test.ts` "queues provider and resource
  cleanup and preserves an earlier deletion timestamp" (line 228): a thread with `sandboxId`
  queues `sandbox.mirror.forget-thread` with its refs; the existing local case queues none.

**Verify.** `vp test run apps/server/src/sandbox/mirror
apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts
apps/server/src/orchestration-v2/CheckpointRollbackService.test.ts`, `vp run check:changed`.
Runtime transcript: ten Replay turns in a Docker cloud thread, with the sync's p50 and p95 from
its span (`MirrorSync.sync`), which 10 §4 uses to decide whether the sync moves after commit.

**Reviewer checks.**

- A local or worktree capture runs no new code beyond a string prefix check (no projection read,
  no git).
- The sync can't fail or stall the capture: 15 s bound, all errors caught, the worker takes over.
- The server picks every ref name; the sandbox only produces bytes (06 §7), and imports go through
  1.30's strict check.
- `sandbox.stop` flushes before stopping, so a settled thread's last diff is in the mirror.
- The new effect type is idempotent and on the replay-safe list; no other effect type changes.

### 1.32 `feat(server): read cloud thread diffs from the mirror`

Turn and full-thread diffs of a cloud thread read the project's mirror, never the sandbox, so they
work while the machine is stopped and cost no runner round trips (07 open question 2). If the
mirror lacks a ref because a sync is still pending, the reader falls back to the sandbox when it is
up. Its own PR because the reader is independent of the sync and can land first (07 §1).

- **Needs:** 1.30. Lands before 1.31; until then no cloud thread exists, and tests seed the
  mirror themselves. **Unblocks:** 1.33.
- **Files:**
  - add `apps/server/src/sandbox/mirror/MirrorCheckpointReader.ts`.
  - change `apps/server/src/checkpointing/CheckpointDiffQuery.ts`: `getTurnDiff` (line 89)
    picks its reader once, and the three `checkpointStore.` calls (lines 212, 218, 229) use it.
  - change `apps/server/src/server.ts`: provide `MirrorCheckpointReader.layer`, which sets the
    `CheckpointDiffPlacement` reference (G11).

**Types, services and RPCs.**

```ts
/** The two CheckpointStore reads a diff needs; cwd is the scope's, and a mirror reader ignores it. */
export type CheckpointDiffReader = Pick<
  CheckpointStore.CheckpointStore["Service"],
  "diffCheckpoints" | "listAuthoredPaths"
>;

/** None means "read where the thread's files are", today's behavior. Default: always None. */
export interface CheckpointDiffPlacementShape {
  readonly readerFor: (threadId: ThreadId) => Effect.Effect<Option.Option<CheckpointDiffReader>>;
}
export const CheckpointDiffPlacement = Context.Reference<CheckpointDiffPlacementShape>(
  "t3/sandbox/mirror/CheckpointDiffPlacement",
  { defaultValue: () => ({ readerFor: () => Effect.succeedNone }) },
);

// MirrorCheckpointReader.ts: builds the real placement; server.ts provides it as the Reference.
export const makeMirrorDiffPlacement: Effect.Effect<
  CheckpointDiffPlacementShape,
  never,
  CheckpointMirror | ProjectionStoreV2 | CheckpointStore.CheckpointStore | ChildProcessSpawner
> = Effect.gen(function* () {
  /* readerFor below */
});
export const layer = Layer.effect(CheckpointDiffPlacement, makeMirrorDiffPlacement);
```

The upstream edit:

```ts
      // Cloud threads read the mirror; everything else reads the scope's checkout.
      const reader = Option.getOrElse(
        yield* (yield* CheckpointDiffPlacement).readerFor(input.threadId),
        () => checkpointStore,
      );
      const authoredPaths = yield* reader.listAuthoredPaths(comparison).pipe(...);
```

`readerFor`: the thread from `ProjectionStoreV2.getThread`; no `sandboxId` → `None`. With one
(07 §1's rule: placement from where the thread runs now, not from `scope.cwd`), return a reader
over the mirror:

- It builds its own git checkpoint ops once with `GitVcsDriver.makeVcsDriverShape()`
  (`apps/server/src/vcs/GitVcsDriver.ts:568`) and calls `checkpoints.diffCheckpoints` and
  `checkpoints.listAuthoredPaths` with `cwd: mirror.gitDir(projectId)`, skipping
  `VcsDriverRegistry`, whose `rev-parse --is-inside-work-tree` fails in a bare repo (07 §1:
  `git -C <bare>` works for both, tested on git 2.43).
- Before the first read of a call, `mirror.tips(projectId, [from, to])`. If either ref is missing
  (a pending sync), delegate that call to `checkpointStore` with the original `cwd`, which reaches
  the sandbox when it is up and fails with `WorkspaceHostUnavailableError` when it is not; the
  existing `Effect.orElseSucceed` around `listAuthoredPaths` and the `CheckpointRefUnavailableError`
  path then apply. The diff panel shows its existing "unavailable" state, which is honest.

The diff code itself is unchanged: same refs, same budget, same batching, and
`--no-ext-diff --no-textconv` already on every diff (`GitVcsDriverCore.ts:90`), so the server's
global git config adds no driver to mirror reads.

**Tests.**

- Extend `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts` with a sibling of "shares the
  turn and full-thread diff budget across real Git batches" (line 203): the same repo and refs,
  then `git clone --bare` into a mirror dir, a placement that returns the mirror reader, and a
  scope `cwd` of `/t3-sandbox/sbx_…/worktrees/x` that does not exist. The turn and full-thread
  diffs equal the working-tree ones. This is the lowest layer that fails on `main`.
- Same file, with `layerFor`'s mocks (line 50): a placement whose mirror lacks the `to` ref
  delegates to the mocked `CheckpointStore` with the scope's `cwd`.
- No new `VcsDriverRegistry` test: skipping it is the point, and the bare-repo case above proves
  the driver works without it.

**Verify.** `vp test run apps/server/src/checkpointing/CheckpointDiffQuery.test.ts
apps/server/src/sandbox/mirror`, `vp run check:changed`. Runtime transcript after 1.31: open a
cloud thread's diff with the sandbox running, then stop it (`sandbox.sleep`) and open it again;
the span `getTurnDiff` shows no runner call in either.

**Reviewer checks.**

- Local and worktree threads take the `None` path: one projection read, then today's code
  unchanged (the existing tests pass untouched).
- Placement comes from the thread's `sandboxId`, never from `scope.cwd`, so M4's moves need no
  change here.
- The mirror reader never writes and never runs a command that reads a working tree.
- The fallback only fires on a missing ref, not on any git error, so a corrupt mirror doesn't
  silently wake or hammer a sandbox.

### 1.33 `feat(server): read stopped cloud threads from the mirror and refuse their writes`

A Docker sandbox stops in M1 once its threads are settled or archived (1.19). While it is
stopped, its threads' files, file search and folder browsing read the mirror's latest checkpoint,
labeled "As of turn N"; writes are refused with a typed error that new clients turn into **Wake**;
terminals keep their history and show exited; status polling and PR discovery leave the thread
alone. Nothing here wakes a sandbox (wake on read is M2). Live files and terminals are 1.10 and
1.11.

- **Needs:** 1.11 (an unregistered sandbox root fails with `WorkspaceHostUnavailableError`, P6),
  1.32, and 1.31 for real data. **Unblocks:** 2.8 (asleep reads swap the checkpoint for the
  sleep snapshot).
- **Files:**
  - add `apps/server/src/sandbox/mirror/StoppedSandboxReads.ts`: the read-only view.
  - change `packages/contracts/src/sandbox.ts` (from 1.2): `SandboxAsleep` (G6).
  - change `packages/contracts/src/project.ts`: `ProjectWriteFileError` (line 549) gains
    `sandboxId: Schema.optionalKey(SandboxId)`.
  - change `apps/server/src/workspace/WorkspaceEntries.ts` (`browse`, `list`, `search`,
    `searchContents`, `listIgnoredFiles`, line 99) and `WorkspaceFileSystem.ts` (`readFile`,
    `writeFile`, `getMetadata`, line 114): one `catchTag` each where the host is resolved.
  - change `apps/server/src/terminal/Manager.ts`: the open and `restartIfNotRunning` paths (line 3002) return the existing exited snapshot instead of spawning on a stopped sandbox.
  - change `apps/server/src/vcs/VcsStatusBroadcaster.ts` (line 607) and
    `apps/server/src/orchestration-v2/ThreadPullRequestService.ts` (the group loop, line 170):
    `WorkspaceHostUnavailableError` keeps the last result, logs nothing, and isn't a failure.
  - change `apps/server/src/ws.ts`: `projectsWriteFile` (line 3134) maps `SandboxAsleep` to
    `ProjectWriteFileError { failure: "operation_failed", sandboxId, message }`.
  - change web: `apps/web/src/components/sandbox/stoppedFilesNotice.tsx` (the "As of turn N" line
    and **Wake** in the file editor and the files panel header).

**Types, services and RPCs.**

```ts
// packages/contracts/src/sandbox.ts
export class SandboxAsleep extends Schema.TaggedError<SandboxAsleep>()("SandboxAsleep", {
  sandboxId: SandboxId,
  state: SandboxState,
}) {
  override get message() {
    return "This machine is stopped. Wake it to make changes.";
  }
}

// StoppedSandboxReads.ts
export interface StoppedView {
  readonly sandboxId: SandboxId;
  readonly threadId: ThreadId; // whose checkpoint backs the view
  readonly turn: number; // appRunOrdinal of that checkpoint, for "As of turn N"
  readonly commit: string; // the checkpoint's oid in the mirror
  readonly gitDir: string; // the mirror
  readonly prefix: string; // cwd relative to the checkout root ("" for the root)
}

export class StoppedSandboxReads extends Context.Service<
  StoppedSandboxReads,
  {
    /** The view for a cwd under /t3-sandbox/<id>/; fails with SandboxAsleep when none exists. */
    readonly viewFor: (
      cwd: string,
      sandboxId: SandboxId,
    ) => Effect.Effect<StoppedView, SandboxAsleep>;
    readonly list: (
      view: StoppedView,
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      view: StoppedView,
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      view: StoppedView,
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly browse: (
      view: StoppedView,
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly readFile: (
      view: StoppedView,
      input: ProjectReadFileInput,
    ) => Effect.Effect<ProjectReadFileResult, WorkspaceFileSystemError>;
  }
>()("t3/sandbox/mirror/StoppedSandboxReads") {}
```

The pattern in each upstream method (shown for `readFile`; `localReadFile` is today's body):

```ts
const readFile: WorkspaceFileSystem["Service"]["readFile"] = (input) =>
  localReadFile(input).pipe(
    Effect.catchTag("WorkspaceHostUnavailableError", (error) =>
      stopped
        .viewFor(input.cwd, error.sandboxId)
        .pipe(Effect.flatMap((view) => stopped.readFile(view, input))),
    ),
  );
```

A local `cwd` never fails `forPath` that way, so local reads run no new code. `writeFile` always answers `SandboxAsleep`.

`viewFor`: `sandboxId` → its attached threads (`sandbox_threads`, 1.3) whose `worktreePath`
contains `cwd`; among their `ready` checkpoints (`getCheckpointContext`,
`ProjectionStore.ts:705`) the newest by `capturedAt` whose ref the mirror holds (`mirror.tips`).
None (no capture yet, or every sync pending) → `SandboxAsleep`, which reads become an empty,
labeled result rather than an error (below). The view is recomputed per call; it is a few
SQLite reads and one local `for-each-ref`.

What each read does (07 §6's table, with the checkpoint in place of the sleep snapshot):

| Read                       | Stopped implementation                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| List a folder, name search | `git ls-tree -r -z --name-only <commit> -- <prefix>`, filtered in memory, capped at 25,000 like `WorkspaceSearchIndex` |
| Read a file                | `git cat-file blob <commit>:<prefix><path>`, with `readFile`'s byte cap and binary check                               |
| Content search             | `git grep -z --max-count=100 [-i] [-w] [-E                                                                             | -F] -e <query> <commit> -- <prefix>`, within the 250 ms budget |
| Browse folders             | `git ls-tree -z <commit>:<dir>`, directories only                                                                      |
| Ignored files              | Empty: the checkpoint follows `.gitignore`                                                                             |
| Write                      | `SandboxAsleep` → `ProjectWriteFileError { failure: "operation_failed", sandboxId }`                                   |

All run with `cwd` = the mirror, on the local host. Paths from the client are joined to `prefix`
and checked with `WorkspacePaths` rules first, so `..` can't leave the tree; git object paths
can't reach the server's disk anyway.

**The label.** No new result field. Clients already have the thread's checkpoints in thread
detail and the sandbox state in the shell summary, so the web notice derives "As of turn N" from
the thread's newest ready checkpoint (G5), the same one the server reads. On mobile, 1.41 shows the
same line. An old client sees the files with no label; its write fails with a message it already
renders.

**Terminals.** When a sandbox stops, the runner drains and every PTY handle fails (1.10/1.11), so
the manager already marks sessions `exited` with their history. 1.33 changes only the two spawn
paths: on `WorkspaceHostUnavailableError`, an existing session returns its snapshot unchanged and
a new terminal fails with `TerminalNotRunningError` (an existing error clients render). The
`stoppedBy` field and the wake divider are 2.8.

**Tests.**

- New `apps/server/src/sandbox/mirror/StoppedSandboxReads.test.ts` over a real mirror with a
  checkpoint ref (built as in 1.32's test): list, name search, read (including a binary file and
  the byte cap), content search, browse; a path with `..` is refused; a sandbox with no synced
  checkpoint yields `SandboxAsleep`; with two threads sharing the checkout, the newest checkpoint
  wins. No sandbox host: a `WorkspaceHosts` fake whose `forPath` fails for `/t3-sandbox/`.
- Extend `apps/server/src/workspace/WorkspaceFileSystem.test.ts` with one case: a `writeFile`
  under an unavailable sandbox root fails with `SandboxAsleep` and touches no disk; and
  `WorkspaceEntries.test.ts` with one `list` case served by a fake `StoppedSandboxReads`. These
  prove the catch points; the git behavior is tested once, above.
- Extend `apps/server/src/terminal/Manager.test.ts` with one case: `open` with
  `restartIfNotRunning` on an unavailable host returns the exited snapshot.
- Extend `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` with one case: an unavailable host
  keeps the last status and does not count as a failure.

**Verify.** `vp test run apps/server/src/sandbox/mirror apps/server/src/workspace
apps/server/src/terminal/Manager.test.ts`, `vp run typecheck`, `vp run check:changed`.
`test-t3-app` on web and desktop with a Docker cloud thread: settle it so the machine stops, open
a file (label shows), search, try to save (refused, **Wake** offered), open the terminal
(history, exited). Before/after captures of the file panel and the editor notice.

**Reviewer checks.**

- No read path wakes or starts a sandbox, and no write is ever queued for later.
- Local and worktree paths never reach `StoppedSandboxReads` (only a `/t3-sandbox/` path can fail
  `forPath` that way).
- The checkpoint chosen is the one the label names, and both come from `ready` checkpoints only.
- New contract keys are optional and new literals appear nowhere; old clients decode every result
  and error.
- Status and PR discovery treat a stopped sandbox as "no news", not as a failure that backs off
  or logs every minute.

### 1.34 `feat(server): stage attachments into the sandbox`

Before a cloud thread's turn or steer reaches the provider, the server copies the message's
attachments (and their extracted `.txt`) into the sandbox, and Claude and Codex name the sandbox
paths in the prompt. Image bytes are still read on the server and sent inline (07 §6). Its own PR
because it touches the turn-start path and both adapters' prompt builders, nothing else.

- **Needs:** 1.12 (session host in the adapters). **Unblocks:** the M1 "attachments in cloud"
  check (10 §4).
- **Files:**
  - add `apps/server/src/sandbox/attachments/SandboxAttachments.ts`: `sandboxAttachmentPath` and
    the `SandboxAttachmentStaging` service.
  - change `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` `start` (:343): after the
    message is found and `resolvedRuntimePolicy` is known, before the session's `startTurn`, call
    `staging.stage({ cwd: resolvedRuntimePolicy.cwd, attachments: message.attachments })`.
  - change `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` `steer`, before
    `steerTurn` (:388): the same call. (Steering carries attachments, :395.)
  - change `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`:
    `makeClaudeUserMessageWithAttachments` (:2538) gains an optional `promptAttachmentPath`
    used only by `providerMessageTextWithAttachmentPaths` (:2562-2570); byte reads of images and
    PDFs (:2610, :2653) keep `resolveAttachmentPath` on `attachmentsDir`. Its two callers
    (:11102, :11552) pass it when the session host is a sandbox. `makeClaudeQueryOptions` at
    :10853 gets `attachmentsDir: /t3-sandbox/<id>/attachments` on sandbox hosts, so
    `additionalDirectories` (:1901) names the sandbox folder.
  - change `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` `toCodexInput`
    (:3319-3331): the text line uses the sandbox path on sandbox hosts; `resolveCodexAttachment`
    (:3288, data URLs) is unchanged.

**Types, services and RPCs.**

```ts
// sandbox/attachments/SandboxAttachments.ts
/** /t3-sandbox/<id>/attachments/<thread segment>/<id><ext> (P1). Null when the server path is. */
export const sandboxAttachmentPath = (
  sandboxId: string,
  attachment: ChatAttachment,
): string | null => {
  const relative = attachmentRelativePath(attachment); // attachmentStore.ts:150
  const segment = parseThreadSegmentFromAttachmentId(attachment.id); // attachmentStore.ts:119
  return relative === null || segment === null
    ? null
    : `${SANDBOX_ROOT}/${sandboxId}/attachments/${segment}/${relative}`;
};

export class SandboxAttachmentStagingError extends Schema.TaggedError<SandboxAttachmentStagingError>()(
  "SandboxAttachmentStagingError",
  { attachmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not copy an attachment to the machine. Retry the message.";
  }
}

export class SandboxAttachmentStaging extends Context.Service<
  SandboxAttachmentStaging,
  {
    readonly stage: (input: {
      readonly cwd: string | null;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) => Effect.Effect<void, SandboxAttachmentStagingError | WorkspaceHostUnavailableError>;
  }
>()("t3/sandbox/SandboxAttachmentStaging") {}
```

`stage` returns at once when `cwd` is null, there are no attachments, or `hosts.forPath(cwd)` is
local, so local turns pay one prefix test. Otherwise, per attachment with a saved file: the source
is `resolveAttachmentPath({ attachmentsDir, attachment })` on the server, the target
`sandboxAttachmentPath(host.id, attachment)`; the extracted text follows when
`DocumentText.resolveExtractedTextPath(source)` finds `<source>.txt`. Idempotent: `host.fileSystem
.stat(target)` with the same size as the server file skips the copy (the file name is the
attachment id, so id and size both match). Copies run with concurrency 4, through
`host.fileSystem.makeDirectory(dir, { recursive: true })` once per segment and an atomic
`writeFile` (1.11 chunks large files over `fs.writeStream`), so a partial copy never passes the
size check. The runner writes as root with mode 0644 under a 0755 folder; the agent user only reads.

Prompt paths: the sandbox branch passes `promptAttachmentPath = (a) => sandboxAttachmentPath(host.id,
a)` and a `resolveExtractedTextPath` that checks the server copy by basename (`<attachmentsDir>/
<basename>.txt`) and answers `<sandbox path>.txt`, because the default would look for the sandbox
path on the server's disk.

Cleanup: copies live on the sandbox disk and go with it at destroy (1.19). The server's
`attachment.cleanup` effect is unchanged.

**Commands, events and effects.** None new. Staging runs inside the existing `provider-turn.start`
and `provider-turn.steer` effects, before the provider call, and is safe to repeat on a retried
effect (the size check).

**Tests.**

- `orchestration-v2/ProviderTurnStartService.test.ts`: one case on a loopback host (via
  `ProviderTurnStartService.testkit.ts`) with an image and a PDF that has extracted text: after the
  worker drains, the fake session's `startTurn` saw the turn and all three files exist under
  `<root>/attachments/<segment>/`; starting the run again (a retried effect) writes nothing (the
  recording host counts zero `writeFile`).
- `orchestration-v2/ProviderTurnControlService.test.ts`: the steer case stages before `steerTurn`
  (one assertion added to the existing steer case).
- `orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` and `CodexAdapterV2.test.ts`: on a sandbox
  host the prompt text names the sandbox path and its `.txt`; Claude's `additionalDirectories`
  holds the sandbox attachments folder; image blocks are unchanged.

**Verify.** `vp test run apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts
apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`, `vp run check:changed`.
Runtime transcript: a cloud thread on a dev server, a PDF and a screenshot attached, the agent runs
`ls -l` on the named paths and reads the PDF's text (one Haiku turn).

**Reviewer checks.**

- Local turns and local adapters are unchanged (one prefix test in `stage`).
- Every server write of an attachment goes through `hosts.forPath` on a `/t3-sandbox/` path,
  never `$HOME` in the sandbox (P1).
- Byte reads for inline images and PDFs still use the server's `attachmentsDir`.
- A retried effect does not copy again; a partial copy cannot pass the size check.
- Staging runs before the provider call on both the start and the steer paths.

### 1.35 `feat(server): push and open GitHub PRs from cloud threads`

**Commit, push & create PR** works on a cloud thread: git runs in the sandbox, the push
authenticates through 1.28's helper as the thread it is for, and the forge calls run on the server.
A push with no credential, or to a host other than GitHub, fails before git runs, with a code
clients render. Its own PR because it is the one change to `GitManager`'s push path, and it proves
the M1 exit criterion.

- **Needs:** 1.28 (and 1.28a for the `code` field), 1.31. **Unblocks:** the M1 pass.
- **Files:**
  - add `apps/server/src/sandbox/credentials/SandboxGitHooks.ts`: the push hook.
  - change `apps/server/src/git/GitManager.ts`: `pushCurrentBranch` (line 824) asks the hook
    first and passes its env; `runStackedAction` (line 3416) passes `input.threadId`.
  - change `apps/server/src/vcs/GitVcsDriver.ts` `pushCurrentBranch` (line 331) and its core:
    `options.env`, passed to `execute` (`ExecuteGitInput.env` exists, line 53).
  - change `apps/server/src/server.ts`: provide the hook.

**What runs where** (07 §3, settled against the code):

| Step                         | Where                                                              | Code                                                                                         |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Commit                       | Sandbox, through the host (0.3)                                    | `GitManager.runStackedAction`                                                                |
| Push                         | Sandbox; credential from the server over the forward               | `GitVcsDriver.pushCurrentBranch` with `T3CODE_THREAD_ID`                                     |
| Record the branch base       | Sandbox (`git config` in `cwd`)                                    | `shareBranchBase` → `recordBranchBase`                                                       |
| PR text                      | Git reads in the sandbox, generation on the server                 | `readRangeContext`, `textGeneration.generatePrContent`                                       |
| Body file                    | Server temp dir, written and read by the server's own `FileSystem` | `runPrStep.create` (line 2448), `GitHubSourceControlProvider.createChangeRequest` (line 964) |
| Repository identity          | `git remote -v` in the sandbox                                     | `resolveRepository` (`GitHubSourceControlProvider.ts:475`)                                   |
| Create the PR                | Server REST, as the clicking member or the server, as today        | `actingCredentialFor`                                                                        |
| Agent's `gh pr create`       | Sandbox, through the `gh` shim                                     | 1.28                                                                                         |
| Discovery and linking, awake | Sandbox git plus the forge                                         | `branchPullRequest`, unchanged                                                               |
| Discovery, stopped           | Skipped; last link kept                                            | 1.33                                                                                         |

**Types, services and RPCs.**

```ts
// SandboxGitHooks.ts. Default: local paths pass through with no env, so local pushes are unchanged.
export const SandboxGitHooks = Context.Reference<{
  /** Fails before git runs when a cloud push can't authenticate; else the env git needs. */
  readonly preparePush: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId | undefined;
  }) => Effect.Effect<NodeJS.ProcessEnv, GitManagerError>;
}>("t3/sandbox/credentials/SandboxGitHooks", { defaultValue: () => passThrough });

// The real one: only for a /t3-sandbox/ cwd.
//   threadId absent → the thread whose worktreePath is cwd (GitManager callers without one).
//   GitCredentialService.sourceFor(threadId):
//     None, project remote on github.com → GitManagerError { code: "github-credential-missing",
//        detail: "Connect GitHub to push: Settings → Team, your row." }
//     None, another host                 → GitManagerError { code: "cloud-push-unsupported-host",
//        detail: "Pushing from cloud supports GitHub until a later release." }
//     Some                               → { T3CODE_THREAD_ID: threadId }
```

The upstream edit:

```ts
  const pushCurrentBranch = Effect.fn("GitManager.pushCurrentBranch")(function* (
    cwd: string, branch: string | null, threadId?: ThreadId,
  ) {
    const env = yield* (yield* SandboxGitHooks).preparePush({ cwd, threadId });
    const result = yield* gitCore.pushCurrentBranch(cwd, branch, { env });
```

`T3CODE_THREAD_ID` makes the helper answer for _this_ thread (G1), so a fork owned by another member
pushes with its own owner's credential even though it shares the sandbox. Without it the helper
would fall back to the sandbox's owning thread.

**1.28a's `code` field, made forward compatible.** `GitManagerError.code` is
`Schema.optionalKey(TrimmedNonEmptyString)`, not a literal union, so this PR's second code (and any
later one) decodes on clients that know only the first. Clients map known codes to copy and show
`detail` otherwise. 1.28a should declare it that way.

**No branch sync after push (PR-list change).** 07 §3 syncs the branch ref to the mirror after a
push. A push doesn't move the local branch, and 1.31 already syncs it at every capture; the only
reader of a fresher mirror branch is 2.9's head context. It moves there.

**Tests.**

- Extend `apps/server/src/git/GitManager.test.ts` beside "creates feature branch, commits, and
  pushes with featureBranch option" (line 3201): with a `SandboxGitHooks` that fails with
  `github-credential-missing`, the action fails with that code and no `git push` runs (the test's
  recorded git calls); with a hook that returns `{ T3CODE_THREAD_ID }`, the push call carries it.
- Same file, beside "create_pr targets the remote default branch when it is not main" (line 3662):
  under `WorkspaceHostTesting.layerRecording` (0.1) with the worktree under a registered sandbox
  root (`layerLoopback`, 1.11), assert `remote -v`, `push` and `readRangeContext`'s git ran on the
  sandbox host, the body file was written and read on the local host, and the REST create ran on
  the server. This is 07 §10 #9's "PR creation runs on the server with git reads from the sandbox".
- New `SandboxGitHooks.test.ts`: the three `sourceFor` outcomes and a local cwd passing through
  without a projection read.
- Extend `GitVcsDriver.test.ts`'s push case: `options.env` reaches the process.

**Verify.** `vp test run apps/server/src/git/GitManager.test.ts
apps/server/src/sandbox/credentials`, `vp run check:changed`. `test-t3-app`, the M1 integrated pass
(10 §4): on web and desktop with Docker, run a Replay turn that edits a file, then **Commit, push &
create PR** to the test repo, once with the App key (the PR's commits show the App's bot as
pusher) and once with only a member's pasted token; then remove the token and see "Connect GitHub
to push". Captures of the PR result and the refusal. Mobile's PR action is the same RPC and needs
no change; 1.41 renders the code.

**Reviewer checks.**

- Local and worktree pushes run the default hook: no env added, no projection read, bit for bit
  as before.
- The body file never goes through `forPath`: both writer and reader use the server's own
  `FileSystem`, or a sandbox cwd would send it to the wrong machine.
- The refusal happens before `git push`, so git never prompts and the user gets the code, not
  stderr.
- `T3CODE_THREAD_ID` is set only on the push; the server still checks the thread is bound to the
  asking sandbox (1.28), so the variable grants nothing by itself.
- PR creation keeps today's acting-credential order; nothing here makes the server's own sign-in
  push code (D1: "No server-login fallback" is about git, and git never sees it).

### 1.36 `feat(contracts,server): add ServerSettings.sandbox driver instances and the project sandboxAllowed, defaultsToCloud and sandboxEnv overrides`

Makes the one setting that gates Cloud on every client exist, with its project overrides, stored
and redacted like provider settings. Its own PR because the driver service (1.4), Settings → Cloud
(1.40) and `cloudAvailability` (1.37) all read it, and nothing else changes on the wire.

- **Needs:** 1.2 (`ComputeDriverId`, `SandboxSize`). **Unblocks:** 1.4, 1.37, 1.40, 1.25 (env layers).
- **Files:**
  - change `packages/contracts/src/settings.ts`: new schemas above `ServerSettings`; `sandbox` on
    `ServerSettings` (after `secretProviders`, ~1369) and on `ServerSettingsPatch` (~1718); three
    project keys on `ProjectSettingsOverrides` (1065) and its `satisfies` clause (1095).
  - change `packages/shared/src/serverSettings.ts`: `applyServerSettingsPatch` (368) pulls
    `sandbox` out of `patchForMerge` and merges drivers by id, as `usageLimitSources` is merged.
  - change `apps/server/src/settingsSecrets.ts`: `mapSecretFieldGroups` (152) and `mapSettingsSecrets`
    (71) walk `sandbox.env` and each project's `sandboxEnv` as `kind: "environment"` groups.
  - tests: `packages/contracts/src/settings.test.ts`, `packages/shared/src/serverSettings.test.ts`,
    `apps/server/src/serverSettings.test.ts`.

**Types, services and RPCs.**

```ts
// settings.ts
export const DockerSandboxDriver = Schema.Struct({
  kind: Schema.Literal("docker"),
  id: ComputeDriverId,
  label: TrimmedNonEmptyString,
  dockerHost: Schema.optionalKey(TrimmedNonEmptyString),  // absent: the local socket
  runnerUrl: Schema.optionalKey(TrimmedNonEmptyString),   // required by 1.4's validation for a remote dockerHost
  size: Schema.optionalKey(SandboxSize),
});
// M5 adds aws-ec2 and gce members. Old clients must not fail the whole settings snapshot on them.
export const SandboxDriverInstance = Schema.Union([DockerSandboxDriver]);

export const SandboxSettings = Schema.Struct({
  drivers: ForwardCompatibleArray(SandboxDriverInstance),
  defaultDriverId: Schema.optionalKey(ComputeDriverId),
  baseImage: Schema.optionalKey(TrimmedNonEmptyString),   // D6 override
  env: Schema.optionalKey(ProviderInstanceEnvironment),   // team layer (06 §6)
});

// ServerSettings: absent until an admin adds a driver. No decoding default, so DEFAULT_SERVER_SETTINGS has no key.
sandbox: Schema.optionalKey(SandboxSettings),

// ServerSettingsPatch: null removes Cloud; drivers merge per id, null removes one (old admin
// clients that dropped an unknown kind cannot delete it by re-sending the array).
sandbox: Schema.optionalKey(Schema.NullOr(Schema.Struct({
  drivers: Schema.optionalKey(Schema.Record(ComputeDriverId, Schema.NullOr(SandboxDriverInstance))),
  defaultDriverId: Schema.optionalKey(Schema.NullOr(ComputeDriverId)),
  baseImage: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  env: Schema.optionalKey(ProviderInstanceEnvironment),   // whole list, as provider env is
}))),

// ProjectSettingsOverrides: project-only keys with no same-named ServerSettings key (proposed)
sandboxAllowed: Schema.optionalKey(Schema.Boolean),     // absent = allowed
defaultsToCloud: Schema.optionalKey(Schema.Boolean),    // absent = false (D4)
sandboxEnv: Schema.optionalKey(ProviderInstanceEnvironment),
} satisfies Record<
  ProjectScopedServerSettingKey | "providerInstances" | "sandboxAllowed" | "defaultsToCloud" | "sandboxEnv",
  unknown
>);
```

`PROJECT_SCOPED_SERVER_SETTING_KEYS` does not gain them: `resolveProjectOverrides`
(`projectSettings.ts:114`) copies each listed key onto a same-named `ServerSettings` key, and the
web project page shows a source per listed key. Readers take them from `overrides` directly (1.37,
1.25). `knownProjectOverrideKeys` (`shared/serverSettings.ts:244`) reads `ProjectSettingsOverrides.fields`,
so the whole-entry merge accepts them with no change. When the merge leaves `drivers` empty and no
other field set, `applyServerSettingsPatch` deletes `sandbox`, so "no driver" is "no key" (08 §2
rule 1).

Redaction: `mapSecretFieldGroups` gets a second environment group. Secret names, stable and
distinct from `provider-env-*`: `sandbox-env-${encode(name)}` and
`sandbox-project-env-${encode(projectId)}-${encode(name)}`. Storing in the secret store,
`redactServerSettingsForClient` (`serverSettings.ts:142`), echo of `valueRedacted`, and
`materializeSettingsSecrets` all go through `mapSettingsSecrets`, so no other server change.
`dockerHost` and `runnerUrl` hold no secret in M1 (TLS client certs for a remote daemon are files on
the server, named by `DOCKER_CERT_PATH`). `requiredScopesForServerSettingsPatch` needs no branch:
`sandbox` and `projectSettingsOverrides` already require `AuthSettingsWriteScope`.

**Tests.**

- `packages/contracts/src/settings.test.ts`: new `describe("ServerSettings sandbox")`, no existing
  case fits. (1) `Schema.decodeSync(ServerSettings)({})` has no `sandbox` key and
  `encodeSync(decode(doc))` deep-equals a fixture document without it (the round trip). (2) A
  document whose `drivers` holds `{ kind: "aws-ec2", ... }` decodes with that entry dropped and the
  rest of the settings intact.
- Same file, `describe("ServerSettings project overrides across versions")` (453): extend the
  existing case "sends back an override key from a newer server when an older client edits the
  entry" with `defaultsToCloud` and `sandboxEnv` (an older client's struct without the keys keeps
  them through `keepUnknownOverrideKeys`).
- `packages/shared/src/serverSettings.test.ts`, `describe("serverSettings helpers")`: beside
  "upserts and removes usageLimitSources per entry so concurrent edits cannot clobber" (596), the
  same case for `sandbox.drivers`: a patch keeps other ids, `null` removes one, removing the last
  removes `sandbox`, and a patch without `sandbox` leaves it as it was.
- `apps/server/src/serverSettings.test.ts`: extend "uses the same secret lifecycle for provider
  config, environment, host tokens, and quota keys" (1382) with one sensitive `sandbox.env` entry
  and one project `sandboxEnv` entry in `values` and in the echo `updateSettings` call. It already
  asserts absent from the client view and from disk, and restored on echo.
- The strict-path guard "knows every strictly decoded field that can hold a secret reference"
  (1743) stays unchanged, which proves no new strict reference slot.

**Verify.** `vp test run packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/server/src/serverSettings.test.ts`,
`vp run typecheck` (contracts, shared, server and dependents), `vp run check:changed`. No UI.

**Reviewer checks.**

- `DEFAULT_SERVER_SETTINGS` and an untouched settings file encode with no `sandbox` key.
- `drivers` is `ForwardCompatibleArray`; a strict array would break every older client on M5.
- No new key in `PROJECT_SCOPED_SERVER_SETTING_KEYS`; the `satisfies` clause names the three keys.
- Sensitive env values never appear in `redactServerSettingsForClient` output or on disk.
- Patches merge drivers per id; nothing re-sends a whole `sandbox` from an older client.

### 1.37 `feat(client-runtime): present machine status and gate cloud commands with permission atoms`

One copy, for web and mobile, of: whether Cloud is offered, what a machine state says and allows,
the project's Cloud default, and the four guarded `sandbox.*` commands. Its own PR so 1.38–1.41
only render. Includes 0.13's `cloudAvailability`, which lands with its first consumers.

- **Needs:** 1.2 (`OrchestrationV2ThreadShellSandbox`, the four client commands), 1.36 (settings
  keys). **Unblocks:** 1.38, 1.39, 1.41.
- **Files:**
  - add `packages/shared/src/sandbox.ts` and `sandbox.test.ts` with `cloudAvailability` and
    `newThreadPrefersCloud`, exported as `./sandbox` in `packages/shared/package.json` (as
    `./projectSettings`, 170). Shared, not client-runtime, because the server's
    `orchestrator_capabilities` (1.42) applies the same rule and the server does not depend on
    client-runtime.
  - add `packages/client-runtime/src/state/sandbox.ts` and `sandbox.test.ts` (presentation,
    commands, permission atom); export `./state/sandbox` in `packages/client-runtime/package.json`
    (subpath exports, as `./state/auth`).
  - change `packages/contracts/src/clientRpcPermissions.ts`: a `dispatchCommand` branch in
    `clientRpcRequiredScopes` (88).
  - change `packages/client-runtime/src/state/runtime.ts`: `createEnvironmentRpcCommand` (954)
    accepts an `Input` that is not the RPC input when `execute` is given (overloads; the default
    path keeps `Input extends EnvironmentRpcInput<TTag>`). Needed because the commands take
    `{ threadId, sandboxId }` and allocate their `commandId`, as every thread command does.
  - change `packages/client-runtime/src/operations/commands.ts`: `wakeSandbox`, `sleepSandbox`,
    `retrySandbox`, `discardSandbox` next to `deleteThread` (436), using `allocateCommandId` and
    `dispatch`.
  - change `apps/web/src/state/` and `apps/mobile/src/state/`: one `sandbox.ts` each binding
    `createSandboxEnvironmentAtoms(connectionAtomRuntime, { team })`, as `state/orchestration.ts` does.
  - no change to `threadShell.ts` or `shellReducer.ts`: the reducer compares whole shells with
    `Schema.toEquivalence(OrchestrationV2ThreadShell)` (`shellReducer.ts:11`), so the new optional
    `sandbox` key flows through once 1.2 adds it.

**Types, services and RPCs.**

```ts
// clientRpcPermissions.ts: the server already requires operate for every dispatch; this makes an
// unguarded client request of a sandbox command fail closed (RpcPermissionGuard denies by default).
if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && isSandboxCommandInput(input))
  return [AuthOrchestrationOperateScope];
// reads input.type only; never decodes the command union
const isSandboxCommandInput = (input: unknown) =>
  Predicate.hasProperty(input, "type") &&
  typeof input.type === "string" &&
  input.type.startsWith("sandbox.");

// packages/shared/src/sandbox.ts
export type CloudAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: "not-configured" | "project-disallowed";
      readonly message: string;
    };

/** Hidden when not-configured (solo stays T3 Code); disabled with `message` when project-disallowed. */
export function cloudAvailability(
  settings: Pick<ServerSettings, "sandbox" | "projectSettingsOverrides"> | null,
  projectId: ProjectId | null,
): CloudAvailability;

/** D4: the project's override, only while Cloud is available. Callers fall back to resolveNewThreadEnvMode. */
export function newThreadPrefersCloud(
  settings: ServerSettings | null,
  projectId: ProjectId | null,
): boolean;

// packages/client-runtime/src/state/sandbox.ts
export type SandboxAction = "wake" | "sleep" | "retry" | "discard";
export interface SandboxStatePresentation {
  readonly label: string | null; // header and status line; null = say nothing
  readonly rowWord: "Starting" | "Waiting" | "Asleep" | "Failed" | null; // sidebar and mobile list
  readonly tone: "neutral" | "warning" | "danger";
  readonly composer: "normal" | "queues" | "disabled";
  readonly actions: ReadonlyArray<SandboxAction>; // before the owner-or-admin check
  readonly ownerOnly: ReadonlyArray<SandboxAction>; // "sleep" and "discard"
}
export function sandboxStatePresentation(
  summary: OrchestrationV2ThreadShellSandbox,
  thread: { readonly hasActiveRun: boolean },
): SandboxStatePresentation;

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  deps: { readonly team: ReturnType<typeof createTeamEnvironmentAtoms> },
): {
  readonly wake: SandboxCommand;
  readonly sleep: SandboxCommand;
  readonly retry: SandboxCommand;
  readonly discard: SandboxCommand;
  /** Scope from the command's permissionAtom, then canMemberDeleteThread for sleep and discard. */
  readonly actionAllowedAtom: (key: {
    environmentId: EnvironmentId;
    action: SandboxAction;
    ownerMemberId: MemberId | null | undefined;
  }) => Atom.Atom<boolean>;
};
// each: createEnvironmentRpcCommand(runtime, {
//   label: "environment-data:sandbox:wake", tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
//   execute: wakeSandbox })   // Input = { threadId, sandboxId, commandId? }
```

`actionAllowedAtom` reads `command.permissionAtom(environmentId, { type })` (the scope half;
`clientRpcRequiredScopes` keys on `type`), and for `sleep` and `discard` also
`canMemberDeleteThread({ members, memberId, ownerId: ownerMemberId })`
(`client-runtime/src/state/team.ts:40`), the same owner-or-admin rule the server applies in
`assertTeamPermission` (`ThreadMessageIntake.ts:57`). It is true outside team mode, as delete is.

**Proposed gap answer.** The owner who may sleep or discard is the sandbox's `ownerMemberId`, which
can differ from the viewed thread's owner for a fork by another member. The shell summary in 1.2
has no owner. Proposed: 1.2's `OrchestrationV2ThreadShellSandbox` gains
`ownerMemberId: Schema.optionalKey(MemberId)`, changed only by adopt and reassign. Until then callers
pass the thread's `source.ownerId`, and the server's refusal is the backstop.

Presentation (04 §1 states, 01 §3 copy). `actions` assume the viewer may act; callers hide what
`actionAllowedAtom` denies, except owner-only actions, shown disabled with "Only the owner or an
admin" (08 §7).

| Summary                                                     | `label`                                                                                   | `rowWord` | `composer`                  | `actions`                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------- | --------------------------- | --------------------------------------- |
| `provisioning`, `admission` set                             | "Waiting for a machine" (`team-cap`: "team limit reached"; `rate-limit`: "starting soon") | Waiting   | queues                      | none                                    |
| `provisioning`                                              | "Starting machine" (the header adds the run's progress phase, 1.39)                       | Starting  | queues                      | none                                    |
| `ready`, `runnerConnected !== false`                        | null                                                                                      | null      | normal                      | sleep, discard when `!hasActiveRun`     |
| `ready`, `runnerConnected === false` (server debounced 2 s) | "Reconnecting to machine"                                                                 | null      | queues                      | none                                    |
| `sleeping`                                                  | "Asleep"                                                                                  | Asleep    | queues (sending wakes)      | wake, discard                           |
| `waking`                                                    | "Waking machine"                                                                          | null      | queues                      | none                                    |
| `failed`                                                    | `failureCopy(failureCode)`, else "Machine failed"                                         | Failed    | disabled                    | retry, discard                          |
| `destroyed`                                                 | "Machine discarded"                                                                       | null      | normal (sending provisions) | none; UI offers **Start a new machine** |
| `state: null` (newer server)                                | "Machine status unknown"                                                                  | null      | normal                      | none                                    |

"3 of 3 running" from 01 §3 needs a count the shell does not carry (08 §3 drops positions);
proposed: M1 copy says the reason only, M2's editable caps (2.17) can add the count.
`failureCopy` maps known codes (`driver-removed`: "The machine's driver was removed",
`workspace_preparation_failed`, `github-credential-missing` is not a machine failure and stays out).

**Tests.**

- `packages/shared/src/sandbox.test.ts` (new; no existing module): table tests for
  `cloudAvailability` (no `sandbox` key, empty `drivers`, `sandboxAllowed: false`, allowed) and
  `newThreadPrefersCloud`.
- `packages/client-runtime/src/state/sandbox.test.ts` (new): one row per presentation table row,
  including `state: null`.
- `packages/client-runtime/src/state/commandPermissions.test.ts`: extend
  `it.effect.each([WS_METHODS.scheduledTasksDelete, ORCHESTRATION_V2_WS_METHODS.stopWorkflow])`
  (185) style with a case: `createCommandPermissions(runtime, dispatchCommand)` requires operate for
  `{ type: "sandbox.wake" }` and nothing for `{ type: "thread.archive" }`.
- `actionAllowedAtom`: one case in `sandbox.test.ts` with a registry seeded as
  `commandPermissions.test.ts` does (`sessions(env)` grants, team members with roles): a member who
  is not owner gets wake and retry, not sleep or discard; an admin gets all four.

**Verify.** `vp test run packages/shared/src/sandbox.test.ts packages/client-runtime/src/state/sandbox.test.ts packages/client-runtime/src/state/commandPermissions.test.ts`,
`vp run typecheck` for contracts, shared, client-runtime, web, mobile; `vp run check:changed`. No UI yet.

**Reviewer checks.**

- No `cloud` literal reaches `ThreadEnvMode` or any contract schema; the default helper returns a
  boolean beside `resolveNewThreadEnvMode`.
- The `dispatchCommand` branch reads `type` without decoding; every other dispatch stays unguarded.
- All four commands are `createEnvironmentRpcCommand`s; no raw `request` of a `sandbox.*` command.
- Sleep and discard use the same rule as delete (`canMemberDeleteThread`), not a new one.
- Presentation is pure and has no timers; the 2 s reconnect debounce stays on the server.

### 1.38 `feat(web): offer Cloud in the mode picker, drafts and sidebar`

A member picks **Cloud** in the composer, sends, and gets a cloud thread with a cloud icon in the
sidebar (01 J2 steps 1–3). On the critical path because it is the first place a person can start a
cloud thread.

- **Needs:** 1.16 (the server accepts the `cloud` launch member), 1.37. **Unblocks:** 1.39 (new
  cloud thread entry points reuse the draft mode), 1.41 (the `prepareCloud` bootstrap), 1.45.
- **Files:**
  - change `apps/web/src/components/BranchToolbar.logic.ts`: `EnvMode` (26) becomes
    `Schema.Literals(["local", "worktree", "cloud"])`; `resolveEnvModeLabel` returns "Cloud";
    `resolveEffectiveEnvMode` (159) takes `sandboxId` and `cloudAvailable`; `resolveLockedWorkspaceLabel`
    says "Cloud" for a thread with a `sandboxId`.
  - change `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`: a `cloud` `SelectItem` after
    `worktree` (167), with `CloudIcon` from lucide; the locked row (73) shows the cloud icon from the
    thread's `sandboxId`, not from `activeWorktreePath`. New prop `cloud: CloudAvailability`; hidden
    when `not-configured`, disabled with `message` in a tooltip when `project-disallowed`, disabled
    with "Each model starts in its own worktree." when `forceNewWorktree`.
  - change `apps/web/src/components/BranchToolbar.tsx`: the context-strip `MenuRadioGroup` (~396)
    gets the same third item; `envModeLocked` (630) also locks a server thread with a `sandboxId`;
    reads `cloudAvailability(serverSettings, projectId)` once and passes it to both pickers.
  - change `apps/web/src/composerDraftStore.ts`: `DraftThreadEnvModeSchema` (115) gains `"cloud"`;
    `normalizeDraftThreadEnvMode` (1335) accepts it. No storage version bump: older stored drafts
    still decode.
  - change `apps/web/src/components/ChatView.logic.ts`: `planComposerTurn` (1401) treats `cloud` like
    `worktree` for the base branch (`missingWorktreeBaseBranch`, copy "Select a base branch before
    sending in Cloud mode.") and returns `baseRefForCloud`.
  - change `apps/web/src/components/chat/useComposerSend.ts`: when `baseRefForCloud` is set, the
    bootstrap (~1324) carries `prepareCloud: { baseRef }` instead of `prepareWorktree`;
    `runSetupScript` is not sent (the server runs setup in the sandbox, 1.24).
  - change `packages/client-runtime/src/operations/commands.ts`: `StartThreadBootstrap` (150) gains
    `prepareCloud?: { baseRef: string; branch?: string }`; `startThreadTurn` (702) maps it to
    `workspaceStrategy: { type: "cloud", baseRef, ...(branch ? { branch } : {}) }`.
  - change `apps/web/src/hooks/useHandleNewThread.ts`: `resolveDefaultEnvMode` (201) returns
    `"cloud"` when `newThreadPrefersCloud(targetServerSettings, projectId)`, else today's
    `resolveNewThreadEnvMode`; the `envMode` option accepts `"cloud"` (used by 1.39's
    `chat.newCloud`).
  - change `apps/web/src/components/chat/useWorktreeSetup.ts`: skip local worktree prompts when the
    thread has a `sandboxId` (08 §4).
  - change `apps/web/src/components/ThreadStatusIndicators.tsx`: `ThreadWorktreeIndicator` (572)
    renders `CloudIcon` with tooltip "Cloud: <branch>" when `thread.sandbox` is present (the
    `worktreePath` is `/t3-sandbox/...` and means nothing locally), and a new
    `ThreadMachineStateWord` renders `sandboxStatePresentation(...).rowWord` as quiet text.
  - change `apps/web/src/components/sidebar/SidebarThreadRow.tsx`: the meta line (~1162) adds
    `ThreadMachineStateWord` after the branch; the tooltip block (~299) adds a "Cloud" line.

**Types, services and RPCs.**

```ts
// BranchToolbar.logic.ts
export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  preparingWorktree?: boolean;
  sandboxId: SandboxId | undefined;
  cloudAvailable: boolean;
}): EnvMode {
  if (input.hasServerThread && input.sandboxId !== undefined) return "cloud";
  // A cloud draft falls back in render when Cloud goes away; the stored draft keeps its choice.
  if (!input.hasServerThread && input.draftThreadEnvMode === "cloud")
    return input.cloudAvailable ? "cloud" : "worktree";
  ... // today's body
}
```

No state syncing: the fallback is derived in render, so restoring the driver restores the pick.

**Tests.**

- `apps/web/src/components/BranchToolbar.logic.test.ts`, `describe("resolveEffectiveEnvMode")` (75):
  rows for a server thread with `sandboxId`, a cloud draft with Cloud available, and a cloud draft
  after Cloud went away.
- `apps/web/src/components/ChatView.logic.test.ts`, `describe("planComposerTurn")` (1067): a first
  `cloud` send with and without a branch.
- `apps/web/src/composerDraftStore.test.ts`, `describe("composerDraftStore project draft thread
  mapping")` (820): a persisted draft with `envMode: "cloud"` survives a reload.
- `packages/client-runtime/src/operations/commands.test.ts`: beside "preserves an existing worktree
  and branch during first-message launch" (216), one case that `prepareCloud` sends
  `workspaceStrategy: { type: "cloud", baseRef: "main" }` to `launchThread`.
- The icon and word are visual: captures, no UI test.

**Verify.** `vp test run apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/composerDraftStore.test.ts`;
`vp run typecheck` for client-runtime and web; `vp run check:changed`. `test-t3-app` pass, with
Docker on the dev machine, a Docker driver saved in seeded `.t3` settings (1.40 may not have
landed), the integrated M1 server rows merged:

1. Open a project draft with no driver configured: the picker shows Current checkout and New
   worktree only (capture "before").
2. Save a driver: Cloud appears without a reload (settings stream). Pick Cloud, pick `main`, send a
   Replay `showcase` prompt. The thread appears with the cloud icon and "Starting" word.
3. Set the project's `sandboxAllowed: false`: Cloud shows disabled with its reason. Set
   `defaultsToCloud: true` and allowed: a new draft opens on Cloud.
4. Remove the driver while a cloud draft is open: the picker shows New worktree; re-add it: Cloud
   again.
   Captures to attach: the picker before and after (web and desktop), the locked picker on a cloud
   thread, the sidebar row with the cloud icon and "Starting", "Asleep" and "Failed" words (seeded
   states), and the disabled Cloud item with its tooltip.

**Reviewer checks.**

- No `cloud` value reaches `ThreadEnvMode`, `defaultThreadEnvMode`, or a project record; only the
  client-local `EnvMode`, the draft, and the launch strategy carry it.
- With no `ServerSettings.sandbox`, the picker, sidebar and drafts render exactly as before.
- Both pickers (Select and the context-strip menu) offer Cloud; the multi-model send disables it.
- Cloud sends never send `runSetupScript` or `prepareWorktree`.
- The sidebar adds one icon and at most one word, no timers or animation.

### 1.39 `feat(web): show the machine in the header, banners, thread menu and palette`

Everything a member needs to see and act on a machine after the thread exists: the state line,
the failure and asleep notices with their buttons, Wake, Sleep now, Retry and Discard machine in
the thread menu and palette, and "New cloud thread" with `chat.newCloud` (08 §4 "Every entry
point per action"). Its own PR because 1.38 is about starting, and this is about the reverse states.

- **Needs:** 1.37 (presentation, commands, `actionAllowedAtom`); 1.38 for the `envMode: "cloud"`
  option that "New cloud thread" passes. **Unblocks:** 1.45.
- **Files:**
  - add `apps/web/src/components/sandbox/useSandboxThreadStatus.tsx`: for the active thread, reads
    `thread.sandbox`, `sandboxStatePresentation`, `actionAllowedAtom`, and returns
    `{ statusLine: ReactNode | null; bannerItems: ComposerBannerStackItem[]; run(action) }`. One
    hook so the line, the banner, the menu and the palette agree.
  - add `apps/web/src/components/sandbox/sandboxActionLabels.ts`: "Wake machine", "Sleep now",
    "Retry machine", "Discard machine", and the disabled reason "Only the owner or an admin".
  - change `apps/web/src/components/chat/useThreadLifecycle.tsx`: `threadStatusLine` (616) shows
    the machine line before the snooze and settle lines, using the existing `ThreadStatusLine`
    (label from the presentation; action **Wake** when asleep). While `provisioning` the label
    appends the run's preparing phase ("Starting machine: cloning"), read from the run the composer
    already shows.
  - change `apps/web/src/components/ChatView.tsx`: append `sandboxBannerItems` beside
    `systemComposerBannerItems` (2627, 2636). Failure banner: the one-line failure (detail
    `failure.message` when loaded, else `failureCopy`), **Retry** and **Discard**. Destroyed banner:
    "Machine discarded" with **Start a new machine**, which focuses the composer. Asleep is a status
    line, not a banner (01 J6: quiet).
  - change `apps/web/src/components/chat/ChatHeader.tsx`: a `Badge` after the title (as the link
    origin badge, 428) with the presentation label when non-null and a cloud icon; nothing for a
    `ready` machine.
  - change `apps/web/src/components/threadActionMenu.logic.ts`: `ThreadActionMenuState` gains
    `machine?: { actions: SandboxAction[]; ownerOnlyDenied: SandboxAction[] }`; items
    `machine:wake | machine:sleep | machine:retry | machine:discard` in a group after "Mark unread",
    with `disabled` and the "(owner or admin only)" suffix like `delete` (284). Keep the existing
    "Wake thread" (unsnooze) label distinct from "Wake machine". `copy-path` is left out for cloud
    threads, and `new-thread-on-branch` passes `envMode: "cloud"` for them.
  - change `apps/web/src/hooks/useThreadActionMenu.ts`: pass `machine` (from `readThreadShell` and
    the atoms read with `appAtomRegistry.get`), and handle the four ids by calling
    `sandboxEnvironment.<action>` with `{ threadId, sandboxId }`. Discard confirms first:
    "Discard this machine? Its disk is deleted; transcript and diffs stay."
  - change `apps/web/src/components/CommandPalette.tsx`: inside `if (activeThread !== null)` (1478),
    one action item per allowed machine action ("Wake machine", "Sleep machine", "Retry machine",
    "Discard machine"); after "New thread in" (1265), "New cloud thread in <project>" with
    `shortcutCommand: "chat.newCloud"`, shown only when `cloudAvailability(...).available`; add
    `chat.newCloud` to the `isNewThread` check (2542).
  - change `packages/contracts/src/keybindings.ts`: `"chat.newCloud"` after `"chat.newLocal"` (105)
    in `STATIC_KEYBINDING_COMMANDS`. No default in `packages/shared/src/keybindings.ts` (08 §4).
  - change `apps/web/src/shortcuts/chatRouteCommands.ts`: `"chat.newCloud"` beside `startNewLocal`
    (95), calling `startNewThreadFromContext(context, { envMode: "cloud" })`; it does nothing when
    Cloud is unavailable for the project.
  - change `apps/web/src/lib/chatThreadActions.ts`: `startNewThreadFromContext` (85) takes optional
    `options` and forwards them to `handleNewThread`.
  - change `apps/web/src/components/chat/OpenInPicker.tsx` callers (`ThreadDetailsPanel.tsx`,
    `FilePreviewPanel.tsx`): hide local path actions for a thread with a `sandboxId` (08 §4, M1
    hide); `remoteOpen.ts` resolves per environment and would open `/t3-sandbox/...` on the
    server's disk.
  - change `apps/web/src/contextMenuFallback.ts`: `cloud` and `power` icon paths for the menu.

**Commands, events and effects.** None new. The four actions are 1.37's
`createEnvironmentRpcCommand`s over `orchestration.dispatchCommand`; the server routes them to the
owner's stream (04 §1). Failures toast with the server's message, as `useThreadActionMenu` does.

**Tests.**

- `apps/web/src/components/threadActionMenu.logic.test.ts`, `describe("buildThreadActionMenuItems")`
  (29): extend "offers assign and gates delete only on a server with a team" (79) with machine
  rows: a member sees Wake and Retry enabled, Sleep and Discard disabled with the suffix; no
  machine group without `machine`; no Path item for a cloud thread.
- `apps/web/src/shortcuts/chatRouteCommands.test.ts`, `describe("new thread commands")` (27): rows
  in the `it.each` for `chat.newCloud` (Cloud available starts a cloud draft; unavailable does
  nothing).
- No new keybinding decode test: "drops resolved rules with commands this build does not know"
  (`packages/contracts/src/keybindings.test.ts:26`) already covers older clients. No test for
  forwarding `options` through `startNewThreadFromContext` (callback wiring).
- The header badge and the status line are visual: captures, no UI test.

**Verify.** `vp test run apps/web/src/components/threadActionMenu.logic.test.ts apps/web/src/shortcuts/chatRouteCommands.test.ts`;
`vp run typecheck` for contracts and web; `vp run check:changed`. `test-t3-app` pass on web and
desktop with Docker and a seeded cloud thread:

1. Start a cloud thread: header badge "Starting machine: cloning", then nothing once ready.
2. Sleep now from the thread menu, then the palette's "Wake machine": "Asleep" line with **Wake**,
   then "Waking machine", then nothing.
3. Stop the container by hand (`docker stop` on the captured container id, not by name pattern) to
   reach `failed`: failure banner with **Retry** and **Discard**; Retry recovers.
4. As a second, non-admin member (`node apps/server/src/bin.ts pair` for a fresh member link): Sleep
   and Discard show disabled with "Only the owner or an admin".
5. Discard: "Machine discarded" banner; **Start a new machine** focuses the composer; sending
   provisions again.
6. Bind `chat.newCloud` in Settings → Keybindings and press it: a cloud draft opens.
   Captures: header and status line per state (starting, asleep, waking, failed, discarded), the
   thread menu as owner and as member, the palette items, on web and desktop.

**Reviewer checks.**

- Menu, palette, line and banner all read `actionAllowedAtom` and the same presentation; none
  computes its own rule.
- Owner-only actions are shown disabled with the reason, not hidden (08 §7).
- No spinner: the line and badge change text only.
- `chat.newCloud` has no default binding, and the palette hides "New cloud thread" when Cloud is
  unavailable.
- Path copying and open-in-editor are hidden for cloud threads; the existing "Wake thread"
  (snooze) is untouched.

### 1.40 `feat(server,web): add Settings → Cloud with the Docker driver, cloud env, and a Test button`

The admin journey J1 on web and desktop: one page to add a Docker driver (local or through
`DOCKER_HOST`), see whether it is isolated, set the base image override and team env vars, read the
caps, and **Test** a machine end to end. Plus the project rows in Settings → Projects: "Allow cloud
threads", Cloud as the default workspace, and project env vars. Saving the first driver is what
turns Cloud on for every client (08 §2 rule 3).

- **Needs:** 1.36; 1.14 (Docker driver and isolation detection), 1.25 (reserved env names),
  **and, PR-list change, 1.16, 1.18, 1.23, 1.30**: the Test button boots a runner (1.16's path),
  read-only caps come from 1.18's admission defaults, Overview names the base image (1.23) and the
  mirror size (1.30). The GitHub App key row is 1.27's, in Source Control. **Unblocks:** 1.45, the
  M1 integrated pass.
- **Files (server):**
  - change `packages/contracts/src/sandbox.ts`: `SandboxOverview`, `SandboxDriverCheckResult`.
  - change `packages/contracts/src/rpc.ts`: `WS_METHODS.sandboxOverview: "sandbox.overview"` and
    `sandboxCheckDriver: "sandbox.checkDriver"`, `Rpc.make` entries beside
    `WsServerCheckOtlpEndpointRpc` (987), added to the RPC group.
  - change `packages/contracts/src/clientRpcPermissions.ts`: `sandboxCheckDriver:
    AuthSettingsWriteScope` in `CLIENT_GUARDED_RPC_SCOPES` (a check boots a machine, like storage
    cleanup acts on the server). `sandboxOverview` is a read, unguarded on clients.
  - change `apps/server/src/auth/RpcAuthorization.ts`: `sandboxOverview` at
    `AuthOrchestrationReadScope` (as `serverGetDatabaseStorage`, 90); the guarded map is spread in.
  - add `apps/server/src/sandbox/lifecycle/SandboxOverview.ts` and
    `apps/server/src/sandbox/compute/ComputeDriverCheck.ts`; one handler line each in
    `apps/server/src/ws.ts` (beside `serverCheckOtlpEndpoint`, 2864).
- **Files (web):**
  - add `apps/web/src/routes/_chat.settings.cloud.tsx` (`createFileRoute("/_chat/settings/cloud")`,
    as `_chat.settings.team.tsx`) and `apps/web/src/components/settings/CloudSettings.tsx` with three
    sections on one route: Overview, Compute, Environment variables.
  - change `apps/web/src/components/settings/settingsSearch.ts`: `"/settings/cloud"` in
    `SettingsPath` (20), `SETTINGS_SECTION_LABELS` ("Cloud"), `SETTINGS_NAV_GROUPS` "Connections"
    after `/settings/team` (shown on solo servers too); search items below. Do not use the existing
    `cloudOnly` flag: it means T3 Connect's public config (1385).
  - change `apps/web/src/components/settings/SettingsSidebarNav.tsx`: `"/settings/cloud": CloudIcon`
    in `SETTINGS_SECTION_ICONS` (~107).
  - change `apps/web/src/components/settings/ProjectDefaultsSettings.tsx`: in project scope only,
    a third `SelectItem` "Cloud" in the default workspace select (~264) that writes
    `defaultsToCloud: true` (choosing Current checkout or New worktree writes `false`), an
    "Allow cloud threads" switch (`sandboxAllowed`), and a project env section reusing
    `ProviderEnvironmentSection` (`ProviderInstanceCard.tsx:340`) for `sandboxEnv`. All three
    write through `projectOverrideWrites` in `scopedSettings.ts` (179), as
    `buildProviderInstanceOverridePatch` does in `ProviderSettingsPanel.tsx` (922). Shown only when
    the environment's settings have `sandbox`.

**Types, services and RPCs.**

```ts
// sandbox.ts
export const SandboxDriverHealth = Schema.Struct({
  driverId: ComputeDriverId,
  reachable: Schema.Boolean,
  isolation: Schema.Literals(["rootless", "gvisor", "runc", "unknown"]), // from 1.14's detection
  message: Schema.optionalKey(Schema.String),
});
export const SandboxOverview = Schema.Struct({
  drivers: Schema.Array(SandboxDriverHealth),
  machines: Schema.Struct({
    ready: NonNegativeInt,
    sleeping: NonNegativeInt,
    failed: NonNegativeInt,
    waiting: NonNegativeInt,
  }),
  caps: Schema.Struct({ team: NonNegativeInt, startsPerMinute: NonNegativeInt }), // read-only in M1, no member cap (D5)
  baseImage: Schema.Struct({ ref: Schema.String, label: Schema.String }), // "Pair base <version>" or the override
  mirrorBytes: NonNegativeInt,
});
export const SandboxDriverCheckInput = Schema.Struct({ driverId: ComputeDriverId });
export const SandboxDriverCheckResult = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      step: Schema.Literals(["image", "create", "runner", "git", "discard"]),
      ok: Schema.Boolean,
      durationMs: NonNegativeInt,
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});

// sandbox/lifecycle/SandboxOverview.ts
export class SandboxOverview extends Context.Service<
  SandboxOverview,
  {
    readonly read: Effect.Effect<SandboxOverviewResult, SandboxOverviewError>;
  }
>()("t3/sandbox/lifecycle/SandboxOverview") {}
// counts from orchestration_v2_projection_sandboxes (1.3) grouped by state; caps from
// SandboxAdmission's defaults (1.18); health from ComputeDriverRegistry (1.4) per instance;
// baseImage from SandboxBaseImage (1.23); mirrorBytes from CheckpointMirror (1.30).

// sandbox/compute/ComputeDriverCheck.ts
export class ComputeDriverCheck extends Context.Service<
  ComputeDriverCheck,
  {
    readonly check: (
      input: SandboxDriverCheckInput,
    ) => Effect.Effect<SandboxDriverCheckResult, ComputeDriverCheckError>;
  }
>()("t3/sandbox/compute/ComputeDriverCheck") {}
// Effect.fn("ComputeDriverCheck.check"): resolve the image, driver.create with a throwaway
// SandboxId, await the runner hello, run `git --version` through the sandbox host, driver.destroy
// in an ensuring finalizer. Each step is timed; the whole check is bounded at 3 minutes.
```

**Proposed gap answers.**

- The check sandbox has no thread, so it is not an orchestration record and is never projected or
  counted. It needs the runner hub to accept a hello for an id it was told to expect, without
  dispatching `sandbox.runner.attached`: proposed `RunnerHub.expectCheck(sandboxId)` returning a
  `Deferred` the hello completes (1.7's owner adds it). The reconciler (1.19) lists by the
  install-id tag, so a check container left by a crash is destroyed with other orphans.
- J1 says Test also runs "the project's setup script". The page is server-wide and has no project,
  so M1's Test stops at `git --version`; a project's first cloud thread shows its setup output.
- A remote `dockerHost` requires `runnerUrl` (form validation and 1.4's decode refinement).

**UI.** Admins (`AuthSettingsWriteScope`) edit; members see Overview read only and no Compute
(01 §6).

- Overview: before any driver, one paragraph ("Cloud runs each cloud thread on its own machine.
  Nothing changes until you add a driver.") and **Add Docker driver**. With drivers: health per
  driver, machine counts, the base image label, mirror size. Two warnings, in the page's notice
  style: isolation `runc` ("Plain Docker is not a security boundary: agents in a machine can reach
  this host's Docker network and kernel. Use rootless Docker or gVisor.", 01 J1), and, when
  `environment.capabilities.serverSelfUpdate === "desktop-managed"`, "This server runs inside the
  desktop app. Closing this computer stops cloud turns. Use an always-on team server." (01 J5).
- Compute: per driver label, "This machine" or a Docker host URL, runner URL (shown when the
  host is remote), machine size; **Test** (results listed step by step with times; static text
  "Testing…" while it runs, no spinner); **Remove**. Base image override field (D6), empty means
  "Pair base <version>". Read-only caps: "Team: N machines (floor of vCPUs / 4)", "10 starts a
  minute", "No member cap".
- Environment variables: the team layer through `ProviderEnvironmentSection`; reserved names from
  1.25 show as invalid rows.
- Saving uses the settings patch: `{ sandbox: { drivers: { [id]: driver } } }`, `null` to remove one,
  `{ sandbox: null }` never sent by this page.

Search items (ids): `cloud-overview`, `cloud-docker-driver` ("docker host DOCKER_HOST rootless gvisor
runc isolation machine"), `cloud-base-image`, `cloud-caps`, `cloud-env`, `cloud-test`, all
`to: "/settings/cloud"`, `environmentOnly: true`; project rows `project-cloud-allowed`,
`project-defaults-to-cloud`, `project-cloud-env` with `scope: "project"`.

**Tests.**

- `apps/web/src/components/settings/settingsSearch.test.ts`: extend "finds rows by the titles shown
  on their pages" (193) with the Cloud titles, and "keeps environment-wide settings out of project
  scopes" (226) with the cloud ids (only the three project rows show in project scope).
- Server: `apps/server/src/sandbox/compute/ComputeDriverCheck.test.ts` (new; no existing case),
  `it.effect` with `FakeComputeDriver` and `RunnerHubTesting`: steps in order, `destroy` runs when
  the runner step fails (the test completes the hello `Deferred` or fails it; no sleeps), and the
  3-minute bound fires on `TestClock.adjust`.
- `SandboxOverview`: one `it.effect` over seeded projection rows (counts by state); health and caps
  come from fakes.
- No new authorization test: "declares exactly one scope for every RPC in the server group"
  (`apps/server/src/auth/RpcAuthorization.test.ts:39`) fails until both methods have a scope.

**Verify.** `vp test run` on the files above; `vp run typecheck` for contracts, server, web;
`vp run check:changed`. `test-t3-app` on web and desktop, Docker on the dev machine:

1. Solo dev server, no driver: Settings → Cloud shows the intro and **Add Docker driver**; the
   composer shows no Cloud (capture "before").
2. Add the local Docker driver: the runc warning shows on a plain Docker host. **Test**: five
   steps pass with times (capture). The composer now offers Cloud without a reload.
3. Point a second driver at a remote `DOCKER_HOST` without a runner URL: the form refuses it.
4. Projects → one project: turn off "Allow cloud threads" (Cloud disabled in that project's
   picker), pick Cloud as the default workspace (new drafts open on Cloud).
5. On the desktop app's own server: the desktop warning shows.
6. As a member: Overview read only, no Compute.
   Captures: Overview empty and configured, the isolation and desktop warnings, Test results, the
   project rows; web and desktop.

**Reviewer checks.**

- No page change writes `sandbox` until an admin saves a driver; removing the last driver removes
  the key (1.36), and Cloud disappears from pickers live.
- Members never see driver hosts or env values; sensitive values arrive redacted.
- The check's machine is destroyed on every exit path, is not projected, and does not count
  toward caps.
- Search entries do not reuse `cloudOnly`; the route is `/settings/cloud`, files say `Cloud` in UI
  names only where they are UI.

### 1.41 `feat(mobile): start cloud threads, show machine status and add a read-only machines screen`

J3 on iOS and Android: pick **Cloud** in the new-task screen, see the same machine status as web,
wake, retry, sleep or discard, and read a machines screen. Also D1's mobile half: the member's own
GitHub token row in the Team screen and the "Connect GitHub to push" notice (08 §5).

- **Needs:** 1.37, 1.28a (token RPCs and `cloudPushCredential`), **and, PR-list change, 1.38**
  (the `prepareCloud` bootstrap in client-runtime and, through it, 1.16), **and 1.40** (the
  read-only screen reads `sandbox.overview`). **Unblocks:** the M1 integrated pass, 1.45.
- **Files:**
  - change the client-local mode in its five places to `"local" | "worktree" | "cloud"`:
    `features/threads/new-task-flow-provider.tsx` (`WorkspaceMode`, 116),
    `features/threads/new-task-context-presentation.ts` (6), `NewTaskDraftScreen.tsx` (101),
    `checkout-new-task-branch.ts` (22), `projectThreadCreationValidation.ts` (2), and
    `state/use-composer-drafts.ts` (`ComposerDraftWorkspaceSelection.mode`, 424, and its schema,
    443). Proposed: export one `NewTaskWorkspaceMode` from `new-task-context-presentation.ts` and
    import it in the other four, so the next mode is one edit.
  - change `features/threads/NewTaskDraftScreen.tsx`: the workspace control (834) toggles local and
    worktree as today when Cloud is not available; when `cloudAvailability(...)` is available it opens
    a native menu (Current checkout, New worktree, Cloud), and when `project-disallowed` the Cloud
    entry is disabled with the message. `resolveNewTaskWorkspaceLabel` returns "Cloud", and
    `NewTaskWorkspaceIcon` draws `cloud`.
  - change `features/threads/NewTaskContextPickerScreens.tsx`: Cloud uses the base-branch picker
    (title "Base branch", 317) as worktree does.
  - change `lib/projectThreadStartTurn.ts`: `buildProjectThreadStartTurnInput` (40) sends
    `prepareCloud: { baseRef: spec.branch!, branch: spec.worktreeBranchName }` for `cloud`, without
    `prepareWorktree` or `runSetupScript`.
  - change `features/threads/use-new-task-project-defaults.ts` (64): `"cloud"` when
    `newThreadPrefersCloud(settings, projectId)`, else `resolveNewThreadEnvMode`.
  - change `features/threads/ThreadRouteScreen.tsx`: `headerSubtitle` (522) adds
    `sandboxStatePresentation(...).label` when non-null; a `machineHeaderMenu` beside
    `teamHeaderMenu` (515), built by a new `features/threads/thread-machine-menu.ts`
    (`buildThreadMachineMenuItems(presentation, allowed)`), passed to `ThreadHeader`.
  - change `features/threads/ThreadHeader.tsx`: `menus` (113) takes the machine menu and the team
    menu. Proposed deviation from 08 §5: the actions go in the header menu, where Follow and Assign
    live, not `ThreadSettingsSheet.tsx`, which holds model and runtime settings.
  - change `features/threads/thread-list-v2-items.tsx`: the metadata line (~529) shows a `cloud`
    symbol for a thread with `sandbox`, and the `rowWord`; context menus gain "Wake machine" for an
    asleep machine and "Retry machine" for a failed one (members may do both).
  - change `features/threads/ThreadDetailScreen.tsx`: the failure notice (one line, **Retry**,
    **Discard**), "Machine discarded" with **Start a new machine**, and the push notice: "Connect
    GitHub to push" for the owner (opens `SettingsTeam`), "Ask <owner> to connect GitHub" for others,
    when the thread is a cloud thread and `cloudPushCredential(...)` is `none`.
  - work log: no change. Provision phases arrive as the title of the run's "Preparing workspace"
    item (`Orchestrator.ts:10696`), which `thread-work-log.tsx` already renders.
  - add `features/settings/SettingsMachinesRouteScreen.tsx`: read-only per environment with
    `settings.sandbox`: drivers and their health, counts by state, base image label, team cap. No
    editing (08 §5 "by design").
  - register it: `Stack.tsx` (`SettingsMachines`, `linking: "settings/machines"`, beside
    `SettingsTeam`, 352); `features/settings/components/settings-page-targets.ts`
    (`"SettingsMachines"`); `features/settings/settings-search.ts` (`SettingsMachines: ["cloud",
    "machines", "docker", "sandbox", "driver"]`); `features/settings/SettingsRouteScreen.tsx`: a
    `{ id: "SettingsMachines", icon: "cloud", label: "Machines", target: "SettingsMachines" }` row
    in Connections (174), shown when any connected environment's settings have `sandbox`, on solo
    servers too. `settings-navigation.ts` derives the route from the name.
  - change `features/settings/SettingsTeamRouteScreen.tsx`: the viewer's own `TeamMemberRow` (26)
    shows GitHub ("Connected as <login>", "Token", or "Not connected"), **Use a token instead** (a
    secure text field, `secureTextEntry`, submit calls the token-set command), **Remove token**, and
    the warning "Agents in your cloud threads can read this token." Other members' rows unchanged.
  - change `apps/mobile/src/state/sandbox.ts` (from 1.37) for the commands; the team token commands
    come from `packages/client-runtime/src/state/team.ts` (1.28a). If 1.28a put them in `apps/web`,
    this PR moves them to client-runtime so web and mobile share them.

**Tests.**

- `features/threads/new-task-context-presentation.test.ts`: rows in
  `describe("resolveNewTaskWorkspaceSelection")` (11) for a cloud selection on a git project and on
  a non-git project (falls back to local), and in `resolveNewTaskBranchWorktreePath` (98) for cloud
  (never reuses a local worktree path).
- `lib/projectThreadStartTurn.test.ts`: a `describe("buildProjectThreadStartTurnInput")` case
  (new; the file only tests titles today) that `cloud` sends `prepareCloud` and no `prepareWorktree`
  or `runSetupScript`.
- `features/threads/checkout-new-task-branch.test.ts`: a row that a cloud draft keeps its base
  branch like worktree.
- `features/settings/settings-search.test.ts`: "machines" and "docker" find `SettingsMachines`.
- Menus, header text and rows are visual: captures.

**Verify.** `vp test run` on the four test files; `vp run typecheck` for mobile and client-runtime;
`vp run check:changed`. `test-t3-mobile`: `vp run mobile:install ios` (and `android`), Metro,
pair against the worktree's dev server that has a Docker driver:

1. New task, project, **Cloud**, `main`, a Replay prompt: the thread opens with "Starting machine"
   in the header subtitle, then nothing once ready; the list row shows the cloud symbol.
2. Header menu: Sleep now, then Wake machine; asleep and waking text.
3. Fail the machine (stop the container by its captured id on the host): failure notice, Retry.
4. Settings → Machines: read-only page.
5. Team screen (two members): own row, set a token, remove it; on a cloud thread without any
   credential the push notice shows and opens Team.
6. A server without a driver: no Cloud entry, no Machines row (capture "before").
   Captures: new-task mode menu before and after, the header subtitle per state, the header menu as
   owner and as member, the list row, the Machines screen, the Team row and the push notice, on iOS
   and Android.

**Reviewer checks.**

- Mobile computes nothing on its own: availability, presentation, permissions and the push
  credential come from client-runtime.
- No Cloud UI on a server without `settings.sandbox`; the toggle stays a toggle there.
- No new code under `features/cloud` (T3 Connect).
- The token is only typed into a secure field and sent once; it is never shown back.
- Owner-only actions are shown disabled with "Only the owner or an admin".

### 1.42 `feat(server): launch cloud threads from MCP tools and t3 thread start --cloud`

Agents and scripts start cloud threads (01 J7 for MCP and the CLI, M1): `t3_thread_launch` with a
`cloud` workspace strategy, `delegate_task` with `isolation: "cloud"`, `orchestrator_capabilities`
reporting whether cloud is available, `t3_thread_read` returning the machine summary, and
`t3 thread start <project> --cloud <ref>`. One PR because every change is model-facing text or its
CLI caller, and they share one eval run and one budget update.

- **Needs:** 1.16; 1.37 (`cloudAvailability` in `@t3tools/shared/sandbox`). **Unblocks:** 1.45.
- **PR-list change (with 1.16):** `t3_thread_launch`'s `workspaceStrategy` parameter
  (`mcp/toolkits/project/tools.ts:141`) is typed with the shared launch strategy, so the moment
  1.16 (or 1.2) adds the `cloud` member it reaches every model, outside this PR's evals and
  without the `agent-context-increase` budget review. Proposed: 1.16 types that parameter with
  0.11's three-member `OrchestrationV2RunWorkspacePreparation`; 1.42 widens it.
- **`create_threads`: no change (proposed).** It has no workspace input today
  (`OrchestratorMcpCreateThreadRequest`, `orchestratorMcp.ts:261`); its threads inherit the caller's
  checkout. Fan-out to cloud uses `delegate_task` with `isolation: "cloud"` or several
  `t3_thread_launch` calls, as worktree fan-out does. 08 §4's entry-point table should drop
  `create_threads` from "Start in cloud".
- **Files:**
  - change `apps/server/src/mcp/toolkits/project/tools.ts`: parameter type (141) to
    `OrchestrationV2ThreadLaunchWorkspaceStrategy`; its description gains one clause.
  - change `apps/server/src/mcp/toolkits/project/handlers.ts`: beside the `worktree` base check
    (154), a cloud launch with no `ServerSettings.sandbox`, or a project with
    `sandboxAllowed: false`, fails `invalid_request` before anything is created. The check is
    `ThreadLaunchService.checkCloudLaunch` (a service method, so the CLI, MCP and the composer
    share it; if 1.16 already refuses in `launch`, reuse that and add no second check).
  - change `packages/contracts/src/orchestratorMcp.ts`: `OrchestratorMcpDelegateTaskInput.isolation`
    (173) to `Schema.Literals(["shared", "worktree", "cloud"])` with the description below;
    `OrchestratorMcpCapabilitiesResult.features` (639) gains `cloudThreads: Schema.Boolean`;
    `OrchestratorMcpThreadDetail` (425) gains `sandbox: Schema.optional(OrchestrationV2ThreadShellSandbox)`.
  - change `apps/server/src/mcp/OrchestratorMcpService.ts`: `features` (2365) sets
    `cloudThreads: cloudAvailability(settings, parentProjectId).available` from
    `@t3tools/shared/sandbox` (1.37). `delegateTask` (2441): `isolation === "cloud"` builds
    `workspaceStrategy = { type: "cloud", baseRef: parent.thread.branch }`; with no parent branch it
    fails `invalid_request` "A cloud task starts from a pushed branch; this thread has none. Use
    isolation 'worktree'." The thread read maps the shell `sandbox` into the detail.
  - change `apps/server/src/mcp/toolkits/orchestrator/tools.ts`: `delegate_task` (86) and
    `orchestrator_capabilities` (72) descriptions.
  - change `apps/server/src/peer/RemoteDelegation.ts` (215): refuse `isolation: "cloud"` exactly as
    `worktree` is refused, naming `t3_thread_launch` with `environmentId` and a cloud strategy. The
    target decides placement with its own drivers and caps.
  - change `apps/server/src/cli/thread.ts`: `threadStartCommand` (719) gains
    `cloud: Flag.String("cloud").pipe(Flag.withDescription("Run on a cloud machine, checked out from this branch, tag, or commit on the remote."), Flag.optional)`;
    `launchWorkspaceStrategy` (626) takes `cloud`; `show` (876) prints the machine state line.
  - change `apps/server/src/provider/agentContextBudget.json`: the measured values (the PR carries
    the `agent-context-increase` label).
  - add cases to `evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`.
  - change `docs/user/outside-agents.md` "Scripts and CI": "runs in the project folder unless you
    pass `--worktree <base-branch>`" gains "or `--cloud <base-branch>` for a cloud machine, when your
    server has Cloud set up"; "Agents working with agents" gains one sentence that agents can start
    cloud threads and cloud tasks the same way (10 §5's M1 docs row).

**Model-facing text (exact edits).**

- `t3_thread_launch` `workspaceStrategy` description, appended: "'cloud': a new machine, checked
  out from `baseRef` on the remote, that keeps running when this computer sleeps. Only when
  `orchestrator_capabilities` reports `features.cloudThreads`."
- `delegate_task` `isolation` description: "'shared' (default): parent checkout. 'worktree': new
  prepared checkout from the parent commit, for a separate checkout or PR per child. 'cloud': own
  machine from the parent's pushed branch, if `features.cloudThreads`. Uncommitted edits stay out."
- `delegate_task` tool description: "... Separate checkout or PR per child: `isolation:'worktree'`,
  or `'cloud'` for a machine of its own. ..."
- `orchestrator_capabilities`: no description change; the new `features.cloudThreads` key speaks
  for itself.

**CLI.**

```ts
const launchWorkspaceStrategy = (input: {
  readonly worktree: Option.Option<string>;
  readonly cloud: Option.Option<string>;
  readonly branch: Option.Option<string>;
}) => {
  if (Option.isSome(input.worktree) && Option.isSome(input.cloud))
    return Effect.fail(new ThreadUsageError({ detail: "Use --worktree or --cloud, not both." }));
  // --branch names the new branch for either
  const baseRef = Option.orElse(input.worktree, () => input.cloud);
  ...
  type: Option.isSome(input.cloud) ? ("cloud" as const) : ("worktree" as const)
};
```

`--branch` without either keeps its error, reworded "--branch needs --worktree or --cloud
<base-ref>." `--wait` is unchanged; while the run waits and the thread's `sandbox.admission` is
set, `finishRun` prints "Waiting for a machine" to stderr once. `show` prints, after the worktree
line, `Machine: <label>` from the same presentation copy (asleep, failed with the code, starting).

**Tests.**

- `apps/server/src/mcp/toolkits/project/handlers.test.ts`: beside "a launch into a new worktree
  creates nothing when its base ref has no commit" (493), "a cloud launch creates nothing when no
  driver is configured" and "... when the project does not allow cloud".
- `apps/server/src/mcp/OrchestratorMcpService.test.ts` (existing delegate cases): `isolation:
  "cloud"` dispatches `delegated_task.request` with the cloud strategy from the parent branch, and
  fails with no branch; capabilities report `cloudThreads` from settings.
- `apps/server/src/peer/RemoteDelegation.test.ts`: "refuses worktree isolation for a task there
  before launching anything" (1123) becomes an `it.effect.each` over `worktree` and `cloud`.
- `apps/server/src/cli/thread.test.ts`: `--cloud main` sends `{ type: "cloud", baseRef: "main" }`;
  `--cloud` with `--worktree` fails with the usage error; `show` prints the machine line.
- `apps/server/src/provider/AgentContextBudget.test.ts` "agent context matches the committed
  budget" (131) passes with the updated JSON.
- Evals, three cases in `threads-vs-tasks.ndjson`, sourced to 08 §6 and 01 J5:
  - `cloud-laptop-can-sleep` (`bad` before the fix): prompt "Start a thread to migrate the billing
    tests and run this where my laptop can sleep"; mocked `orchestrator_capabilities` with
    `features.cloudThreads: true`; expect `calls: [{ tool: "t3_thread_launch", args:
    { "workspaceStrategy.type": "cloud" } }]`.
  - `cloud-unavailable-no-cloud` (`guard`): the same prompt with `cloudThreads: false`; expect
    `callsMustNot` a cloud strategy and `finalTextMust` "~cloud" (it says cloud is not set up).
  - `worktree-stays-worktree` (`control`): "Start a thread on a new worktree from main to fix the
    cache"; expect `workspaceStrategy.type: "worktree"` even with `cloudThreads: true`.

**Verify.** `vp test run` on the test files above; `vp run typecheck` for contracts and server;
`vp run check:changed`. Evals from `evals/`: `pnpm mcp-tool-use --case cloud-laptop-can-sleep --dry-run`,
then `pnpm mcp-tool-use --cases mcp-tool-use/cases/threads-vs-tasks.ndjson --samples 3 --out runs/cloud`
on the old text (the new case fails) and the new text (passes, others unchanged), on Sonnet and
Opus; attach both summaries. Runtime transcript: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go" --cloud main --wait`
against a dev server with Docker, then `t3 thread show` with the machine line, and the
`--cloud`/`--worktree` usage error.

**Reviewer checks.**

- The cloud member reaches models only in this PR; the budget JSON changes with the label.
- Refusals happen before a thread exists, in a service method, not in tool handler logic.
- `isolation: "cloud"` never uses the parent's unpushed commit; the description says so.
- A linked environment never receives a cloud strategy through `delegate_task`.
- The CLI keeps `--worktree` behavior byte-identical when `--cloud` is absent.

### 1.43 `feat(server): notify the prompter and owner when a machine fails`

A machine that fails to start or wake pushes "Machine failed" to the people a failed turn would
reach, the prompter and the owner (01 §5). Small and separate because it touches the shared routing
rule every client and the push notifier use.

- **Needs:** 1.16 (a sandbox failure fails the waiting run through `sandbox.release-waiters`, and
  the shell carries `sandbox`). **Unblocks:** none.
- **Files:**
  - change `packages/shared/src/threadNotificationRouting.ts`: `ThreadNotificationKind` (4) gains
    `"machine-failed"`; `shouldNotifyMember` (35) routes it in the agent-event arm with `failed`;
    `threadNotificationTitle` (60) returns "Machine failed".
  - change `apps/server/src/notifications/MemberPushNotifier.ts`: in `detect`, the `run.updated`
    failed branch (149) picks the kind:

    ```ts
    if (run.status === "failed") {
      return agentEvent(
        thread,
        thread.lastErrorClass === "usage_limit"
          ? "limited"
          : thread.sandbox?.state === "failed"
            ? "machine-failed"
            : "failed",
      );
    }
    ```

    No new detection path: the run a machine failure fails is already the push trigger, its
    `firstSighting(run:<id>:failed)` key already dedupes, so one failure sends one push, never
    "Thread failed" and "Machine failed" both.

  - web: no change. `ThreadNotificationCoordinator.logic.ts` (1) has its own kind list without
    `failed`, so in-app notices are unchanged.
  - change `docs/user/team.md` "Follow threads and notifications" (158): the first bullet reads "A
    finished or failed turn, a machine that fails to start, or a request for approval or input,
    notifies ...".
- **Proposed gap answer.** A manual **Wake** or **Retry** that fails with no run waiting sends no
  push: the person who pressed it is looking at the failure, and nobody else was waiting. 01 §5's
  "Machine failed to start or wake" is covered for every machine a turn waited on.

**Tests.**

- `packages/shared/src/threadNotificationRouting.test.ts`: add `"machine-failed"` to `AGENT_KINDS`
  (16), which runs it through both rows of the `shouldNotifyMember` table (prompter and owner; owner
  only for their own turn) and the "never notifies anyone of their own action" and solo cases. One
  assertion in `describe("threadNotificationTitle")` (116) for "Machine failed".
- `apps/server/src/notifications/MemberPushNotifier.test.ts`: beside "pushes Bob's completed turn on
  Alice's thread to Bob and Alice, not Carol" (266), "pushes Machine failed once to Bob and Alice
  when Bob's waiting run fails with its machine": seed a cloud thread shell with `sandbox.state:
  "failed"`, publish the failed `run.updated`, assert one push per member with the title, no
  "Thread failed". It waits on the push sink fake, as the existing cases do.

**Verify.** `vp test run packages/shared/src/threadNotificationRouting.test.ts apps/server/src/notifications/MemberPushNotifier.test.ts`;
`vp run typecheck` for shared, server, web, mobile; `vp run check:changed`. Runtime transcript on a
two-member dev server with Docker: Bob prompts a cloud thread Alice owns, the container is stopped
by its captured id during "Starting machine", and the notifier's log shows one "Machine failed" push
each to Alice and Bob. `test-t3-mobile` confirms the push title on a device in the M1 integrated pass.

**Reviewer checks.**

- `machine-failed` is routed exactly like `failed`, from the same branch; no second trigger.
- The kind is read from the shell's current sandbox state, which the owner's stream wrote before
  `prepared-run.fail` reached this thread.
- The push body stays the thread title only.

### 1.44 `perf(server): measure runner latency and check the startup budget`

Puts numbers on 03 §9 and §2.3: spans and metrics in the running server, startup marks in the
runner, and a benchmark script (not in CI) that fails when a Docker-on-the-same-machine figure
misses its budget. Its own PR because it adds instrumentation across 1.7–1.9 and a tool, and its
table is the evidence M1 ships with (10 §4).

- **Needs:** 1.8 (stats, writer fibers), 1.9 (a bundle to boot). **Unblocks:** the M1 evidence
  table; 03 open question 5 (window size) is answered from its output.
- **Files:**
  - change `apps/server/src/observability/Metrics.ts`: the metrics below, beside the existing
    `Metric.counter`/`timer`/`gauge` exports.
  - change `apps/server/src/sandbox/runnerHub/RunnerHub.ts`: count bytes, time calls, record
    hello and spawn spans, set gauges from `resource.pressure` events.
  - change `apps/server/src/sandbox/runner/bin.ts` and `main.ts`: startup marks.
  - change `packages/contracts/src/runner.ts`: `resource.pressure` gains `highWaterBytes` and
    `pausedMsTotal` (cumulative since boot). A field add, before any release, so no version bump.
  - add `apps/server/scripts/runner-benchmark.ts`; add `"bench:runner": "node
    apps/server/scripts/runner-benchmark.ts"` to the root `package.json` scripts.
  - change `docs/internals/performance-regressions.md`: a short "Runner" section with the
    command and the failing budgets (a constraint spanning runner, hub and Docker driver).

**Types, services and RPCs.**

```ts
// Metrics.ts
export const runnerBytesTotal = Metric.counter("t3_runner_bytes_total", {
  description: "Bytes carried between the server and sandbox runners, by channel and direction.",
  attributes: { unit: "By" },
}); // attrs: channel = process | pty | fs | forward | ops, direction = in | out
export const runnerCallDuration = Metric.timer("t3_runner_call_duration", {
  description:
    "Round trip of runner calls, by method. pty.input and process.write approximate the socket RTT.",
});
export const runnerSourcePausedTotal = Metric.counter("t3_runner_source_paused_ms_total", {
  description: "Time runner sources spent paused because buffers were full.",
});
export const runnerBufferHighWaterBytes = Metric.gauge("t3_runner_buffer_high_water_bytes", {
  description: "Highest bytes buffered by one sandbox's runner since its boot.",
  attributes: { unit: "By" },
});
export const runnerAttachDuration = Metric.timer("t3_runner_attach_duration", {
  description: "From the socket upgrade to the answered runner.hello.",
});
```

- **Byte counts** are taken in `RunnerConnection`'s wrappers (one `Metric.update` per chunk, not
  per byte), with `Effect.fnUntraced` where they sit on the stream path.
- **Ping RTT is not observable directly**: `RpcClient` consumes `Pong` internally
  (`RpcClient.ts:1328`) and exposes no hook. `runnerCallDuration` for `pty.input` and
  `process.write`, which do no work on the runner, stands in for it (**proposed**).
- **Spans**: `RunnerHub.hello` (attributes `sandboxId`, `runnerBuildId`, `handles`),
  `RunnerConnection.spawn` with a `first-byte` span event when the first output chunk arrives,
  `RunnerBundle.current` (dev builds are slow and should show up). All `Effect.fn` with stable
  names, so they reach the existing OTLP exporter.
- **Startup marks** in the runner, only when `T3CODE_STARTUP_PROFILE_DIR` is set, as `bin.ts:45`
  does: `performance.mark("runner.start")` first in `sandbox/runner/bin.ts`, then
  `performance.measure("runner.import.main", …)`, `runner.dialed`, `runner.hello`. `vp run
  profile:startup`'s preload already writes them out.

**The benchmark** (`apps/server/scripts/runner-benchmark.ts`, an Effect CLI like
`scripts/cli.ts`). It starts an HTTP server on an ephemeral loopback port with the real
`RunnerRoute`, `RunnerHub` and an in-memory `RunnerGrants`, builds the bundle once with
`RunnerBundle`, then runs each case against two runners: a `node runner.mjs runner` subprocess
over loopback (informational), and Docker on this machine (`docker run --rm --network host -v
<bundle>:/opt/pair-runner/<id>:ro <sandbox image>`, Linux only; the image is `sandbox.baseImage`
or `t3-sandbox:dev` per P3). Each case also runs on `LocalWorkspaceHost` as the baseline.
Latency stamps use `process.hrtime.bigint()` in both child and server, which is `CLOCK_MONOTONIC`
and shared by every process on one kernel, containers included.

| Case                          | How                                                                                         | Fails when (Docker, same machine)    |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------ |
| Startup, bundle mounted       | 10 boots: from `docker start` returning to the `runner.hello` answer                        | p50 > 500 ms                         |
| Startup, bundle fetched       | 10 boots with no mount (bootstrap downloads over loopback)                                  | p50 > 700 ms (500 ms + 200 ms fetch) |
| Provider stdout added latency | child prints 10 000 stamped lines at 1 kHz; receipt minus stamp, minus the local baseline   | p50 > 1 ms or p99 > 5 ms             |
| Keystroke to echo             | PTY running `cat`; 1 000 single bytes, each sent after the previous echo arrived            | p50 > 2 ms                           |
| PTY throughput                | `cat` of a 256 MiB file in the PTY                                                          | < 50 MB/s                            |
| Server CPU per MB             | `process.cpuUsage()` delta over the throughput case, compression off                        | > 5 ms per MB                        |
| Server memory per sandbox     | heap and RSS after 5 attached idle runners, minus before, after a forced GC (`--expose-gc`) | > 8 MiB each                         |

It prints one Markdown table (figure, local, loopback, Docker, budget, pass) for the PR body and
exits 1 on any failing Docker figure. Hosted figures (r/2 + 2 ms and so on) wait for M2's vendor
driver. Product targets from 01 §9 (first token, Send to runner connected) need the full stack
and are taken in M1's integrated pass, not here.

**Tests.** Metrics and spans follow existing patterns and get no new tests (AGENTS.md: no tests
for wiring). One assertion joins an existing 1.8 case in `RunnerResume.test.ts`: after the
stalled-reader case, `t3_runner_source_paused_ms_total` is positive and
`t3_runner_buffer_high_water_bytes` equals the test's `handleBufferBytes`, read from the metric
registry, which pins that the events reach the gauges. The benchmark is a tool, not a test.

**Verify.** `vp test run apps/server/src/sandbox/runnerHub/RunnerResume.test.ts`; `vp run
typecheck` (server, contracts); `vp run check:changed`. Then `vp run bench:runner` on a Linux
machine with Docker and the base image, and `vp run profile:startup` once with a cloud thread to
see the runner marks. Attach the benchmark table to the PR (10 §4 evidence).

**Reviewer checks.**

- No metric or span sits per byte or per event on the stream path; counts update per chunk.
- Metric names follow `t3_<area>_<name>` with units as in `Metrics.ts`; no high-cardinality
  attributes (no sandbox ids on metrics; spans may carry them).
- The benchmark never touches `~/.t3/userdata`: it builds its own state in a temp dir and kills
  only the PIDs and container ids it started (AGENTS.md rule 1).
- Budgets in the script and in `performance-regressions.md` match 03 §2.3 and §9.
- The startup marks cost nothing unless `T3CODE_STARTUP_PROFILE_DIR` is set.

### 1.45 `docs: add the cloud threads guide`

One user guide that lets an admin turn Cloud on and a member use it, written once M1's surfaces
exist, plus the product-doc entries 10 §5 lists for M1 that no feature PR owns. Last, because it
describes what shipped.

- **Needs:** 1.38, 1.39, 1.40, 1.41, 1.42 (it documents their entry points and copy).
  **Unblocks:** none.
- **Not here, by AGENTS.md's rule that a change fixes the docs it makes wrong:** the App key in
  `docs/user/source-control.md` and `team.md` "Set up the GitHub App" (1.27, 1.28), **Use a token
  instead** in `team.md` "Connect your account" (1.28a), `--cloud` in `outside-agents.md` (1.42),
  the notification line in `team.md` (1.43). This PR links to those sections, it does not repeat them.
- **Files:**
  - add `docs/user/cloud.md`, "Cloud threads". A new page has a durable reason: Cloud is a major
    feature with an admin setup, a member flow and its own trust advice, which no existing page
    covers.
  - change `docs/README.md`: `- [Cloud threads](./user/cloud.md)` after Team in "Using Pair".
  - change `docs/user/team.md` "New threads use a worktree" (209): one sentence, "A project can
    start new threads in Cloud instead; see `[Cloud threads](./cloud.md)`."
  - change `docs/product/pair-features.md`: a "Cloud threads on Docker" entry in "On main" with the
    M1 PR links, in the existing entries' style.
  - change `docs/product/decisions.md`: apply 01 §5's M1 amendments: "Solo stays T3 Code"
    clarified; "Provider accounts in cloud" and "Git credentials in cloud" added under Provider
    accounts and Git and GitHub; "Machine failed" under Presence and notifications; and drop the
    concurrency-cap item from "Open follow-ups" (138), as 10 §5 says.

**`docs/user/cloud.md` outline** (task-focused sections; no internals, no file paths, no contributor
tooling; each section a few short paragraphs):

1. **What Cloud does.** A cloud thread runs its agent, terminals and setup on its own machine
   instead of on the server's checkout, so many agents work in parallel without sharing files.
   Transcripts, diffs and approvals stay on your server. Turns keep running when your laptop
   closes, as long as the server is always on; a server inside the desktop app stops them.
2. **Turn on Cloud** (admins). **Settings → Cloud** → **Add Docker driver**: this machine, or
   another Docker host by its address (then also the address machines use to reach this server).
   Plain Docker is not a security boundary; use rootless Docker or gVisor, and the page says when
   neither is in use. **Test** starts a machine, checks it, and removes it. Base image: Pair's
   published image matches your server version; set your own image name to use a mirror. Caps show
   read only: the team's machine limit and starts per minute. Nothing changes for anyone until a
   driver is saved.
3. **Choose which projects use Cloud.** **Settings → Projects**: **Allow cloud threads**, Cloud as
   the project's default workspace, and project environment variables for machines. Team-wide
   variables are in **Settings → Cloud → Environment variables**.
4. **Start a cloud thread.** Pick **Cloud** in the composer's workspace menu and a base branch that
   exists on the remote, or use "New cloud thread" in the command palette (bind a key to it in
   **Settings → Keybindings**). On a phone, choose **Cloud** in the new task screen. Agents and
   scripts: see `[Agents and automation](./outside-agents.md#scripts-and-ci)`. Side chats and forks
   share their thread's machine.
5. **What the status means.** One table: Starting machine, Waiting for a machine, Reconnecting,
   Asleep, Waking machine, Failed (with **Retry** and **Discard**), Machine discarded (**Start a new
   machine**). Anyone can wake or retry; only the thread's owner or an admin can **Sleep now** or
   **Discard machine**. A Docker machine stops when all its threads settle or are archived;
   sending a message or **Wake** starts it again with its files.
6. **Setup scripts in cloud.** The project's setup script runs on every new cloud thread, inside the
   machine, with `T3CODE_SANDBOX=1` set and project paths pointing into the machine. The base image
   is Ubuntu with Claude and Codex; install other tools with `apt-get` in the setup script.
7. **Provider accounts.** Claude works with a setup token from `claude setup-token` or an API key;
   Codex with an API key or a managed account. An account with neither shows as "Local only".
   Cursor and Muse are not supported in cloud. Link `[Team](./team.md#your-own-provider-account)`.
8. **Pushing and pull requests.** A cloud thread pushes with the team's GitHub App when an admin
   added its key (`[Source control](./source-control.md)`), else with the thread owner's own GitHub
   (`[Team](./team.md#connect-your-account)`). Without either it shows "Connect GitHub to push".
   Pushing from a machine works only with GitHub for now.
9. **What agents in a machine can read.** Its thread's provider credential, its git credential
   (your own token, when that is what pushes), and the machine's environment variables. Nothing is
   written to the machine's disk, but anyone who can prompt the thread can ask its agent to print
   what it was started with. Membership is still the trust boundary.
10. **Coming from Conductor Cloud.** Install a team server on an always-on machine, invite the team,
    connect GitHub or add the App key, paste your Conductor install script into each project's
    setup script (use `apt-get` where it used `dnf`), and add headless provider credentials (10 §5).

**Tests.** None (docs).

**Verify.** Follow the guide on a fresh `vp run dev` with seeded data and Docker, top to bottom,
and fix any step that does not match the UI. Check every link resolves (the relative anchors above
exist: `outside-agents.md#scripts-and-ci`, `team.md#your-own-provider-account`,
`team.md#connect-your-account`). `vp run check:changed` for formatting.

**Reviewer checks.**

- Product voice: tasks and decisions, no code names (`sandbox`, `runner`), no file paths; the UI
  says "machine".
- No UI tour: settings paths and what is unintuitive, not every button state.
- Nothing documented that the feature PRs already documented; links instead.
- The isolation advice, the always-on server requirement and what agents can read are all present.

## M1 integrated pass

One run after wave 13, by the primary agent, following [test-t3-app](../../../../.agents/skills/test-t3-app/SKILL.md)
and [test-t3-mobile](../../../../.agents/skills/test-t3-mobile/SKILL.md). It proves 10 §1's M1 exit
criteria end to end. Subagents do not start their own dev servers.

1. **Image.** On a Linux or macOS dev machine with Docker: `vp run sandbox-image:build`, which tags
   `t3-sandbox:dev` (P3, as refined in 1.23).
2. **Server.** `vp run dev` with seeded data (AGENTS.md "Test data"); read the real ports from the
   `[dev-runner]` line. Never set `VITE_HTTP_URL` or `VITE_WS_URL`.
3. **Enable.** In Settings → Cloud, add the Docker driver on the local socket, press **Test**, and
   capture the result with each step's time. Check the isolation warning matches the daemon.
4. **Cloud thread, web.** Pick **Cloud** in the composer on a project whose remote is a test repo,
   send a Replay prompt, and watch "Starting machine" → "Cloning repository" → "Running setup
   script" → the first streamed item. Record a short video, since this is timing. The same from
   the CLI: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model
   showcase --cloud main <project> "go"`.
5. **In the thread.** Open a terminal and create a file; start a side chat and confirm it shares
   the machine; read the turn diff (from the mirror); restore a checkpoint.
6. **Push.** **Commit, push & create PR** to the test repo twice: once with the GitHub App key set
   (the PR opens as the App's bot), once with it cleared and the member's own token set through
   **Use a token instead** (the PR opens as the member). With neither, the thread shows
   "Connect GitHub to push".
7. **Stop and failure.** Settle the thread and confirm the container stops and diffs still read;
   kill the container and confirm "Machine failed" with **Retry** and **Discard**, and the push to
   the owner.
8. **Desktop and mobile.** Repeat step 4 in the desktop app. With `test-t3-mobile`, start a cloud
   thread from the phone and read its status, the machines screen and the token row.
9. **Real providers, once.** One Claude turn on Haiku with a setup token and one managed Codex turn
   on its cheapest model, because those credential paths depend on the real CLIs.
10. **Numbers.** Run 1.44's benchmark and attach its table; record Send to runner connected at p50.

Evidence: before and after captures of the composer, the thread header and Settings → Cloud on
web, desktop and mobile; the video from step 4; the benchmark table; and the transcripts of the
server-only PRs. Stop only the processes this run started, by the PIDs it captured.
