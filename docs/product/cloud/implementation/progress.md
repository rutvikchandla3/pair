# Pair Cloud: implementation progress and handoff

Status: in progress on `feat/pair`, updated by the lead agent after every landed PR. This file lets
another session (or another account) resume the build exactly where it stopped, and records each
milestone gate's runs.

Scope of this run: M0 (11 PRs) and M1 (46 PRs) from [m0-seam.md](./m0-seam.md) and
[m1-cloud-threads-docker.md](./m1-cloud-threads-docker.md), both integrated passes and G1, then M2
(36 PRs) from [m2-pair-cloud-docker.md](./m2-pair-cloud-docker.md) and G2, then M3 (8 PRs) from
[m3-continue-in-cloud.md](./m3-continue-in-cloud.md) and G3. M4 and M5 have no full specs yet
([README](./README.md): each milestone's are written while the previous gate runs).

## Status

**Landed on `feat/pair` (57 of 57):**

- M0, complete (11): 0.1–0.9, 0.11, and 0.10 folded into 1.11 (allowed by M0's plan).
- M1, complete (46): 1.1–1.45 with 1.28a. Plus follow-ups: `perf-pty` (runner output coalescing),
  the runner revoke fix, `fix-flaky-kill` and `fix-cloud-delegate`.

**M2 (36 of 36 done), G2 closed:** full specs in [m2-pair-cloud-docker.md](./m2-pair-cloud-docker.md).
Landed: 2.1, 2.2, 2.4, 2.7–2.9, 2.12, 2.13, 2.18, 2.21–2.40, 2.42–2.47; 2.41 measured with no
change needed on the Mac. G2 ran on releases `0.1.7-pair.1`–`.3` and landed fix rows 2.48–2.59
([G2 on real hardware](#g2-on-real-hardware-2026-11-09-pair-cloud-pass-releases-v1v3)). Lead decision
awaiting maintainer sign-off: 2.44 reads pull requests with the server's own sign-in first and the
App only where that can't (07 open question 1 recommended App-first). Open maintainer questions are
under the spec page's "What the code changed in 10 §2".

**M3 (8 of 8, plus fix row 3.27), G3 running:** full specs in
[m3-continue-in-cloud.md](./m3-continue-in-cloud.md), copy reviewed (87adfbf41). Landed: 3.20
(78669f835), 3.19 (2cd926a34), 3.21 (0689f46ff), 3.22 (598da8e4b), 3.25 (9018429b7) and 3.23
(cea3b8942), 3.26 (13ab74753), 3.24 (63e12b0e3) and the eval fix 3.27 (529fd4920). Release
`0.1.7-pair.4` (V4) is published as a prerelease. G3 is running by the spec's
[integrated pass](./m3-continue-in-cloud.md#m3-integrated-pass) without its phone step: see
[G3 on real hardware](#g3-on-real-hardware-2026-11-10-mac--pair-cloud-pass-release-v4).

**M4 (0 of 12), specs written 2026-11-10:** full specs in
[m4-team-images.md](./m4-team-images.md) (aa324bef9), written from the code at `d01e81c56`, so
before 3.23. Its open questions are answered as proposed (the maintainer is away); the list is
under that page's "What the code changed in 10 §2". M4's rows are built while G3 runs. They are
integrated on the local branch `m4` (checkout `../pair-wt/m4`, pushed as `wip/m4`) and
`feat/pair` fast-forwards to it once G3 passes: 4.11 (e8ad2d5c0) and 4.12 (86d84b583) are there,
4.13 is in flight. `land.sh` and `mkwt.sh` take `BASE=m4` (and `LEAD=../pair-wt/m4`) for that.

### M3 maintainer answers (2026-11-09)

Every open question in the M3 spec is answered as proposed, except the row wording: the cloud side
reads "Continued locally on `<environment label>`", and a copy reads "`<member>` copied this thread
to `<environment label>`". So: agent links need no Labs beta on either side; non-cloud MCP launches
on Pair Cloud stay refused; the no-model link account and the link fence across renewals wait until
after G3; unclaimed seeds live 24 h; an export is user and assistant text at the spec's caps;
Continue locally on an asleep machine with no snapshot is refused ("Wake the machine first") and
shows in `npx t3`'s web too; the cloud model is the member's own instance of the same model first;
Connect GitHub is a warning; no keybinding. The evals key is still open.

### Maintainer answers (2026-11-10)

The lead is back on the Mac (`../pair-wt/`, as for M2) for the rest of M3, G3, M4's specs and
build, and G4. The maintainer is away for the run, so every open question takes the spec's
proposal and is recorded in the row's notes.

- **Pairing.** The lead mints pairing and invite links on the VM and pairs the G3 test clients
  itself. Links stay out of commits and transcripts.
- **Member B** for G3 step 3 is the GitHub login `rutvik-netizen`, with no Claude account or
  GitHub connection of their own: the step only needs B to copy A's session.
- **Evals.** The maintainer adds `ANTHROPIC_API_KEY` to the repo's `.env`; the lead then runs the
  live evals that 1.42, 3.19 and 3.23 owe. Until the key is there they stay owed.
- **Releases.** Any prerelease the run needs is approved: V4 with M3, fix releases after G3, and
  one with M4 for G4.
- **Phone.** 3.24 is built but not tested on a phone, and G3 step 5 is set aside. The same holds
  for M4's mobile row.
- **G4** runs step 1 only (the Docker driver on the G3 server). Steps 2–6 need M5 and an AWS
  account.
- **Workers:** Opus high for critical rows, Sonnet high for small ones.

**Left from M1:** the [M0 integrated pass](./m0-seam.md#m0-integrated-pass) and the
[M1 integrated pass](./m1-cloud-threads-docker.md#m1-integrated-pass). They also collect the
PR-level runtime evidence workers could not (each PR's note below says what it owes). Nothing is
in flight and no worktrees exist; start from `feat/pair`.

## Where this run stopped (2026-11-07)

### Remaining work

1. **Integrated passes, server side** (possible in a cloud container with Docker): `vp run dev` with
   Docker and the Replay (dev) provider; Settings → Cloud **Test** against the real daemon; a cloud
   thread from `t3 thread start --cloud main`; a side chat sharing the machine; settle → container
   stops and diffs still read from the mirror; kill the container → "Machine failed", Retry,
   Discard and the push; the 1.24 setup-script env transcript (also confirm the clone is owned by
   the `t3` user, not root); the 1.42 CLI transcript and `--cloud`/`--worktree` usage error; the
   M0 metrics comparison (OTLP receiver, before/after git command counts); `vp run bench:runner` on
   an idle machine. Rebuild `t3-sandbox:dev` first if the container restarted (Machine setup step 4).
2. **Integrated passes that need resources a cloud container lacks:** seeded data (a real
   `~/.t3/userdata` to copy from), a test GitHub repo plus a GitHub App key (and a member token) for
   the two push/PR runs, real provider credentials for one Claude (Haiku) and one Codex turn, a
   phone or simulator for `test-t3-mobile`, and a working browser for `test-t3-app` captures on web
   and desktop (Playwright's pinned browser does not launch here).
3. **Live evals for 1.42:** `threads-vs-tasks.ndjson` on the old and new text, Sonnet and Opus
   (needs a model API key; the dry run passes). The PR needs the `agent-context-increase` label.
4. **PR links:** `docs/product/pair-features.md`'s "Cloud threads on Docker" entry gets PR links
   once the M1 work has GitHub PR numbers.
5. **Then:** M2's full specs, written on 2026-11-09 in
   [m2-pair-cloud-docker.md](./m2-pair-cloud-docker.md).

### Maintainer answers (2026-11-08)

1. **Integrated passes:** run on GCE VM `pair-cloud-pass` (`vm-provider`, `asia-south1-a`,
   e2-standard-8, x86_64). It stays until every milestone lands; stop it when idle.
2. **TODO, not an M1 blocker:** every `OrchestrationV2Command` is dispatchable by any client with
   operate scope, including `sandbox.provision`, `sandbox.created` and `sandbox.runner.attached`,
   so a member can provision a machine past `checkCloudLaunch` (`sandboxAllowed`, credential
   refusals). Predates this run. Fix later by having ws.ts refuse server-only command types.
   Checked 2026-11-08: those three are already excluded from `dispatchCommand` (`rpc.test.ts`). The
   real hole is `delegated_task.request` and its optional `sandbox` field; M2 moves that command
   into the internal union (10 §2, row 2.23).
3. **Accepted for now:** the settings stream sends `sandbox` driver config (`dockerHost`,
   `runnerUrl`) to every member, and only the UI hides it. M2 fixes it (10 §2, row 2.25).
4. **1.42 evals:** still open; they need a model API key in the repo root `.env`.

5. **Open decisions (10 §7):** #1–#6, #9, #10 and #13 are accepted as recommended. The Mac and
   phone reach the VM over Tailscale (`vp run dev --share`); the phone is the maintainer's iPhone,
   since this Mac has no Xcode. Vite+ on the Mac: Node 26.12.1 through nvm, then
   `npm i -g vite-plus@1.4.0 pnpm@12.14.0` and `vp i`.

### M1 server-side pass (2026-11-08, on `pair-cloud-pass`)

**Passed:** Settings → Cloud **Test**; a CLI cloud thread (`t3 thread start --cloud master`) with
the clone owned by `t3`; the terminal runs as `t3` in the worktree; checkpoints `ready`, turn diffs
and Changes work, and read from the mirror after settling; settle stops the container (header
"Asleep" with **Wake**, **Un-settle**); the thread menu shows Sleep now and Discard machine; a
removed container reaches "Machine failed" with **Retry** and **Discard**, and Retry provisions a
new machine; "Connect GitHub to push" shows without a credential.

**Fixed (each with a test unless noted):**

1. The runner bundle pulled in `ProjectionStore` through `StoppedSandboxReads`: the tag moved to
   `StoppedSandboxReadsService.ts`, and CI checks the bundle.
2. `git -C` spawned from the server's cwd, which a sandbox lacks ("Failed to resolve the VCS
   driver"): `VcsProcessInput.spawnOutsideCwd` uses the host's home on a sandbox.
3. The runner made temp dirs as root with mode 0700, so the agent's git could not use the review
   index (untracked-file diffs failed): it chowns them to the agent. No unit test: it needs a root
   runner and a non-root agent, which the test layers are not; proven on the VM.
4. The runner's ops git (checkpoints, turn diffs) ran as root and git refused the `t3`-owned repo,
   so every checkpoint was `missing`: `opsLayer.ts` spawns through `setpriv` as the agent. Same
   test gap as 3.
5. Retry and Wake on a machine whose container was gone restarted the missing container forever: a
   start that finds no backend (and a status or reconcile that says missing) fails with code
   `missing`, which clears `driverRef`, so the retry provisions.
6. That new machine had an empty disk, but only a destroyed machine counted as one: a prompt to a
   machine failed `missing` now also rebuilds the checkout (`hasNoDisk`).
7. A server restart failed every cloud run still waiting for its machine ("Worktree setup
   cancelled"): shutdown interrupts the preparation fiber, which failed the run before startup
   recovery could re-arm it. An interrupted cloud preparation now leaves the run parked.
8. Web's branch picker sent a remote ref (`origin/test`) as a cloud base, which the machine refused
   ("origin/test is not on origin"). Web now drops the remote for Cloud, as mobile does.
9. A local draft's "Previous worktree" offered a cloud thread's checkout, a path inside its machine.
   It now skips cloud threads.
10. Every client send carries `deliveryIntent: "auto"`, which resolved to `start_immediately` after
    the cloud gate had deferred the prompt: a prompt to an asleep or discarded machine started at
    once and failed "workspace folder no longer exists". The gate now drops the intent it overrides.

**Not fixed, for the maintainer:**

- **Working-tree Changes on an asleep machine** fail ("Review diff preview cwd must stay within the
  configured workspace root"): 1.33's stopped reads cover files, search and turn diffs, not
  `ReviewService.getDiffPreview`. Spec gap.
- **Wake on a settled thread** starts the machine, and the settle rule stops it a second later. Wake
  should either un-settle or the rule should fire only on the settle transition.
- **The M1 pass plan says `docker stop` reaches "Machine failed"**; 04 makes a stopped backend
  `sleeping` (correct), and only a missing one `failed`. Use `docker rm -f` in the pass.
- **Retry from the machine-failed banner after `missing`** provisions a machine with no checkout,
  and every later prompt fails "workspace folder no longer exists". Only a prompt (or the failed
  run's Retry) rebuilds it. Either the banner should say "Sending starts a new machine", as a
  discarded one does, or a new disk should get its threads' checkouts back.
- **A cloud thread waiting for its machine** shows the host checkout's branch ("From master") in
  its details panel, not the base it asked for: the thread has no branch until preparation runs.
- **Changes after a restore** keeps the pre-restore count until the window regains focus or
  reloads: restore does not invalidate git status. Not cloud-specific.
- **The runner's other fs writes** (writeAtomic, makeDirectory, copy) also create root-owned files
  in the agent's tree. None broke the pass; worth one look.

**Also passed:** the web composer's Cloud send; a side chat shares the owner's machine (no second
container) and its approval shows on the parent; restore on that shared checkout is refused as
shared; at the Docker cap (a quarter of the CPUs, 2 here) a third thread shows "Waiting for a
machine: team limit reached"; restore with "Revert files too" on an unshared cloud thread removes
the turn's file on the machine; a member sees no admin-only machine actions in the menu or palette
and gets the member-worded GitHub banner; the palette's New cloud thread, Sleep now and Wake machine;
Discard's confirm and banner, then a prompt that waits for a new machine and rebuilds the checkout.

**`vp run bench:runner` on the idle VM (8 CPUs):** startup, stdout latency, echo and memory pass;
Docker misses PTY throughput (41 MB/s vs ≥50) and server CPU per MB (25 ms vs ≤5). Local alone
spends 17.6 ms/MB, so the CPU budget is out of reach as written; the throughput gap is the hub.

**M0 metrics (OTLP to LGTM, Replay `showcase`, Hello-World, a local and a worktree thread):** every
run made the same 41 git operations the same number of times (`t3_git_commands_total`): `main`,
0.3's parent `b140d35fa`, 0.3 `b93bd84cc`, and `feat/pair` head. Counts pass. 0.3 itself stayed in
the noise (count-weighted p50 19.7 → 21.3 ms). Head is slower than `main` in five of five paired
runs: mean p50 `main` 23.9 ms (22.7–25.5), head 27.5 ms (25.8–29.3), about +15%. A bisect over the
72 commits after 0.3 found no single step (runs vary ±1.5 ms on this VM), so it is spread out or
background load; worth a profile before M2.

**M0 in the browser (Replay, Hello-World, a local and a worktree thread):** a turn streams and
completes; the terminal opens in the thread's cwd, and its busy state shows on the closed drawer's
button and clears when the command exits; the file browser lists, opens and saves into the thread's
own worktree, and search finds a file made outside the app; "Revert files too" on the worktree
thread restores the turn's files and removes a later one; on the local thread it is refused as
shared and the chat stays; a `python3 -m http.server` started in the terminal shows under Servers
(only while the drawer is closed, since the details panel drops to compact) and **Stop** frees the
port.

**With real credentials (Claude setup token as the provider env secret, GitHub App
`pair-cloud-test-d548` installed on the private test repo `rutvikchandla3/pair-cloud-test`):**
a Haiku turn in a local worktree and in a cloud thread (the token reaches the machine, the agent
runs as `t3`); a private-repo cloud clone through the installation token; the agent's own commit,
`git push` and `gh pr create` from the machine (pair-cloud-test#2, opened by the App, committer
"T3 Code"); a waiting thread gets a machine as soon as another sleeps.

11. **Fixed:** with no member git email, every agent commit on a machine failed "Author identity
    unknown": the image sets no `user.name` and `GIT_AUTHOR_*` is set only for a member's email.
    `SandboxProcessEnvironment` now passes the server's identity as `user.name`/`user.email`
    through `GIT_CONFIG_*`, which a member's `GIT_AUTHOR_*` still overrides.

**Not fixed, from the credential runs:**

- **The PR list and panel need the server's own GitHub credential** (Settings → Source Control
  token or `gh auth login`): `GitHubRequestPolicy` never uses the App key's installation token, and a
  member token is used only when Pair opens a PR. With just the App key, the panel says "GitHub has
  no working credential for this host". Open question: should the installation token serve reads
  on repos where the App is installed? The cloud threads guide says this for now.
- **A private repo with no credential** fails provisioning with a bare "git clone failed", while the
  banner talks only about pushing. It should say "Connect GitHub to clone private repos", as 05
  does for image builds.
- **Host setup, for the pass:** the server spawns `claude`, `codex` and `gh` from its own PATH (on
  the VM the system default, not the shell's: symlink them into `/usr/local/bin`), and the GitHub
  settings need `gh` 2.81 or newer (Ubuntu's 2.45 is too old; use cli.github.com's apt repo).
  Settings already names both, so no guide change.

**Still to run:** Codex turns, local and cloud (connect a ChatGPT account); the member-token
push/PR (remove the App key, paste a token under Settings → Team → **Use a token instead**, and a
server token for the PR panel); the 1.42 evals (`ANTHROPIC_API_KEY` in the VM's `~/pair/.env`); the
machine-failed push (needs a device); `test-t3-mobile`; `test-t3-app` captures on desktop.

### G1 on real hardware (2026-11-08, Mac → `pair-cloud-pass` over Tailscale)

Passed so far:

1. **Connect.** Pair (Dev) on the Mac added the VM through `vp run dev --share` and listed
   `pair-cloud-test` and its cloud threads.
2. **Cloud thread.** A new Cloud-workspace thread on the Docker driver ran a Claude Haiku 5.5 turn
   (5.4 s, `gate-g1.md` +1).
3. **Commit and push.** Commit & push landed `f7350d6` on `t3/39029d10` (Haiku wrote the message).
   Create PR then opened [pair-cloud-test#3](https://github.com/rutvikchandla3/pair-cloud-test/pull/3)
   once the server had its own token. Settings → Source control takes a fine-grained token with
   the repo selected and Contents and Pull requests set to read and write. A token without the
   repo makes GitHub answer "Pull request not found".
4. **Sleep and Wake** from the thread menu: the container stopped, restarted, and kept the commit.

Fixed during the run:

- `cf2fe7cea`: a runner bundle staged on macOS kept musl externals and went over the 25 MiB cap.
- `8588944fe`: Vite answered CORS preflights for proxied routes itself, so the desktop app
  (`t3code-dev://` origin) could not add a shared dev server.
- `12e3c192b`: Codex text generation wrote its schema and output files on the server, but ran on
  the thread's machine.
- `621664773`, `85b6f38c4`: git the server itself ran on a machine (Commit & push) had no
  identity. Every process there now gets the server's identity from the host's base environment.

- Text generation for a cloud thread ran in its machine with the server's whole environment.
  Codex died on the server's `HOME` (`Permission denied`), and the agent's user could read any
  secret in that env. Commit, PR and branch text now generate on the server. A review guide that
  investigates a cloud thread fails until it gets the machine's own env.

Drive the web app in a browser over `gcloud compute ssh … -L 15733:localhost:5733` (the dev
cookie is set). Desktop GUI automation through `orca computer` repeated typed text and was slow.

Step 6 (phone) is skipped for now. The phone paired over the tailnet, but it runs the App Store
T3 Code app, which has no member push. A Pair build that receives push needs a paid Apple
Developer team to sign it. Personal-team builds leave out the push entitlement.

Step 6's `docker rm -f`, run from the web during a `sleep 120` turn, passed. The machine went
`failed` with `missing` when the 120 s lease ran out, and the banner showed **Retry** and
**Discard**. Retry provisioned generation 3 with an empty `/t3-sandbox/<id>`, and the details panel
offered "Initialize Git". That is the known Retry gap, and 2.13 owns it.

Video (desktop steps 1–4, then web for the PR, the fixed commit and Machine failed):
`~/rcode/pair-gate-videos/g1-gate-run-2026-11-08.mp4` on the maintainer's Mac.

**G1 closed on 2026-11-09 by the maintainer**, with steps 1–5 and step 6's `docker rm -f`
passed. These were set aside, not run, and need the maintainer when picked up:

- step 6's `machine-failed` push, which needs a Pair build signed by a paid Apple Developer team;
- Codex turns, local and cloud. A managed ChatGPT account added from the web (Add provider →
  Continue with ChatGPT) lost its instance mid sign-in ("This provider instance is no longer
  available"), and the account was gone from settings afterwards;
- the member-token push and PR. Clear the App ID first: `GitCredentialService.sourceFor` picks
  the App whenever one is configured;
- the 1.42 evals, with `ANTHROPIC_API_KEY` in the repo root `.env`;
- test-t3-mobile, with a simulator (this Mac has no full Xcode) or a Pair build.

### G2 on real hardware (2026-11-09, `pair-cloud-pass`, releases V1–V3)

The [M2 integrated pass](./m2-pair-cloud-docker.md#m2-integrated-pass) ran on the VM from the
published prereleases [V1 `0.1.7-pair.1`](https://github.com/rutvikchandla3/pair/releases/tag/v0.1.7-pair.1),
[V2 `0.1.7-pair.2`](https://github.com/rutvikchandla3/pair/releases/tag/v0.1.7-pair.2) (rows
2.48–2.56) and [V3 `0.1.7-pair.3`](https://github.com/rutvikchandla3/pair/releases/tag/v0.1.7-pair.3)
(2.57, 2.58), driven from the Mac's browser pane over Tailscale. Steps 6, 7 and 13 were set aside
by the maintainer (phone, phone across servers, managed Codex).

1. **Install and start: passed.** Cloud-only, `cloudLaunch` true, Test reports gVisor, team cap 6,
   App ID and key saved, a Claude team account (setup token). Fixed on the way: gVisor refused the
   runner's host socket without `--host-uds=open` (661bf393f says what to run), and machines under
   gVisor could not resolve names (7fd616700; the install guide now asks for outbound DNS).
2. **Desktop beside its local server: passed** on web (local and worktree Replay turns, terminal,
   diff, restore). Findings 9, 10 and 13 (2.48).
3. **Cloud from a local project: passed.** PR #4 opened as the member through the device flow with
   an App push; PR #5 pushed with the member's own token; the App ID was restored after.
4. **Unpushed branch: passed** ("Push <branch> first", then the ahead warning). Findings 18 and 21
   (2.52).
5. **Private repo: passed through the Git URL source** (add, clone, a Haiku session pushed
   `g2-step5-private`). The GitHub repository source failed for any private repo (2.56).
6. **Sleep, wake, lost disk: passed** on V1 (auto-sleep on time, reads while asleep, Send → reply
   5.3 s, Retry rebuilt from the mirror). `docker rm -f` lost the send and the next turn hit a
   missing Claude session (2.54, 2.55). Video: `~/rcode/pair-gate-videos/g2-step8-sleep-wake-lost-disk.mp4`.
7. **Automations: passed.** A scheduled task and the webhook each launched a cloud session.
8. **Drain and upgrade: passed on V2 → V3.** V1 → V2 drained and held a prompt, but V2's start
   prune removed V1's runtime, which every V1 machine bind-mounts (2.57, blocker). On V2 → V3 the
   running Haiku turn finished, `t3 drain` held a new send (admission `draining`), `t3 update`
   restarted the service on V3, a V1 machine woke on V3 and the held send reached its first token
   5 s after the machine was ready; the V2 machine survived the restart. V2's runtime stays until
   the prune's one-hour grace ends. Finding 28 reproduced.
9. **Restore: not passed.** On V2, saving `restoreModeSince` made the server drop settings.json for
   defaults (2.58, blocker), so Settings → Cloud had no Restore mode section. 2.58 is in V3; the
   rerun on V3 was set aside when the gate closed.
10. **Numbers.** Ten Haiku sends each on V3: first token on a ready machine p50 1.28 s (p95
    1.51 s) against 1.19 s (p95 1.78 s) for a local worktree thread on a second, non-cloud V3 server
    on the VM: 90 ms apart, within 300 ms. Asleep (Sleep now) → machine ready p50 1.23 s (p95 2.32 s),
    under 5 s; asleep → first token p50 4.27 s, p95 8.59 s, under 20 s and 45 s.
    `bench:runner --load` against V3's runner tree with 2.59: stdout and keystroke rows pass (03 §9's
    M2 column), startup misses (548 ms mounted, 917 ms fetched), CPU over local 8.9 ms per MB
    against 5, and the load test fails (2.59's note). The 2.41 A/B rerun was stopped after one run.

Findings → rows: 2.48 (6, 9, 10, 13), 2.49 (1–5, 7, 8), 2.50 (11, 14, 15), 2.51 (16, 20), 2.52
(18, 21), 2.53 (17), 2.54 (23), 2.55 (24), 2.56 (25, 26), 2.57 (29), 2.58 (30), 2.59 (31). 19 was a spec
fix (8ef0a28ca), 12 was dropped (deliberate attribution), and 22, 27, 28 and 32 are follow-ups.
Evidence: `../pair-wt/g2-evidence/` on the lead's Mac (not committed).

**G2 closed on 2026-11-09 by the maintainer.** Set aside, not run:

- step 11 on V3, and steps 6, 7 and 13;
- the V3 checks rows 2.48–2.56 owe (each note's "Owes"), with their captures: 2.54 and 2.55's
  `docker rm -f` with a Claude thread, 2.56's **GitHub repository** add, 2.51's `docker stop`,
  2.53's PR text with Codex signed out, and 2.49's `t3 service install` transcript;
- 2.41's A/B on the VM.

Follow-ups from G2:

- 22: deleting a scheduled task asks for no confirmation.
- 27: after `t3 drain --cancel` the web keeps "Pair Cloud is restarting for an upgrade…" until a
  reload.
- 28: a wake held by a drain shows "Waking machine" and "Setting up …", not the draining copy.
- 32: 2.57 recreates `versions/<old>/runner` as an empty folder that the start prune never removes
  (it skips entries without `.install-complete`).
- Startup and CPU over budget on the VM (03 §2.3 and §9), and the load test (2.59).

### G3 on real hardware (2026-11-10, Mac → `pair-cloud-pass`, release V4)

In progress. Pair Cloud runs [v0.1.7-pair.4](https://github.com/rutvikchandla3/pair/releases/tag/v0.1.7-pair.4)
(prerelease, tagged at `e231e566f`: every M3 row but 3.27). The Mac runs two worktrees at the tag,
`../pair-wt/g3-a` (member A, seeded) and `../pair-wt/g3-b` (member B), each with a clone of
`pair-cloud-test` under `../pair-wt/g3-repos/`. Evidence is in `../pair-wt/g3-evidence/` (not
committed). The VM has a `shutdown -h` timer as a guard while the maintainer is away.

0. **Before: passed.** `t3 drain`, `t3 update 0.1.7-pair.4 --yes`, `t3 --version` prints
   `v0.1.7-pair.4` (transcript `upgrade-v4.txt`). `~/g2-local` is deleted. g3-a's client added Pair
   Cloud with a one-time owner link, and Settings → Environments offered **Link** with Linked
   environments off in Labs; the link lists as "Supervised · Reachable". The link was made
   Supervised (the dialog's default), so cloud turns started through it ask before commands.
1. **Continue in cloud: passed (first move).** A local worktree thread on `g3/move-1` with two
   unpushed commits, a changed `README.md`, untracked `notes/seed.md` and `scratch.env`, and an
   ignored `node_modules/`. The preview listed both commits, `README.md`, `notes/` and
   `scratch.env`, and not `node_modules/`. With `scratch.env` excluded the cloud session opened on
   Pair Cloud with the conversation as history ("Continued from … on Rutvik Chandla"), its machine
   had both commits, the `README.md` change and `notes/`, and no `scratch.env`; Haiku's first turn
   reported exactly that from the history. The local thread shows "Continued in cloud on
   pair-cloud-pass…", and its worktree, branch and origin are unchanged. Seed 1,490 bytes, export
   1,829 bytes, upload 261 ms, 1.6 s in all (`cloud move` in g3-a's trace). Still to run: the
   pushed-branch move with no seed, and the palette entry.

2. **Continue locally, owner: passed, after two refusals (finding 1).** On the step 1 session
   Haiku appended a line to `README.md` and made `cloud/note.txt`, uncommitted. **Continue
   locally** from g3-a made a local worktree with both commits, the uncommitted `README.md` change,
   `cloud/` and `notes/`, and a thread with the history and "Continued from … on
   pair-cloud-pass…". The cloud session shows "Continued locally on Rutvik Chandla", settled, and
   its container exited. Then Wake, **Sleep now**, and Continue locally again: the container
   stayed stopped (same `FinishedAt`) and the local worktree matched. The local branch is
   `g3/move-1-2`, then `g3/move-1-3`: the first move's local worktree still holds `g3/move-1`.
3. **Continue locally, another member: passed, after one refusal (finding 1).** Member B
   (`Teammate`, GitHub `rutvik-netizen`, role member, no accounts of their own) joined from g3-b's
   client with an invite link and linked g3-b without the beta. A fresh session as member A
   (`t3 thread start --environment <Pair Cloud> --cloud main` from g3-a's terminal) left a
   `README.md` change. From g3-b, **Continue locally** made a thread on `g3/step3-a-copy` with the
   change; the cloud session shows "Teammate copied this thread to Rutvik Chandla", stayed awake
   and answered member A's next prompt; `git ls-remote` shows no `g3/*` branch.
4. **The agent link: partly run.** From g3-a's terminal, `t3 thread start --environment <Pair
   Cloud's id>` without `--cloud` answers "… runs every thread on a cloud machine. Pass --cloud
   <base-ref>.", and with `--cloud main` it launches there as member A (step 3's session). Still
   to run: `delegate_task` from a local Haiku thread, `t3_thread_continue_in_cloud`, and the
   refused `cloud` delegation to g3-b with the beta on.
5. **Phone: set aside** (maintainer, 2026-11-10).

Findings so far:

- **Finding 1 (fix row 3.28, in flight): Continue locally fails about every other try.** The
  laptop refuses with "The cloud thread's origin, github.com/…, doesn't match this project's.",
  or Pair Cloud answers 500 "couldn't prepare this thread to continue locally". Both sides read
  the project's origin from `ProjectService.getShell`, which only peeks the repository-identity
  cache (`ProjectEnrichmentService.getAvailable`) and is null when the cache has no entry, as it
  is after the previous move's git work. `CloudMoves.continueLocally`, `CloudMoves.move` and
  `CloudMoveSource.seed` all do it. Trying again works. The laptop half is in neither V4 nor the
  g3 worktrees; the cloud half needs a release.
- A failed Continue locally showed no toast in captures taken 2 s and 9 s after the click. The
  code updates the "Continuing locally…" toast to an error; check that it stays long enough to read.
- Both local servers on this Mac are labeled "Rutvik Chandla" (the host's name), so the move rows
  for g3-a and g3-b read alike. Expected with two servers on one Mac.
- The preview lists an untracked folder as `notes/` with `+0 −0`, not its files (the spec's step
  expects `notes/seed.md`). Cosmetic.
- The live evals (Sonnet 5.5 and Opus 5.5, nine cloud cases, `m3-sonnet/`, `m3-opus/`): seven pass
  on both, including both Continue in cloud cases. `agent-link-laptop-can-sleep` failed 0 of 2 on
  both (the launch left out `projectId`) and `agent-link-vps-stays-vps` failed on a missing mock.
  Fixed by 3.27 (529fd4920), which is after the V4 tag; its two cases are still to re-run live.

## How to resume

The lead agent orchestrates; workers implement one PR each in a sibling worktree and report back;
the lead rebases, typechecks, fast-forwards `feat/pair` and pushes. Keep about four workers at a
time (four CPUs, 15 GB, and usage limits: eight Opus workers exhausted a 5-hour window). Models: Opus
high for critical-path and security PRs, Opus medium or Sonnet high for the rest.

### M2 on the maintainer's Mac (2026-11-09)

M2 is built on macOS, not the container. `../pair-wt/` (`/Users/rutvik/rcode/pair-wt`) holds
`env.sh` (Node 26 from nvm plus the worktree's own `vp`), `mkwt.sh`, `land.sh`, `push.sh`,
`WORKER_BRIEF.md` and `HANDOFF.md`, adapted from the scripts below. Workers are the lead's own
background subagents (Opus, high effort), one per PR in `../pair-wt/<id>`; Orca can't wake a
desktop-app session. Workers check the lead checkout with `git --no-optional-locks status`, since a
plain `status` takes the lead's index lock. Mac-only test failures are listed in the brief.

### M3 in a cloud container (2026-11-09)

M3 is built in a claude.ai/code cloud container: lead checkout `/home/user/pair`, worktrees and
the scripts below in `/home/user/pair-wt/` (recreated from this file, the brief pointed at the M3
spec). Workers: Opus high for security and critical-path rows (3.19, 3.20, 3.22, 3.23, 3.25),
Sonnet high for 3.21, 3.24 and 3.26.

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
# Workers never edit progress.md and every landing does, so a squash that reverts landed work shows here.
git diff --name-only feat/pair "wt/$id" | grep -q 'implementation/progress.md' && { echo "REVERTS LANDED WORK $id (touches progress.md)"; git diff --stat feat/pair "wt/$id" | tail -3; exit 3; }
cd /home/user/pair
before=$(git rev-parse HEAD)
git merge --ff-only -q "wt/$id"
files=$(git diff --name-only "$before" HEAD)
echo "$files" | grep -q 'pnpm-lock.yaml\|package.json' && vp i --frozen-lockfile -- --yes >/tmp/land-install.log 2>&1
pkgs=$(echo "$files" | grep -oE '^(apps|packages)/[^/]+' | sort -u)
echo "$pkgs" | grep -q 'packages/\(contracts\|shared\|client-runtime\)' && pkgs=$(printf '%s\n' $pkgs apps/server apps/web packages/client-runtime | sort -u)
fail=0
for p in $pkgs; do
  [ -f "$p/package.json" ] && { grep -q '"typecheck"' "$p/package.json" || grep -qs 'typecheck:' "$p/vite.config.ts"; } || continue
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

Workers read `../pair-wt/WORKER_BRIEF.md` (the brief below) and `../pair-wt/HANDOFF.md` (a copy of "Notes from landed PRs" below, to the end of this file); recreate both from this file in a fresh container.

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
- To squash, run `git reset --soft $(git merge-base HEAD feat/pair)` and commit. Never
  `git reset --soft feat/pair` after the lead moved it: your commit would revert landed PRs.
- Do not commit plans or scratch notes, and do not edit `docs/product/cloud/implementation/progress.md`
  (the lead owns it).

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

## 1.16 cloud launch (landed)

- Contracts: `OrchestrationV2ThreadLaunchCloudStrategy` + a launch-only union used solely by `OrchestrationV2ThreadLaunchInput` (runs, defer_start, MCP, scheduled tasks never take `cloud`).
- sandbox/lifecycle/CloudPreparation.ts: `CloudLaunchError`, `resolveCloudLaunch`, `awaitSandboxReady` (also waits for `RunnerHub.connection`), `checkoutInSandbox`, `sandboxIdForLaunch`, `SandboxCheckoutRoot` Reference (test seam). Git `readRemoteUrl`, `cloneRepository`.
- ThreadLaunchService: three-commit launch; refuses LocalOnly/Unsupported credentials before any thread or machine; retry dispatches `sandbox.retry` first; preparation reserved per run id; requires ProjectionStoreV2. ws.ts shows refusal reasons.
- Lifecycle: `sandbox.release-waiters` on `ready` and every `failed` (incl. boot timeout). `decideCloudPrompt` + `gateCloudMessage` park prompts, wake, or re-provision after discard. Recovery re-arms cloud `preparing` runs with `sandbox-rearm:<runId>`. Runner bundle warmed at startup when a driver is configured.
- SandboxEffects/recovery use `Effect.serviceOption(ThreadLaunchService)` (production wiring not asserted by a test).
- E2E test (ThreadLaunchService.test.ts, it.live): fake driver + real hub + in-process runner → ready → real clone/worktree → deferred run released (stops before a provider turn).
- For later: 1.17 replaces the non-owner refusal in `decideCloudPrompt` with `request-wake`; 1.24 setup scripts still get sandbox paths without sandbox handling; 1.42 MCP schema lacks `cloud`. Cloud threads' own `root`/`existing_worktree` delegation strategies unhandled.

## 1.24 setup scripts (landed)

- `sandbox/scripts/sandboxScriptEnvironment.ts` takes `Pick<WorkspaceHost, "spawner">`; Manager.ts calls it only when `host.kind === "sandbox"`. Every terminal on a sandbox host gets `T3CODE_SANDBOX=1`; scripts (with `T3CODE_PROJECT_ROOT`) get the clone root from `git rev-parse --git-common-dir` run in the sandbox, falling back to the worktree path or cwd.
- Also fixed 1.25's "TODO 1.24": sandbox terminals no longer get the server's managed ACP bin dirs on PATH.
- 1.16's setup script goes through `ProjectSetupScriptRunner` → `terminalManager.open`, so it is covered.
- `T3CODE_SANDBOX` is still not set for provider processes (1.12's open note). A root-owned clone would trip git's dubious-ownership check and silently fall back; the clone is made through the sandbox spawner (agent uid), so check ownership once in the integrated pass.

## 1.38 web Cloud mode (landed)

- `BranchToolbar.logic.ts`: `EnvMode` gains `cloud`; `resolveCloudEnvModeItem` (hidden / offered / disabled + reason) feeds both pickers, which take a resolved `cloudItem` prop. Cloud is offered on drafts only, not empty server threads. A cloud draft falls back to worktree in render when Cloud goes away.
- `packages/shared/src/projectSettings.ts` `resolveSendEnvMode` is generic now so `ThreadEnvMode` never gains `cloud`.
- "Local only" model reason: `cloudModelDisabledReason` (web) wraps 1.26's `sandboxCredentialSupport`, driver read from `ServerProvider`. Mobile (1.41) can mirror it and reuse client-runtime's `prepareCloud`.
- `useWorktreeSetup.ts` unchanged (cloud sends never call local setup tracking; the snapshot still shows 1.24's sandbox setup script).
- For 1.39: "new-thread-on-branch" in `useThreadActionMenu.ts` and `Sidebar.tsx` passes a cloud thread's `/t3-sandbox` `worktreePath` into a local worktree draft; map it to `envMode: "cloud"`. `useHandleNewThread`'s `envMode` already accepts `"cloud"` for `chat.newCloud`. Web bindings for `createSandboxEnvironmentAtoms` are not added yet.
- Owed in the integrated pass: the spec's `test-t3-app` steps 1–4 and captures (browser tests cannot launch here).

## 1.43 machine-failed push (landed)

- `ThreadNotificationKind` gains `machine-failed`, routed with `failed`; MemberPushNotifier picks it from `thread.sandbox?.state === "failed"` in the failed-run branch. Ordering verified: `sandbox.failed` commits `state: "failed"` and enqueues `release-waiters` in one transaction, so the shell is already failed when the run's `run.updated` arrives.
- Accepted edges: a Retry pressed before the notifier reads falls back to "Thread failed"; an unrelated run failure while the machine is failed reads "Machine failed". The web in-app coordinator keeps its own kind list without it.
- Owed in the integrated pass: two-member Docker transcript and the `test-t3-mobile` push title check.

## 1.42 MCP + CLI (landed)

- `t3_thread_launch` takes the launch-only union; refusals reuse 1.16's `resolveCloudLaunch` through new `ThreadLaunchService.checkCloudLaunch` (and `provisionCloud`, which `launch` now calls too). `CloudPreparation.isCloudLaunchRefusal` is shared with ws.ts.
- `delegate_task isolation:"cloud"`: refuses a parent with no branch or a parent already on a machine (its child would inherit the parent's `sandboxId` from `makeSubagentChildThread`). **Deviation:** `delegated_task.request` still carries `{ type: "worktree", baseRef }` and the service provisions the child right after, because carrying `cloud` needs Orchestrator.ts (1.17's). A crash between the two leaves the child prepared locally. Follow-up `fix-cloud-delegate` after 1.17: carry `cloud` through `delegated_task.request` and clear the inherited `sandboxId`.
- CLI: `--cloud`, the usage errors, `Machine: <label>` in `show` (local copy: the server cannot import client-runtime), one "Waiting for a machine" line while `sandbox.admission` is set.
- Budget: `mcpToolListJsonBytes` 47498 → 47818; the PR needs the `agent-context-increase` label.
- Owed: live evals (`threads-vs-tasks.ndjson` on old vs new text, Sonnet and Opus; no API key here, dry run passes) and the CLI runtime transcript. 08's `create_threads` rows (around lines 304 and 381) still list it under "Start in cloud": 1.45 drops them.

## 1.17 shared sandboxes (landed)

- Outbox: `sandbox.request-wake`, `sandbox.hand-over` (timeouts live in EffectWorker.ts's `EFFECT_TIMEOUTS`, 60 s). `planSandboxOnDelete` replaced 1.19's `planSandboxOnThreadDelete`; `sandboxOwnerMemberChange`; `sandbox.adopt` row. `decideCloudPrompt` gives a non-owner `Defer` + `RequestWake`.
- `SandboxEffects.handOver` (adopt id `sandbox-adopt:<sbx>:<oldOwner>`, next candidate on a moved refusal, shared `destroy` when nobody is left); `driverFor`/`destroy` extracted.
- Outside the spec: a fork or side chat's first prompt (context-transfer path) ignored `defer_start`; it now parks like the normal path.
- Deviations: delete destroy enqueues only `sandbox.destroy` (it stops); commands on a deleted owner during a hand-over are accepted, not refused (effects queue behind the hand-over, generation-guarded), so an attached thread's wake isn't lost.
- Open: non-owner prompts on a `destroyed` sandbox are refused (they'd need their own run); delegated children skip `gateCloudMessage` (`fix-cloud-delegate`); a hand-over that exhausts its retries does not fail parked runs.

## 1.39 web header + menus (landed)

- First landing (54dcab85) was squashed onto a newer `feat/pair` with its old tree and reverted 1.17, 1.42 and 1.43; reverted and relanded from its real diff. `land.sh` now refuses a branch whose diff touches progress.md.
- `components/sandbox/useSandboxThreadStatus.tsx`: one shell-derived atom (`useSandboxThreadMachine` / `readSandboxThreadMachine`) that header badge, status line, banners, both thread menus (the sidebar's too) and the palette read; `useSandboxActionRunner` confirms Discard and toasts server errors. Labels in `sandboxActionLabels.ts`.
- The shell `sandbox` summary has no `ownerMemberId`, so the owner-or-admin check uses the owner thread's `ownerId` (kept in sync by 1.17's adopt and reassign); the server refusal is the backstop. Read-only connections see no machine actions.
- `chat.newCloud` (no default binding) in contracts keybindings, chatRouteCommands, and the palette ("New cloud thread in <project>", hidden when Cloud is unavailable). New-thread-on-branch from a cloud thread opens a cloud draft (menu and Sidebar).
- "Starting machine: cloning" can't show as the spec's step 1 caption: cloning runs after `ready`. Mobile (1.41) can mirror the atom's shape.
- For 1.45: `docs/user/keybindings.md` needs `chat.newCloud`. Owed in the integrated pass: `test-t3-app` steps 1–6 and captures.

## fix-cloud-delegate (landed)

- `delegated_task.request` gains optional `sandbox: { sandboxId, driverId, size }` (the run still records `worktree`, no union widens). The orchestrator gives a cloud child that `sandboxId` and provisions it in the delegation's commit through `dispatchSandboxCommand`, which now takes an optional `pendingThread` (keep it if 1.18 changes the signature). The MCP service derives the id with `sandboxIdForLaunch(commandId)`; `provisionCloud` is local to ThreadLaunchService again.
- Cloud delegation from a parent already on a machine is allowed now (the child gets its own); the no-branch refusal stays. Shared delegated children go through `gateCloudMessage`.
- Untested edge: a shared child of a parent on a `destroyed` machine likely fails with a projection error instead of a clear refusal. `existing_worktree`/`worktree` delegation from cloud parents is still unhandled (1.16).

## 1.18 admission (landed)

- `sandbox/lifecycle/SandboxAdmission.ts`: one process-wide lock, `snapshot(driverId)` → `{ running, waiting, cap, startAvailable }`, a start bucket (10 tokens, one per 6 s, from `Clock`; `STARTS_PER_MINUTE` unexported until 1.40 needs it). A removed driver counts as no cap so its start fails `driver-removed`.
- Orchestrator: `dispatchWithReceipt` wraps `dispatchWithThreadLocks` in the admission lock (outside every thread lock) for provision, wake, retry, admit, cloud-thread prompts and cloud delegations. The start token is taken after the commit, under the lock. `AdmissionSnapshot.waiting` makes new starts queue behind waiters.
- Decider: past cap or rate sets `admission`, bumps generation, enqueues no driver effect; `sandbox.admit` row (refusal `no-capacity`); `admission` clears when the state leaves provisioning/waking. Waiting machines skip boot deadlines.
- `SandboxLifecycleWorker` admission pass per driver, oldest first, ids `server:sandbox-admit:<id>:<gen>:<uuid>`, `DueHint` from `nextStartAt`.
- `ComputeCapabilities.defaultRunningCap`: Docker `max(1, floor(NCPU/4))` from `/info` at driver build (falls back to 1 if the daemon is down, until settings change); fake driver option (default 20). 1.40 reads caps from there. `ProjectionStore.countSandboxAdmission`.
- Test harness defaults to an always-open admission stand-in; opt into the real one with the `sandboxAdmission` option.
- Open: a waiting machine can't be discarded (discard refuses provisioning/waking); a cap change sends no event, so waiters re-check only on the next event or the 10 min `DueHint` max.

## 1.40 Settings → Cloud (landed)

- Contracts `sandbox.ts`: `SandboxDriverHealth`, `SandboxOverview`, `SandboxDriverCheckInput/Step/Result` and errors; RPCs `sandbox.overview` (read scope) and `sandbox.checkDriver` (`AuthSettingsWriteScope`, client and server).
- `sandbox/lifecycle/SandboxOverview.ts`: per-driver health (10 s bound), counts via `ProjectionStoreV2.countSandboxStates`, base image label, mirror size (`CheckpointMirror.diskBytes`). Caps are per driver (`runningCap` on each health row) plus top-level `startsPerMinute` (now exported), not `caps.team`.
- `sandbox/compute/ComputeDriverCheck.ts`: image → create → runner → git → discard, timed, 3 min bound; destroy + grant revoke run uninterruptibly (60 s) on every exit. No `RunnerHub.expectCheck`: uses `hub.connection` then `hub.revoke`.
- client-runtime `state/sandbox.ts`: `overview` query (30 s stale, never polls — Docker health runs a privileged egress helper; the page has Refresh) and single-flight `checkDriver`.
- Web: `/settings/cloud` (`CloudSettings.tsx` + logic), search rows (cloud project rows `sandboxOnly`), project rows in `ProjectDefaultsSettings.tsx`. Turning Cloud default off removes `defaultsToCloud` in the same override write.
- Open: the settings stream still sends `dockerHost`/`runnerUrl` to every member (only the UI hides Compute). No real-Docker run of the check yet. Owed in the integrated pass: `test-t3-app` steps and captures.

## 1.41 mobile (landed)

- Shared code moved out of web into client-runtime: `threadMachineAtom` (`createSandboxEnvironmentAtoms` takes `threadShells`), action labels, isolation and machine-count labels, `githubAppConfigured`; `cloudModelDisabledReason` is in `@t3tools/shared/sandboxCredentials`. Web uses them.
- Mobile `lib/newTaskWorkspaceMode.ts` (`NewTaskWorkspaceMode`; the spec's location made import cycles the dependency-graph test caught), used by drafts, outbox, send path and new-task screens. The toggle becomes a menu with Cloud once a driver exists.
- Cloud threads: header label and Machine menu (Sleep/Discard live only there), list-row symbol + word with Wake/Retry, composer notices (failure, discarded, push, shared machine), Local-only model reason. Read-only Machines page in Settings (needs at least one driver); GitHub token row on your own Team row.
- Mobile strips a remote prefix from a cloud base branch (the server branches from `origin/<base>`, so `origin/main` would be refused). Check web's picker can't send `origin/...` as `baseRefForCloud` in the integrated pass.
- Owed in the integrated pass: `test-t3-mobile` on iOS and Android and captures.

## 1.45 cloud guide (landed)

- `docs/user/cloud.md` (new) follows the code, not the spec: only Claude and Codex run in cloud; Codex needs a Pair-connected ChatGPT account or `OPENAI_API_KEY`; caps are per driver plus 10 starts a minute; Cloud only on new threads; setup scripts may `sudo apt-get` (the `t3` user has passwordless sudo). Linked from docs/README.md; team.md, keybindings.md (`chat.newCloud`), pair-features.md, decisions.md and 08's `create_threads` rows updated.
- 08 was reformatted whole by the pre-commit `vp fmt` (none of `docs/product/cloud/*.md` was formatted); layout only.
- pair-features.md's entry has no PR links until the M1 work has GitHub PR numbers.
- Owed in the integrated pass: walk the guide on a dev server with Docker.

## 2.32 historyOrigin forward-compatible (landed 9fa7da9a2)

- `historyOrigin` on `OrchestrationV2AppThread` and `OrchestrationV2ThreadShell` uses
  `ForwardCompatibleOptional`: an unknown value decodes to `historyOrigin: undefined` with the key
  still present (assert `undefined`, not absence). Every reader compares only to `"v1_import"`.

## 2.25 member driver redaction (landed)

- `redactServerSettingsForClient(settings, { secretReferences, settingsWriter })`. Without the
  `settings:write` scope, each driver is rebuilt by `memberDriverView` from an allowlist (`kind`,
  `id`, `label`, `size`). ws.ts builds `client` once per session and uses it at all three sites.
- 2.43 adds `runningCap` to `memberDriverView`'s allowlist. A new driver kind keeps its extra keys
  optional so the member view still decodes. The member-vs-admin frame transcript is owed in G2.
- Closes the "settings stream sends driver config to every member" open follow-up.

## 2.4 retryAfterMs (landed)

- `OrchestrationEffectExecutionError` and `SandboxEffectError` carry `retryAfterMs`. The outbox delay
  is `retryDelayMs(attemptCount, cause)` = max(backoff, min(`RETRY_AFTER_CAP_MS` 10 min, hint)).
  `retryDelayMs` is module-private (knip): 2.39 adds `export` if it imports it.
- `SandboxEffects` `call` skips its in-effect `DRIVER_RETRY` when the driver error has a hint, so
  the effect leaves at once and the outbox waits. Also applies to `sandbox.hand-over`.
- Unchanged: a `SandboxEffectError` with `retryable: false` still retries until attempts run out.

## 2.33 /runner/* gate (landed)

- `RunnerRoute.layerWhen(mounted)`: while `mounted` is false, connect and bundle answer 404 before
  reading the request. `RunnerRoute.layer` (always mounted) serves the runner socket.
- `RunnerEndpoint.dialsOverTcp` (per request, reads settings; read failure = false) is true when a
  docker driver's `chooseRunnerRoute` gives `url`. server.ts's member listener uses
  `layerWhen(endpoint.dialsOverTcp)`. Every `RunnerEndpoint` stub must supply `dialsOverTcp`.
- A fresh `t3 serve` with no TCP-dialing driver returns 404 on `/runner/v1/connect` (2.36's smoke).
  Curl transcript owed in G2.

## 2.44 App PR reads (landed)

- `GitHubAppInstallationTokens.readTokenFor({ repository })` mints a read-only token
  (`READ_TOKEN_PERMISSIONS`) for that one repo; own cache keyed by lowercase repo, untouched by
  `revoke`; not-installed repos are remembered 5 min; 422 → `failed`.
- `withAppReads(api, target, tokens)` in `pullRequest/pullRequestAppReads.ts` wraps the 19 read
  methods. **Order (lead-accepted deviation, needs maintainer sign-off):** the server's own sign-in
  reads first; the App serves only `missing-tool`/`unauthenticated`/`not-found`/`forbidden`, and
  never under a pinned or acting credential, nor for a call naming another repository.
  `appReadCredential(tokens, repo)` gives the pin (`source: "installation"`).
- 2.26 clones with `readTokenFor`; the token never reaches a machine.

## 2.1 idle sleep (landed)

- RPC `sandbox.viewing` (`WS_METHODS.sandboxViewing`, `SandboxViewingInput`, operate scope).
  `SandboxActivity` (key `t3/sandbox/lifecycle/SandboxActivity`): `view(threadId)` renews an
  in-memory lease and returns true when no live lease covered it (2.2 wakes on that, hooking the
  ws.ts handler); `read(threadIds)` → `{ viewedAt, terminalAt, nextScheduledAt }`
  (`scheduled_tasks.next_run_at` via `SqlClient`). `makeTest` (not `layerTest`) shares one lease.
- `idleDecision(IdleInput)` → `Busy | Awake{untilMs} | Sleep{reason, interrupt}`; `APPROVAL_HOLD_MS`
  2 h. `sandbox.auto-sleep` carries `reason` and `snapshotAt`; idle/cap-pressure sleeps refuse if
  the machine woke or a thread had activity after the snapshot. Settle sleep refuses when the newest
  settle predates the machine's last ready (`record.updatedAt`).
- `ComputeCapabilities.sleepOnSettle` / `.defaultIdleSleepMs` (Docker: true, 60 min).
  `TerminalManager.lastActivityAt`. `threadActivityAt` moved to
  `orchestration-v2/threadActivity.ts` (pure; storageCleanup and SandboxDecisions import it).
- Unexported for knip: `VIEWER_LEASE_MS` (2.2 exports it), `holdsMachine`, `decideAutoSleep`.
- Clients: client-runtime `sandbox-viewing` (`stepViewerLease`), `sandboxEnvironment.viewing`; web
  `components/sandbox/ViewerLeaseWatch.tsx` in `__root.tsx`; mobile `features/threads/ViewerLeaseWatch.tsx`.
  Leases are in memory: after a restart, record and thread activity anchor the idle clock.

## 2.36 release (landed)

- Release workflow `.github/workflows/sandbox-image.yml` ("Pair Cloud release"): arm64/x64 `archive`
  job and a `release` job that refuses an existing release; a manual dry run uploads an artifact.
  Assets `t3-<v>-linux-{x64,arm64}.tar.gz`, `SHA256SUMS`, `install.sh` at tag `v<v>`.
- `RunnerBundle` reads `runner/` beside the server; no tree → reason `not-bundled`.
  `RunnerBundle.layerFromTree(dir)` serves any tree (2.40's `--runner-dir` uses it).
- `cliReleaseRepositoryOf`; `update.ts` reads `T3CODE_RELEASE_BASE_URL` (shell or `service.env`).
  `build-cli-archive.ts --runner-dir`, `smoke-cli-archive.ts --expect-runner` (serve probe doesn't
  touch /runner), `apps/server/scripts/runner-release-smoke.ts`.
- DockerComputeDriver now uses node:http (`NodeHttpClient.makeAgent`), not undici: the single
  executable can't import the external undici. Verified on real Docker over the unix socket; the TLS
  `dockerHost` path is untested.
- First real tag run is the first CI `build-exe` on native runners; local smoke was arm64 only
  (SEA blob injected on the Mac because Docker had ~2 GB).

## 2.31 branch-not-pushed (landed)

- `existingBranch: Schema.optional(Schema.Literal(true))` on the cloud launch strategy;
  `prepareCloud.existingBranch` copied in client-runtime commands.
- `GitVcsDriver.remoteHasBranch` (`ls-remote --exit-code -- <remote> refs/heads/<ref>`, 15 s; exit 0
  true, 2 false, else `GitCommandError`), shared `gitExitError` helper with `executeGit`;
  `GitWorkflowService.remoteHasBranch`.
- `CloudLaunchError` reasons now include `"branch-not-pushed"` (`branch`, `remote` as host/path) and
  `"no-branch"` (existingBranch without branch). 2.22 adds `"local-launch"` to the same list.
- ThreadLaunchService refuses `no-branch` before any thread; `checkExistingBranch` runs only without
  a launch receipt; a git failure there logs and continues (the in-sandbox check in
  `checkoutInSandbox` still refuses). No origin URL → skip, in-sandbox `no-origin` decides.
- Open gap: a run re-armed after restart/retry loses `existingBranch` and falls back to the base.
- Owed: MCP tool description changed (`agentContextBudget.json` 47818 → 47927, needs the
  `agent-context-increase` label on a PR); the `mcp-tool-use` eval was not run (no API key).

## 2.34 public URL for webhooks (landed)

- `--public-url` / `T3CODE_PUBLIC_URL` → optional `ServerConfig.publicUrl?: URL`; startup refuses
  anything but an http(s) origin. `webhookOrigin({ relayHookBaseUrl, publicUrl })` in
  ScheduledTaskService.ts: tunnel wins, then `<publicUrl>/api/hooks`, else null; endpoints carry
  `relayed` (contracts `ScheduledTask.webhook.relayed`, optionalKey). Web shows the hold-while-offline
  control only when relayed (or `relayed` absent with a url, for older servers).
- The CLI flag record is exact: every flag object (config.test.ts, `resolveCliAuthConfig`) lists
  `publicUrl: Option.none()`. 2.21 documents the flag in the operator guide.
- Owed: `ScheduledTasksSettings.browser.test.tsx` (no Playwright browser on the Mac); runtime transcript.

## 2.43 team cap per driver (landed)

- `DockerSandboxDriver.runningCap: optionalKey(PositiveInt)`; `ComputeDriverRegistry.runningCap(driverId)`
  = `config.runningCap ?? defaultRunningCap`. `sync` compares configs without the cap, so a cap-only
  edit swaps `entry.config` and never rebuilds the driver. Admission and SandboxOverview read the cap
  only through the registry. `memberDriverView` includes `runningCap`.
- `makeSweep` subscribes to `ServerSettingsService.subscribeChanges` and invalidates the due hint on
  every settings change (a raised cap admits waiters on the next tick). Supersedes the 1.18 note that
  a cap change sends no event.
- `ComputeDriverTesting.layerRegistry` now needs `ServerSettingsService`
  (`runningCapFromSettings(settings, fake)`); registry fakes that admission/overview reach must
  implement `runningCap`. Web: "Machines at once" in the driver form. Captures owed in G2.

## 2.38 restore mode (landed)

- `SandboxSettings.restoreModeSince` (settings) and `SandboxOverview.restoreMode {since, machines}`
  with `SandboxRestoreModeMachine`. `--restore-mode` / `T3CODE_RESTORE_MODE` → optional
  `ServerConfig.restoreMode`; the startup flag is applied once, and a failed write fails the pass.
- `planReconciliation(record, backend, now, restoreMode)` adds `StopOrphan`: in restore mode an
  unrecorded backend is stopped, never destroyed. Auto-enable only for unrecorded backends older
  than `ORPHAN_GRACE_MS`.
- New `apps/server/src/sandbox/lifecycle/SandboxRestoreMode.ts` (key
  `t3/sandbox/lifecycle/SandboxRestoreMode`) keeps the confirmed set, so leaving restore mode does
  not re-trigger it for the same backends (fixes a spec gap). Layers building
  `SandboxReconciler.layer` need ServerSettingsService, ServerConfig and SandboxRestoreMode.
- Web CloudSettings "Restore mode" section; mobile Machines line. 2.21's runbook should name
  `--restore-mode`. CloudSettings browser test owed (Playwright missing on the Mac).

## 2.22 cloud-only mode (landed)

- `ServerConfig.cloudOnly: boolean` (required), `--cloud-only` / `T3CODE_CLOUD_ONLY`; refused in
  desktop mode; forces `autoBootstrapProjectFromCwd` off. Every `CliServerFlags` record lists
  `cloudOnly` (next to `restoreMode`).
- `CLOUD_ONLY_MESSAGE` and `CloudOnlyRefusedError {operation}` live in contracts
  (`environment.ts`), re-exported from `apps/server/src/environment/CloudOnly.ts` with
  `refuseLocalHost(operation, path)` and `localHostGuard` (services read once). A null path is the
  server's own; a path under the sandbox root whose machine isn't connected passes (routing fails
  closed).
- Orchestrator: `OrchestratorLocalThreadReadOnlyError` for message.dispatch, prepared-run.retry and
  checkpoint.rollback on a thread with no `sandboxId`; it is rethrown, not recorded as a rejected
  receipt. `ProviderSessionManager.open` backstop fails `CloudOnlyRefusedError` for a non-sandbox
  host. `ThreadLaunchService.launch` fails `CloudLaunchError "local-launch"` for any non-cloud
  strategy. `ProviderRuntimeRecoveryService.recover` fails `CloudOnlyLocalWorkError` while a local
  thread has runtime or queued work.
- `TerminalCloudOnlyError` (contracts terminal.ts); `TerminalManagerOptions.cloudOnly` is required.
  `ProjectFileFailure "cloud_only"` for workspace writes. MCP: `create_threads` refused (also on any
  cloud parent), `delegate_task` needs isolation `"cloud"`. Also refused: git/VCS writes, scratch and
  new projects, agent-session scan/import, ACP import, open-in-editor, stop local server, startup
  auto-pull. `CloudOnlyRefusedError` joins those four RPC error unions.
- Gotchas: `removeWorktree` refuses host paths on a cloud-only server; scheduled/webhook runs are
  refused until 2.18's `cloudPlacement`. Read-side rows stay for 2.45.

## 2.7 pre-sleep snapshot (landed)

- `sleepSnapshotAt` (optional key) on `OrchestrationV2Sandbox` and the `sandbox.stopped` command.
  `sandboxSnapshotRef(threadId)` = `<sandboxThreadRefPrefix>snapshot` in CheckpointMirror.ts.
- `CheckpointServiceV2.captureSnapshot({cwd, ref})` → `ready | missing | error`, never fails, under
  the workspace lock (a `turn` capture with previous = ref). `MirrorSyncWorker.syncRefs({threadId,
  cwd, checkpointRefs})` → boolean, never fails.
- `SandboxEffects.snapshotBeforeSleep` runs on `sandbox.stop` only when the record is `sleeping`,
  before `flush`, bounded at 15 s; checkouts deduped by `worktreePath` (owner, else oldest attached,
  names the ref). Records the time only when every checkout synced.
- Decider: `sandbox.sleep`/`auto-sleep` patch `sleepSnapshotAt: null`; `sandbox.stopped` on
  `sleeping` records it when given; an unplanned stop (ready/waking) resets it to null.
- For 2.8/2.13: a failed snapshot sync isn't retried by the 30 s pass (time stays unset); after an
  unplanned stop the field is null while an older snapshot ref may still be in the mirror. Docker
  runtime transcript owed in G2.

## 2.2 wake triggers (landed)

- `SandboxWake` tag in `apps/server/src/sandbox/lifecycle/SandboxWakeService.ts` (key
  `t3/sandbox/lifecycle/SandboxWakeService/SandboxWake`); layer in `SandboxWake.ts` (split to break
  a cycle through the terminal manager). `wake({threadId, actorId?})` sends one `sandbox.wake` when
  the machine is `sleeping`, id `sandbox-wake:<sandboxId>:<ownerThreadId>:<generation>`; `viewed`
  wakes only on a new viewer lease of a thread that is neither settled nor archived. Never fails.
- `sandbox.viewing` RPC calls `sandboxWake.viewed`. A key typed in a stopped machine's terminal wakes
  it (TerminalManager reads `SandboxWake` per call via `serviceOption`).
- Orchestrator: a cloud-thread `checkpoint.rollback` takes the admission lock, refuses when the
  machine has no disk, else wakes like a prompt (shared `applyCloudWake`) and parks its rollback
  effect `RESTORE_PARK_MS` (10 min). `EffectOutboxV2.expedite({threadIds, effectTypes})`; a pending
  `provider-thread.rollback` no longer blocks the thread's `sandbox.*` effects. `releaseWaiters`
  expedites parked rollbacks. `ThreadMessageIntake.dispatchSandboxCommand` is exported.
- For 2.18: call `SandboxWake.wake`. Gaps: the no-disk restore refusal is untested; a side chat's
  restore committed after the owner's release-waiters waits out the full park.

## 2.35 Pair's one app build (landed)

- `MemberPushNotifier`: pushes gate on `cloudOnly ? true : team.isTeamMode` (handle and seeding);
  `ws.ts` advertises `memberPush` when `cloudOnly || isTeamMode`. `AgentAwarenessRelay` treats a
  cloud-only server like a team server (no Live Activity).
- Mobile: `T3CODE_ANDROID_PACKAGE` override (Java package pattern check). `eas.json` gains
  `pair-production` build and submit profiles with `PAIR_*_PLACEHOLDER` values that fail the config
  checks until replaced. The Google services file stays an EAS file variable, not profile env.
- `decisions.md` "Identifiers and builds" rewritten; team-push.md, team.md, pair-features.md, 01
  and 08 updated. Owed: real store ids/Apple team/EAS project/ASC app id/Firebase (maintainer),
  a device pass on Pair's preview build, a CI workflow for `pair-production`; universal links don't
  open Pair's build in M2.

## 2.23 launch gate (landed)

- `NOT_CLOUD_ONLY_MESSAGE` in `packages/shared/src/sandbox.ts`. `SandboxDecisionInput.cloudOnly`
  and `decideCloudPrompt({..., cloudOnly})` are required; refusal reason `"not-cloud-only"`.
  `decideSandboxCommand` wraps the private `decide` with `createsMachine` (a `sandbox.create`
  effect, or a new-generation `provisioning`). Off cloud-only, a gated `sandbox.admit` marks the
  record `failed` with `failure.code "not-cloud-only"` (retryable false) and releases waiters; every
  other gated command is refused. Waking, sleeping and discarding stay open everywhere.
- `CloudLaunchError` reason `"not-cloud-only"`; `resolveCloudLaunch` checks
  `ServerConfig.cloudOnly` first (2.24 should move it into `cloudAvailability`).
- `delegated_task.request` moved to `OrchestrationV2InternalCommand` (clients can't dispatch it).
- Lead fix at landing: 2.2's `parkRestoreForMachine` now passes `cloudOnly`. Untested: that the
  orchestrator passes `cloudOnly` through; Settings → Cloud **Test** isn't behind the gate (2.24
  hides Cloud on these servers). At a full cap, a gated waiting create fails once a slot frees.

## 2.39 effect lanes and bounds (landed)

- `EFFECT_LANE_SLOTS = 4` (exported) and module-private `RUNNER_BOUND_EFFECT_TYPES` (turn
  start/restart, runtime continue, rollback, checkpoint capture, terminal cleanup) in
  EffectOutbox.ts. A runner-bound effect on a thread in `orchestration_v2_projection_sandbox_threads`
  claims from its own lane of 4; everything else shares the other 4. The worker runs
  `2 * EFFECT_LANE_SLOTS` fibers. Lane counts are global (a test leaving rows `running` in a shared
  DB fills a lane).
- `EFFECT_TIMEOUTS` adds `checkpoint.capture` and `provider-thread.rollback` (10 min) and
  `terminal.cleanup` (60 s), and `satisfies` replay-safe types only. The rollback's
  `checkpoint.rollback.fail` report moved to `reportExhausted`, so a timed-out last attempt still
  sets `rollbackFailure`.
- Unrelated Mac failure: `sandbox/runner/handlers.test.ts` "signals a ready watch…" (120 s timeout).

## 2.37 drain before upgrade (landed)

- `apps/server/src/drain/ServerDrain.ts` (in-memory: `current`, `changes`, `start`, `cancel`,
  `watch`; `layerTest`). `t3 drain [--timeout 15m] [--cancel]` (`cli/drain.ts`); shared server
  connection code moved to `cli/liveServer.ts`.
- Contracts: `server.drain` (stream of `ServerDrainStatus {since, runningTurns}`) and
  `server.cancelDrain`, both `AuthEnvironmentMaintainScope`; `ServerDrainError`;
  `SandboxAdmissionReason "draining"`; `ServerConfig.drainingSince`; a `drainUpdated` config event
  sent only to subscribers passing `drainUpdates: true`.
- `ProjectionStore.countRunningRuns`. Admission, decisions (`AdmissionSnapshot.draining`;
  `sandbox.admit` refuses while draining), the orchestrator's prompt gate, SandboxEffects and the
  lifecycle worker hold new prompts and machines during a drain; the sweep checks for an ended
  drain itself. `selfUpdate` drains before hand-off and cancels only its own drain on refusal.
- Clients: waiting label, a drain notice above a cloud thread's composer (web and mobile), Settings
  → Cloud notice with **Cancel drain** for admins.
- Gaps: a run still preparing its checkout isn't held if its machine turns ready mid-drain; no
  server test for the opt-in event; ChatView browser tests owed; runtime transcript owed in G2.

## 2.47 managed Codex account add (landed, root cause unconfirmed)

- Web `AddCodexAccountDialog.createAccount` now sends `mutateProviderInstance` `create`, and
  onboarding's Codex mode switch sends `upsert`; no web code writes the whole `providerInstances`
  map any more (`buildProviderInstanceUpdatePatch` remains only in ProviderSettingsPanel, which
  strips the map). Lead 2 (sign-in before the registry builds the instance) is ruled out for Add
  provider; a watcher reload after create yields an equal config.
- Not confirmed: reproduce Add provider → ChatGPT in a real client in G2 (note which "no longer
  available" message fires and whether the account stays in settings.json). Untraced candidates:
  server-mode OAuth callback on `localhost:1455` not reaching a remote server, and the panel's
  "…on this device." message after the return-URL reload. Browser tests owed:
  AddCodexAccountDialog, WelcomeWizard.import.

## 2.24 Cloud offered only on cloud-only servers (landed)

- `ExecutionEnvironmentCapabilities.cloudLaunch` (contracts environment.ts), set true only when
  `ServerConfig.cloudOnly`. `cloudAvailability(settings, projectId, cloudLaunch)` returns reason
  `"not-cloud-only"` first (message `NOT_CLOUD_ONLY_MESSAGE`); `newThreadPrefersCloud(...,
  cloudLaunch)` ignores `defaultsToCloud` (every new thread is cloud while available). The 2.23
  check in `resolveCloudLaunch` now comes from `cloudAvailability`.
- Web: `environmentCloudLaunchAtom` (state/server.ts), `CloudEnvModeItem.only` (pickers show Cloud
  alone), `resolveEffectiveEnvMode(..., cloudLaunch)`; `cloudSettingsVisible` in
  CloudSettings.logic.ts; search-row flag `cloudSettingsOnly`, `sandboxOnly` needs `cloudLaunch`.
  Off cloud-only, Settings → Cloud hides Add/Test/Edit/base image/limits/env (Remove and Leave
  restore mode stay) and shows "Cloud moved to Pair Cloud…". Project Workspace picker lost Cloud;
  a stale `defaultsToCloud` clears on the next workspace write. Mobile follows `cloudLaunch`.
- On a cloud-only server `"not-configured"` shows Cloud disabled with its message (local modes are
  refused there). Not done: the project Workspace default still lists local/worktree on cloud-only
  servers. Browser tests owed: ChatView, CommandPalette, SettingsSidebarNav.composition,
  ProjectSettingsPanel.

## 2.8 asleep reads (landed f072d5046)

- contracts terminal.ts: `TerminalStoppedBy {reason: "sleep" | null (forward-compatible), at}`, optional
  `stoppedBy` on snapshot, summary and exited event.
- Server: `StoppedSandboxReads` gains snapshot candidates (only while `sleepSnapshotAt` is set; a
  wake does not reset it, 2.13 owns that), `StoppedView.source` ("snapshot" | "checkpoint") and
  `diffPreview` (whole tree, Uncommitted source only; branch/commit sources come back empty).
  `ReviewService` reads the mirror for an unreachable /t3-sandbox/ cwd before the workspace guard;
  `getDiffFileContents` fails `VcsUnsupportedOperationError` "This machine is asleep…".
  `CheckpointMirror.snapshotNamers`; review constants exported from `GitVcsDriverCore`.
- `SandboxEffects.SandboxSleepHooks` (Context.Reference, no-op default) runs after the snapshot and
  mirror flush, before driver.stop; server.ts wires it to `TerminalManager.stopForSleep`, which
  exits each shell with `stoppedBy`. The next open on a reachable machine keeps history, appends
  "Machine woke. Earlier processes were stopped." and spawns. Restart is client-driven (type, or Wake
  by this viewer); viewing never restarts. client-runtime lifecycle neither closes nor reopens a
  sleep-stopped shell.
- client-runtime sandbox.ts: `stoppedFilesFromProjection`, `stoppedReadLabel`,
  `terminalStoppedLabel`, `TERMINAL_ASLEEP_LABEL`. 2.9 passes `stoppedFilesFromProjection(projection)`
  to `stoppedReadLabel`.
- Web `TerminalStoppedNotice`, `stoppedFilesNotice`; mobile `StoppedMachineNotice` (files, review,
  terminal; not the file inspector pane). Browser tests owed: ThreadTerminalDrawer, DiffPanel,
  FilePreviewPanel. Mobile notice placement under the iOS header needs a look in G2.
- Lead fixes at landing: merged 2.2's wake-on-key check into 2.8's Manager.test case; removed
  duplicate imports from the auto-merge (Manager.ts `sandboxIdFromPath`, client-runtime DateTime).

## 2.18 scheduled and webhook runs on Pair Cloud (landed 2482fc5d2)

- Migration 091 `ScheduledTaskCloudRuns`: `discardOnSettle` (kept when an upsert omits it) and
  `lastRunThreadId` on scheduled tasks. `ThreadLaunchInput.cloudPlacement` / `discardOnSettle`;
  `ThreadLaunchService.placeInCloud` (before the local-launch refusal) turns any stored strategy into
  `cloud` on a cloud-only server: worktree keeps its base (`origin/` stripped), others use the task
  branch, else the checkout's current branch, else `main`.
- `sandbox.provision.discardOnSettle` → record flag; the idle rule runs for it even without
  `sleepOnSettle`, and the settled auto-sleep becomes `destroyed` + `sandbox.destroy`. Destroy now
  flushes the mirror first. A woken discarded machine keeps the flag.
- client-runtime `sandboxWaitingLabel`; web/mobile scheduled-task editors show Cloud placement
  read-only, the discard switch, and "Waiting for a machine" on the last run (only after a
  successful run). Browser test owed: ScheduledTasksSettings.

## 2.42 smaller M1 defects (landed 038ee7005)

- contracts `orchestrationV2PendingWorktreeBase(runs)`: the newest `preparing` worktree run's
  baseRef. (a) Web `resolveBranchToolbarValue(..., cloudThread)` shows `branch ?? baseRef` for a cloud
  thread without a worktree; ChatView `gitCwd`/`gitStatusCwd` are null then (ThreadDetailsPanel hides
  its branch and git sections). Mobile had the same defect: `use-selected-thread-worktree` returns
  null for such a thread, ThreadRouteScreen falls back to the pending base; mobile shell mocks need
  `source`.
- (b) client-runtime `deriveWorkspaceMutationId(..., runs)` keys on the newest rolled-back
  `completedAt`, from a runs-only atom.
- (c) runner `ownForAgent` chowns server writes for the agent user (atomic staging, plain writes,
  recursive mkdir's new folders, copy trees minus symlinks, temp dirs, write streams at open,
  `files.writeNoFollow`); `stateDir` and the bundle stay root's. `chown` follows symlinks, which is
  fine only because the agent has passwordless sudo. Owed: `docker exec stat` transcript, captures,
  ChatView.browser.test.

## 2.13 rebuild a lost or destroyed disk from the mirror (landed f9fcd8b6d)

- `MirrorSync.restore({threadId, projectId, clonePath, worktreePath, branch})`: bundles the
  thread's mirror branch (+ the sleep snapshot only when its parent is the branch tip), fetches it
  into the clone, `worktree add`s at the recorded path, and puts the snapshot in the working tree
  (index reset). Null when the mirror has no branch. New `MirrorSyncError` reason
  `"restore-failed"`. Bundle held in memory (512 MiB cap).
- `CloudPreparation.checkoutInSandbox` takes `threadId`, returns `restoredFrom`/`snapshotAt`; order
  kept disk → mirror → origin; a mirror rebuild is `created: false` (cancel never deletes it).
- `ThreadLaunchService.restoreCheckout` (background, reruns setup, never fails the caller), a
  per-machine checkout lock; `retryPreparation` refuses a no-disk machine off cloud-only.
  `SandboxEffects.releaseWaiters` calls it on every `ready` for threads with no re-armed run.
- New internal command `thread.notice.record` → `system_notice` row "Rebuilt from the snapshot of
  2026-11-09 14:02 UTC" (UTC: fixed server text). Web never offers "Initialize Git" on a cloud thread.
- Owed: Docker run (edit, sleep, `docker rm -f`, Retry) and captures; the "nothing to bundle" branch
  is untested; an older snapshot still on the branch tip comes back after a later lost disk.

## 2.27 Pair Cloud target resolver (landed 621af86a7)

- `@t3tools/client-runtime/state/cloud-target`: `CloudTarget`, `CloudTargetOption`,
  `isCloudLaunchEnvironment(Pick<ServerConfig,"environment"> | null)`, `resolveCloudTarget({project,
  environments: {environmentId, label, connected, serverConfig: Pick<ServerConfig,"environment" |
  "settings"> | null}[], projects})`. Web maps `connected` from `connection.phase`. Origin key
  compared case-insensitively under `github.com/`. Lint rejects `Array#toSorted` in client-runtime.
- Lead change at landing: rule 1 no longer hides Cloud for `not-configured` on the project's own
  Pair Cloud; it returns the one target with `disabledReason` "Cloud is not set up on this
  environment." (matches 2.24's pickers: local modes are refused there). Spec and the
  shared/sandbox.ts doc comment updated.
- Filters: web `resolveLogicalProjectEnvironments` (pure, in BranchToolbar.logic.ts;
  `useLogicalProjectEnvironments` wraps it), `useAddProjectTargets`, and mobile
  `new-task-flow-provider` leave `cloudLaunch` environments out except the active project's own.

## 2.9 PR discovery and status while asleep (landed c937dbf4c)

- `SandboxHeadContext` (sandbox/mirror/SandboxHeadContext.ts): branch, upstream, remotes (tokens
  stripped), defaultBranch, stored as a blob at `refs/t3/sandbox/<b64>/head`
  (`CheckpointMirror.sandboxHeadRef`, `writeBlobRef`). `MirrorSync.recordHead` / `readHeadContext`;
  `syncRefs({recordHead})`, which `snapshotBeforeSleep` passes. A failed record is only logged.
- `StoppedSandboxReads.headContext(threadId)` (null without a record; read via `cat-file`).
  `GitManager.pullRequestForRecordedHead` asks only the forge, own cache; head selectors from the
  pure `branchHeadContextFrom`. No upstream → null; a worktree's base upstream is never the PR head.
  `ThreadPullRequestService` uses it for an asleep machine's thread; a sandbox path never falls back
  to the project root. Asleep discovery never clears a link.
- Web Changes row and iOS git menu show `stoppedReadLabel(stoppedFilesFromProjection(projection))`
  (Android has no git menu). Owed: runtime transcript (sleep, open a PR on GitHub, see it appear).
- Lead fix at landing: merged with 2.13's `MirrorSync.restore` (service now `{ sync, restore,
  recordHead }`) and removed a duplicate DateTime import.

## 2.26 Pair Cloud projects by repo (landed 20212077c)

- `ServerDerivedPaths.checkoutsDir` (`<stateDir>/checkouts`); a Pair Cloud project's folder must be
  exactly `<checkoutsDir>/<projectId>` (`ProjectService.pairCloudCheckoutPath`).
- `project/PairCloudProjects.ts`: `add(input, {memberId})` (URL → `parsePairCloudRemote`: https
  github.com owner/name only, no port/query/fragment/userinfo; serialized duplicate check incl.
  in-progress clones; member read access via api.github.com with the member's token, fails closed;
  `github-not-connected` for an anonymous 404), `gitEnvFor` (App token, else member token, as an
  env-only `http.https://github.com/.extraHeader`; `ISOLATED_GIT_ENV`), `fetchCheckout` (before
  each launch, failures logged). `HARDENED_CHECKOUT_CONFIG` persisted with `git clone -c`.
  `PairCloudProjectError` reasons `unsupported-remote | already-added | no-access |
  github-not-connected`.
- `ProjectCloneHooks.ts` (hooks moved out of ws.ts); `ProjectCloneHooks.cloneOptions`;
  `SourceControlCloneOptions.config/env`. Contracts: `destinationPath` optional, clone result gains
  `projectId`. ws.ts and MCP route cloud-only clones to PairCloudProjects and refuse
  `sourceControlCloneRepository`.
- Web CommandPalette, NewThreadLinkView, addProjectToMachine and mobile AddProjectScreen skip the
  folder step on Pair Cloud and use the https URL.
- Not done: picking from the GitHub repo list still asks the server's `gh` (a pasted URL works);
  background git status fetch runs without credentials; deleting a project leaves its checkout.
  Owed: mcp-tool-use eval, runtime transcript, browser tests (CommandPalette ×3, NewThreadLinkView,
  AddProjectToMachineDialog), mobile AddProjectScreen.test (jsdom missing here).

## 2.29 mobile Cloud routing (landed 8e7314728)

- client-runtime `cloudTarget.ts`: `routedCloudLaunch`, `cloudBranchCheck`, `CloudBranchCheck`
  (landed here ahead of 2.28; 2.28 reuses them).
- Mobile `features/threads/new-task-cloud.ts`: `resolveNewTaskCloud` → `NewTaskCloud { offered,
  options, available, message, target, routed }`. "Cloud" for one target, "Cloud on <label>" for
  several; no project → "Add <owner/name> to <label> first."
- Draft `workspaceSelection.cloudEnvironmentId`; queued `creation.routedFrom { environmentId,
  projectId, defaultBranch }`. A rejected routed launch restores the draft to the Mac project with
  its Cloud pick.
- Flow provider's `launch` (environment, project, server config) drives models, team viewer, linked
  threads and uploads in routed mode (`useEnvironmentServerConfig`, not `serverConfigs.get`, for the
  React Compiler).
- Known gap: draft attachments pre-upload to the Mac, then re-upload to Pair Cloud on delivery.
- Owes test-t3-mobile: routed launch on a Pair Cloud model; unpushed blocks; ahead warns; Worktree
  picker hides Pair Cloud; Mac-only pairing shows no Cloud; several Pair Clouds; disabled Add entry;
  queued routed task survives restart; branch-not-pushed refusal restores the draft.

## 2.12 disk retention (landed f19477fe8)

- Contracts: `SandboxSettings.diskRetention { archivedAfterDays, asleepAfterDays }` (null = never;
  patch accepts null to reset); internal command `sandbox.expire { reason: "archived" | "inactive"
  }`. Shared `DEFAULT_DISK_RETENTION` = 7 / 30 days.
- `SandboxDecisions`: `diskRetentionOf` (restore mode → never), `diskExpiryFloorMs`,
  `decideDiskExpiry` → `{ reason, atMs } | null`; `sandbox.expire` arm → `destroyed` +
  `sandbox.destroy` (flushes the mirror). Refused off cloud-only and while any attached run is
  active. Both clocks start no earlier than the record's `updatedAt`.
- `SandboxLifecycleWorker` sweep expires sleeping/failed machines on cloud-only only, and only when
  the mirror holds `sandboxBranchRef(thread)` for every attached thread with a worktree; else the
  disk is kept.
- `CheckpointMirror.sandboxBranchRef`. Web: two Compute rows in CloudSettings using
  `RetentionControl` (moved out of StorageSettings, new `enabledDays` prop). Mobile: none.
  Driver-level cap waits for M3.
- Owes: `StorageSettings.browser.test.tsx` (moved control) in CI; G2 can show an expired machine as
  "Machine discarded" and a wake rebuilding it.

## 2.40 runner load test and ingress budget (landed 48fecf420)

- `RunnerConnection.ts`: per-sandbox token-bucket ingress budget shared by all output streams; past
  it the hub sleeps on `Clock` before its next pull, so window acks wait and the runner pauses
  sources (`t3_runner_source_paused_ms_total`). `RunnerHub.DEFAULT_INGRESS_BYTES_PER_SECOND` = 16
  MiB/s, burst 1 MiB; `layerWith({ ingressBytesPerSecond })`, `Infinity` = off.
- `runner-benchmark.ts`: `--load` (30 loopback runners, one PTY hog, one bundle downloader, 28
  stamped-line probes; fails when probes' p95 rises > max(1 ms, 10%) or memory/sandbox > 8 MiB),
  `--ingress <MiB/s>` (0 = off), `--runner-dir`. CPU row is now overhead over local.
- 03 §9: M2 column = "G2 step 12" (to fill on the VM). Mac run (shared, loaded) failed its own p95
  limit (3.00 → 7.24 ms, ELU 0.86); bundle download (546 MB/s, not under the budget) is the first
  suspect if the VM fails too. Profile: ~37% GC from `ws` frame assembly and SchemaBinary copies; no
  per-frame copy of ours.
- Known: a throttled stream's full 16-chunk queue blocks that sandbox's socket read loop, so its
  other calls wait up to one chunk's delay.
- The loopback runner doesn't run on macOS (Linux natives, /etc/passwd, setpriv) — run `bench:runner
  --load` on the VM.

## 2.28 web Cloud routing (landed 90582bc76)

- `BranchToolbar.logic.ts`: `resolveCloudEnvModeItem({ cloud: CloudTarget, project,
  cloudEnvironmentId, … })` → `CloudEnvModeItem { disabledReason, only, rows: CloudEnvModeRow[],
  value }`; rows are "Cloud" / "Cloud on <label>" (launch) or "Add to Pair Cloud" / "Add to <label>"
  (add). `resolveCloudLaunchTarget`, `pairCloudAddInput` (https clone of origin, no files).
- `composerDraftStore`: optional `cloudEnvironmentId` on the draft session (dropped when the project
  changes).
- `ChatView.tsx`: in routed Cloud mode, provider-shaped reads (providers, provider settings,
  team-aware default model, attachments, usage limits, catalog) come from Pair Cloud; `serverConfig`
  stays local (PRs, version, side chats). Multi-model off. Warn banner from `cloudBranchCheck`.
- `useComposerSend.ts`: `routedCloud` input; `block` stops send; uploads + `thread.launch` go to
  Pair Cloud with `routedCloudLaunch`; the draft promotes to the Pair Cloud thread. Default branch
  not loaded → fresh branch from the selected one.
- `state/sandbox.ts`: `useCloudTarget(projectRef)` (hook; null ref subscribes to nothing) and
  `readCloudTarget` (event-time, `chat.newCloud`).
- Owes test-t3-app with two dev servers (local + cloud-only) and captures; browser tests ChatView,
  CommandPalette ×3.

## 2.45 cloud-only confinement (landed 14e33e44b)

- `workspace/WorkspaceReadGuard.ts` (tag + `layerUnconfined` for the runner) and
  `KnownWorkspaces.layerReadGuard` (server): on cloud-only, a server-disk path must resolve
  (symlinks, nearest existing ancestor) inside a known workspace, else `CloudOnlyRefusedError`.
  Wired into WorkspaceFileSystem (readFile, getMetadata), WorkspaceEntries (list/search root,
  browse) and AssetAccess. `/t3-sandbox/` paths pass the guard (machine or mirror reads), except
  AssetAccess refuses them on cloud-only (it reads local disk).
- DeviceService registers no local host; preview `open` refused (`preview.ts` error), HtmlRender
  refuses preview/measure/image inlining, `serverBrowser` omitted, no port scan.
- `t3_environment_link`: in team mode on cloud-only, only a run whose member is an admin/owner may
  link.
- Text generation on cloud-only: a server cwd becomes an empty scoped temp dir; a server-cwd review
  guide is refused ("investigates a checkout only inside its machine"); a `/t3-sandbox` cwd keeps
  cwd and tools (2.46). Only Claude (`--tools ""`) and Codex
  (`features.shell_tool/unified_exec/view_image=false`, outside investigations) may run it; other
  drivers are refused and skipped as fallback. Verified with `codex debug prompt-input` on 0.167 and
  one luna `codex exec`; not yet on the 0.166 pin.
- `ProviderRegistry` skips workspace scans of server folders. Web: trust text branches on
  cloudLaunch (`useTrustWarning`), Claude member terminal sign-in hidden on cloudLaunch.
- Open: VCS/git reads on an arbitrary cwd (15 ws.ts entry points, listed in the spec row), symlink
  check-then-read race. Owes test-t3-app pass + trust-text capture;
  `ProviderAccountsSection.browser.test.tsx`.

## 2.46 review guides in the cloud thread's machine (landed cd6484a32)

- `textGeneration/machineInvestigation.ts`: `makeMachineInvestigationFor` → `{ host, environment }`;
  on a sandbox cwd the guide's provider runs in the machine with
  `sandboxProviderSessionEnvironmentFor` plus `CLAUDE_CONFIG_DIR`/`CODEX_HOME` =
  `ensureSandboxProviderHome(host, instanceId)`. Claude/Codex text generation constructors take
  `instanceId` first. `cloudInvestigationUnsupported` removed.
- `PullRequestReviewGuideService`: `ReviewGuideRequester { mayUseMachines }` (ws.ts from
  `terminal:operate`, MCP true). On cloud-only, `machineCheckout` uses the newest linked cloud
  thread (same project, sandbox + worktree, not a side chat, link not stack-dismissed) on a sandbox
  host; scratch dir via `makeSandboxTempDirectory`; `sandboxActivity.view(threadId)` keeps it awake.
  `generate` picks the model once and passes it to `write`.
- Refusals: no linked cloud thread; requester can't use machines; machine asleep ("Wake the machine
  of ‘<title>’…"); guide model on a member-owned instance ("Pick a team account for Review guide
  model in Settings → Source Control.").
- `ProjectionThreadPullRequests` gains title, sandboxId, worktreePath. Docs: 02, 07,
  `docs/user/source-control.md`.
- Not checked: a machine clone's origin URL matching the project's `remoteUrl` (the linked-thread
  choice relies on it). Owes a G2 runtime transcript.

## 2.30 what a member must connect before a cloud session (landed 390435f6f)

- `CloudPreparation`: `CloudLaunchError` reason `repo-unreadable` ("Pair Cloud can't read <remote>.
  Connect GitHub to clone private repos, in Settings → Team."), mapped only from git's
  `authentication_failed` / `remote_unreachable` on the machine's fetch or clone.
  `ThreadLaunchService.failureDetail` returns a cloud refusal's own message, also inside
  `ThreadLaunchError`.
- client-runtime `state/sandbox.ts`: `cloudAccountNotice` → "Add an account on Pair Cloud" /
  "Connect GitHub on Pair Cloud" / null (constants); `createCloudAccountNoticeAtoms` stays null
  until config and the member's row load. Web `sandbox/cloudAccountBanner.tsx` in ChatView, mobile
  notice in `NewTaskDraftScreen` (opens SettingsTeam), both keyed on 2.28/2.29's resolved launch
  target. No banner on an "Add to Pair Cloud" or offline target.
- Web `state/team.ts`: Team visibility per environment (`useTeamSettingsEnvironmentIds`);
  `TeamSettings` gets an environment picker via the shared `SettingsEnvironmentPicker` (moved out of
  ConnectionsSettings). The picker sets the settings `machine` scope. Hosted web can now show Team
  for connected environments.
- Owes: browser tests ChatView ×2, SettingsSidebarNav.composition, ProviderAccountsSection;
  private-repo launch transcript; test-t3-app / test-t3-mobile with captures.

## 2.21 Pair Cloud install guide (landed 2636727f5)

- New `docs/user/pair-cloud.md` (install, Docker + gVisor, service.env, proxy, Cloud, GitHub App,
  invites, projects, cap and retention, backup, restore, upgrade, offboarding, Conductor).
  `cloud.md` gains Cloud on a local project, idle sleep, provider accounts and the clone error;
  small edits to team, mobile-notifications, project-settings, updating, README, internals/overview,
  operations/release, product/decisions, pair-features.
- As landed vs spec: isolation label shows in the driver's Overview row; Docker group and
  service.env come before `t3 service install`; projects via Add Project → Git URL (the GitHub
  picker still asks the server's `gh`); backups also need `attachments` and `sandbox/mirrors`;
  `T3CODE_PUBLIC_URL` only sets webhook URLs, so invites need `--base-url`; first sign-in uses `t3
  auth pairing create --base-url` (`t3 pair` has none); no `t3 service stop` (`systemctl --user stop
  t3code.service`); `t3 update` doesn't drain, **Update server** does.
- G2 to confirm: whether the Claude and Codex CLIs must be on the server host, and gVisor with the
  machines' local socket.

## 2.41 local git p50 on the Mac (no change)

Five A B pairs on the Mac (load 4.9–12.1), each 5 local + 5 worktree Replay `showcase` turns on a
Hello-World project, both builds seeded from one snapshot of real data. Both made the same 43 git
operations; per-run totals vary within each build (689–751) from worktree status refreshes.

| build              | metric p50 mean (range), ms | metric p95 mean | `VcsProcess.run` span p50 |
| ------------------ | --------------------------- | --------------- | ------------------------- |
| `main` `e8eb50b4b` | 17.7 (16.5–19.0)            | 41.4            | 16.8 (15.9–17.5)          |
| head `b82f045a9`   | 17.5 (16.9–18.5)            | 39.7            | 16.8 (16.3–17.4)          |

Head sits inside `main`'s range, so M0's +15% does not reproduce on macOS and no profile or fix
followed. M0 measured it on the Linux VM, whose git spawn path differs, so G2 step 12 reruns the
procedure there. Head-only background work is the sandbox lifecycle sweep (every 5 s) and a few
sandbox projection reads, about 7 ms of span time per run: not worth gating. Raw tables, trace
summaries and the harness: `../pair-wt/2.41-r1/` on the lead's Mac (not committed).

## 2.48 Pair Cloud only where it applies (landed d275c814e, bfe0d6bee, afe053f0e)

- Settings → Cloud lists only environments where Cloud settings apply, picks the only one by itself,
  ignores the project/all scope, and takes `?machine=` to choose. Load balancing leaves out Pair
  Cloud. A draft on Pair Cloud offers no other machine (web `BranchToolbar.logic.ts`,
  `useAddProjectTargets.ts`; mobile `new-task-flow-provider.tsx`).
- `AddProjectToMachineDialog.browser.test.tsx` passes locally (with 2.49's and 2.52's: 7 files, 30
  tests). Owes: before/after captures.
- Follow-up: a routed Cloud draft on a local project with two local machines still offers Run on /
  Auto balance (ChatView `canChangeEnvironment` ~1320, `automaticEnvironment` 1327; moving drops
  `cloudEnvironmentId`, composerDraftStore.ts 1527–1529). Gate on `envMode !== "cloud"`.

## 2.53 commit and PR text on a cloud-only server (landed 991b8e4b8)

- `TextGeneration.ts` `canGenerate`: on cloud-only, a selected provider that is disabled, missing,
  signed out, unavailable or not text-capable falls back to a ready one. The fallback skips
  member-owned instances on every server (a member's own account never writes text for others).
- Owes: the VM check (Codex signed out, Claude team account: Commit, push & create PR writes text).
- Follow-up: nothing stops an admin picking a member's account as the Text generation model (a
  2.46-style refusal would be its own row). Local servers keep upstream's behavior (no fallback).

## 2.49 next steps on a Pair Cloud setup (landed 05f179188..24294fe72)

- Installer banner and lines say Pair (`install.sh`, `install.ps1`; the code-page check lost the
  logo glyphs). `sandbox-image.yml` checks the accepted `repo=` stamp line changed.
- `t3 service install` on cloud-only (read from `service.env`) prints the proxy or Tailscale HTTPS
  line and `t3 auth pairing create --base-url <T3CODE_PUBLIC_URL>`; a bad `T3CODE_CLOUD_ONLY`
  value falls back to `t3 up`.
- Claude and Codex drivers on cloud-only say where to add an account instead of "Run … login".
  Onboarding on Pair Cloud: no terminal sign-in, no "Use existing CLI", no Projects stage
  ("Finish"); the 2-stage header shows once setup starts. Source control reads
  `isCloudLaunchEnvironment(environment?.serverConfig ?? null)` (its `environmentId` can be null).
  "Backend added" → environment.
- Browser tests `DesktopWebLinkCoordinator`, `WelcomeWizard.import`, `AddEnvironmentDialog`,
  `ProviderSettingsPanel.environment`, `AddCodexAccountDialog` pass locally. Owes: a
  `t3 service install` transcript on the VM; captures.
- Not changed: other "backend" copy (PairingRouteSurface.tsx 259/282, ConnectionsSettings.logic.ts
  277, the `backend.example.com` placeholder). `claudeSignedOutMessage` (Drivers/ClaudeHome.ts
  127–135) still says `claude auth login` in a cloud thread's turn error.

## 2.52 unpushed commits on any branch (landed 0155b0073, 57b3e8ac0)

- `VcsRef.aheadCount` (new on the wire, optional): the snapshot's `for-each-ref` also reads
  `%(upstream:track,nobracket)`; set only with an upstream that isn't `gone`. No new spawn or cache.
  `cloudBranchCheck` uses HEAD's status only when HEAD is the branch and has an upstream.
- ChatView mounts `vcsStatusRevalidation` for a routed cloud draft, so a branch checked out after
  the draft opened is checked again when the window comes back.
- Perf, kept in the snapshot (paid once per snapshot refresh, at most every 2 min): `snapshotRefs`
  p50 12.7 → 14.9 ms on this repo; 13.3 → 31.3 ms with 301 tracking branches; raw `for-each-ref`
  42 → 86 ms with 300 branches up to 3000 behind (Mac under load). Recheck on a large real repo.
- `ChatView.browser.test.tsx` passes locally. Owes: the video and a phone capture. Follow-up: a `gone`
  upstream checks ok on the client; 2.31 refuses after send ("Push <branch> first." before send).

## 2.50 why adding or cloning a Pair Cloud project failed (landed 1ae6c9281, f173b8bbf, 54f22138a)

- `SourceControlRepositoryError.message` is its `detail` alone (no "Source control repository
  operation … failed for github:" prefix). Old clients keep the prefixed text.
- `PairCloudProjects` without a GitHub App Client ID says `github-token-needed` ("Add a GitHub token
  to clone private repos, in Settings → Team."). `GitHubDeviceFlow.requestCode` reads GitHub's 4xx
  `device_flow_disabled` body and says the App's admin must enable Device Flow.
- A failed Pair Cloud clone says git's reason (`cloneFailureDetail` in GitVcsDriverCore), with URL
  credentials removed by `redactUrlCredentials`, now in `@t3tools/shared/git`.
- Follow-up: `repo-unreadable` CloudLaunchError still says Connect GitHub without a Client ID.

## 2.51 machines stopped outside Pair, and the Cloud Test reaches github.com (landed 0efaa17ca, 4a01f0d8d)

- `RunnerHub.drops`: 5 s after a connected runner's socket ends, `RunnerHubFacts` asks the driver
  (10 s bound). Stopped, missing or failed dispatches the same `lost` as the lease; running keeps the
  lease; a status error changes nothing. `RunnerHubFacts.layer` now needs `ComputeDriverRegistry`,
  and a `RunnerHub` mock needs `drops: Stream.never`.
- The sweep checks a created `provisioning` machine every 30 s until its hello: stopped or failed is
  `boot-stopped` ("The machine stopped before it was ready."), missing is `missing`. Wakes and
  admission waiters are not checked.
- Test: no new `network` step. `SandboxDriverCheckStep` is closed and V1 shipped, so the github.com
  probe (curl, messages by exit code) runs inside `git`, labelled "Run git and reach github.com".
- Owes: on the VM, `docker stop` mid-turn and during boot; Test passing, then failing without the
  gVisor DNS shim; captures.

## 2.54 machine gone during a message (landed 579102545)

- `ProviderSessionManager.open` passes `WorkspaceHostUnavailableError` through (an unregistered
  `/t3-sandbox/` path); `ProviderWorkspaceMissingError` now means only a folder that is really
  missing or not a directory.
- `ProviderTurnStartService.start`: on the last attempt that error settles the run with signal
  `machine-unavailable`, title "This message didn't run", and the record's `failure.message` when it
  is `failed`, else "The machine stopped. Send your message again." No new command, event or state.
- Owes: the VM check (Replay prompt, `docker rm -f` within 2 s, before/after capture).

## 2.55 Claude resume on a rebuilt machine (landed 1022a217d)

- `claudeTranscriptState` returns "absent" when no transcript exists (a missing `projects` folder
  counts as none); "missing" now means a copy existed but couldn't be read.
- `resumeThread` on a machine fails ("…is not on this machine.") for an "absent" transcript, so
  ProviderTurnStartService's upstream `resume_failed` fallback starts a new native session with the
  handoff. Local hosts still resume and leave it to the CLI. A machine session that never wrote a
  transcript also starts fresh.
- Docs say "the conversation so far", not "a summary": a handoff is a budgeted selection
  (portable-handoffs.md).
- Owes: G2 step 8 rerun with one Claude (Haiku) and one Codex (Luna) thread: `docker rm -f`, Retry,
  send; both run and the log shows `resume_failed`. Codex's fallback is read from code only.

## 2.56 GitHub repository on Pair Cloud (landed ef24b0d7b, b034479c7)

- On cloud-only, `sourceControlLookupRepository` is `PairCloudProjects.lookup`: the same parse
  (`owner/name[.git]`, `github.com/owner/name`, the https URL), the member-only `checkAccess` and
  `repositoryInfo` as `add`, with no duplicate check (`add` runs it). A bare name says "Enter the full
  owner/repository name."; other providers get `unsupported-remote`. Off cloud-only, upstream's
  lookup is unchanged.
- `buildAddProjectRemoteSourceReadiness(discovery, { cloudLaunch })`: GitHub is ready on a Pair
  Cloud environment without the server's own GitHub (web palette, mobile Add project).
- `PairCloudProjectError` gains `app-no-access` (server only), picked by `MemberGitHubCredential.source`:
  Connect GitHub gets the App's repository access text, a pasted token the token text.
- Owes: captures, and the G2 step 5 rerun through **GitHub repository** on web and mobile. GitLab,
  Bitbucket and Azure DevOps stay listed on Pair Cloud and fail at the lookup.

## 2.57 machines from a pruned release (landed 09ec4dbdb)

- An update prunes every runtime but the new one, removing the old release's `runner/` tree that
  stopped machines bind at `/opt/pair-runner/<build>`. Docker then refuses `start` (404), and the
  reconciler later destroyed a machine's disk (G2 step 10, V1→V2).
- Docker's `start` recreates each missing bind source under `/opt/pair-runner/` as an empty
  directory. The bootstrap then finds no `.install-complete` and downloads the server's own build.
  The bind exists only for a local Docker host, so the directory is always on the server's host.
- Owes: the step 10 rerun V2→V3 with machines from V1 and V2.

## 2.58 restore mode in settings.json (landed a994ae4bc)

- `restoreModeSince` is `Schema.DateTimeUtcFromString`, in settings and in the patch. With
  `Schema.DateTimeUtc` the file held an ISO string that the persisted-settings decode rejected, so
  every read with restore mode on fell back to default settings: no driver, GitHub App or provider
  instances (G2 step 11). The wire carries the same ISO string as before, so clients are unchanged.
- A V2 server stuck there recovers on V3 with no edit: the file on disk never changed.
- Owes: the step 11 rerun on V3 (Restore mode listed, **Leave restore mode**).

## 2.59 runner bundle downloads share one budget (landed 0768dad29)

- `makeByteBudget` (runnerHub/ByteBudget.ts) is the token bucket both budgets use. RunnerRoute
  streams the tarball through one budget per layer, 32 MiB/s with a 16 MiB burst; rate and burst
  are `layerWhen` options (Infinity is off). Two listeners (socket and TCP) get a budget each. The
  response reads exactly `content-length` bytes; `etag` and `last-modified` are gone.
- VM bench (V3's runner tree): downloads 147–183 → 33 MB/s, load ELU 0.81 → 0.59, quiet p95
  6.1–6.8 → 4.7–5.7 ms, still over the ~2.6 ms limit. Scratch runs at 8 and 4 MiB/s: 3.3–3.8 ms.
  The rate is not the lever below 32 MiB/s; any download beside the PTY hog fails, the hog alone
  passes (2.21 ms against 2.59). Kept at 32 MiB/s. The next step (worker-thread framing, per 03 §9,
  or a restated limit) is open.

## 3.20 staged seeds (landed 78669f835)

- `packages/contracts/src/cloudMove.ts` holds the Staging names as specified; `cloudImport` sits
  beside `cloudLaunch` in `ServerEnvironment.ts`. Migration 093.
- `apps/server/src/cloudMove/StagedCloudImports.ts`: `stage`, `check`, `claim` and `sweep` take one
  lock per key; the sweep re-checks each row under it. `check`/`claim` take `{ key, kind, projectId,
  memberId }` (`claim` adds `threadId`); a replayed claim for the same thread succeeds. Only `seed`
  is handled: 3.22 adds `context-export` where `stage`, `check`, `claim` and the sweep switch on
  kind (the table already takes any kind).
- `CloudMoveHttp.ts`: 404 off cloud-only first, then auth, key and `projectId`, `content-length`;
  one 32 MiB/s, 16 MiB burst budget. Refusals carry fixed text from `FAILURE_MESSAGES` (lead
  rewrote it into product words, since 3.23 shows `upload-failed` messages), never git stderr.
  `authenticateLinkMember` is not exported (knip): later routes go in the same file, joining
  `Layer.mergeAll` in `layer`, with new reasons in `STAGE_REFUSALS`.
- `sweep`'s error is `StagedCloudImportError | PersistenceSqlError`. `importBundle`'s `exactRefs`
  is checked before the lock and `index-pack`.
- Owes: the runtime transcript against the VM (curl), with G3.

## 3.19 agent link (landed 2cd926a34)

- The `/mcp` scope carries `memberId` for every client (peer links still get no `hostedAppUrl`).
  `register` and the `/mcp` middleware allow a peer link when the beta is on or the server is
  cloud-only. Migration 092 `cloud_launch`; `PeerLinks.agentLinks` is always empty on a cloud-only
  server.
- `RemoteDelegation` sends `{ type: "cloud", baseRef }` to a `cloudLaunch` peer, refuses other
  isolation, and checks the parent's branch with `ls-remote` first (a git error is logged, the
  launch goes on).
- `OrchestratorMcpEnvironmentLink.cloud` lives in `orchestratorMcp.ts`. `ThreadConnection` gained
  `cloudLabel` for `t3 thread --environment`'s `--cloud` check.
- `useLinkMachine(host)(machine, access, pairingCode?)` returns `Result<PeerLink, { minting,
  message | null }>`; a null message is a cancel. 3.23 calls it.
- Box toolkit fixtures in PeerForwarding and RemoteDelegation tests use the box's own TeamState:
  link calls now carry a `memberId`, which runs the member overlay on thread lists.
- `mcpToolListJsonBytes` 47990 → 48110: the PR needs the `agent-context-increase` label.
- Owes: live evals (no API key here; dry run passes), the runtime transcript and a `test-t3-app`
  pass, with G3.

## 3.21 seed checkout (landed 0689f46ff)

- `checkoutInSandbox` takes a required `seeded`; the mirror case also runs for a thread with no
  recorded worktree (clears a leftover checkout at the new path, `restoredFrom: "seed"`,
  `created: !rebuilt`). A seeded launch the mirror lacks fails `seed-unavailable`, never origin.
- `launch` refuses a seed before any thread for no branch (`no-branch`) or a branch equal to
  `baseRef` or the checkout's branch (`seed-on-base`); `check` runs only without a launch receipt,
  the claim on every call just before `provisionCloud` (helper `seedStaged` in `make`). Staging
  errors other than `failed` become `seed-unavailable`. `existingBranch` is false with a seed.
- `restoreInBackground`: rebuilds a thread with no `worktree` preparation from its branch (`baseRef:
  firstCheckout?.baseRef ?? branch`); the no-message rebuild test hangs without it.
- 3.23 builds the strategy as `{ type: "cloud", baseRef, branch, seedRef, existingBranch: true }`
  with `actorId` the link member. New `CloudLaunchError` reasons go after `seed-unavailable`.
- Owes, with G3 step 1: the Docker run (`restoredFrom: "seed"`, then `docker rm -f`, Retry,
  `"mirror"`).

## 3.22 context export (landed 598da8e4b)

- `ContextExports.ts` (`build`, `import`, `capContextExport`, `ContextExportError`) needs
  `ThreadManagementService` and `ServerEnvironment`, wired in `runtimeLayer.ts`.
  `ThreadLaunchService` now requires `ContextExports`: anything that builds `ThreadLaunch.layer`
  must provide it.
- Orchestrator deciders for `thread.history.import` and `thread.move.record` derive ids from the
  command id. Every `v1_import` reader uses `threadHasImportedHistory`; `prepareLegacyImport` takes
  `historyOrigin`. The gap notice text is built in the decider (importing it from ContextExports
  would cycle back to the Orchestrator); the `from` row text is in ContextExports.ts.
- `capContextExport` reserves 16 KiB for the envelope; messages before the first user message stay
  only when everything fits; `build` skips empty messages. `import` tells `not-empty` from `failed`
  by re-reading the shell after a refused dispatch.
- `StagedCloudImports` handles `context-export` (plus `readContextExport`, `dropContextExport`):
  capped while streaming, decoded, renamed into `<stateDir>/cloud-moves/<key>/`, removed on any
  failure. `CloudMoveHttp`'s routes are `stagedUpload(kind, maxBytes)`; `invalid-export` is 422;
  `too-large` names both limits.
- A launch with `contextExportRef` checks the export before creating anything, then after 3.21's
  seed claim and before `provisionCloud` claims, imports (skipped if the history is there) and
  drops the staged file. Transcripts leave out `move` rows; MCP shows the row's sentence; web
  renders `MoveDivider`; mobile's three switches take `move`.
- 3.23 calls `ContextExports.build` and `thread.move.record`; 3.25 passes
  `ThreadLaunchInput.contextExport`.
- Owes, with 3.25's: the runtime curl transcript and `test-t3-app` captures.

## 3.25 continue locally (landed 9018429b7)

- `MirrorSync.bundleThread` (`restore` calls it) keeps only the haves the mirror holds
  (`rev-list --ignore-missing`) before the prerequisite tiers; the cap fails as `too-large`.
- `CloudMoveSource` (`contextExport`, `seed`, `continued`) and three thread routes through one
  `threadRoute` helper in `CloudMoveHttp.ts` (404 off cloud-only, link auth, thread id). Seed
  headers (branch, base, origin) are URI-encoded. `CloudMoveRefusal` has an optional `text`.
- Laptop: `CloudMoveClient` (`send` is the shared helper for 3.23's uploads), `CloudMoves`
  (beside `PeerLinks` in `server.ts`), RPC `threadMove.toLocal` behind operate scope.
  `createThreadMoveAtoms` returns `{ toLocal }` (`./state/threadMove`).
- The `origin/<name>` taken-check applies to copies only (a move's branch is already on origin).
  Continue locally is exempt from `threadActionRequiresOperate`: its permission is on the primary
  environment.
- Gaps: a `toLocal` retried with the same `commandId` after a partial run makes a second worktree;
  a launch that fails after creating the thread removes the worktree and branch, not the thread.
- Browser tests (3 files) could not launch here (no Playwright Chromium). Owes, with G3: runtime
  transcripts and `test-t3-app` captures.

## 3.23 continue in cloud (landed cea3b8942)

- `apps/server/src/cloudMove/`: `CloudMoves` gained `preview` and `continueInCloud`; new
  `CloudMoveLaunch` launches the thread as the link's member, capped at the link's access, and
  `CloudMoveHttp` reads it when the layer is built. The seed is a git bundle from
  `GitVcsDriver`/`VcsDriver`, staged under `cloud-move-seeds/`. `putContextExport` returns
  `{ outcome, bytes }`.
- RPCs `threadMove.preview` and `threadMove.toCloud`; `ThreadMoveError` keeps its reasons.
  `createThreadMoveAtoms` returns `preview` and `toCloud` beside `toLocal`, with the copy
  constants. `continueInCloudOffer` (`cloudTarget.ts`) takes `environmentId` and `originKey`.
- MCP tool `t3_thread_continue_in_cloud`, hidden while the server has no link.
  `mcpToolListJsonBytes` 48110 → 48788: the PR needs the `agent-context-increase` label. Two eval
  cases in `threads-vs-tasks.ndjson`; the dry run builds both.
- Web: `ContinueInCloudDialog.tsx`, the thread menus and the palette. The palette item isn't gated
  on operate scope; the server checks it.
- Follow-up (lead): the sidebar's row menu never offered Continue locally (3.25 wired only the
  header menu and the palette). Fixed in `fix(web): offer Continue locally from the sidebar's
  thread menu`.
- Fails on `feat/pair` without this row too, and not in the brief's list:
  `apps/server/src/mcp/toolkits/core.test.ts` doesn't load on this Mac (`SchemaError: Expected
  string at ["lastRunThreadId"]`); CheckpointStore's two known cases now count 29 `exists` checks
  against an expected 33.
- Owes, with G3: a web pass with a local server linked to Pair Cloud, a real seed upload, and the
  live evals.

## 3.24 mobile Continue in cloud (landed 63e12b0e3)

- `resolveContinueInCloud`, `cloudTargetEnvironments` and `sameContinueInCloudOffer` in
  client-runtime's `cloudTarget.ts`; web's `state/sandbox.ts` calls them too.
- Mobile: `ContinueInCloudSheet.tsx` (route `ThreadContinueInCloud`), the header's Cloud menu
  (`buildThreadCloudHeaderMenu`, in the machine menu's slot for a thread with no machine) and the
  row menu. A confirm while `preview.moving` joins the running move; web disables it there.
- Not run on a phone or simulator (maintainer, 2026-11-10). Owes the whole `test-t3-mobile` pass:
  both entry points, the sheet's notices, a move with one file off, no entry on a Pair Cloud
  thread or a phone paired only with the Mac, rejoin after reconnect, and Android's sheet layout.

## 3.26 docs (landed 13ab74753, 908432a48)

- `docs/user/cloud.md` "Move a thread between your Mac and Pair Cloud", `outside-agents.md` "Pair
  Cloud from your Mac's agents", and sentences in remote-access, portable-handoffs, pair-cloud,
  context-handoffs, overview and pair-features. Facts read from code: 512 MB seed cap; history
  capped at 1,000 messages or 2 MB; the copy branch is `<branch>-copy`; a member's link goes up to
  Auto. The lead corrected "desktop only": Continue locally also shows in a local server's web.

## 3.27 a linked launch finds the project by repository (landed 529fd4920)

- From the live evals. `PeerForwarding.resolveProject` (moved from RemoteDelegation) resolves the
  project for a forwarded `t3_thread_launch` with no `projectId` or `scratch`, from the calling
  thread's repository. Not in V4.
- Same hole, left: `t3_thread_search` with `environmentId` and no `projectId` searches every
  project there.

## 4.12 team image contracts (on `m4`, 86d84b583)

- `packages/contracts/src/sandboxImage.ts`: schemas only. No RPC methods or scopes yet: 4.13 adds
  them with their handlers. `TeamImageBuildId` and `SandboxImageBuildRef` are in `sandbox.ts`;
  `ExecutionEnvironmentCapabilities.teamImages`, `sandbox.teamImage.keepSucceeded` and
  `ServerDrainStatus.runningBuilds` exist as schema.

## 4.11 outbox aggregate key (on `m4`, e8ad2d5c0)

- Migration 094. `aggregate_id` is a generated column (`COALESCE(thread_id, aggregate_kind)`) and
  `aggregate_kind` defaults to `'thread'`, so raw-row thread tests stand unedited.
- `EventSinkV2.commitTeamImageCommand` / `commitRejectedTeamImageCommand` (no lock: the service
  holds it), `appendTeamImageEvents`, `TeamImageCommandReceiptV2`. Effects run one at a time on
  `('team-image', 'team-image')` in the shared lane; launch, destroy-machine and delete-image are
  bounded at 60 s, capture at 20 min, run-program is unbounded and cancelled on process loss.
- `OrchestrationEffectExecutionError.retryable: false` skips the remaining attempts. 4.14 ships
  the live `TeamImageEffects` layer.

## Open follow-ups and risks

- Every `OrchestrationV2Command` is client-dispatchable with operate scope, including server-internal ones (`sandbox.provision`, `sandbox.created`, `sandbox.runner.attached`). A member could provision a machine past `checkCloudLaunch` (sandboxAllowed, credential refusal). Decide before M1 ships whether ws.ts should refuse server-only command types from clients.

- Web browser tests can't launch in this container (Playwright browser version mismatch); environment only.

- Runner PTY budgets (1.44) still miss after the perf-pty fix under load; re-benchmark on an idle machine and decide whether to batch acks in the hub.
- The runner's fs ops run as root: anything the server writes into a sandbox that the `t3` agent must modify needs chown (1.12, 1.16, 1.24, 1.34).
- `DEFAULT_BASE_IMAGE_REPOSITORY` is `ghcr.io/rutvikchandla3/t3-sandbox` (1.23): maintainers to confirm the owner.
- Old runner builds under `<stateDir>/runner/` are never pruned (1.9).
- PR-level runtime evidence the specs ask for (dev-server metrics tables, `test-t3-app` passes, captures) was deferred: workers may not start dev servers. The lead does it once in the integrated passes.
- M3 copy review gaps, left for after G3 (maintainer, 2026-11-09): label Continue locally "Continue
  a copy locally" for a non-owner; the inline Link's access picker defaults to Supervised and offers
  Full access, which a member can't mint ("cannot create sign-in codes" misleads); no notice when a
  thread already moved to cloud once; the mobile move row can't open the other thread; "From Pair
  · <Mac>"'s tooltip says "Started by an agent…" for a member's own move; the shipped Forget confirm
  says "Connections" where the guide says Sharing & access.
