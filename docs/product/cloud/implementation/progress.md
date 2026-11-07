# Pair Cloud: implementation progress and handoff

Status: in progress on `feat/pair`, updated by the lead agent after every landed PR. This file lets
another session (or another account) resume the M0 + M1 build exactly where it stopped. Delete it
when M1's integrated pass is done; the merged commits are the record.

Scope of this run: M0 (11 PRs) and M1 (46 PRs) from [m0-seam.md](./m0-seam.md) and
[m1-cloud-threads-docker.md](./m1-cloud-threads-docker.md), then both integrated passes. M2–M5 have
no specs yet ([README](./README.md): write them after M1 lands).

## Status

**Landed on `feat/pair` (46 of 57):**

- M0, complete: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.11. 0.10 was folded into 1.11 (allowed
  by M0's plan: "0.10 may slip into 1.10").
- M1: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.13, 1.14, 1.15, 1.19, 1.20, 1.21,
  1.22, 1.23, 1.25, 1.27, 1.30, 1.32, 1.36, 1.37, 1.44, 1.31, 1.28, 1.33, 1.28a, 1.12, 1.29, 1.26, 1.35, 1.34.

**In flight when this was written** (local worktrees `../pair-wt/<id>` on branches `wt/<id>`, not
pushed — if the container is gone, restart these from their spec):

- 1.16 cloud launch (critical path)

**Not started (9), in dependency order** (Needs from [M1's table](./m1-cloud-threads-docker.md#build-order)):

| Next when  | PRs                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| after 1.12 | 1.16 cloud launch (critical), 1.26 provider credentials (also 1.13, 1.25), 1.34 attachments                          |
| now        | 1.29 revocation (needs 1.19, 1.28 — landed)                                                                          |
| after 1.16 | 1.17 shared sandboxes, 1.24 setup scripts, 1.38 web Cloud mode (also 1.37), 1.42 MCP + CLI, 1.43 machine-failed push |
| after 1.28 | 1.28a owner's GitHub, then 1.29 revocation (also 1.19), 1.35 push + PR (also 1.31)                                   |
| after 1.17 | 1.18 admission                                                                                                       |
| after 1.38 | 1.39 web header + menus                                                                                              |
| after 1.18 | 1.40 Settings → Cloud (also 1.16, 1.23, 1.25, 1.30)                                                                  |
| after 1.40 | 1.41 mobile (also 1.28a, 1.37, 1.38)                                                                                 |
| last       | 1.45 cloud guide, then the M0 and M1 integrated passes                                                               |

Critical path left: 1.12 → 1.16 → 1.17 → 1.18 → 1.40 → 1.41.

## How to resume

The lead agent orchestrates; workers implement one PR each in a sibling worktree and report back;
the lead rebases, typechecks, fast-forwards `feat/pair` and pushes. Keep about four workers at a
time (four CPUs, 15 GB, and usage limits: eight Opus workers exhausted a 5-hour window). Models: Opus
high for critical-path and security PRs, Opus medium or Sonnet high for the rest.

### Machine setup (a fresh container)

1. Node 26 (the repo pins 26.12.1): download `https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-x64.tar.xz`
   into `/opt/node26`. Then `npm i -g vite-plus@1.4.0 pnpm@12.14.0` with that Node (the
   `curl … | bash` installer may be blocked).
2. `export PATH=$PWD/node_modules/.bin:/opt/node26/bin:$PATH`, then `vp i`. Always use the
   repo-local `vp`: the global one fails server `it.layer` tests ("reading 'config'"). In a
   worktree, use that worktree's own `node_modules/.bin`.
3. Docker (for 1.14's contract suite and real-container checks): `nohup dockerd >/tmp/dockerd.log 2>&1 &`.
   Docker Hub may return 429 here: pull `mirror.gcr.io/library/ubuntu:24.04` and tag it `ubuntu:24.04`.
4. `t3-sandbox:dev`: `vp run sandbox-image:build` fails behind an HTTPS-intercepting proxy
   (`curl: (60)`). Workaround: `node apps/server/scripts/sandbox-image.ts context <dir>`, copy the
   proxy CA into `<dir>/proxy-ca.crt`, add after `ARG PAIR_VERSION=dev` in `<dir>/Dockerfile`:
   `COPY proxy-ca.crt /tmp/proxy-ca.crt` and
   `ARG CURL_CA_BUNDLE=/tmp/proxy-ca.crt NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.crt SSL_CERT_FILE=/tmp/proxy-ca.crt`,
   then `docker build --network host --target base --build-arg PAIR_VERSION=dev --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg https_proxy="$https_proxy" --build-arg NO_PROXY="$NO_PROXY" -t t3-sandbox:dev <dir>`.
5. Known environment-only test failures (fail on `feat/pair` too): `GitVcsDriver` partial-clone
   insteadOf case, anything needing `ssh-keygen` (signed-commit cases in GitVcsDriverCore,
   GitManager, CheckpointStore), RepositoryIdentityResolver (insteadOf), DeviceService ("T3 Code"
   vs "Pair"), RemoteDelegation (message-read count).

### Lead scripts (recreate in `../pair-wt/`)

`mkwt.sh`:

```bash
#!/bin/bash
# usage: mkwt.sh <id>...  creates /home/user/pair-wt/<id> on wt/<id> from feat/pair and installs
set -e
export PATH=/home/user/pair/node_modules/.bin:/opt/node26/bin:$PATH
for id in "$@"; do
  d=/home/user/pair-wt/$id
  git -C /home/user/pair worktree add -q "$d" -b "wt/$id" feat/pair
  (cd "$d" && vp i --frozen-lockfile -- --yes > "$d.install.log" 2>&1) && echo "ready $id" || echo "INSTALL FAILED $id"
done
```

`land.sh`:

```bash
#!/bin/bash
# usage: land.sh <id>  rebase wt/<id> onto feat/pair, fast-forward feat/pair, typecheck touched packages
set -e
export PATH=/home/user/pair/node_modules/.bin:/opt/node26/bin:$PATH
id=$1
wt=/home/user/pair-wt/$id
git -C "$wt" status --porcelain | grep -v '^??' && { echo "DIRTY worktree $id"; exit 1; } || true
git -C "$wt" rebase feat/pair || { echo "REBASE CONFLICT $id"; exit 2; }
cd /home/user/pair
before=$(git rev-parse HEAD)
git merge --ff-only -q "wt/$id"
files=$(git diff --name-only "$before" HEAD)
echo "$files" | grep -q 'pnpm-lock.yaml\|package.json' && vp i --frozen-lockfile -- --yes >/tmp/land-install.log 2>&1
pkgs=$(echo "$files" | grep -oE '^(apps|packages)/[^/]+' | sort -u)
echo "$pkgs" | grep -q 'packages/\(contracts\|shared\|client-runtime\)' && pkgs=$(printf '%s\n' $pkgs apps/server apps/web packages/client-runtime | sort -u)
fail=0
for p in $pkgs; do
  [ -f "$p/package.json" ] && grep -q '"typecheck"' "$p/package.json" || continue
  (cd "$p" && vp run typecheck > /tmp/land-tc.log 2>&1) && ! grep -q "error TS" /tmp/land-tc.log && echo "typecheck ok $p" || { echo "TYPECHECK FAIL $p"; grep -E "error TS" /tmp/land-tc.log | head -20; fail=1; }
done
git log --oneline "$before"..HEAD
exit $fail
```

`push.sh`:

```bash
#!/bin/bash
cd /home/user/pair
for d in 0 2 4 8 16; do sleep $d; git push -q -u origin feat/pair && { echo pushed $(git rev-parse --short HEAD); exit 0; }; done
exit 1
```

Per PR: `mkwt.sh <id>`, launch a worker with the prompt below, and on its report `land.sh <id> && push.sh`, then append the worker's notes to the section below and update Status here. On a rebase conflict, resolve in the worktree, `git rebase --continue`, rerun `land.sh`. `land.sh` fails on any `error TS` line, not only the exit code.

### Worker prompt

Each worker gets: "Implement Pair Cloud PR **<id>** `<spec title>`. Read and follow ../pair-wt/WORKER_BRIEF.md first …", plus the spec section, the track notes, the design docs it cites, which landed PRs' notes below to read, which parallel workers' files to avoid, and the security or critical-path emphasis. The brief:

````markdown
# Pair Cloud worker brief

You are one worker implementing one PR of the Pair Cloud plan, under a lead agent who merges your
branch into `feat/pair`. Several workers run at once in sibling worktrees on this machine.

## Your checkout

- Your worktree is `../pair-wt/<PR>` on branch `wt/<PR>`, already created and installed.
  Work only there. Never touch `<integration checkout>` (the lead's integration checkout) or other
  worktrees under `../pair-wt/`.
- Handoff notes from already-landed PRs: `../pair-wt/HANDOFF.md` (read the entries your PR
  builds on; they record where the code differs from the spec).
- Toolchain: run `export PATH=$PWD/node_modules/.bin:/opt/node26/bin:$PATH` from the worktree root
  in every shell (Node 26, `pnpm`). Use the repo-local `vp` (`node_modules/.bin/vp`): the global
  `/opt/node26/bin/vp` fails server `it.layer` tests ("reading 'config'").
- If the lead says your branch must be rebased onto newer `feat/pair`, run
  `git -C ../pair-wt/<PR> rebase feat/pair` (the local branch, no fetch needed).

## What to read first

1. `../pair-wt/<PR>/AGENTS.md` (repo rules: testing, taste, comments, lint, effect style).
2. `docs/product/cloud/implementation/README.md` (shared names, proposed answers P1–P16, traps).
3. Your PR's spec in `docs/product/cloud/implementation/m0-seam.md` or `m1-cloud-threads-docker.md`
   (search for its `### <number>` heading), plus the track notes for M1 PRs, plus the design-doc
   sections it cites. `m1-cloud-threads-docker.md` is 7k lines: read your section, not the file.
4. Re-read every file and symbol the spec cites. Line numbers drift; the spec may be wrong in a
   detail. The code wins on facts; the spec wins on intent. Note any deviation in your report.
5. `.repos/effect/LLMS.md` when writing Effect code; prefer existing repo patterns.

## Rules

- Implement exactly your PR's scope. Do not build later PRs' fields "while you're there" (knip fails
  unused exports). If something your PR needs from an earlier PR is missing, say so in the report
  and implement the smallest stand-in only if unavoidable.
- No dev servers, no `vp run dev`, no real provider turns, nothing under `~/.t3`. Don't kill any
  process you did not start. Docker IS running on this machine (the lead started it). Docker Hub returns 429, so pull
  from `mirror.gcr.io/library/<image>` and tag locally if needed; `ubuntu:24.04` is already
  tagged. Clean up containers/volumes/networks you create; never remove ones you did not create.
- Iterate with `vp test run <files>` and `vp run typecheck` in the affected package dirs.
  Do not run repo-wide checks (`vp check`, `vp run -r ...`).
- Before you finish, run `vp run check:changed feat/pair` from the worktree root and make it pass
  (format with `vp fmt <files>` if it reports formatting). If something fails that is unrelated to
  your change (already failing on `feat/pair`), say so with the output.
- Known environment-only failures on this machine (they fail on `feat/pair` too; ignore them):
  `GitVcsDriver.test.ts` "lists the fetch and push URLs of a partial clone remote" (git insteadOf
  rewrite), anything needing `ssh-keygen` (signed-commit cases in GitVcsDriverCore, GitManager,
  CheckpointStore), RepositoryIdentityResolver (insteadOf), DeviceService ("T3 Code" vs "Pair") and
  RemoteDelegation (message-read count).
- Many workers share 4 CPUs and 15 GB. An exit 137 from typecheck/knip is out-of-memory, not your
  code: rerun it once. Prefer focused `vp test run <files>` over broad runs while iterating.
- Tests follow AGENTS.md: behavior that can break, at the lowest layer, extend existing files, no
  sleeps/polling/timeouts.
- Commit on `wt/<PR>` (one commit is ideal, more are fine) with a conventional title — use the PR
  title from the spec — and a body: the problem in a sentence or two, then how you fixed it. End the
  message with exactly these lines:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PuJ25TsdFHdVqJmN4VLGii
  ```

  Never push. Never create PRs. Never include a model identifier anywhere else in commits or code.

- The container can restart without warning (background shells die). Commit work-in-progress to
  `wt/<PR>` every time a meaningful piece compiles (`wip:` commits are fine; squash before your
  final report). Don't park long test runs in background shells you wait on.
- Do not commit plans or scratch notes.

## Your final message (the lead reads only this)

Keep it under 350 words:

1. Commit sha(s) on `wt/<PR>`.
2. What landed, by file (one line each for the important ones).
3. Deviations from the spec and why; anything marked proposed that you decided.
4. Test and `check:changed` results (pass/fail, with the failing line if any).
5. Anything a later PR must know (new names, seams, gotchas), and anything left undone.
````

## Notes from landed PRs

Where the code differs from the spec, and what later PRs must know. Workers read the entries their PR builds on.

## 0.1 WorkspaceHost seam (landed)

- `apps/server/src/workspaceHost/`: WorkspaceHost.ts, LocalWorkspaceHost.ts, WorkspaceHosts.ts (exports `make` and `layer`), WorkspaceHostTesting.ts (`layerFromContext`), test.
- `WorkspaceHostError` is NOT added yet (0.10 adds it). Tests that need WorkspaceHosts add `WorkspaceHostTesting.layerFromContext` to their provide list.
- The stub FileSystem in layerFromContext throws on any call (so a test can't mistake it for an empty disk).

## 0.11 contract split (landed)

- `OrchestrationV2RunWorkspacePreparation` exported; `OrchestrationV2ThreadLaunchWorkspaceStrategy` is an alias of the same schema. Run records + `defer_start.workspaceStrategy` use the run name.
- 1.16: widen only the launch alias with `cloud`; add a cloud-launch case decoding with `oldRunWorkspacePreparation` (module scope in orchestrationV2.test.ts).

## 1.27 GitHub App key (landed)

- `packages/source-control-github/src/shared/definition.ts` settings: `appId` (TrimmedString, "" = unset), `appPrivateKey` (SettingsSecretValue, secret).
- Read with `getWithSecrets("github")`; secret name `sourceControlHostSecretName({ kind: "github", field: "appPrivateKey", serverHost: null })`.
- Normalize PEM on the server like web's `restorePemLineBreaks` (GitHubAppKeySettings.logic.ts). 1.28 still owns the docs/user/source-control.md section.

## 1.1 runner protocol (landed) — `packages/contracts/src/runner.ts`, subpath `@t3tools/contracts/runner`

- `RUNNER_PROTOCOL_VERSION`, `RUNNER_METHODS`, `RunnerCoreRpcGroup` (42), `RunnerOpsRpcGroup` (7 incl. `ops.search.refresh`), merged `RunnerRpcGroup`. Individual Rpc consts are not exported.
- `RunnerSystemError` mirrors Effect's PlatformError: `reason`, `module`, `method`, optional `description`, `syscall`, `pathOrDescriptor` (not the spec's path/errno).
- Empty successes are `Schema.Void`. Frame cap fails in SchemaBinary's parser ("frame within maxFrameSize").
- TCP `connectionId` is a `RunnerHandleId` (resumes like a process). Paths are non-empty, untrimmed strings. `fs.stat` returns File.Info with Option→null, dates epoch ms, bigints kept.
- 1.6: stream keys in `RunnerHandleState.next`: output `fd:<n>`, `pty`, `tcp`; input `in:<fd>`, `in:pty`, `in:tcp`. Input seq = per-input call counter; output seq = chunk start offset. Extra fds must be >= 4; no wire processGroup (every spawn gets its own group).
- 1.8: stream element schema is `successSchema.success` (detect with `RpcSchema.isStreamSchema`).
- `ops.ports.listeners` reuses `DiscoveredLocalServer`; runner sends null for thread fields, server fills them.
- 1.10/1.11: ops schemas reuse the client schemas (spec names like `RunnerOpsSearchListInput` were not used). 1.13/1.28 add git-credential schemas; `RunnerForwardName` already declared.

## 1.20 base image (landed) — `infra/sandbox-image/`

- Dockerfile targets `base` and `with-runner` (1.21 passes `--build-context runner=<dir>`). provision.sh, pair-bootstrap.sh (entrypoint), versions.env, providers/package.json (+lock, Claude Code 2.1.311). `/etc/pair-image.json` keys `claudeAgent`, `codex` (1.22 reads them).
- `apps/server/src/provider/codexReleases.ts` holds `CODEX_RELEASES` (leaf module). `apps/server/scripts/sandbox-image.ts` (`context`, `build [--tag]`); root script `sandbox-image:build`.
- Local image `t3-sandbox:dev` exists on this machine (built with the proxy CA injected by hand; plain `vp run sandbox-image:build` fails here on curl (60) because of the sandbox's HTTPS proxy CA — environment-only).
- `PAIR_RUNNER_URL` is `http(s)://host` or `unix:/path` (single colon). 1.14 must write `bootstrap.env` into the container layer (copy, not bind-mount): the script deletes it.
- The runner must write `/run/pair-runner/server-build` before exiting 75 (bootstrap then refetches the build once and reruns). Bundle `sha256` file may be bare hex or `hex  name`.

## 1.22 CLI pin check (landed)

- `apps/server/scripts/sandbox-image.ts check-providers [--version <v>]` (accepts leading `v`). `readProviderPins`, `checkProviderPins`, `SandboxImageProviderPinError`.
- 1.21 MUST run `node apps/server/scripts/sandbox-image.ts check-providers --version "${GITHUB_REF_NAME}"` first in the release `bundle` job, before any push. `.github/workflows/sandbox-image.yml` has a `check-providers` job; `build` needs it.

## 1.2 sandbox contracts (landed)

- `packages/contracts/src/sandbox.ts` (exported from index): `SandboxId` (`^sbx_[0-9a-f]{20}$`, branded), `ComputeDriverId`, `ComputeDriverKind` (`docker`), `SandboxState`, `SandboxSize`, `SandboxAdmissionReason`, `SandboxSleepReason`, `SandboxFailure`.
- orchestrationV2.ts: `OrchestrationV2SandboxAdmission`, `OrchestrationV2Sandbox`, `OrchestrationV2SandboxJson`; optional `sandboxId` on threads; `sandboxId` + `sandbox` summary (`OrchestrationV2ThreadShellSandbox`, ForwardCompatibleNullable state/admission.reason) on shells; `sandbox` on projection. `sandbox.updated` event in both event unions. Client commands `sandbox.wake|sleep|retry|discard`; 11 internal commands in the unexported internal union (each its own struct so `Extract<…,{type}>` works). `prepared-run.progress` phases gain `sandbox-admission`, `sandbox-start`, `clone`.
- Orchestrator.ts: `commandThreadId` routes sandbox commands to `command.threadId`; `dispatchOnce` default still REJECTS them (1.5 adds deciders). `preparedRunProgressTitle(phase)` switch. OrchestratorScenario testkit has arms for the 4 client commands.
- ProjectionStore.ts `applyToProjection` already has the `sandbox.updated` arm (`{...projection, sandbox: event.payload}`) — 1.3 must NOT re-add it; 1.3 owns the SQL apply arm, shell reads, ShellStream. client-runtime orchestrationV2Projection.ts has the same arm. AgentAwarenessRelay ignores sandbox.updated.
- TODO for 1.5 or 1.37: `clientRpcRequiredScopes` branch for `sandbox.*` (08 §8). `WorkspaceHostUnavailableError.sandboxId` still Schema.String. `baseImage` not on the record (1.23 adds it).

## 1.30 checkpoint mirror (landed) — `apps/server/src/sandbox/mirror/CheckpointMirror.ts`

- Service: `gitDir`, `ensure`, `tips`, `importBundle`, `deleteRefs`, `deleteThreadNamespace`, `remove`; `CheckpointMirrorError` (reasons incl. `missing-project`, `invalid-objects`, `git`), `MirrorRefUpdate`, `layer` (provided in server.ts below layerOrchestrationApplication). Per-project KeyedLock; layer start removes mirrors of deleted projects.
- Mirror git commands pass `--git-dir` (GitVcsDriver sets safe.bareRepository=explicit). `ExecuteGitInput.stdin` also accepts `Stream<Uint8Array, PlatformError>`.
- Thread ref namespace: `sandboxThreadRefPrefix(threadId)` = `refs/t3/sandbox/<base64url(threadId)>/` — 1.31 MUST write refs with it, and call `ensure` before `importBundle`.
- ProjectService.deleteProject calls `mirror.remove` via `Effect.serviceOption(CheckpointMirror)`.
- Mirror git runs on the local spawner (GitVcsDriver not yet routed through WorkspaceHosts — 0.3 does that).

## 0.2 lint rule `t3code/workspace-host-boundary` (landed)

- Flags value imports of node:fs/fs/fs/promises/child_process/node-pty, `X.ChildProcessSpawner`/`X.PtyAdapter`/`X.FileSystem` service reads, HostProcess `.Platform/.HomeDirectory/.Environment/.isWindows` reads, and `process.env`. Type-only imports OK. Override list in root vite.config.ts.
- 94 files carry a line-1 file disable: `/* oxlint-disable t3code/workspace-host-boundary -- <reason> */`. Find yours with `git grep "workspace-host-boundary -- not routed yet (0.N)"`.
  - 0.3: git/GitManager.ts, git/GitWorkflowService.ts, vcs/{GitVcsDriver,GitVcsDriverCore,VcsDriverRegistry,VcsProcess,VcsProjectConfig,VcsStatusBroadcaster,removeEmptyDirectory,worktreeRemoval}
  - 0.4: workspace/{KnownWorkspaces,WorkspaceEntries,WorkspaceFileSystem,WorkspacePaths}
  - 0.5: terminal/Manager.ts
  - 0.6: orchestration-v2/Adapters/{ClaudeAdapterV2,CodexAdapterV2}.ts, packages/provider-acp/src/server/{AcpSessionRuntime,adapter}.ts
  - 0.7: orchestration-v2/{ClaudeTaskOutputTail,ProviderSessionManager,ProviderTurnStartService,ThreadSettlementService,ThreadTitleRegenerationService,workflowFileRead}, provider/Drivers/ClaudeHome.ts, provider/codexLaunchArgs.ts, textGeneration/{ClaudeTextGeneration,CodexTextGeneration}, packages/provider-core/src/server/instanceEnvironment.ts (ProviderTurnStartService/ThreadSettlementService/ThreadTitleRegenerationService are worktree existence checks NOT in 0.7's spec — 0.7 takes them)
  - 0.8: orchestration-v2/{CheckpointRollbackService,Orchestrator,ThreadPullRequestService}, storageCleanup.ts
  - 0.10: preview/PortScanner.ts
  - Other reasons: `server-scoped:` (stays), `routed in M3:`, `not supported in cloud:`.
- Gotcha: removing a file-level disable shows every violation in that file; clear or re-disable each (with a reason) in the same PR.
- New sandbox code that must touch the server's own disk (e.g. mirror, runner) needs a reasoned disable or override entry.

## 1.36 sandbox settings (landed)

- contracts settings.ts: `DockerSandboxDriver`, `SandboxDriverInstance` (union of one), `SandboxSettings` (`drivers` ForwardCompatibleArray, `defaultDriverId`, `baseImage`, `env`). `ServerSettings.sandbox` optionalKey, absent by default. `ServerSettingsPatch.sandbox` nullable struct; `drivers` is a Record<ComputeDriverId, NullOr<driver>> (each driver must sit under its own id); null removes.
- `ProjectSettingsOverrides` gains `sandboxAllowed`, `defaultsToCloud`, `sandboxEnv` — readers (1.25, 1.37) read them from `overrides`.
- shared serverSettings.ts `mergeSandboxPatch`. Server settingsSecrets.ts: sandbox env secret names `sandbox-env-${enc(name)}`, project `sandbox-project-env-${enc(projectId)}-${enc(name)}`; redacted to clients.
- `sandbox` may exist with empty `drivers` — 1.37's cloudAvailability must check `drivers.length`. Removing the default driver doesn't clear `defaultDriverId` (1.4 validates).
- web SettingsPanels.logic.ts `buildProviderInstanceUpdatePatch` returns `ServerSettingsPatch`.

## 1.32 mirror diff reader (landed) — `apps/server/src/sandbox/mirror/MirrorCheckpointReader.ts`

- `CheckpointDiffReader`, `CheckpointDiffPlacement` (Context.Reference, default None), `layer`. Picks the mirror reader for threads with `sandboxId`; missing refs fall back to CheckpointStore with the original cwd.
- Bare repos: VcsProcess sets safe.bareRepository=explicit, so the reader wraps VcsProcess to prepend `--git-dir=<cwd>` and builds ops via `makeVcsDriverShape()`. If 0.3 changes makeVcsDriverShape's requirements, adjust MirrorCheckpointReader.ts (keep the --git-dir injection).
- CheckpointDiffQuery reads the placement once at layer construction. server.ts provides MirrorCheckpointReader.layer + ProjectionStoreV2.layer to it.

## 0.5 terminal routing (landed)

- terminal/Manager.ts yields WorkspaceHosts; per spawn `hosts.forPath(session.cwd)` gives pty, agentScope, info. `TerminalSessionState.hostId`. `assertValidCwd` stats through host (sandbox path → TerminalCwdNotFoundError). `resolvePosixPsCommand(host)` cached per host id. Process table grouped per host via `acquireSubprocessInspectors` — 1.10's `processes.table` plugs in there. `TerminalSubprocessCheckError.command` gains `"workspace-host"`.
- runtime core still provides layerPtyAdapter (provider-acp-registry auth/probe read it via serviceOption).
- TODO after 0.3: pass `host` into `posixProcessTableSnapshot`/`windowsProcessTableSnapshot` (ProcessRunInput.host).
- Test gotcha: host.info is read per call, so tests overriding HostProcess.* must wrap the test body, not just the layer construction.

## 0.4 workspace files routing (landed)

- WorkspaceHost gains `files` (`WorkspaceHostFiles`, `WorkspaceFileKind`, `WorkspaceHostFileError{operation, code}`; operations include stat/close). Local impl in LocalWorkspaceHost.ts.
- WorkspaceFileSystem/WorkspaceEntries/KnownWorkspaces route through hosts; where `files` lacks a call they use `host.fileSystem`. Sandbox cwd → `UnknownWorkspaceError` / `WorkspaceEntriesReadDirectoryError` (unions unchanged). getMetadata has no cwd: each path picks its host.
- 1.11 changes: KnownWorkspaces (sandbox checkout never in server's worktree list) and the unavailable-host branches.

## 1.3 sandbox projections (landed)

- Migration `088_SandboxProjections` (3 tables + `idx_sandbox_usage_sandbox`); registered `[88, "SandboxProjections"]`; manifests in reconcileV2PreviewMigration.test.ts updated. Next free migration id is 89.
- `sandbox/lifecycle/SandboxProjection.ts`: `applySandboxUpdated` (skips events older than latest interval boundary — replay safe), `applySandboxMembership`, `getSandbox`, `getSandboxes`, `listSandboxThreads`, `sandboxShellSummary`, `usageIntervalChange`, `SandboxThreadRow`.
- ProjectionStoreV2 shape gains `getSandbox`, `listSandboxThreads`; shells carry `sandboxId` + summary; thread projections/snapshot windows carry `sandbox`. Read errors → `ProjectionStoreReadError` with threadId `sandbox:<id>`.
- ShellStream `expandSandboxShellEvents` fans `sandbox.updated` to unarchived attached threads. `subscribeOrchestrationV2Shell` requires ProjectionStoreV2.
- testkit ProjectionReplay.rebuild clears the two sandbox projection tables (never the usage ledger).
- Membership: provider-native subagents get no row; deleting a thread removes its row.
- RISK for 1.19: `migrate-dev-db` does not clear sandbox tables — 1.19 (reconciler) MUST make migrate-dev-db drop sandbox rows so a dev server never touches the developer's real containers.

## 0.6 provider sessions routing (landed)

- provider-core ProviderHost: optional `sessionProcesses(cwd)` (`ProviderSessionProcesses`), `ProviderSessionHostUnavailableError`. ProviderHostLive implements it with WorkspaceHosts.forPath; tests building ProviderHostLive need `layerFromContext`.
- provider-acp adapter: openSession resolves sessionProcesses once; both runtime spawns use it. ACP session spawns in server tests use the WorkspaceHosts spawner (not a driver-level override).
- CodexAdapterV2 factory takes WorkspaceHosts (local when cwd null). Codex app-servers still reused per instance — 1.12 must key reuse by host.
- WorkspaceHost gains `spawnProcessGroup(input, hooks)` (sync; ProcessGroupSpawnInput/Hooks/Process types). Local impl in LocalWorkspaceHost.ts (Claude group watch script + Windows branch).
- ClaudeAdapterV2: query runner resolves host per open; cwd file reads via optional `ClaudeAdapterV2Options.fileSystemForPath` (filled by createClaudeAdapterV2).
- AcpSessionRuntime.ts keeps a file-level disable; its process.env uses tagged 0.7 (not in 0.7's spec — 0.7 should take them).

## 1.37 client-runtime machine status (landed)

- contracts clientRpcPermissions.ts: any `sandbox.*` dispatchCommand needs operate (reads only input.type).
- `@t3tools/shared/sandbox`: `cloudAvailability` (drivers.length, then project `sandboxAllowed === false`), `newThreadPrefersCloud`. No `cloud` literal in contracts yet (1.16 adds it to the launch input).
- client-runtime `createEnvironmentRpcCommand` has an overload taking any Input when `execute` is given. commands.ts: `wakeSandbox|sleepSandbox|retrySandbox|discardSandbox`, `SandboxCommandInput {threadId, sandboxId, commandId?}`.
- `@t3tools/client-runtime/state/sandbox`: `sandboxStatePresentation`, `createSandboxEnvironmentAtoms` (4 commands + `actionAllowedAtom`). Web/mobile bindings NOT added (knip): 1.38/1.41 add `createSandboxEnvironmentAtoms(connectionAtomRuntime, { team: teamEnvironment })`.
- Shell summary lacks `ownerMemberId`: callers pass thread `source.ownerId`; server refusal is the backstop. Custom-input commands rely on the transport RpcPermissionGuard for the operate check (don't remove it).

## 1.4 ComputeDriver (landed) — `apps/server/src/sandbox/compute/`

- ComputeDriver.ts: service tag `t3/sandbox/compute/ComputeDriver`, `ComputeCapabilities`, `SandboxBootstrap`, `BackendSandbox`, `BaseImageInfo`, `ComputeDriverHealth`, `ComputeDriverError` (no `detail`; `retryable` set at construction), `ComputeDriverCreateInput/Result`, `sandboxBackendName`, `sandboxTags`, `parseSandboxTags` (null unless all 4 tags valid).
- ComputeDriverRegistry.ts: `ComputeDriverRegistry`, `ComputeDriverNotConfiguredError`, `ComputeDriverFactory<K, R = never>`, `layer(factories)`. get/list re-read settings under a lock (can fail with ServerSettingsError); driver reused while config unchanged, scope closed on change/removal. NOT wired in server.ts yet and no `layerRegistry` — 1.5 adds both.
- ComputeDriverTesting.ts: `make(driverId?)` → `{ driver, calls }`, `FakeComputeCall`, `answerFromMemory`, `StandInRunnerHello`, `STAND_IN_RUNNER_HELLO_PATH` (`/hello`). Fake's driver ref = sandbox name; errors carry driver id `fake`; create/start POST a hello in the background (warn on failure).
- computeDriverContract.ts: `computeDriverContract(name, makeDriver)` — 7 it.live cases; `makeDriver(installId, runner)` where runner = `{ socketPath, serverUrl, awaitHello }` (socket dir 755, socket 666).
- 1.14: `stand-in-runner.mjs` must read `/t3-sandbox/<id>/contract-marker` (null if absent), write `g<generation>`, then POST `{sandboxId, generation, enroll, marker}` to `<PAIR_RUNNER_URL>/hello` (URL is `unix:<path>`; server answers 204).

## 1.6 runner core (landed) — `apps/server/src/sandbox/runner/`

- `src/bin.ts` has a `runner` branch; `sandbox/runner/bin.ts` is the bundle entry (also answers `acp-mcp-bridge`, `acp-mcp-call`, `__managed-chatgpt-token` when run directly).
- RunnerConfig.ts: `RunnerConfig`, `readRunnerConfig` (deletes enroll secret from env and `<stateDir>/enroll`). `PAIR_RUNNER_DIR` (default /run/pair-runner).
- RunnerSocketServer.ts: one-socket SocketServer over `ws`; 45 s frame timer; redial 250 ms→10 s full jitter; 426 → writes `server-build`, exit 75; 401 → exit 77. `RunnerCredential` stores token at `<stateDir>/token` 0600. `RunnerShutdown` carries exit code.
- HandleTable.ts: process/PTY/fs.writeStream handles in table-owned scopes; seq-stamped output buffers; input seqs from 1, in order, gap → BadArgument; `wait` resolves after exit + all EOFs; `drain`, `live`, `handle.exited` events. Writer handles key `in:file`. First fs.watch batch is `[]` (ready); watch paths relative.
- GroupWatcher.ts (watcher is a separate child of the runner, not in-group), ProcessRun.ts (`process.run`/`runStream` reimplemented, not ProcessRunner; cap hit in error mode kills + reports truncated — server maps to its limit error). handlers.ts: 42 core handlers + placeholder ops layer (1.10 fills). runnerTesting.ts: in-process runner layer for 1.7.
- Root vite.config.ts: runner import fence (mcp/ left open) + workspace-host-boundary off for the runner.
- 1.8 owns serverBootId handling, buffer bounds, source pausing.
- TODO (1.9 or 1.15): pair-bootstrap.sh passes PAIR_RUNNER_ENROLL via env, which stays readable in /proc/<pid>/environ; hand it to the runner as the `<stateDir>/enroll` file instead (readRunnerConfig already supports it).

## 1.14 Docker driver (landed) — passes the contract suite on the real daemon here

- DockerEngineApi.ts: typed Engine API v1.41 client over undici (unix socket or tcp:// with DOCKER_CERT_PATH TLS); `parseDockerHost`, `mapEngineError`, `DockerEngineError`, ustar writer, `readFirstTarFile`. ssh:// → `unsupported`.
- DockerComputeDriver.ts: `make(config)` registry factory (install id from ServerEnvironmentIdentity, `sandbox.baseImage ?? "t3-sandbox:dev"` — 1.23 replaces), `makeWithEngine`, `containerCreateBody` (has a `local` option: 1.15 passes socket dir + bundle path; bundle mount is Option.none() for now; socket dir derived from bootstrap.serverUrl `unix:<path>`), `isolationFromInfo`, `egressScript` (helper container `pair-<id8>-egress`, rules use RETURN). `list` scopes to this install's `pair.install` label + requires `pair.sandbox`.
- Contract test: `T3_TEST_DOCKER=1 vp test run src/sandbox/compute/` (image `t3-sandbox-contract:test` from testdata/stand-in-runner, built locally here). CI: .github/workflows/sandbox-docker.yml.
- 1.19 can call `health` to re-apply the egress block. NOT wired into server.ts (1.5 owns registry wiring).

## 1.5 sandbox decisions + effects (landed)

- sandbox/lifecycle/SandboxDecisions.ts (pure decider, 04's M1 state table), SandboxEffects.ts (5 driver effects; stale generations finish without driver call; shared deterministic ids; `reportExhausted` dispatches `sandbox.failed` once), SandboxBootstrapSource.ts (service + `layerUnconfigured` — 1.7/1.15/1.16 provide the real one).
- EffectOutbox: sandbox effect member, all 5 types replay-safe. EffectWorker: `EFFECT_TIMEOUTS` (sandbox 60 s), exhausted hook before outbox.fail; executor shape has optional `reportExhausted`.
- Orchestrator: `dispatchSandboxCommand`; 4 no-op types on the no-event allow list; `OrchestratorSandboxCommandMovedError` refused without receipt; stale generation → rejected `stale-generation`.
- ThreadMessageIntake routes client sandbox commands to the owner thread; sleep/discard need owner-thread owner or admin (`machine_not_owner_or_admin`).
- Discard enqueues only `sandbox.destroy`. `sandbox.created` sets driverRef in any live state of the same generation (hello may arrive first). Wake from failed without driverRef provisions anew. `provision` also emits `thread.metadata-updated` with sandboxId. Failure codes `driver-removed` / `<operation>-failed`.
- Registry wired in runtimeLayer.ts/server.ts with `{ docker: DockerComputeDriver.make }` (lazy). `ComputeDriverTesting.layerRegistry(fake)`.
- Test gotchas: `layerExecutor` needs SandboxEffects (replay harness provides `Layer.mock(SandboxEffects)({})`); RuntimeLayer.layer needs ComputeDriverRegistry + ServerEnvironment; a test building its own executor next to the replay harness must use `Layer.fresh(EffectWorker.layerExecutor)`.
- `SandboxLifecycle.test.ts` is the harness 1.16–1.19 extend. `sandbox.admit`, `sandbox.auto-sleep`, `sandbox.adopt` still unsupported.

## 1.19 reconciler + lifecycle worker (landed)

- SandboxReconciler.ts (`pairBackends`, `planReconciliation`, `ReconcileAction`, `layer`; Scheduler "sandbox-reconciler" after startup recovery then every 10 min; ends each driver pass with `health`). SandboxLifecycleWorker.ts (`makeSweep`, `layer` "sandbox-lifecycle", DueHint; settle/archive auto-sleep + boot deadlines). Both wired in runtimeLayer.ts `layerProduction`.
- SandboxDecisions: `SandboxAttachedThread`, `sandboxAttachedThread(shell)`, `decideAutoSleep`, `planSandboxOnThreadDelete`, `sandbox.auto-sleep` arm, boot-timeout arm (provisioning/waking → `sandbox.stop`). Decider input `attachedThreads` ("active run" includes queued). `sandbox.stopped` on failed = NoOp.
- Orchestrator `thread.delete` arm appends the destroy effect (1.17 adds hand-over beside `planSandboxOnThreadDelete`). SandboxProjection `listLiveSandboxes`.
- migrate-dev-db clears sandbox tables and `sandbox.updated` events.
- TODO 1.16: boot timeout should also enqueue `sandbox.release-waiters` once that effect exists.

## 1.7 runner route + hub (landed) — `apps/server/src/sandbox/runnerHub/`

- Migration 089_SandboxRunnerGrants (next free id: 90). migrate-dev-db clears `sandbox_runner_grants`.
- RunnerGrants.ts: SHA-256 hashes only; `mint` (revokes older generations, re-mints unconsumed secret, one txn), `enroll` (single conditional UPDATE…RETURNING), `authenticate`, `revoke`; `RunnerAuthError`.
- RunnerHub.ts (key `t3/sandbox/runnerHub/RunnerHub`): protocol check before credential (426 never spends a secret); token reaches runner only inside `runner.hello`; one live socket per sandbox; in-memory status with 120 s lease; facts attached / lost(runner-restarted|lease-expired); `connection` waits up to the lease; after `revoke`, `connection` fails `RunnerLostError("drained")`. `mintEnrollment` exists. `expectCheck` NOT built (1.40).
- RunnerHubFacts.ts dispatches `sandbox-attached:<id>:<gen>:<runnerBootId>` / `sandbox-lost:…`; RunnerRoute.ts (400 non-upgrade, 401 no detail, 426 `{protocolVersion}`); RunnerHubTesting.ts (real 1.6 handlers over in-memory socket pair; `drop`). Wired in server.ts/runtimeLayer.ts.
- `attached` command has no build/arch/cpu/memory; `lost` has no reason (1.5 shapes kept).
- OPEN: SandboxBootstrapSource still `layerUnconfigured` — needs 1.9's runnerBuildId + 1.15's serverUrl; 1.15 wires it to `RunnerHub.mintEnrollment`.
- OPEN (1.8): post-restart lease wait missing — a `ready` sandbox whose runner never returns after server restart stays `ready`; should call `connection` then dispatch `sandbox-lost:…:unattached`. Until 1.8, a runner keeps its runnerBootId after lease expiry so its re-attach is dropped by the receipt.
- A socket dropping during the enrollment hello leaves the secret spent → runner exits 77.

## 0.3 git/checkpoint routing (landed)

- processRunner.ts `ProcessRunInput.host?` (uses that host's spawner). VcsProcess resolves `forPath(cwd)` each run, platform from host.info; `process.env` line keeps a `(0.7)` disable.
- GitVcsDriverCore: executeRaw uses host spawner + host.info platform/env; trace2 via host fs; disk checks/temp index/worktree home via forPath. GitVcsDriver capture/restore resolve host once per call. `worktreeRemoval` takes `host`. `removeEmptyDirectory` still local (disable `routed in M1 (1.11)`). VcsDriverRegistry, VcsProjectConfig (falls back to "auto" when host unavailable), VcsStatusBroadcaster, GitWorkflowService, GitManager route via forPath. Unavailable host → existing errors (VcsProcessSpawnError / GitCommandError).
- Terminal ps snapshots now pass host (0.5 TODO done). storageCleanup.ts passes `hosts.local`.
- `WorkspaceHostTesting.makeRecording` (records at spawner + fs; spawn name skips git global options). `layerFromContext` is now `Layer.fresh` — provide it at the same level as any spawner/fs override in tests.
- Op-count tests exist (capture + local status) — 1.10 must keep them meaningful.

## 0.8 restore/rollback/PR/cleanup routing (landed)

- CheckpointRestoreSafety `isCheckpointRestoreIsolated(hosts, …)`: unavailable host → path as written (conservative). Orchestrator now requires WorkspaceHosts instead of FileSystem. CheckpointRollbackService: unavailable host counts as "exists". ThreadPullRequestService `.git` check via forPath (unavailable → keep worktree cwd). storageCleanup: per-path host for measureWorktree/branchChanged/submoduleRemoval; unreachable worktrees skipped; managed roots/orphan walk/pnpm store server-scoped.
- testkit ProviderReplayHarness `layerReplayRuntime` provides `layerFromContext`.
- 1.32+/1.33 replace these unavailable-host fallbacks with real sandbox comparisons.

## 1.9 runner bundle (landed) — verified end to end in t3-sandbox:dev (426 → refetch → enroll → attach)

- apps/server/vite.config.ts `pack` is an array (server + runner + history worker + dev Replay agent, unsplit). `T3CODE_PACK_RUNNER_ONLY`, `T3CODE_RUNNER_DEV`. scripts/cli.ts `build-runner --out <dir> [--dev] [--externals-cache <dir>]`; `build` writes `dist/runner` (fails on fenced modules, history-worker externals, >25 MiB; currently 22.9 MB).
- `RunnerBundle.ts` (key `t3/sandbox/runnerHub/RunnerBundle`): `current` → `{ runnerBuildId, directory }`, `computeRunnerBuildId`, `encodeRunnerManifest`, `layer`, `layerTest(files)`; wired in server.ts. Source-run server builds the bundle on first use (failed builds retried, not cached); tarball made by the server on first use.
- RunnerRoute: `GET /runner/v1/bundle/:file` (current id only; others 404 + `x-pair-runner-build`; `.sha256` body `<sha>  <id>.tar.gz`). Connect → 426 `{protocolVersion, runnerBuildId}` + header on build mismatch, before credential. `RunnerGrants/RunnerHub.authorizeDownload` (token or unspent enrollment secret, not consumed). RunnerRoute.layer needs RunnerBundle.
- `t3 runner prefetch <id>` (runner/prefetch.ts); runner exits 78 when Node is outside the manifest range.
- pair-bootstrap.sh now fetches with `/run/pair-runner/token` once it exists. No `runnerBootstrap.ts` (1.20's script does that job).
- Old builds under `<stateDir>/runner/` are never pruned (follow-up).

## 0.7 provider base env (landed)

- instanceEnvironment.ts, ClaudeHome.ts, codexLaunchArgs.ts require base env (no process.env defaults). Server-scoped callers (probes/installs/drivers) pass HostProcess.Environment.
- Codex/Claude adapters build instance env from `hosts.local.info` ("1.12 rebuilds it per session"). Claude SDK default env reads the session host's info. `createCodexAdapterV2` requires WorkspaceHosts (CodexAdapterV2DriverEnv). Text generation + ProviderSessionManager require WorkspaceHosts.
- ACP: `ProviderSessionProcesses.environment` (filled from host.info) → provided as HostProcess.Environment to AcpSessionRuntime — the seam for 1.12's sandbox env.
- ClaudeTaskOutputTail takes explicit fs + uid. ProviderSessionManager open stat via forPath (unavailable → ProviderWorkspaceMissingError).
- Remaining disables: workflowFileRead.ts + instanceEnvironment home/platform → `routed in M1 (1.12)`; ClaudeHome host facts + task-tail uid → `not routed yet (0.9)`. Codex temp files/attachments server-scoped (1.12/1.34 stage them).

## 1.15 Docker runner routes (landed)

- RunnerEndpoint.ts: pure `chooseRunnerRoute` (runnerUrl wins; local Linux daemon → unix socket; macOS local → `http://host.docker.internal:<port>`; remote → `runner-url-required`; else `unsupported-platform`; long socket path → `socket-path-too-long`; `socket-unavailable`). `RunnerEndpoint.planFor` lazily opens `<stateDir>/sandbox/runner-socket` (0700) serving RunnerRoute only. `RunnerDialPlan = { serverUrl }` (`unix:<host path>` or URL).
- SandboxBootstrapSource real `layer` (server.ts): `forGeneration(…, driverId)` plans route → `RunnerBundle.current` → `hub.mintEnrollment` (no grant spent if the boot can't dial).
- Docker driver mounts the socket dir read-only at `/run/pair-host`, mounts `RunnerBundle.directory` when its build id matches; egress allow list from the route plan; `makeWithEngine(…, { route, bundle })`.
- pair-bootstrap.sh writes the enroll secret to `/run/pair-runner/enroll` (0600); readRunnerConfig reads only the file. Verified: secret absent from /proc/*/environ.
- RISK (1.16): on a source-run server the first boot may build the runner bundle inside the 60 s sandbox effect timeout — warm `RunnerBundle.current` at startup when a sandbox driver is configured, or outside the bounded effect.

## 1.10 coarse runner ops (landed)

- checkpointing/CheckpointCapture.ts: `isGitCheckpointable`, `captureBaseline`, `captureTurn` (git half of capture; CheckpointService keeps lock/ids/makeCheckpoint). captureCheckpoint returns the commit oid through VcsDriver/GitVcsDriver/CheckpointStore. Warnings keep causes locally; only kinds cross the wire.
- terminal/processTable.ts: `TerminalSubprocessCheckError`, `resolvePosixPsCommand`, `readPosixProcessTable`. WorkspaceEntries `entriesFailureContext` (moved from ws.ts). New `WorkspacePaths.isWithinRoot`, `worktreePaths.ts` (pure folder rules) for the runner fence.
- WorkspaceHost.ts: `CoarseOperations`, `CoarseOperationError`. WorkspaceHosts.ts: `layerLocalOnly`. PortScanner `layerAllListeners` (unowned listeners too; `terminal: null`, agent from T3CODE_THREAD_ID).
- Runner: sandbox/runner/opsLayer.ts + opsHandlers.ts replace the placeholder (processes.table polls ps 1/s only while subscribed, emits on change). Server: sandbox/runnerHub/RunnerOpsClient.ts; `RunnerConnection.ops` per socket; process table in a SubscriptionRef.
- Contracts: `ops.search.entries`, `ops.search.contents`, `ops.entries.browse` are now `stream: true` pages of ~`RUNNER_OPS_PAGE_BYTES` (192 KiB); client joins pages. Dropped socket mid-op → `RunnerOpsError("failed")`.
- NOT built (moved to 1.11): 0.10's per-host port discovery (`PortDiscovery` map keyed by host, `processes.signalGroup`, `WorkspaceHostError`). 1.11 branch: `host.kind === "sandbox" ? connection.ops.x : local call`; capture: local CheckpointCapture vs `ops.checkpointCapture`.

## 1.21 image publish CI (landed)

- sandbox-image.yml: tag trigger + workflow_dispatch(version); jobs `bundle` (check-providers first, then `node apps/server/scripts/cli.ts build-runner --out apps/server/dist/runner`, artifact `runner-<runnerBuildId>` as runner.tar), `image` (amd64/arm64 native), `manifest`. PR jobs gated to pull_request.
- `planRelease` / `release-plan` in sandbox-image.ts: image `ghcr.io/<owner lowercased>/t3-sandbox`, tag = server package version exactly (no `latest`); manual run → `<v>-dryrun.<run id>`. Image carries label `t3.runner-build`.
- .github/scripts/sandbox-image-smoke.sh shared smoke. docs/operations/release.md "Sandbox base image" (package must be made public by hand after first push).
- 1.23: pull `<image>:<serverVersion>`; local dev still `vp run sandbox-image:build` → `t3-sandbox:dev`.

## 1.8 resume + flow control (landed)

- `@t3tools/shared/rpcOutputWindow`: `withOutputWindow`, `encodedChunkBytes` (terminal's withTerminalOutputWindow uses it).
- Runner HandleTable: 64 KiB output batches; buffer = unsent + `windowBytes + 128 KiB` tail; pipes/PTYs pause at limits, resume below half; `pressure` stream, `resource.pressure` events, `stats`; limits from hello. New `serverBootId` → kill old handles + new runnerBootId. Runner-side lease when last socket ends (SIGTERM, SIGKILL after 10 s, new boot id).
- runner/main.ts `layerProtocol` (lease session per socket + window on every stream method).
- runnerHub/RunnerConnection.ts: a connection lasts one runner BOOT. `client: Effect<…>` (waits out a reconnect; plain calls NOT retried after a drop — 1.11 decides which are safe to retry), resumable `output(handle, "fd:N" | "pty")`, `pipeWriter` (suspends at 1 MiB queued), `ptyWriter` (sync). Fails `RunnerLostError` once the boot is gone. `ops` per boot.
- RunnerHub: `serverBootId:<expiries>`, `layerWith({ limits })`, hello races disconnect.
- RunnerHubFacts: at startup each `ready` sandbox with runnerLostAt null waits on `hub.connection`; on RunnerUnavailableError dispatches `sandbox-lost:<id>:<gen>:unattached`.
- RunnerHubTesting faults: `dropAfterBytes`, `stallReader`/`resumeReader`, `halfOpen`, `runnerEnded`, runner `table` access. RunnerResume.test.ts (8 cases).
- 1.44: `pausedMs` uses the Effect Clock.

## 1.23 base image pull (landed)

- sandbox/image/SandboxBaseImage.ts: `DEFAULT_BASE_IMAGE_REPOSITORY` (= ghcr.io/rutvikchandla3/t3-sandbox), `baseImageCandidates`, `ensureBaseImage`, `BaseImageMissingError`, `baseImageMissingHint`. DockerEngineApi `pullImage(ref, onAccepted)`.
- Docker driver: per-driver image state; background pull forked at driver build; `health` retries after missing; `health.baseImage` = `{pulling}` | `{missing, hint}` | info; `create` boots from resolved image id and returns `baseImage`. `makeWithEngine` 5th arg `{ version, fromSource }`. `ComputeDriverError.image` (+ optional hint; message is user-facing).
- Contracts: `SandboxBaseImageInfo`, `sandboxImageLabel(Pick<…,"baseImage">): string` in sandbox.ts; `baseImage` optionalKey on OrchestrationV2Sandbox and `sandbox.created`. 1.39/1.41 use `sandboxImageLabel`; 1.40 shows `health.baseImage`.

## 0.9 host facts (landed) — M0 done except 0.10 (folded into 1.11)

- shared `resolveSpawnCommand(…, { facts: { platform, environment } })`; processRunner passes host.info when `input.host` set; GitVcsDriverCore executeRaw passes host facts.
- CodexAdapterV2 `makeCodexAppServerSpawnCommand({ facts })`, open passes session host info. ClaudeAdapterV2 option `hostForPath` (→ `{ fileSystem, info }`) replaces `fileSystemForPath`; per-turn platform/uid from the turn's host. `discoverClaudeSkills(…, facts { platform, homeDirectory })`.
- Remaining: PortScanner `(0.10)` disable (1.11); Claude transcript scan uses server fs (1.12); AcpSessionRuntime host facts `routed in M3`.

## 1.13 runner forwards (landed)

- contracts runner.ts: `RunnerGitCredentialRequest/Response`. Runner HandleTable `openListener`/`closeListener`/`closeTcp` (accepted conns are resumable `tcp` handles; unclaimed accepts re-sent to new `runner.events` subscribers). runner/forwards.ts: `mcp` on 127.0.0.1:0, others on Unix sockets; `git-credential` fixed path, one per sandbox. runner/gitCredentialHelper.ts: `t3 runner git-credential <get|store|erase>` (store/erase skip round trip).
- RunnerConnection: `openForward({name, ownerKey, serve})`, `ended`, tcp read/write/close (forward.open not retried). RunnerHub: `boots` stream.
- runnerHub/RunnerForwards.ts: bearer proxy pinned to /mcp, Codex instance check (ownerKey = provider instance id), git thread-membership check, `answerGitCredential`; git forward opened per boot from `hub.boots`. `RunnerForwards.layer` is in `layerRuntimeCoreDependencies` and needs McpSessionRegistry.
- credentials/GitCredentialService.ts (tag + `layerNone`; 1.28 swaps in the real layer and exports `GitCredentialError`). `McpSessionRegistry.endpoint`.
- SEAM for 1.11/1.12: sandbox host `exposeServerEndpoint` = `RunnerForwards.exposeServerEndpoint(forwards, sandboxId)` → `http://127.0.0.1:<port>/mcp` or socket path; failures → WorkspaceHostUnavailableError. `ServerEndpoint.address` (not localAddress). 1.12 adds call sites (Codex MCP URL, CodexManagedRuntime, ACP bridge).
- Docker tmpfs for /run/pair-runner now 0711; sockets 0666; token file 0600.

## 1.44 runner latency benchmark (landed)

- `resource.pressure` + `stats` carry `highWaterBytes`, `pausedMsTotal`. Metrics in observability/Metrics.ts; runnerHub/RunnerWireMetrics.ts wraps each socket's RunnerClient (bytes by channel/direction, one-shot call timing). Startup marks (runner/startupMarks.ts). `vp run bench:runner` (`--image`, `--skip-docker`, `--quick`) → scripts/runner-benchmark.ts. docs/internals/performance-regressions.md "Runner".
- 1.11: wrap the sandbox spawn in `Effect.fn("RunnerConnection.spawn")` (a `first-byte` span event is emitted in RunnerConnection.output).
- RESULTS: all budgets pass except PTY throughput (~45 MB/s vs ≥50) and server CPU/MB (~19 ms vs ≤5): PTY output reaches the hub in ~5.4 KiB chunks. FOLLOW-UP: coalesce PTY output in the runner (e.g. flush per event-loop tick / setImmediate or at 64 KiB) without breaking the 1 ms stdout budget.
- `t3-sandbox:dev` on this machine is STALE (bootstrap predates 1.15) — rebuild before any real-container test.

## 1.11 SandboxWorkspaceHost (landed) — also absorbs 0.10

- workspaceHost/SandboxWorkspaceHost.ts: every member over one runner boot's connection; `exposeServerEndpoint` via RunnerForwards (registers itself with the hub at startup via `RunnerHub.serveEndpoints`). `spawnProcessGroup` THROWS on a sandbox — 1.12 builds the Claude bridge on `spawner`. WorkspaceHostLoopback.ts `layerLoopback` (real runner over loopback, for tests).
- WorkspaceHost.ts: `invoke?`, `processes.signalGroup` (`kill -- -pid` via process.run), `WorkspaceHostError`, `isRunnerLost`, `sandboxIdFromPath`, `files.removeEmptyDirectory` (vcs/removeEmptyDirectory.ts deleted). `WorkspaceHostUnavailableError.sandboxId` optional `SandboxId`.
- WorkspaceHosts `register(root, host)` (scoped) + `forPath` (`..` collapsed, longest root, fail closed). RunnerHub: per-boot scope holding host + process table; closes on lease expiry/new boot/revoke/new generation.
- `RunnerConnection.idempotent`: only idempotent calls resent after a drop (never spawn, pty.open, rename, append, non-replacing writes).
- Contracts: RunnerInfo gains `agent`, `tmpDirectory`, `bundleDirectory`, `imageEnvironment`; `fs.utimes`; `files.*` group; `fs.stat` `noFollow`. Agent user from /etc/passwd (`PAIR_AGENT_USER`, default `t3`), no root fallback.
- Coarse calls wired into WorkspaceEntries + CheckpointService. KnownWorkspaces accepts checkouts under registered sandbox roots. Terminal process table from runner; PortScanner on `hosts.local`, stops servers via signalGroup. Per-host port discovery map NOT built (M2 previews).
- Runner fixes: one page/chunk per frame; recursive mkdir encoding; signal names on exit; group watcher disarmed on release (was ~1 s per sandbox git call).
- CAUTION for 1.12/1.16/1.24/1.34: the runner's fs ops run as ROOT, so files the server writes via host.files/fileSystem in the sandbox are root-owned while agents run as `t3`. Chown (or write as the agent) anything the agent must modify (checkouts, homes, attachments, setup outputs).
- `fs.watch` coalesces on the runner's real clock → watch tests need `it.live`. A process lost after a lease ends shows exit code 1.

## 1.25 sandbox process env (landed)

- sandbox/credentials/SandboxProcessEnvironment.ts: service (key `t3/sandbox/credentials/SandboxProcessEnvironment`) + `layer` (needs ServerSettingsService, SecretResolver, ProjectionStoreV2); `sandboxBaseEnvironment` drops reserved names; `SandboxEnvironmentError{sandboxId, cause}`.
- `forProcess(host) → Effect<Record<string,string>, SandboxEnvironmentError>` = `{...host.info.environment, ...team env, ...project env}` (project from `getSandbox(host.id).projectId`), reserved names dropped, secrets read in one call; dies on a non-sandbox host. Callers spread their own names after it: CLAUDE_CONFIG_DIR, CODEX_HOME, T3CODE_THREAD_ID, T3CODE_SANDBOX. `layerSandboxProcessEnvironment` defined in server.ts. Git/coarse ops keep host.info.environment only.
- contracts: `isReservedSandboxEnvName` (incl. `PAIR_` prefix); settings op `"use-reserved-sandbox-env"`; serverSettings refuses reserved names on write.
- terminal/Manager.ts uses `forProcess(host)` on sandbox hosts (option `sandboxEnvironment`).
- TODO 1.24: sandbox terminals still append the server's managed ACP binary dirs to PATH. TODO 1.28: add T3CODE_THREAD_ID + git committer names.

## 1.31 mirror sync (landed)

- sandbox/mirror/MirrorSync.ts: `MirrorHooks` (Reference, default no-op), `MirrorSyncError`, `MirrorSync.sync` (returns the ProjectId), `make({ maxBundleBytes })`. Ref tips from `for-each-ref` in the sandbox; skip refs already at that oid; `git bundle create` with prerequisite tiers (previous ordinal + mirror branch + seed origin/HEAD → seed → none; "bad object" drops a tier); bundle streamed to `<stateDir>/sandbox/tmp/<uuid>.bundle` with a cap; strict `importBundle` then `updateRefs`.
- MirrorSyncWorker.ts (one layer: worker + real MirrorHooks, `layerMirrorSync` in server.ts): seeds from threads on non-destroyed sandboxes; retries every 30 s; `flush`, `drain`; hourly maintenance per mirror. `afterCapture` (prefix check for local threads), `afterRollback` → `deleteRefs`.
- CheckpointMirror: `updateRefs` (oid format-checked), `maintain`. SandboxProjection `listLiveSandboxThreadIds`.
- ThreadDeletion queues effect `sandbox.mirror.forget-thread` (replay-safe). `isSandboxEffectRequest`/`SandboxEffectRequest` now require `generation`. `sandbox.stop` calls `flush` before `driver.stop`. EffectWorker/SandboxEffects reach mirror/worker via `Effect.serviceOption`.
- The worker only checks a ready ref exists in the mirror (not its oid); capture-time updateRefs corrects it. `ensure` refetches seed origin refs every sync.

## perf-pty follow-up (landed)

- runner HandleTable `OutputBuffer.push` wakes the reader on `setImmediate` for a lone write; pushes <0.5 ms apart wait up to 1 ms or 64 KiB. Applies to all buffers. Benchmark loopback runner gets `PAIR_AGENT_USER`.
- Under load (4–8 on 4 CPUs): mean frame 5.4 → ~27 KiB, CPU/MB ~16 → ~9 ms, PTY 32 → 38 MB/s loopback, Docker 25 → 29 MB/s. Budgets (≥50 MB/s, ≤5 ms/MB) still miss; stdout p99 noisy under load. RE-RUN `vp run bench:runner` on an IDLE machine in the integrated pass before judging. Remaining hub CPU: per-frame ack writev + websocket receive.

## 1.28 git credentials (landed)

- contracts runner.ts: git-credential request has no `operation`; response `{version, answer}` with `Credential{username, password: Redacted, expiresAt}` | `Refused{code, message}` (codes incl. `unavailable`).
- credentials/GitHubAppInstallationTokens.ts: JWT (RS256, PKCS#1→PKCS#8) from App settings; per-repo token with contents/pull_requests write + metadata read (never workflows); 15 s per call; server-side cache per `<sandboxId>\0<repo>` until 5 min before expiry, locked; no bodies in errors. 1.29 adds `forget`.
- credentials/GitCredentialService.ts (real layer): https github.com only; helper's thread id trusted only if attached to the socket's sandbox (else owner thread); project repo via RepositoryIdentityResolver or a verified fork (cached); order App → `MemberGitHub.credentialFor(thread.ownerId)` → refusal; always answers, 45 s bound. `GitCredentialError` deleted. `sourceFor` left to 1.35.
- RunnerForwards git forward calls `credentials.answer` (membership check moved into the service). gitCredentialHelper: refusal → `quit=1` + stderr; `token [--host]` mode for the gh shim.
- `SandboxProcessEnvironment.forProcess(host, threadId)` adds GIT_COMMITTER_NAME/EMAIL (server global git config, fallback "T3 Code") and T3CODE_THREAD_ID.
- Image: provision.sh writes /etc/gitconfig, real gh → /usr/bin/gh, gh-shim.sh at /usr/local/bin/gh. `t3-sandbox:dev` must be REBUILT for real-container tests. docs/user/source-control.md has the App section.

## 1.33 stopped reads (landed)

- sandbox/mirror/StoppedSandboxReads.ts: `viewFor` (→ `StoppedView` incl. cwd; newest checkpoint by committer date, ties → innermost checkout, higher turn), `refuseWrite`, `list`, `search`, `searchContents`, `browse`, `readFile` — git against the mirror under live caps (25k entries, 1 MiB, 250 ms); `..`/`~`/`.git` refused. No synced checkpoint → empty results (`readFile` exists:false).
- WorkspaceEntries/WorkspaceFileSystem catch WorkspaceHostUnavailableError; writes fail `SandboxAsleep{sandboxId, state}` (contracts sandbox.ts) → ws.ts maps to `ProjectWriteFileError{failure:"operation_failed", sandboxId, message}` (new optional field, old clients decode).
- Terminal on stopped machine: existing → exited snapshot; new → TerminalNotRunningError. VcsStatusBroadcaster keeps last status silently. ThreadPullRequestService skips stopped machines (replaces 0.8 fallback). Restore safety/rollback fallbacks untouched.
- Web: apps/web/src/state/sandbox.ts (sandboxEnvironment atoms — 1.38/1.39 reuse), components/sandbox/stoppedFilesNotice.tsx ("As of turn N" + Wake; FilePreviewPanel read-only while stopped).
- Helpers: `CheckpointMirror.mirrorGitDir`, exported `WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES`. Still failing on stopped machines: asset-URL reads, HtmlRender.
- Env: web browser tests can't launch here (Playwright wants chromium_headless_shell-1223; /opt/pw-browsers has 1243).

## 1.28a owner's GitHub token (landed)

- Contracts: `TeamMemberGitHub.source` ForwardCompatibleOptional(`app`|`token`); RPCs `team.githubTokenSet {token}` / `team.githubTokenClear` (operate scope, own member only); `GitManagerError.code?` (1.35 sets `github-credential-missing` and renders copy from it).
- Migration 090_MemberGitHubSource (`members.github_source`; backfill `app` where github_user_id not null). Next free migration id: 91.
- MemberGitHub `setToken` (validates via GitHub /user, refuses an account another member holds, secret store only `github-member-token-<id>`), `clearToken`, `credentialFor` returns a pasted token without the App client id. Token and device-flow session replace each other.
- client-runtime `setGitHubToken`/`clearGitHubToken`, `cloudPushCredential({appConfigured,…})` (1.41 reuses). Web: Settings → Team own row "Use a token instead"; `components/sandbox/cloudPushBanner.tsx` in ChatView (attention group). docs/user/team.md "Bring your own GitHub token".

## 1.12 sessions on sandbox hosts (landed) — Replay runs a full turn on the loopback sandbox host

- Session manager refuses all providers except claudeAgent, codex and Replay on a sandbox (`ProviderCloudUnsupportedError`, provider/Errors.ts) before any adapter runs; opens the thread's `mcp` forward in the session scope; refuses reusing a shared session from another machine. `McpProviderSessions.useEndpoint`. Shared session ids keyed by the thread's sandbox (Orchestrator passes `thread.sandboxId`).
- ACP/Replay: MCP bridge via the sandbox's `t3`; Replay runs `node <bundle>/replay/dev-replay-agent.mjs`.
- Codex: image's `codex`, `CODEX_HOME=/t3-sandbox/<id>/homes/<instance>`; `CodexManagedRuntime.resolveFor(host)` (bundle `t3` + codex-token forward; no auth.json).
- Claude: sandbox/providers/ClaudeSandboxProcess.ts bridge on `spawner`; Claude home in the sandbox; fork/subagent lookup/settings via the bundle's history worker. Task output tail uses the sandbox file watch.
- Provider processes start on `forProcess(host, threadId)`. Provider homes created by `mkdir` as the agent (no chown in the sandbox fs).
- OPEN: `T3CODE_SANDBOX` not set for providers (1.24 sets it for scripts). ACP/Codex app-server processes lack T3CODE_THREAD_ID (git answers for the owner thread). workflowFileRead.ts + Claude transcript reads still server-side ("not routed yet").

## 1.29 credential revocation (landed)

- Contracts: `SandboxGitCredentialSource`, internal command `sandbox.git-credential.record`, event `sandbox.git-credential.issued` (projection/awareness no-op).
- credentials/SandboxCredentialRevocation.ts: revokes runner grant + socket, MCP tokens (owner + attached threads), installation tokens. Runs after the driver accepts stop/destroy and when the status executor finds the backend stopped/missing/failed. OPEN: reconciler `ReportStopped`/`ReportLost` paths don't revoke yet.
- GitHubAppInstallationTokens `revoke` (drops cache entries; DELETE /installation/token per token, 5 s, failures ignored); tokens carry `permissions`. GitCredentialService dispatches an audit record (id `sandbox-git-credential:<sbx>:<gen>:<thread>:<repo>:<expiresAt|source>`); `decideGitCredentialRecord` refuses threads not on that sandbox. `MemberGitHubCredential.source` (`app`|`token`).
- server.ts: RunnerForwards/GitCredentialService moved into the top merge of `layerRuntimeCoreDependenciesBase`; one shared GitHubAppInstallationTokens.
- Client: `sharesOtherOwnersMachine` (client-runtime), web `components/sandbox/sharedMachineBanner.tsx` in ChatView. Mobile banner → 1.41.

## fix-flaky-kill (landed)

- Kill-test flake was a test race (dash defers a trap during `sleep` in a loop); script now ends `sleep 300 & wait`.
- Real bug: `RunnerHub.revoke` closed the boot scope before marking the boot lost, so in-flight host finalizers (e.g. `pty.release`) waited for a reconnect while holding the hub lock (120 s hang). `revoke` now marks the boot `lost` ("drained") before `endBoot`, like `expire`. `WorkspaceHostLoopback` revokes in a finalizer while the in-process runner still answers — any test layer that tears its runner down before the hub must revoke first.
- Not changed: hub shutdown when `hubScope` closes without a revoke (an in-flight release could still wait).

## 1.35 push + PR from cloud threads (landed)

- sandbox/credentials/SandboxGitHooks.ts: Context.Reference (default no-op); real layer acts only on `/t3-sandbox/` cwds: picks the thread (caller if attached → thread whose worktreePath is the cwd → owner), refuses `cloud-push-unsupported-host` (non-GitHub) / `github-credential-missing` before git runs, else returns `{ T3CODE_THREAD_ID }`.
- GitCredentialService `sourceFor(threadId)` (`app-installation` | `member-account` | none; never mints). GitManager `pushCurrentBranch(threadId)` uses the hook env; GitVcsDriver `pushCurrentBranch(options.env)`. Shared `makeSourceFor` (used by GitCredentialService.sourceFor and SandboxGitHooks; returns `member-token` for a pasted token) — a shared GitCredentialService layer would cycle through OrchestratorV2 → GitManager after 1.29.
- client-runtime `state/vcsAction.ts` `vcsActionErrorMessage` (codes → copy); used by web GitActionsControl toast. 1.41 reuses it.
- Gaps: App key set but not installed → hook allows, helper fallback decides (missing owner credential shows as git stderr). SourceControlRepositoryService publish push doesn't use the hook.

## 1.26 provider credentials (landed)

- `@t3tools/shared/sandboxCredentials`: `sandboxCredentialSupport` → `Ready{mechanism}` | `LocalOnly{reason}` | `Unsupported` (reads only driver, `config.setupMode`, env entry names — same answer on redacted client settings); `sandboxCredentialEnvNames`, `CODEX_MANAGED_STRIPPED_ENV_NAMES`. Hard-codes `"devReplay"` (= server DEV_REPLAY_INSTANCE_ID; no test ties them).
- SandboxProcessEnvironment `forProviderSession({host, instanceId, threadId})` = forProcess + instance's unreserved entries + exactly its one credential (one secret batch; refuses LocalOnly/Unsupported/empty token; managed Codex strips shared names; nothing cached). `sandboxInstanceConfig`.
- `ProviderCloudLocalOnlyError` (provider/Errors.ts). ProviderSessionManager.open uses the shared function before any forward/adapter. Claude/Codex sandbox branches use `sandboxProviderSessionEnvironmentFor` (SandboxProviderHome.ts); ACP/Replay keep forProcess. Terminal with providerInstanceId on a sandbox path → forProviderSession (`TerminalProviderEnvironmentError`).
- 1.16 should call `sandboxCredentialSupport({instanceId, instance: sandboxInstanceConfig(settings, id)})` before provisioning; 1.38/1.41 use it directly. Unverified: pinned Codex CLI uses OPENAI_API_KEY without `codex login`.

## 1.34 attachments (landed)

- sandbox/attachments/SandboxAttachments.ts: `sandboxAttachmentsDirectory`, `sandboxAttachmentPath`, `resolveSandboxExtractedTextPath`, `SandboxAttachmentStagingError`, `SandboxAttachmentStaging` + `layer` (needs WorkspaceHosts, ServerConfig, FileSystem). `stage` no-ops for null cwd/no attachments/local host; else mkdir 0755 + write missing or size-changed files (and extracted `.txt` = sandbox path + `.txt`), concurrency 4, agent-readable.
- ProviderTurnStartService stages after session open, before startRootRun; ProviderTurnControlService.steer stages before steerTurn. Both layers need `SandboxAttachmentStaging` (layer or Layer.mock).
- Claude prompt uses sandbox paths (`promptAttachmentPath`); image/PDF bytes still read server-side. Codex `toCodexInput` names sandbox paths (`hostForPath`).

## Open follow-ups and risks

- Web browser tests can't launch in this container (Playwright browser version mismatch); environment only.

- Runner PTY budgets (1.44) still miss after the perf-pty fix under load; re-benchmark on an idle machine and decide whether to batch acks in the hub.
- 1.16 must warm `RunnerBundle.current` outside the 60 s sandbox effect (source-run servers build the bundle on first use), and add `sandbox.release-waiters` to the boot-timeout arm (1.19).
- The runner's fs ops run as root: anything the server writes into a sandbox that the `t3` agent must modify needs chown (1.12, 1.16, 1.24, 1.34).
- `DEFAULT_BASE_IMAGE_REPOSITORY` is `ghcr.io/rutvikchandla3/t3-sandbox` (1.23): maintainers to confirm the owner.
- Old runner builds under `<stateDir>/runner/` are never pruned (1.9).
- PR-level runtime evidence the specs ask for (dev-server metrics tables, `test-t3-app` passes, captures) was deferred: workers may not start dev servers. The lead does it once in the integrated passes.
