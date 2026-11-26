# Performance regression checks

## Wire and payload budgets

```bash
vp run test:perf:v2-wire
```

Exercises real V2 projections and client reducers. Payload budgets are enforced in
[`transferBudgetV2.integration.test.ts`](../../apps/server/integration/transferBudgetV2.integration.test.ts)
(whose opt-in objects are typed `Required` against contracts so new client opt-ins must be tested)
and reported in CI via `TransferBudgetReport.integration.ts`. Run this whenever changing projection
schemas, history paging, shell synchronization, or thread state.

Core wire invariants:

- **Bounded windows.** Cold opens, history pages, and resume catch-ups enforce byte and row bounds
  before decoding full payloads, and exclude finished runs and duplicate message tables outside the
  active window.
- **No raw tool bodies on thread snapshots.** Raw command output, dynamic-tool result bodies, and
  inline file-change bodies are omitted at the wire boundary (diffs and explicit transcript exports
  fetch full data on demand).
- **Live command output bypasses orchestration events.** Adapters stream raw command output to
  [`CommandOutputHub`](../../apps/server/src/orchestration-v2/CommandOutputHub.ts) ahead of event
  ingestion, and clients subscribe only while a command row is expanded. Never route output deltas
  through `turn_item.updated`—a busy command would flood the event store and stall every thread.
- **Incremental shell sync.** Initial shells send active navigation rows only (omitting archived
  rows, idle subagents, and older settled threads), and resumes send deltas rather than full
  snapshots.

## Server process metrics

[`scripts/server-metrics.ts`](../../scripts/server-metrics.ts) benchmarks server CPU, wakeups, RSS,
heap, and first-request latency against a fake Anthropic API and the real `claude` CLI:

- Always compare refs with `ab <checkoutA> <checkoutB>` on the same machine rather than comparing
  isolated runs.
- Use `scaling` to separate per-thread cost from fixed server overhead, and `--soak <minutes>` to
  spot rising heap slopes (leaks).
- Steer server work by `working`: many worktree threads editing files at once with one client
  subscribed to all of them. Turns per minute that stay flat as threads are added mean the
  server, not the agents, is the bottleneck.
- Upper bounds no user hits daily, such as 20 clients reconnecting at once, run only with
  `--stress`; the default reconnect is a user's 3 devices holding 10 threads each.
- `--quick` shortens every window for a per-PR or nightly check; `compare` refuses to mix quick
  and full runs. `server-metrics --help` says which scenario to trust for what.
- Test macOS, Windows, and Linux with `--no-agent-scope`: Linux systemd agent scopes mask
  per-process polling paths that other platforms run.

## Persistence and background work invariants

- Event-store sequence cursors and startup recovery candidate selection must seek indexes rather
  than scan retained history or decode completed threads just to discover no work remains.
- Trace and provider logs must use asynchronous, serialized writes and rotation—synchronous appends
  stall the server event loop on slow disks (especially Windows).
- Background awareness and settlement work must coalesce per thread and ignore high-frequency
  transcript/tool-output deltas.

## Mobile looping animations

`apps/mobile/package.json` enables Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` for iOS keyboard
avoidance without React Native's `preventShadowTreeCommitExhaustion`. Continuous Reanimated frames
(`withRepeat`) commit to the shadow tree every frame and can starve React's JS commits, freezing the
screen (or aborting in dev with `ShadowTree.cpp: assertion failed`). Use React Native's `Animated`
with `useNativeDriver: true` for looping animations that run beside heavy content (see
[`thread-work-log.tsx`](../../apps/mobile/src/features/threads/thread-work-log.tsx)).

## Runner

```bash
vp run bench:runner [--image <ref>] [--skip-docker] [--quick] [--load] [--ingress <MiB/s>] [--runner-dir <dir>]
```

It serves the real `RunnerRoute` and `RunnerHub` on loopback and prints one table: a local baseline
(the host's own spawner and PTY), a `runner.mjs` subprocess, and a container of the sandbox image
on the same Linux machine. It exits 1 when a Docker figure misses its budget from
[03 section 9](../product/cloud/03-runner.md#9-performance) and
[2.3](../product/cloud/03-runner.md#23-startup-budget):

- Startup to the answered `runner.hello`, p50: 500 ms with the bundle mounted, 700 ms fetched.
- Provider stdout added over the local baseline: p50 1 ms, p99 5 ms. Keystroke to echo p50: 2 ms.
- PTY throughput at least 50 MB/s, or 95% of the per-sandbox ingress budget when that is lower
  (`--ingress 0` turns the budget off); server CPU at most 5 ms per MB over the local baseline.
- Server heap and RSS at most 8 MiB per attached idle sandbox.

`--load` then load-tests 30 loopback runners on the same hub, one hogging a PTY and one downloading
the bundle, and fails when the other 28 runners' p95 stdout latency rises more than `max(1 ms, 10%)`
over their all-quiet baseline or memory per sandbox passes 8 MiB. `--runner-dir` serves a release's
`runner/` tree instead of building one.

Run it on an idle machine: the figures are CPU-bound, and other processes move them. `--image` must
hold the current `pair-bootstrap.sh` (`vp run sandbox-image:build` refreshes `t3-sandbox:dev`); an
older image never enrolls and the run waits out the lease. Hub-side series are
`t3_runner_bytes_total`, `t3_runner_call_duration`, `t3_runner_source_paused_ms_total`,
`t3_runner_buffer_high_water_bytes` and `t3_runner_attach_duration`; runner startup shows in
`vp run profile:startup` as `runner.import.main`, `runner.dialed` and `runner.hello`.
