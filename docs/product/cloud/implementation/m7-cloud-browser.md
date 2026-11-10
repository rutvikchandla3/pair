# M7 Cloud browser: implementation specs

Status: implementation plan, 2026-11-10. Nothing here is built. Read [README](./README.md) first
for the shared names and traps. The design is [07 §5](../07-access-and-data.md#5-previews-and-ports-m7),
with [03 §4](../03-runner.md) for the runner protocol, [02](../02-workspace-host.md) for the seam
and [06 §10](../06-credentials-and-security.md) for what a cloud-only server may run. The PR list
is [10 §2](../10-delivery-plan.md#m7-cloud-browser).

Each PR follows the usual template: what it makes true, Needs and Unblocks, Files, Types and
services, Commands and events, Migrations, Tests, Verify, Reviewer checks. Line numbers are from
`feat/pair` at `d93b52fc` (2026-11-10, release `0.1.7-pair.10`); re-read every symbol before
editing. Where a spec says **proposed**, it fills a gap the design left open; a reviewer can
overrule it in that PR.

## The maintainer's answer of 2026-11-10

The Browser tab is disabled on cloud sessions, and the maintainer asked for it to work against the
machine. Asked to choose between Chrome on Pair Cloud's server (07 §5 as first written) and Chrome
on the machine, the maintainer chose **Chrome on the machine**. That settles 07 §5's "Decide
first" and 06 §10's open row: Pair Cloud's own browser never loads an agent-served page.

```
 Mac, phone, web                     Pair Cloud server                          Machine (Docker or GCE VM)
┌─────────────────────┐           ┌──────────────────────────────┐          ┌──────────────────────────┐
│ Browser tab         │  frames   │ ServerBrowser (unchanged)    │          │ runner                   │
│  streamed view      │◄──────────│  tabs, control, screencast   │          │   │ spawns, as user t3   │
│ clicks and keys     │──────────►│        │ connectOverCDP      │          │   ▼                      │
└─────────────────────┘           │        ▼                     │          │ headless Chrome          │
  /api/preview-stream             │ MachineBrowser: loopback     │          │   CDP on 127.0.0.1       │
  (exists today)                  │ bridge, one per machine      │ tcp.     │   │                      │
                                  │        │                     │ connect  │   ▼                      │
                                  │ RunnerHub ═══════════════════╪══════════╪► localhost:3000          │
                                  └──────────────────────────────┘ the      │  (the agent's server)    │
                                                                   runner's └──────────────────────────┘
                                                                   own socket
```

What this buys, and what it costs:

- `localhost` in a tab is the machine's loopback, with no proxy and no Chromium bypass rule. The
  page sees the Host header and origin it expects.
- The only bytes tunnelled are CDP. A machine still has no inbound port and clients still connect
  only to Pair Cloud (decision 4).
- Chrome's memory is the machine's, not the server's.
- The image grows by about 127 MB of Chrome plus its libraries, and a machine built from an older
  image has no browser until its image is rebuilt.
- A sleeping machine has no browser, so sleep closes its tabs.

## Build order

| Wave | Rows     | Notes                                                                     |
| ---- | -------- | ------------------------------------------------------------------------- |
| 1    | 7.1, 7.2 | Independent. 7.1 touches only the image; 7.2 only the runner protocol.    |
| 2    | 7.3      | Needs both.                                                               |
| 3    | 7.4, 7.5 | 7.4 needs 7.3. 7.5 needs nothing from this milestone and can start early. |
| 4    | 7.6      | Needs 7.4.                                                                |
| 5    | 7.7      | Needs 7.4, 7.5, 7.6. It is the only row that turns the tab on.            |

Until 7.7 lands, no client sees a difference: `preview.open` works for a cloud thread from 7.4, but
no client offers it because the server does not advertise the capability.

## What the code changed in 10 §2

- **2.10 becomes 7.2 and loses port discovery.** With Chrome on the machine, nothing on the server
  connects to a dev server's port. `tcp.connect` carries CDP only, and SSH later. Per-host port
  discovery (02 §6 PR 8) is its own row, 7.5, and needs no tunnel: it reads `ops.ports.listeners`.
- **2.11 becomes 7.3, 7.4 and 7.6.** Its loopback proxy, its `<-loopback>` spike and its
  per-machine contexts on the server's Chromium are dropped.
- **`RemoteCDP` is not new.** `ServerBrowserContexts.connectDesktopPage` (201–210) already attaches
  Playwright to a browser it did not launch, through a loopback bridge
  ([DesktopBrowserChannel.ts](../../../../apps/server/src/preview/DesktopBrowserChannel.ts)
  128–182). The machine browser is the same shape with a runner tunnel behind the bridge.
- **`ops.ports.listeners` has no consumer.** It is implemented in the runner
  (`opsHandlers.ts` 156–167) and exposed as `CoarseOperations.portListeners`
  (`WorkspaceHost.ts` 166–169); nothing on the server calls it. The `ports.changed` runner event
  (`runner.ts` 246) is declared and never emitted; leave it.
- **The desktop app opens its own webview for a remote environment.** `previewRuntimeFor`
  ([previewRuntime.ts](../../../../apps/web/src/browser/previewRuntime.ts) 13–21) returns the
  streamed runtime only outside Electron or for the primary environment. A desktop webview cannot
  reach a machine, so 7.7 adds a capability that forces the streamed runtime.
- **Clients have no "this environment is cloud-only" flag** to key that on, so 7.7 adds one
  capability, `machineBrowser`, instead of teaching clients about server modes.

### Open maintainer questions

Each takes its proposal unless a maintainer says otherwise.

| #   | Question                                                 | Proposal                                                                                                                                                                     | Row      |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q1  | Chrome's own sandbox inside a machine                    | On for VM machines, with the AppArmor profile `t3 browser setup` writes installed by the image. Off (`--no-sandbox`) on Docker, where the container forbids user namespaces. | 7.1, 7.3 |
| Q2  | Browser profiles in cloud                                | One persistent profile per machine, on its kept disk. Named profiles and cookie import stay local-only; incognito and agent tabs get their own context as today.             | 7.4      |
| Q3  | Tabs when a machine sleeps                               | They close. Opening a tab wakes the machine. Remembering URLs across sleep waits for a team that asks.                                                                       | 7.6      |
| Q4  | When the machine's Chrome stops                          | With the machine. It is not stopped when its last tab closes.                                                                                                                | 7.3      |
| Q5  | `html_preview` and HTML render measurement on Pair Cloud | Unchanged: still refused. They load agent HTML in the server's own browser, which this milestone keeps empty. Moving them to the machine is a separate row when a team asks. | none     |
| Q6  | A machine whose image predates 7.1                       | The tab opens to an error that names the fix: "This machine's image has no browser. Rebuild the team image, then start a new session."                                       | 7.3      |

## Shared names

- **Folder.** `apps/server/src/sandbox/browser/` for the machine browser. Edits to
  `apps/server/src/preview/` stay small and reach sandbox code through a `Context.Reference` with
  a no-op default (the `PinnedGitHubCredential` pattern), so a local server builds no sandbox code.
- **Paths in a machine.** Chrome at `/opt/pair-chrome/<version>/`, with `/usr/local/bin/pair-chrome`
  linked to its `chrome-headless-shell`. Its profile at `/t3-sandbox/<id>/browser/profile` and its
  downloads at `/t3-sandbox/<id>/browser/downloads`, both under the reserved root so the server
  reads them through the workspace host (README trap: paths outside the root route to local disk).
- **Runner method.** `tcp.connect`.
- **Capability.** `machineBrowser: true` beside `serverBrowser: true` in the environment
  descriptor's capabilities.
- **Errors.** `MachineBrowserError` with `reason: "not-installed" | "machine-unavailable" |
  "runner-outdated" | "launch-failed"`. `CloudOnlyRefusedError { operation: "preview.open" }` stays for a thread with
  no machine and for a non-`server` runtime.

## PR specs

### 7.1 `build(sandbox-image): add headless Chrome to the machine image`

A machine built from this image can start `pair-chrome` as the agent user. Nothing uses it yet.
This reverses 10 §8's "Chrome in the base image before previews need it": previews now need it.

- **Needs:** nothing. **Unblocks:** 7.3.
- **Files:**
  - `infra/sandbox-image/versions.env`: `CHROME_VERSION`, `CHROME_SHA256_AMD64`,
    `CHROME_SHA256_ARM64`. They are the `VERSION` and the `linux64` and `linux-arm64` hashes in
    [PreviewBrowser.ts](../../../../apps/server/src/preview/PreviewBrowser.ts) (27–37). Keep its
    comment's floor: never below `156.0.8078.70`.
  - `infra/sandbox-image/provision.sh`:
    - Step 1 also installs the shared libraries `chrome-headless-shell` needs on Ubuntu 24.04, and
      `fonts-liberation` and `fonts-noto-color-emoji`. Find the list with `ldd` on the unpacked
      binary on a stock 24.04 image (it prints `not found` per missing library);
      `PreviewBrowserHost.diagnoseLaunchFailure` does the same check on a server. Do not copy a
      list from memory: 24.04 renamed several packages with a `t64` suffix.
    - A new step after Codex: `fetch` the zip from
      `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/<linux64|linux-arm64>/chrome-headless-shell-<platform>.zip`
      with its hash, unzip into `/opt/pair-chrome/${CHROME_VERSION}/`, and link
      `/usr/local/bin/pair-chrome`. `unzip` is already installed.
    - Step 9 adds `"browser":"<CHROME_VERSION>"` to `/etc/pair-image.json`. Re-read every reader of
      that file first (`VmBaseImage.ts`, `SandboxProvisionTree.ts`, `teamImageBuildProgram.ts`,
      `TeamImageEffectsLive.ts`): the key must be optional wherever it is decoded, since images
      built before this row lack it.
    - Step 10 adds `sudo -u t3 -H pair-chrome --version | grep -qF "$CHROME_VERSION"` and one real
      start: `sudo -u t3 -H pair-chrome --no-sandbox --dump-dom about:blank` exits 0. A missing
      library fails the image build here, not a member's first tab.
  - `infra/sandbox-image/vm/install-vm.sh` (Q1): write the AppArmor profile that lets
    `/opt/pair-chrome/*/chrome-headless-shell` use unprivileged user namespaces, and load it. The
    text is `PreviewBrowserHost.APPARMOR_PROFILE` (PreviewBrowserHost.ts 20) with the machine's
    path; re-read how `t3 browser setup` names and loads it and do the same. The Dockerfile gets
    no profile.
  - `apps/server/src/sandbox/image/SandboxProvisionTree.ts`: the tree travels in instance metadata
    (M5), so check its size budget still holds after the two edits; the zip is downloaded by the
    script, not carried in the tree.
- **As built:** Chrome is provision.sh step 5, the manifest step 10 and the checks step 11; the
  library list is the 24.04 (`t64`) names of `PreviewBrowserHost.DEBIAN_PACKAGES` plus
  `fontconfig`. `browser` is a top-level manifest key, beside `providers` rather than in it, since
  `TeamImageEffectsLive` reads every `providers` entry as a provider driver; no reader decodes it
  yet. The VM profile is `/etc/apparmor.d/pair-chrome` (profile `pair-chrome`), not `t3 browser
  setup`'s name, so that command on a machine neither skips nor overwrites it; install-vm.sh then
  starts Chrome once with its sandbox on. The image's CI smoke test
  (`.github/scripts/sandbox-image-smoke.sh`) checks `pair-chrome --version` against the manifest
  and loads example.com as `t3`. Cost: a ~127 MB download and roughly 0.4 GB on disk with the
  libraries and fonts; about a minute of build time.
- **Types and services:** none. **Commands and events:** none. **Migrations:** none.
- **Tests:**
  - One test beside `SandboxProvisionTree.test.ts` (or the existing versions test, if one reads
    `versions.env`): `CHROME_VERSION` and both hashes equal `PreviewBrowser.ts`'s. Export what the
    test needs from `PreviewBrowser.ts` rather than repeating literals. This is the only guard
    that the server's Playwright and the machine's Chrome stay the same build.
  - No test for the apt list; step 10 is the check.
- **Verify:** `vp run sandbox-image:build`, then
  `docker run --rm t3-sandbox:dev sudo -u t3 pair-chrome --no-sandbox --dump-dom https://example.com`
  prints the page. On Google Cloud, rebuild the base image (5.7b's path) and run the same command
  without `--no-sandbox` over the serial console or a terminal in a cloud session. Record the
  image size before and after in the PR.
- **Reviewer checks:** every download is hash-checked like its neighbours; nothing is installed
  from an unpinned apt source beyond Ubuntu's own; the agent user can start it; arm64 is covered;
  the image manifest key is optional to old readers. Surfaces: image only. Providers: none.
  Reverse state: an older image keeps working, without a browser (Q6).

### 7.2 `feat(contracts,server): open TCP connections from Pair Cloud to a machine's loopback` (was 2.10)

The server can open a byte stream to `127.0.0.1:<port>` inside a machine over the runner's socket,
with the same windows and resume rules as a forward's connection.

- **Needs:** nothing in M7 (M1's flow control, 1.8). **Unblocks:** 7.3, and SSH (03 §11 #16).
- **Files:**
  - `packages/contracts/src/runner.ts`:
    - `RUNNER_METHODS.tcpConnect: "tcp.connect"` beside `tcpRead` (79).
    - `RunnerTcpConnectRpc`: payload `{ port, host? }` (`PortSchema`; `host` is the literal
      `127.0.0.1`, the default, or `::1`), success `{ connectionId: RunnerHandleId }`, error
      `RunnerCallError`. Add it to `RunnerCoreRpcGroup` beside `RunnerTcpReadRpc` (973). No
      hostname and no other address: the runner's decode refuses them and its handle table checks
      again, so the method cannot be turned into a way out of the machine.
    - `RunnerUnsupportedError { method }`, not on the wire: what the server reads from a runner
      built before `tcp.connect`, which answers `Unknown request tag`. The build check at connect
      replaces such a runner whenever the server has a bundle to serve.
    - Rewrite the comment above the forward RPCs (744–746) so it also covers a connection the
      server opened.
  - `apps/server/src/sandbox/runner/HandleTable.ts`:
    - Split `acceptTcp` (903–957): the part that turns a `NodeNet.Socket` into a `kind: "tcp"`
      entry (the `OutputBuffer`, the `in:tcp` input, the finalizer) becomes a shared
      `registerSocket(socket)`. `acceptTcp` keeps `unclaimed` and the `forward.accepted` event.
    - `connectTcp(port)` on the service: refuse when drained, as `openListener` does (962);
      `NodeNet.connect({ host: "127.0.0.1", port, allowHalfOpen: true })`, wait for `connect` or
      fail with `netError("tcp.connect", error)` (`ECONNREFUSED` is `NotFound`), then
      `registerSocket` and return the handle.
  - `apps/server/src/sandbox/runner/handlers.ts`: `[RUNNER_METHODS.tcpConnect]` beside
    `forwardClose` (367).
  - `apps/server/src/sandbox/runnerHub/RunnerConnection.ts`:
    - `connectTcp(port): Effect<RunnerTcpConnection, RunnerCallError, Scope.Scope>` on the
      interface, as 03 §7 already sketches. Call `tcp.connect` once, not retried, and map
      `RpcClientError` to `RunnerLostError`, exactly as `openForward` treats `forward.open` (443):
      a lost answer would leave a connection nobody reads.
    - Build the connection the way `serveConnection` does (425–436): `byteWriter` over
      `tcp.write` and `tcp.close`, `read: output(connectionId, "tcp")`. Lift that into one helper
      both use. The scope's finalizer sends `tcp.close` and ignores its failure.
  - `apps/server/src/workspaceHost/WorkspaceHost.ts`: an optional member
    `readonly ports?: { readonly connect: (port, host?) => Effect<WorkspaceHostTcpConnection, PortConnectError, Scope.Scope> }`,
    documented "Absent on the local host: local code connects to its own loopback directly."
    The connection's shape lives in `WorkspaceHost.ts` so `preview/` never imports from
    `sandbox/`; `RunnerTcpConnection` satisfies it. Its errors are the runner's
    (`RunnerCallError | RunnerUnsupportedError`), as `invoke`'s are, so a caller can tell a lost
    boot from a closed port. This is 02 §2's `ports.connect`; `ports.listeners` stays where it
    is, on `invoke`.
  - `apps/server/src/workspaceHost/SandboxWorkspaceHost.ts`: `ports: { connect: connection.connectTcp }`
    beside `invoke`.
  - [03 §4](../03-runner.md) and [02](../02-workspace-host.md): the "Later" marks on `tcp.connect`
    and `ports.connect` become what landed.
- **Types and services:** `RunnerConnection.connectTcp`, `WorkspaceHost.ports`.
- **Commands and events:** none. **Migrations:** none.
- **Tests:**
  - `apps/server/src/sandbox/runner/forwards.test.ts`, beside the forward connections: against a
    `NodeNet` server on port 0, `tcp.connect` then write, read and close round-trips bytes and
    reaches EOF; another host, a port nobody listens on and a drained runner are refused. The
    contracts test refuses non-loopback hosts at decode.
  - `RunnerResume.test.ts`: a dialed connection is a row of the stalled-reader case; it resumes
    across a replaced socket and fails `RunnerLostError` when its boot's lease expires; a runner
    without the method fails `RunnerUnsupportedError` and stays usable.
  - No test at the workspace host: it is a pass-through.
- **Verify:** `vp test run` on the files above; a transcript from a dev cloud session on Docker:
  start `python3 -m http.server 8123` in the machine's terminal and fetch it from a server-side
  script through `host.ports.connect(8123)`.
- **Reviewer checks:** the runner dials loopback only and takes no host from the wire; a server
  closing its scope frees the handle; output respects the per-handle and per-sandbox buffers
  (`OutputBuffer`, `sandboxBufferBytes`) and the ingress budget, since CDP screencast frames share
  that budget with provider stdio; the method needs the sandbox token like every runner call.
  Surfaces: server and runner only. Connection modes: Unix-socket, `host.docker.internal` and the
  internal listener all carry it, since it rides the existing socket.

### 7.3 `feat(server): run a machine's Chrome and attach to it over the runner`

**Critical.** The server can ask for "the browser of sandbox X" and get a CDP endpoint on its own
loopback that Playwright can attach to. Chrome starts on first use and stops with the machine.

- **Needs:** 7.1, 7.2. **Unblocks:** 7.4.
- **Files:**
  - New `apps/server/src/sandbox/browser/MachineBrowser.ts`, a service:
    - `endpoint(sandboxId): Effect<string, MachineBrowserError>` returns
      `ws://127.0.0.1:<bridgePort>/devtools/browser/<guid>`. Concurrent calls for one sandbox
      share one start. The result is cached per runner boot and dropped when that boot's scope
      closes (subscribe to `hub.boots`, as `RunnerForwards` does for the git forward).
    - **Start.** Resolve the sandbox's host from `WorkspaceHosts.forPath("/t3-sandbox/<id>")`; a
      `WorkspaceHostUnavailableError` becomes `machine-unavailable`. Check
      `/usr/local/bin/pair-chrome` with `host.fileSystem.exists`; absent is `not-installed` (Q6).
      Spawn through `host.spawner`, so it runs as the agent user like every sandbox process
      (`SandboxWorkspaceHost.ts` 197), in the boot's scope:
      `pair-chrome --remote-debugging-port=0 --user-data-dir=/t3-sandbox/<id>/browser/profile`
      plus the three args `ServerBrowserContexts.launchOptions` passes (92–96) and
      `--no-sandbox` when the sandbox's driver kind is `docker` (Q1). Export the arg list from
      `ServerBrowserContexts.ts` rather than repeating it.
    - **Environment.** The host's base environment only. No provider credential, no
      `T3CODE_THREAD_ID` (the browser belongs to the machine, and port discovery must not credit
      Chrome's own listener to a thread), no git identity. Re-read
      `SandboxProcessEnvironment.ts` for the base it offers and take that.
    - **Port.** Chrome prints `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<guid>`
      on stderr. Read stderr until that line, bounded at 30 s, then keep draining it to a debug
      log so the pipe never fills. Exit before the line is `launch-failed` with the last stderr
      lines.
    - **Bridge.** A `NodeNet` server on `127.0.0.1:0` in the same scope. Each accepted socket
      opens `host.ports.connect(<port>)` and pipes both ways with backpressure (the `toDuplex`
      helper in `RunnerForwards.ts` 117–163 already adapts a `RunnerTcpConnection` to a Node
      duplex; move it somewhere both import). The guid in the path is the secret, as the desktop
      bridge's path is; the bridge never binds beyond loopback.
    - **Stop.** Closing the boot's scope closes the bridge and kills Chrome's process group. A
      Chrome that exits by itself drops the cache entry, so the next `endpoint` starts another.
  - `apps/server/src/server.ts`: one layer, built only when the server is cloud-only.
  - [07 §5](../07-access-and-data.md#5-previews-and-ports-m7): no change; it already describes this.
- **As built:** `MachineBrowser` also has `processId(sandboxId)`, Chrome's pid while one runs:
  `MachinePorts` (7.5) drops that pid's listeners from `listen` and refuses it in `stop` as
  `not-found`. A boot is `hub.connection(sandboxId)` and its `ended`, not a `hub.boots`
  subscription, so a runner that connected before the service started is covered too. The bridge
  reads each socket's request line and passes only `GET /devtools/browser/<guid>`: Chrome's own
  `/json` pages print the guid, so a plain byte pipe would hand it to any local process. Before
  handing out the endpoint it dials Chrome once through the runner, so a runner older than
  `tcp.connect` fails as the added `runner-outdated` ("Stop the machine and start it again")
  rather than at the first tab. Chrome's environment is the host's base without its `GIT_*`
  identity; a driver kind that cannot be read keeps Chrome's sandbox on. Its stderr is logged at
  debug, except the DevTools line. `toDuplex` moved to `sandbox/runnerHub/tcpDuplex.ts`.
- **Types and services:** `MachineBrowser`, `MachineBrowserError`.
- **Commands and events:** none. Chrome is not part of the sandbox record: it is a process the
  server started, like a terminal. **Migrations:** none.
- **Tests:**
  - `MachineBrowser.test.ts`, against a fake host whose spawner emits the stderr line and whose
    `ports.connect` is an in-memory pair: two concurrent `endpoint` calls spawn once; the
    endpoint carries the bridge's port and Chrome's guid; a missing binary is `not-installed`; an
    early exit is `launch-failed` with stderr; closing the boot scope kills the process and a
    later call starts a new one; the spawn's environment has no credential key and no
    `T3CODE_THREAD_ID`; `--no-sandbox` is present for `docker` and absent for `gce`.
  - `runner.live.test.ts`-style `it.live` case only if one already boots a real runner with the
    dev image and the image has Chrome: `endpoint` then `chromium.connectOverCDP` returns a
    browser whose `version()` contains `CHROME_VERSION`. Otherwise this is the Verify step.
- **Verify:** on a Docker dev cloud session, a script that calls `endpoint`, attaches with
  Playwright, opens `http://localhost:<port>` for a server started in the machine's terminal and
  prints the title. Then stop the machine and show Chrome's pid gone and the bridge port closed.
- **Reviewer checks:** one Chrome per machine, never per tab; stderr is always drained; nothing
  here runs on a server that is not cloud-only; the bridge is loopback with an unguessable path;
  no credential reaches Chrome's environment; a runner restart yields a fresh browser rather than
  a dead endpoint. Providers: none. Surfaces: server only.

### 7.4 `feat(server): open a cloud session's browser tabs on its machine` (was 2.11)

**Critical.** `preview.open` for a thread with a machine opens a tab in that machine's Chrome.
Streaming, input, control, the agent's `preview_*` tools and `t3_preview_*` tools work on it
through the code that serves a local server's tabs today. Threads without a machine are still
refused. No client offers the tab until 7.7.

**Spike, done 2026-11-10** on the test server: the image's Chrome 156 in a Docker container (runc
and gVisor, which behaves the same about 15% slower), Playwright 1.60 over `connectOverCDP`.

| #   | Check                                                       | Result                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `browser.contexts()[0]` exists and `newPage()` on it works. | Pass. A persistent cookie survives closing every page, reconnecting and a SIGTERM restart. A cookie set in the ~30 s before a SIGKILL is lost; session cookies drop on restart.                                                                                                                    |
| 2   | `browser.newContext()` gives an isolated context.           | Pass, isolated both ways.                                                                                                                                                                                                                                                                          |
| 3   | Screencast frames arrive and input lands.                   | Pass: first frame in 91 ms; clicks, typing (non-ASCII too) and wheel.                                                                                                                                                                                                                              |
| 4   | A download: where it lands, and `download.saveAs` over CDP. | By default it lands in the container under `/tmp/playwright-artifacts-…`, and `saveAs` to a server path fails (ENOENT). `Browser.setDownloadBehavior` with a folder in the machine works per context, but Playwright resets it on connect and on each `newContext()`.                              |
| 5   | A file chooser: `setFiles` with a path.                     | **Unsafe.** Given a path, Playwright reads the file on the server's host and injects its bytes, so an agent could upload any server file. Bytes payloads are superlinear (1 MiB 0.4 s, 8 MiB 5.4 s, 15 MiB 16 s); CDP `DOM.setFileInputFiles` with a path in the machine takes 161 ms for 100 MiB. |
| 6   | `preview_recording_start` and `stop`.                       | Works, but the encoder page launched the server's Chromium; with the encoder in a scratch context of the machine's Chrome it made a valid 8 s mp4.                                                                                                                                                 |
| 7   | PDF navigation and `presentAsChrome`.                       | Pass. `http://localhost:<port>` inside the machine loads with the right Host header.                                                                                                                                                                                                               |
| 8   | Frame rate and latency at 1280×800.                         | Same host, jpeg q70, maxWidth 1280: 15 fps on runc and 12.6 on gVisor, ~141 KiB a frame (~2 MB/s) on a busy page, input to frame 55–66 ms idle and 160–230 ms busy, Chrome at 1.5–1.75 cores. Acks paced at 100 ms do not limit it. The real tunnel is slower.                                     |

Also seen: without `--no-sandbox` Docker fails with "No usable sandbox!" (Q1). `--disable-gpu` still
starts a GPU process, and dbus errors on stderr are noise, not a failed launch. Chrome takes about
0.58 GB with no tabs and 60 MiB more for three light tabs.

- **Needs:** 7.3. **Unblocks:** 7.6, 7.7.
- **Files:**
  - New `apps/server/src/preview/PreviewMachine.ts`: a service, with `layerNone` for every other
    server (7.8: a reference's default hid that requests never saw the live one).
    - `forThread(threadId): Effect<Option<{ sandboxId, endpoint: Effect<string, …>, host: Effect<WorkspaceHost, …> }>>`.
      The default answers `none`, so a local server's behaviour is bit for bit today's. `host` is
      an effect, read per tab, since a machine that slept has none until it wakes.
    - The sandbox layer's implementation (`sandbox/browser/PreviewMachineLive.ts`, provided in
      `server.ts` with the runtime services on a cloud-only server) reads the thread shell's `sandboxId` from the
      projection (README P6: callers needing sandbox state read the projection) and returns
      `MachineBrowser.endpoint` and the sandbox's workspace host.
  - `apps/server/src/preview/Manager.ts` (`open`, 179–183): replace the unconditional refusal.
    On a cloud-only server, refuse unless `PreviewMachine.forThread` answers `some` and
    `input.runtime` is `"server"` or absent; then set `runtime: "server"`. Everything below the
    check is unchanged. The comment becomes one line saying a cloud-only server's tabs live on
    machines.
  - `apps/server/src/preview/ServerBrowserContexts.ts`:
    - `MachineTarget { sandboxId, endpoint: () => Promise<string> }`, passed per call.
    - `machineBrowser(machine)`: one `chromium.connectOverCDP(endpoint)` per sandbox, cached as
      `sharedBrowser` is and dropped on `disconnected` or a failed attach. A failed attach throws
      its own message: Playwright's quotes the endpoint, which is a secret.
    - `contextFor(profileId, isolationKey, machine?)`: with a machine, the cache key gains the
      sandbox id and every named profile collapses to the default; an isolation key or the
      incognito profile gives `browser.newContext(...)`, anything else gives
      `browser.contexts()[0]` (Q2). Never `launchPersistentContext`, never a local profile
      directory.
    - `clearProfile` stays local. `scratchPage(machine?)` makes a machine tab's recording encoder
      page in the machine's Chrome. `close` also closes machine browsers (the connection only;
      Chrome belongs to `MachineBrowser`).
  - `apps/server/src/preview/ServerBrowser.ts`:
    - `setUpTab` (807–835): resolve `PreviewMachine.forThread(snapshot.threadId)` first. With a
      machine, skip the desktop branch and pass the machine to `contextFor`. `presentAsChrome`
      (847) takes the machine host's platform and architecture from `host.info`, not the
      server's.
    - `onContextClose` (526–530) already drops tabs when a context closes; confirm a lost
      connection reaches it, and that dropped tabs publish `closed` through the manager so
      clients do not keep a dead tab.
    - **Downloads** (`saveDownload`): for a machine tab, set the context's download directory to
      `/t3-sandbox/<id>/browser/downloads` over CDP (`Browser.setDownloadBehavior` with
      `allowAndName`; the setting is per context, so the folder is per machine and files are named
      by Chrome's download guid). Playwright resets it on connect and on every `newContext()`, so
      each new tab sets it again for every context that machine's tabs use. Never `saveAs` or
      `delete` a machine tab's download: both act on the server's disk. Serve a finished download
      by streaming its path through `host.fileSystem` instead of `NodeFSP`. The
      `/api/preview-stream/download` route keeps its shape. Removing a tab's downloads goes
      through the host too, file by file.
    - **Uploads**: a path must never reach Playwright for a machine tab (spike 5). An agent's
      `preview_upload` paths are resolved and refused unless they are under
      `/t3-sandbox/<that sandbox id>/`, checked before the host sees them (the host routes any
      other path to the server's disk), then confirmed as files through the machine's host. A
      member's files (`POST /api/preview-stream/upload`) are written into the tab's folder under
      `/t3-sandbox/<id>/browser/uploads/`, kept until the tab closes since Chrome reads a chosen
      file only when the page does. Either way Chrome gets the paths through CDP
      `DOM.setFileInputFiles` on the input, found by a one-use attribute and `DOM.performSearch`
      on the frame's session.
    - `resolveNavigationUrl` (1665–1672) needs no change: `localhost:<port>` is now correct by
      construction. Say so in a one-line comment there, since it is the invariant the design
      rests on.
  - `apps/server/src/preview/ServerBrowserStream.ts`: `MachineBrowserError` maps to the stream's
    existing host-setup close (`PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE`, 4503) with a new `need`,
    so a client shows Q6's sentence instead of a blank tab. Add the `need` to
    `PreviewStreamHostSetup` in `packages/contracts/src/preview.ts` (144–150) as an optional
    literal old clients ignore; re-read how the union is decoded before choosing between a new
    literal and a message field.
  - `apps/server/src/mcp/toolkits/preview/*`: no change. The tools reach the tab through
    `PreviewAutomationBroker`. Their descriptions are model-facing and do not change, so no eval
    run is owed; if the spike forces a wording change (recording, row 6), run the evals
    [evals/README.md](../../../../evals/README.md) names first.
  - [06 §10](../06-credentials-and-security.md): the Preview tools row, as landed.
- **As built:** `MachineBrowserError.reason` is `PreviewMachineBrowserReason` in contracts, and
  `PreviewStreamHostSetup` gained `need: "machine"` with `command: ""` and an optional `reason`;
  `preview/` matches the error structurally (`isPreviewMachineError`) so it imports no sandbox
  code. Clients still decode only `sandbox` and `libraries` and fall back for anything else:
  7.7 teaches `decodeHostSetup` and `previewStreamHostSetupMessage` in
  `packages/client-runtime/src/preview/serverBrowserStream.ts` the machine case. The tab's
  machine is read once when the tab is set up and kept on the tab, so the screencast and input
  paths do no lookup. `presentAsChrome` takes the machine's platform and architecture and a fixed
  kernel version (`MACHINE_PLATFORM_VERSION`), never the server's. Recording runs its encoder page
  in a scratch context of the machine's Chrome (`MACHINE_RECORDING_ALLOWED`), so the server's
  Chromium never starts for a cloud thread; the finished file is an attachment and lands on the
  server like every attachment. The download's guid comes from the name in Playwright's
  `download.path()`, a string that is never read. Machine screencasts keep the server's limits
  for now, in `MACHINE_SCREENCAST`. Making a sleep stop Chrome with SIGTERM and a short grace
  is 7.6's: 7.3 already sends SIGTERM with a 5 s force-kill, but only once the boot has ended,
  when the runner is gone. The spike-dependent choices sit in one place each:
  `ServerBrowserContexts.createMachineContext` (spike 1, 2), `ServerBrowser.routeMachineDownloads`
  and `machineDownloadPath` (4), `ServerBrowser.machineFilePaths`, `writeMachineUploads` and
  `setMachineFiles` (5), `MACHINE_RECORDING_ALLOWED` (6) and `MACHINE_SCREENCAST` (8).
- **Types and services:** `PreviewMachine`. **Commands and events:** none. **Migrations:** none.
- **Tests:**
  - `Manager.test.ts`, the cloud-only cases: a thread with a machine opens with
    `runtime: "server"`; a thread without one is refused; `runtime: "desktop"` is refused.
  - `ServerBrowserContexts.test.ts`: with a machine, a non-isolated tab takes the default context
    and an isolated one a new context, both from the connected browser; two machines never share
    a browser; a disconnect drops the cache; no local profile directory is created.
  - `ServerBrowser.test.ts`, machine cases beside the download and upload ones: the download is
    named by its guid in the machine's folder, never `saveAs`, served and removed through the
    host; an agent upload hands Chrome a path in its machine, and the server's database,
    `/etc/passwd`, another machine's root and a `..` escape are refused without a lookup; a
    member's upload is written into the machine; recording asks for the machine's Chrome; two
    threads' tabs open in their own machines, and an agent never reaches the other thread's tab.
  - `ServerBrowserContexts.test.ts`: nothing on a machine tab's path, recording included, asks
    for the server's Chromium.
  - `ServerBrowserStream.test.ts`: a machine error closes with 4503 and `need: "machine"`
    without the sandbox id; a machine download streams through the host's file system.
  - Do not re-test streaming or input for machine tabs; they are the same code.
- **Verify:** a dev cloud-only server with the Docker driver and the Replay provider. From a
  script or the WS client: `preview.open` on a cloud thread with `http://localhost:<port>`, attach
  to `/api/preview-stream/ws`, save three frames, click a link, and call `preview_snapshot` from
  the thread's agent. Then the same `preview.open` on a thread with no machine shows the refusal.
- **Reviewer checks:** a local server takes no new path (the Reference's default); the server's
  own Chromium is never launched for a cloud thread and never loads an agent page; a tab's machine
  is decided from the thread's `sandboxId` on the server, never from client input; side chats and
  forks that share a machine share its browser and its default profile (decision 6); the M6
  access guard (6.3's target table) covers `preview.*`, `subscribePreviewEvents` and the three
  `/api/preview-stream` routes, so a private thread's tabs follow the thread; nothing is written
  to the server's disk for a machine tab. Providers: Claude and Codex get the tools as before;
  others are unchanged. Reverse state: closing the tab; closing the session.

### 7.5 `feat(contracts,server): list and stop a machine's servers`

The Browser's list of running servers shows the ports open in the thread's machine, and **Stop**
stops one. This is 02 §6 PR 8 and 07 §10 #26, without a `LayerMap`: the runner already scans.

- **Needs:** nothing in M7. **Unblocks:** 7.7.
- **Files:**
  - `packages/contracts/src/rpc.ts`: `subscribeDiscoveredLocalServers` (1867–1874) and
    `PreviewStopLocalServerInput` (`preview.ts` 323–327) each gain
    `threadId: Schema.optionalKey(ThreadId)`. Old clients omit it and old servers ignore it.
  - `apps/server/src/ws.ts` (3484–3500):
    - `subscribeDiscoveredLocalServers` on cloud-only: with no `threadId`, today's empty list.
      With one, resolve the thread's host (its checkout path through `WorkspaceHosts.forPath`);
      stream `host.invoke.portListeners(configuredUrls)` mapped to `DiscoveredLocalServerList`,
      filling `agent: { threadId }` with the requested thread where the runner left both thread
      fields empty (the server cannot tell a sandbox terminal's listener apart, so those read as
      the agent's). The runner's own listeners (its MCP forward) are dropped. **As built:** the
      subscription follows `RunnerHub.status`: an empty list while the machine has no runner,
      and the new boot's listing after a wake, so one subscription outlives a sleep (6.13).
    - Chrome's debugging listener is dropped by its pid (`MachineBrowser.processId`, 7.3) and
      refused in `stop`.
    - `preview.stopLocalServer` on cloud-only: with a `threadId`, check the pid and port are in
      a fresh scan by that machine's runner, then read the machine's process table (`ps`, with
      the runner's pid as the shell's `$PPID`) and signal `stoppableProcessGroup`'s group with
      SIGTERM, refusing as `shared-group` a group that holds the runner or one of its direct
      children (agents, terminal shells). `signalGroup(pid)` alone would miss a server that is
      not its group's leader. No SIGKILL escalation. Without a `threadId`, today's refusal.
    - Both handlers call one service method each: `sandbox/browser/MachinePorts.ts`.
  - Clients pass the open thread's id in 7.7, not here.
- **Types and services:** `MachinePorts`. **Commands and events:** none. **Migrations:** none.
- **Tests:**
  - `MachinePorts.test.ts`: a snapshot then a change arrive in order; Chrome's port is absent;
    stop refuses a pid not in the listing and signals one that is; a disconnected machine gives
    an empty list.
  - The permission behaviour tests gain the `threadId` forms if either method is in
    `CLIENT_GUARDED_RPC_SCOPES`.
- **Verify:** in a Docker cloud session, start two servers in the terminal; the subscription
  lists both and not Chrome's port; stop one and the list updates.
- **Reviewer checks:** a member never sees ports of a thread they cannot open (6.3's guard on the
  new `threadId`); the server's own ports are never scanned on cloud-only; stop cannot signal a
  pid outside the listing; an idle machine sends nothing. Surfaces: web, desktop, mobile through
  client-runtime. Connection modes: unchanged.

### 7.6 `feat(server): browser tabs wake a machine and keep it awake while watched`

Opening a tab on a sleeping machine wakes it. A tab somebody is watching holds off idle sleep. When
the machine sleeps, its tabs close.

- **Needs:** 7.4. **Unblocks:** 7.7.
- **Files:**
  - `apps/server/src/sandbox/` implementation of `PreviewMachine` (7.4): `endpoint` first calls
    `SandboxWake.wake({ threadId })` (a no-op when awake), then waits for the machine's host to
    register, bounded at 120 s, and fails with `machine-unavailable`: "The machine did not wake.
    Try again." The tab shows its normal loading state meanwhile.
  - `apps/server/src/preview/ServerBrowserStream.ts`: while a viewer is attached to a machine
    tab, renew the thread's viewer lease on attach and every five minutes
    (`SandboxWake.viewed`, the call `sandboxViewing` makes at `ws.ts` 2925). A phone watching in
    picture-in-picture has no focused thread to renew it. Reach `SandboxWake` with
    `Effect.serviceOption`, as the terminal manager does (`terminal/Manager.ts` 3420–3425).
  - No new idle input. An agent using a tab is inside a running turn, which already counts as
    busy (`SandboxDecisions.ts` 221–270). A tab nobody watches and no agent uses does not hold a
    machine awake (Q3).
  - Closing tabs on sleep needs no code: the runner goes, the CDP connection drops, and 7.4's
    `onContextClose` path closes the tabs. Confirm it in the test below rather than adding a second path.
  - [04 §2](../04-sandbox-lifecycle.md#2-idle-policy-and-wake-triggers): add the two triggers to
    its table.
- **Types and services:** none new. **Commands and events:** the existing `sandbox.wake`.
  **Migrations:** none.
- **Tests:**
  - `SandboxLifecycle.test.ts` (or the wake cases' file): `preview.open` on a sleeping machine
    dispatches one `sandbox.wake` and the tab opens after the runner's hello, driven by the
    test's runner, with no sleeps.
  - `ServerBrowserStream.test.ts`: an attached viewer renews the lease at attach and after
    `TestClock.adjust("5 minutes")`, and stops when it detaches.
  - One case where the runner is lost with a tab open: the manager publishes `closed` for it.
- **Verify:** on Docker with a short idle window: watch a tab past the window and the machine
  stays up; close the viewer and it sleeps; the tab is gone; open a new tab and the machine wakes.
- **Reviewer checks:** viewing a thread's tab list never wakes a machine, only opening a tab or
  attaching to one does; watching a settled or archived thread's tab does not wake its machine
  (the rule `SandboxWake.viewed` already has), though opening one does, as typing in a sleeping
  terminal does; no timer runs for local tabs. Reverse state: detaching lets the machine sleep.
- **As built:** the wake is in `PreviewMachineTarget.host`, which tab setup reads before
  `endpoint`, so a context that reconnects never wakes a machine. It waits for `RunnerHub.status`
  to report the woken generation connected. After 120 s it keeps waiting only while the record is
  still `provisioning` or `waking`: an admission wait, which has no deadline and which the thread
  shows as "Waiting for a machine", or a slow or capacity-retried boot, which the lifecycle fails
  at its 5-minute boot deadline. Anything else fails with `machine-unavailable`, whose message is
  now "The machine did not wake. Try again." Meanwhile the tab shows its loading state. Access: a
  member reaches a tab only through the guarded `preview.open` or a stream that passes
  `canOpenThread`, and an agent's preview tools act only on their own thread.
  `ServerBrowserViewer.onMachine` tells the stream to renew the lease. A lease counts only while
  its member can open the machine (6.10), so losing access stops it at once, and the stream also
  closes. Sleep needs one step after all: SIGKILL loses the cookies Chrome has not written, so
  `SandboxSleepHooks.beforeSleep` calls `MachineBrowser.stopForSleep`, which sends a running
  Chrome SIGTERM and waits at most 2 s, starts nothing and never fails. It runs on every
  `sandbox.stop` that leaves the machine `sleeping`: manual sleep and auto-sleep for idle, cap
  pressure, settled and archived. It does not run on discard, expiry, a `discardOnSettle` settle,
  a boot-deadline failure or a lost runner.

### 7.7 `feat(contracts,server,web,mobile): turn on the Browser tab for cloud sessions`

The Browser tab is enabled for cloud sessions on web, desktop and mobile, and always streams.

- **Needs:** 7.4, 7.5, 7.6. **Unblocks:** the integrated pass.
- **Files:**
  - `packages/contracts/src/environment.ts` (153–154): `machineBrowser:
    Schema.optionalKey(Schema.Boolean)`, documented "Tabs run on each thread's machine. Only the
    streamed runtime reaches them."
  - `apps/server/src/environment/ServerEnvironment.ts` (279): a cloud-only server advertises
    `serverBrowser: true` and `machineBrowser: true`; any other server is unchanged.
  - `apps/web/src/browser/previewRuntime.ts`:
    - `previewRuntimeFor` (13–21) returns `"server"` when the environment has `machineBrowser`,
      before the Electron check.
    - `alternatePreviewRuntime` (23–32) returns `null` for it: there is no desktop runtime to
      switch to.
    - Add the reader beside `readEnvironmentSupportsServerBrowser` in `state/entities.ts`
      (341–353).
  - `apps/web/src/browser/browserTargetResolver.ts` (`resolveDiscoveredServerUrl`, 66–88): for an
    environment with `machineBrowser`, return the loopback URL unchanged. The machine's Chrome
    resolves it; the rewrite to the environment's host, and the "planned authenticated preview
    gateway" error, are for a browser that runs somewhere else.
  - Every entry point that opens a tab or lists servers: the chat view's right panel
    (`ChatView.tsx` 1031, `RightPanelTabs.tsx` 175 and 200), `PreviewPanel.tsx` (34–46), the
    command palette, keybindings, `BrowserProfileReporter.ts` (28) and `IntegrationsSettings.tsx`
    (1141). The last two are profile features: with `machineBrowser` they stay off (Q2). Re-read
    each; most follow `usePreviewAvailable` and need nothing.
  - `packages/client-runtime` (`state/preview.ts`) and its web and mobile callers: pass the open
    thread's id as `threadId` on `subscribeDiscoveredLocalServers` and `preview.stopLocalServer`
    (7.5 added the field). The palette and Settings entries that list servers with no thread
    stay as they are.
  - Empty and error states, in web and mobile: a sleeping machine's Browser panel says "This
    machine is asleep. Open a tab to wake it."; 7.4's `not-installed` close shows Q6's sentence
    with no setup command.
  - `apps/mobile`: `ThreadDetailScreen.tsx` (422–427) already keys on `serverBrowser` and shows
    server-runtime tabs, so it follows. Check the open-a-tab entry point exists on the phone for
    a thread with no tab yet; if tabs can only be watched there today, leave that as it is and
    say so in the docs.
  - `docs/user/pair-cloud.md` and `docs/user/cloud.md`: a short **Browser** section. What it is
    (a browser on the session's machine that you and the agent share), that `localhost` means the
    machine, that tabs close when the machine sleeps, that an older team image needs a rebuild,
    and what does not carry over from local (your profiles, audio, the desktop's own webview).
    `docs/user/remote-access.md#browser-on-a-remote-environment` gets one sentence pointing at
    it. Product voice, no implementation detail.
  - [08 §9](../08-clients-and-contracts.md) and [10](../10-delivery-plan.md): the capability and
    the row, as landed.
- **As built:** every server now advertises `serverBrowser`; a cloud-only one adds
  `machineBrowser` (it always runs `MachineBrowser`). Clients pass `threadId` to the server list
  and Stop only when the environment has `machineBrowser`, so a local server keeps one shared
  scan. The profile picker offers only Default and Incognito on a machine environment
  (`MACHINE_BROWSER_PROFILES`), the tab's profile badge reads a named profile as Default, and
  profile reporting and Settings' clear-profile skip it. The machine close's messages live in
  `previewStreamHostSetupMessage`: `machine-unavailable` reads "The machine did not wake. Try
  again." (7.6's wake failure) and an unknown reason reads as an unexplained machine failure; web
  and mobile show no command block when `command` is empty. The server list names neither
  "Agent" nor "Terminal" for a machine's servers, since the runner cannot tell them apart, and
  ⌘-click no longer opens a machine's `localhost` on the member's computer. A sleeping machine's
  empty Browser says "This machine is asleep. Open a tab to wake it." There is no ChatView browser
  test: the panel's availability already follows `serverBrowser`, and the runtime choice is unit
  tested. Mobile has no way to open a tab, so the phone watches tabs only.
- **Types and services:** the `machineBrowser` capability. **Commands and events:** none.
  **Migrations:** none.
- **Tests:**
  - `previewRuntime` and `browserTargetResolver` unit cases (extend the existing tables): a
    `machineBrowser` environment in Electron, non-primary, gives `"server"`, no alternate
    runtime, and an unchanged loopback URL.
  - One browser test in the chat view's existing file: the Browser action is enabled for a thread
    on a `machineBrowser` environment.
  - No server test: the capability is a literal.
- **Verify:** one `test-t3-app` pass on desktop and web against a dev cloud-only server on Docker
  with Replay: open the tab from the right panel, the palette and the keybinding; pick a listed
  port; type into the page; stop the server from the list. One `test-t3-mobile` pass: watch the
  same tab on a phone. Before and after captures of the tab, and a short video of typing, since
  latency is the thing a reviewer cannot read from the diff.
- **Reviewer checks:** an older desktop app against a new Pair Cloud gets a clean refusal, not a
  blank webview (it sees `serverBrowser`, asks for the desktop runtime, and 7.4 refuses; R11); a
  new app against an older Pair Cloud still shows the tab disabled; a local or team server is
  unchanged on every surface; no continuously repainting indicator was added to the stream view.
  Surfaces: web, desktop, mobile. Entry points: panel, palette, keybinding, Settings. Agents: the
  `preview_*` tools. Connection modes: VPN, Tailscale and the optional public listener all carry
  the existing stream route.

## M7 integrated pass

Run on Docker first, then on Google Cloud in `vm-provider-dev` with a base image rebuilt after 7.1.
A step passes only with its capture.

| #   | Step                                                                                          | Passes when                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | From the Mac app, start a cloud session and ask the agent to start a dev server on port 3000. | The Browser tab is enabled and the server appears in its list.                                  |
| 2   | Open `localhost:3000` from the list.                                                          | The page renders; the URL bar says `localhost:3000`.                                            |
| 3   | Take control, type into a form, follow a link, go back.                                       | Input lands; no visible stall with a turn streaming.                                            |
| 4   | Ask the agent to open the page and describe it (`preview_open`, `preview_snapshot`).          | The agent's tab appears beside yours and its answer matches the page.                           |
| 5   | Open the same session on a phone and in a browser on another machine.                         | Both show the same tabs; a read-only viewer cannot type.                                        |
| 6   | Download a file from the page and upload one to it.                                           | The download is offered on the device; the upload reaches the page.                             |
| 7   | Open an external site.                                                                        | It loads from the machine's egress, not the server's (check the site's view of the address).    |
| 8   | Stop the dev server from the list.                                                            | It leaves the list; the tab shows the connection error.                                         |
| 9   | Leave the session until the machine sleeps, then return and open a tab.                       | Tabs closed with the machine; the new tab wakes it and loads.                                   |
| 10  | Watch a tab in the phone's picture-in-picture past the idle window.                           | The machine stays awake.                                                                        |
| 11  | Start a session on a team image built before 7.1.                                             | The tab shows the rebuild message; nothing else breaks.                                         |
| 12  | On the server: `ps` and the server-browser directories during steps 2–7.                      | No Chromium process on the server and no profile or download written under its state directory. |
| 13  | A local thread in the same Mac app.                                                           | Its Browser tab is the desktop's own webview, as before.                                        |

Record for the GCE part: the base image size before and after, a machine's memory with one and
with five tabs, and the frame rate from step 3 on the kit's network.

## Not in this milestone

- `html_preview` and HTML render measurement on Pair Cloud (Q5).
- Named browser profiles, cookie import and audio for machine tabs (Q2).
- Remembering tabs across sleep, and "Restart" rerunning a project script (Q3).
- Forwarding a machine's port to a member's own computer. It comes with SSH
  ([07 §7](../07-access-and-data.md)); there are still no public preview URLs.
- Hosted vendor drivers. A vendor image needs 7.1's step, and nothing else here is driver-specific.
