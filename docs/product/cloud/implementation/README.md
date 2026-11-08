# Pair Cloud: implementation plan

Status: M0 and M1 landed and G1 closed; M2 has full specs; the rest is a proposal, rewritten
2026-11-08 for local-first Pair Cloud.
The design is the [plan](../README.md) and its ten docs; this folder turns their PR list
([10 §2](../10-delivery-plan.md#2-pull-request-plan)) into specs an engineer or agent can implement
without re-deriving the design. Before writing it, every code claim in the design docs was checked
against the repo; the [findings](#verification-findings) are at the end.

## How to use this set

| File                                                       | What it holds                                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [m0-seam.md](./m0-seam.md)                                 | M0's 11 PRs (0.1–0.11), full specs, and the M0 integrated pass.                                                                                 |
| [m1-cloud-threads-docker.md](./m1-cloud-threads-docker.md) | M1's 46 PRs, full specs, the build order in waves, each track's notes, and the M1 integrated pass.                                              |
| [m2-pair-cloud-docker.md](./m2-pair-cloud-docker.md)       | M2's 36 PRs, full specs, the build order in waves, the names they share, each track's notes, and the M2 integrated pass.                        |
| [m2-m5.md](./m2-m5.md)                                     | M3–M5 and Later at PR level: scope, the owner rows each takes, its dependencies, and the decision it needs first; M2's rows as first sharpened. |
| [progress.md](./progress.md)                               | Build status, how to resume, notes from every landed PR, and each milestone gate's runs.                                                        |

To implement a PR: read its spec, then the owner-doc sections its title row in 10 §2 names, then
re-read every file and symbol the spec cites, since line numbers drift with upstream merges. Every
spec has the same parts: what it makes true, Needs and Unblocks, Files, Types and services,
Commands and events, Migrations, Tests, Verify, Reviewer checks. Follow AGENTS.md for verifying:
`vp test run <files>` while iterating, `vp run check:changed` before pushing, no repo-wide checks,
and one `test-t3-app` or `test-t3-mobile` pass where a PR changes what users see.

Precedence: the README's decisions 1–19 and D1–D19 are fixed. The design docs say what and why. A
spec says how; where it is more specific than a design doc, the spec wins for that PR. Anything
marked **proposed** fills a gap the design left open: a reviewer can overrule it inside that PR, and
the spec names what else would change.

Write each milestone's full specs the same way while the previous milestone's gate runs: M2's
during G1, M3's during G2, and so on. Each milestone settles names and seams the next one depends
on, so specs written earlier would be guesses. Until then, [m2-m5.md](./m2-m5.md) holds each row at
PR level. M2's were written during G1, in [m2-pair-cloud-docker.md](./m2-pair-cloud-docker.md).

## Build order

M0 → M1 → G1 → M2 → G2 → M3 → G3 → M4 and M5 side by side → G4. A gate is one end-to-end
run of the real desktop app on a member's Mac, through the Pair Cloud server on the
`pair-cloud-pass` VM, to a real machine; the steps for each are in
[10 §4](../10-delivery-plan.md#milestone-gates). The rules:

- A milestone is done only when its gate passes. The next milestone's specs are written, and its
  PRs can be built, while the gate runs, but they merge only after it passes.
- Each bug a gate finds gets its own fix PR with a failing test first (a purely visual bug gets
  before and after captures), and the gate re-runs the steps that failed.
- Each run is captured as video and recorded in [progress](./progress.md). Steps that need the
  maintainer (their Mac, real credentials, a phone, an AWS account) are marked in 10 §4.

Inside each milestone:

- **M0:** 0.1, then the lint rule 0.2, then the routing PRs 0.3–0.6 in parallel, then 0.7, 0.8 and
  0.10, then 0.9 last. 0.11 can land any time before 1.2. See [M0's build order](./m0-seam.md#build-order).
- **M1:** fourteen waves, from the contracts, the base image, the App key and the mirror store
  (wave 1) to the cloud guide and the integrated pass (wave 14). The critical path runs through the
  sandbox contracts, the driver interface, the decisions, the runner hub, flow control, the sandbox
  host, sessions and cloud launch. See [M1's build order](./m1-cloud-threads-docker.md#build-order).
- **G1:** M1 end to end on the VM, then the passes progress still lists as open. See
  [G1](../10-delivery-plan.md#g1-m1-before-any-m2-pr-merges).
- **M2:** seven waves, from cloud-only mode (2.22), idle sleep, the release (2.36), redaction,
  restore mode, the G1 defects and the App's PR reads (wave 1) to the install and cloud guides
  (wave 7). The critical path runs through cloud-only mode, the launch gate (2.23), Cloud only on
  cloud-only servers (2.24), the resolver (2.27), web and desktop routing (2.28), account onboarding
  (2.30) and the docs (2.21). The release and the 30-machine load test (2.40) must be in before G2.
  See [M2's build order](./m2-pair-cloud-docker.md#build-order).
- **M3:** five waves: the agent link (3.19) and the context export (3.22) first, then staged seeds
  and continue locally, the seed checkout, continue in cloud (3.23), and mobile and docs. See
  [M3's waves](../10-delivery-plan.md#m3-continue-in-cloud).
- **M4 and M5:** merged side by side after G3. M4 starts with the outbox's aggregate key (4.11),
  which merges before any row that adds effect types; M5 starts with the EC2 driver (5.4), the
  internal listeners and the policy keys, builds AMIs (5.7) once Docker builds (4.14) are in, and
  ends with the AWS kit and its CI. See [M4's waves](../10-delivery-plan.md#m4-team-images) and
  [M5's waves](../10-delivery-plan.md#m5-byoc-on-aws).
- **Early starts:** the base image (1.20), the GitHub App key (1.27) and the mirror store (1.30)
  needed nothing from M0 but 0.1. M2's rows that need only M1 can be built while G1 runs. The secret
  providers (5.2, 5.3) and the runner's CA and proxy support (5.8) can be built any time and merge
  with M5.

## Shared names

Every spec uses these, so the tracks fit together.

- **Folders.** `apps/server/src/workspaceHost/` for the seam. `apps/server/src/sandbox/` with
  `runner/` (the in-sandbox runner), `runnerHub/` (its server side), `compute/` (drivers),
  `lifecycle/` (decisions, effects, admission, the lifecycle worker, the reconciler, cloud
  preparation), `credentials/`, `mirror/` and `image/`. `infra/sandbox-image/` for the base image.
  Upstream files get small mechanical edits: a switch arm per sandbox command in `Orchestrator.ts`,
  one layer in `server.ts`, and `Context.Reference` hooks with no-op defaults where upstream code
  must call sandbox code (the `PinnedGitHubCredential` pattern).
- **Contracts.** `packages/contracts/src/sandbox.ts` (`SandboxId` as `sbx_` plus 20 hex, `SandboxState`,
  `SandboxSize`, `ComputeDriverId`, `SandboxAsleep`); `orchestrationV2.ts` (`OrchestrationV2Sandbox`,
  thread `sandboxId`, the shell summary, client commands `sandbox.wake|sleep|retry|discard`, internal
  commands, one `sandbox.updated` event); `runner.ts` under the `@t3tools/contracts/runner` subpath;
  `ServerSettings.sandbox` in `settings.ts`.
- **Command ids.** `sandbox-created:<id>:<generation>`, `sandbox-attached:<id>:<generation>:<runnerBootId>`,
  `sandbox-lost:<id>:<generation>:<runnerBootId>`, `sandbox-wake:<id>:<ownerThreadId>:<generation>`,
  `sandbox-release:<runId>:<generation>`, `sandbox-adopt:<id>:<oldOwnerThreadId>`. A receipt
  matches only its own thread, so ids name the owner; a guarded worker command that may be resent
  takes a fresh id, as `thread.auto-settle` does.
- **Effects.** `sandbox.create`, `.start`, `.stop`, `.destroy`, `.status`, `.request-wake`,
  `.release-waiters`, `.hand-over`: all replay safe and bounded at 60 s in the effect worker.
- **Migrations.** `088_SandboxProjections` (1.3), `089_SandboxRunnerGrants` (1.7) and a small
  `MemberGitHubSource` (1.28a), each taking the next free id at merge. No mirror table in M1.
- **Bootstrap.** `PAIR_RUNNER_URL`, `PAIR_SANDBOX_ID`, `PAIR_RUNNER_BUILD`, `PAIR_RUNNER_ENROLL`.
  Scripts in cloud see `T3CODE_SANDBOX=1`, and every sandbox process carries `T3CODE_THREAD_ID`.

## Proposed answers to gaps that blocked implementation

The design docs left these open, and each one blocks code. Each is the smallest answer that works;
the PR that first needs it carries it.

| #   | Gap                                               | Proposed answer                                                                                                                                                                                                                                                                                                                                                                | First PR       |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| P1  | What lives under `/t3-sandbox/<id>/`              | Everything the server reads or writes by path: `repos/<host>/<owner>/<name>` (the clone), `worktrees/<slug>` (checkouts), `homes/<providerInstanceId>/` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), `attachments/<thread>/`. `HOME`, `/run/pair-runner` and `/opt/pair-runner` stay outside, never addressed by path. On Docker the root is a named volume with its container's name. | 1.14, 1.16     |
| P2  | The "install id" in sandbox names and tags        | The server's environment id, not the telemetry id (absent when telemetry is off).                                                                                                                                                                                                                                                                                              | 1.4            |
| P3  | A base image for a server run from source         | `sandbox.baseImage` if set, else `t3-sandbox:dev` (built by `vp run sandbox-image:build`), else the published image for the server's version.                                                                                                                                                                                                                                  | 1.20, 1.23     |
| P4  | How an M1 checkout is made                        | Clone the project's remote into `repos/`, fetch if present, `git worktree add` from `origin/<baseRef>`, through the sandbox host with a thread-bound credential. `baseRef` must exist on the remote.                                                                                                                                                                           | 1.16           |
| P5  | Testing cloud threads for free                    | Replay (dev) is an ACP agent; the dev runner bundle carries it and its transcripts, and the ACP session spawn routes through the host. Released servers have none, so the BYOC kit's CI uses a terminal command and one cheapest-model turn.                                                                                                                                   | 0.6, 1.9, 1.12 |
| P6  | The seam and sandbox state                        | `WorkspaceHosts` knows only registered hosts; an unregistered sandbox path fails with `WorkspaceHostUnavailableError { sandboxId }`. Callers needing the state read the projection, avoiding a layer cycle.                                                                                                                                                                    | 0.1, 1.11      |
| P7  | The runner bundle on a source-run server          | Built once per server process on first use; its id is the sha256 over each file's path, mode and hash, as for releases.                                                                                                                                                                                                                                                        | 1.9            |
| P8  | Migration numbering                               | Pair shares upstream's ids (080–087 are Pair's already) and the migrator refuses a database whose recorded names differ below its head. Take the next free id at merge, keep sandbox schema changes few, and renumber on upstream merges as today.                                                                                                                             | 1.3            |
| P9  | Where `defaultsToCloud` and `sandboxAllowed` live | Project settings override keys only, special-cased like `providerInstances`, since project records' env-mode field is legacy.                                                                                                                                                                                                                                                  | 1.36           |
| P10 | What gates Cloud on clients                       | In M1, an optional `ServerSettings.sandbox`, omitted until a driver is configured: capabilities are fixed at startup, while settings stream redacted to every client. From M2, cloud-only mode is itself a startup mode, so it sets `capabilities.cloudLaunch` (2.24) and the driver list still comes from settings.                                                           | 1.36, 1.37     |
| P11 | Team cap across threads                           | A process-wide admission lock taken in `dispatchWithReceipt` for commands that take a slot, ordered before the thread lock; the start-rate bucket sits under it.                                                                                                                                                                                                               | 1.18           |
| P12 | `host.info`                                       | An `Effect`, not a value, because today's code and tests read `HostProcess` per call; the sandbox host returns a constant.                                                                                                                                                                                                                                                     | 0.1            |
| P13 | Which thread a git request is for                 | The helper sends `T3CODE_THREAD_ID`; the server checks the thread is bound to the asking sandbox and answers for its project remote only, github.com only in M1; no thread id means the owning thread. App failures fall through to the owner's credential.                                                                                                                    | 1.28           |
| P14 | How the mirror checks agent-made objects          | `git index-pack --strict` on import (Git 2.43 skips `transfer.fsckObjects` for bundles); the mirror path is `<base64url(projectId)>.git`.                                                                                                                                                                                                                                      | 1.30           |
| P15 | Writes to a stopped cloud thread                  | A `SandboxAsleep` error carried inside the existing `ProjectWriteFileError`, so old clients decode it.                                                                                                                                                                                                                                                                         | 1.33           |
| P16 | The Settings **Test** button                      | A check machine with no thread: `RunnerHub.expectCheck` waits for its hello without dispatching anything, and the check stops after `git --version` (the page has no project, so no setup script).                                                                                                                                                                             | 1.40           |

The track notes in [M1](./m1-cloud-threads-docker.md#track-notes) list the smaller proposals each
spec makes (for example the runner's exit codes, fd 3 for the watcher, one bridge network per
install, and dropping the "3 of 3 running" count until M2).

## Verification findings

Every concrete claim in docs 01–10, the README and the research page was read against the code on
`feat/pair` (about 500 claims; every relative link and anchor resolves). Wrong claims were fixed in
place in the owning doc. Most held. These are the corrections that matter, by doc.

| Doc                                     | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README](../README.md)                  | Decision 9's wording: the M4 outbox change is a table rebuild plus a `team-image` receipt and stream kind, not "one additive change". The decision itself stands.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [01](../01-product.md)                  | The local mode is labeled "Current checkout". The invite dialog's real text is quoted. Admins always see Settings → Team.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [02](../02-workspace-host.md)           | Replay (dev) is an ACP agent ([dev-replay-agent.ts](../../../../apps/server/scripts/dev-replay-agent.ts)), not `replayWorkspace.ts`. A turn costs about 56 sequential round trips, not 28, because every checkpoint call re-runs VCS detection; checkpoint capture must run the whole `CheckpointServiceV2` capture in the runner to get turn end down to about 6. `FileSystem.FileSystem` is an interface, not a service class. Inventory counts, the Claude spawn path (`node:child_process`), `resolveSettings` running in process, and the search index key (cwd and variant) were corrected. |
| [03](../03-runner.md)                   | The runner dials with `NodeWS` (the `ws` package), not `NodeSocket`. `RpcClient.makeProtocolSocket` has no "retries off" switch. `RpcServer.makeProtocolSocketServer` already takes any `SocketServer`, so the one-socket adapter is about 20 lines. The history worker must be built unsplit for the bundle. The MCP endpoint is the server's bind address, and the `mcp` forward must be an HTTP proxy that checks each bearer, since `/mcp` also takes member API tokens.                                                                                                                      |
| [04](../04-sandbox-lifecycle.md)        | Deciders read other threads' projections without their locks, so the team cap needs a process-wide admission lock. Retries end within about 2 s. Recovery cancels `preparing` runs; cloud ones are re-armed with `ThreadLaunchService.prepareRun`. Rejections keep their receipts, so resent guarded commands take fresh ids, and a receipt matches only its own thread, so wake ids name the owner. Deleting a thread deletes its side chats, so only forks adopt. The Scheduler ticks every 5 s with a `DueHint`.                                                                               |
| [05](../05-team-images.md)              | The outbox change (as in the README). Build secrets are `SecretReference`s, since `SettingsSecretValue` also takes a literal. The image's repos move into `/t3-sandbox/<id>/repos`, a copy on Docker's named volume. `CommandOutputHub` keeps no files.                                                                                                                                                                                                                                                                                                                                           |
| [06](../06-credentials-and-security.md) | No GitHub App ID or private key setting exists; the client ID is an env var. Codex sets authorship per thread through one app-server per instance. Auth sessions are HMAC-signed, not hashed. `retireOrphans` disables accounts but a running process keeps its token. `create_threads` has no placement input. The mirror checks imports with `git index-pack --strict`, not `receive.fsckObjects`. Installation tokens are cached on the server, not in the runner.                                                                                                                             |
| [07](../07-access-and-data.md)          | The sync design: no `--prune` (a bundle holds one capture's refs), `index-pack --strict` (Git 2.43 skips `transfer.fsckObjects` for bundles), a missing prerequisite fails `bundle create` in the sandbox, and the first bundle needs a mirror commit as its prerequisite. The bare mirror works with the git driver's `-C`; only detection blocks it. Restore safety also runs at admission. PR discovery silently falls back to the project root. Search needs a refresh call. Attachments go under the reserved root. The agent's `gh` uses the thread's git credential.                       |
| [08](../08-clients-and-contracts.md)    | Project defaults live in project settings overrides, so `defaultsToCloud` is an override key, not a project-record field. The launch strategy is used in seven places. Settings, not a capability, gate Cloud (proposed; capabilities are fixed at startup). D1's token input is `TrimmedNonEmptyString`. File locations for usage, mobile modes, keybindings, MCP tools and the CLI were corrected.                                                                                                                                                                                              |
| [09](../09-byoc.md)                     | A background service listens on loopback by default (`T3CODE_LAN=false`), so the kit sets `T3CODE_HOST`. The secret resolver's real location. `T3CODE_RELEASE_BASE_URL` already lets the installer use another release host. The kit's CI can't use Replay.                                                                                                                                                                                                                                                                                                                                       |
| [10](../10-delivery-plan.md)            | Needs and graph edges made consistent, owner references fixed, and the PR-list changes below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [Research](../../conductor-cloud.md)    | Marked as superseded by the plan where they differ; inventory and tool counts updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Changes to decisions, milestones and PR order

The verification changed no README decision. Two decisions' wording did, to match the code:

- **Decision 9.** The M4 outbox change is a table rebuild plus a `team-image` receipt and stream
  kind, a commit path that writes its effects, and its lock, not "one additive change". The
  decision (builds belong to no thread, so the outbox gains an aggregate key in M4) stands; 4.11's
  scope grows.
- **Decision 7.** `defaultsToCloud` is a project settings override, not a project-record field,
  because project records' env-mode field is legacy. The decision (a sibling flag, never `cloud` in
  persisted strict fields) stands.

PR order and scope in 10 §2, each because the code required it:

| Change                                   | Why                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 0.12 dropped                             | Capabilities are fixed at startup, so settings gate Cloud instead (P10).                               |
| 0.13 folded into 1.37                    | An export with no importer fails knip; its input arrives with 1.36.                                    |
| 0.6 and 1.12 route the ACP session spawn | Replay (dev), the free test provider, is an ACP agent. Other ACP agents stay Later (3.14).             |
| 0.3 and 0.8 widened                      | VCS detection, path canonicalization and restore safety at admission also read the server's disk.      |
| 1.5a folded into 1.5                     | The bound and the replay-safe list are tied to the effect types 1.5 adds.                              |
| 1.36 before 1.4                          | The driver registry reads driver instances from settings.                                              |
| 1.9 needs 1.7                            | The bundle routes authenticate with 1.7's grants.                                                      |
| 1.18 after 1.17                          | Both edit `dispatchWithReceipt`.                                                                       |
| 1.32 before 1.31                         | The mirror reader doesn't need the sync.                                                               |
| 1.33 redefined                           | Live terminals and files ride 1.10 and 1.11; what was left is reading stopped threads from the mirror. |
| 1.40 needs 1.16, 1.18, 1.23, 1.30        | The Test button boots a runner; the page shows caps, the base image and the mirror size.               |
| 1.41 carries D1's mobile half            | Mobile has no member GitHub UI today.                                                                  |
| Head-context record from 1.31 to 2.9     | Nothing reads it while M1's sandboxes stop only when settled.                                          |
| 2.4 before 5.4                           | Effect retries end within about 2 s, so a driver's 429 fails a sandbox at once without `retryAfterMs`. |
| 5.10 without Replay                      | Replay exists only on dev servers.                                                                     |

The full list, with each PR's smaller Needs changes, is in [M1's summary](./m1-cloud-threads-docker.md#what-the-code-changed-in-10-2)
and 10 §2 itself.

## Traps for implementers

- **Fork migrations.** Pair's migration ids share upstream's sequence, and the migrator rejects a
  database whose names differ below its highest recorded id (`persistence/Migrations.ts`). Every
  upstream merge that brings new ids needs a renumbering plan before it lands (P8).
- **Turn cost over the wire.** Every checkpoint call re-runs VCS detection, so a turn is about 56
  sequential round trips if each primitive crosses the socket. 1.10's coarse capture must run the
  whole checkpoint service call in the runner, not just the git driver's capture.
- **Receipts are forever.** A rejected command keeps its receipt, and a receipt matches only its own
  thread. Deterministic ids name the owner; resent guarded commands take fresh ids; no-op commands
  go on dispatch's no-event allow list.
- **A delayed effect blocks its thread.** The outbox runs one effect per thread in rowid order,
  whatever `available_at` says. A slow mirror sync delays the thread's next turn; a long
  `retryAfterMs` holds its queue.
- **Paths outside `/t3-sandbox/<id>/` route to local disk.** Anything the server reads or writes by
  path in a sandbox must sit under the root (P1).
- **Every new machine passes the launch gate.** On a server that isn't cloud-only, nothing may
  create a machine (2.23). A new decision that provisions, including a wake or retry that rebuilds a
  lost disk, must call the same check as `resolveCloudLaunch`, and a client command that carries a
  placement must stay internal.
