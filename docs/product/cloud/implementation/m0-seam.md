# M0 Seam: implementation specs

Status: implementation plan, 2026-11-06. Nothing here is built. Read [README](./README.md) first:
it says how to use this set, the names every PR shares, and what the code checks changed. The
design is [02 Workspace host](../02-workspace-host.md); the PR list is
[10 §2](../10-delivery-plan.md#m0-seam-no-behavior-change).

Each PR below follows one template: what it makes true, Needs and Unblocks, Files, Types and
services, Commands and events (none in M0), Migrations (none in M0), Tests, Verify, Reviewer checks.
Line numbers are from `feat/pair` on 2026-11-06; re-read the symbol before editing, because
upstream merges move lines.

## Build order

| Step | PRs                | Needs              | Notes                                                                         |
| ---- | ------------------ | ------------------ | ----------------------------------------------------------------------------- |
| 1    | 0.1                | —                  | Fixes the interface every later PR and three M1 tracks build on.              |
| 2    | 0.2                | 0.1                | From here nothing new can bypass the seam.                                    |
| 3    | 0.3, 0.4, 0.5, 0.6 | 0.2                | Independent of each other. 0.3 adds the recording host and the op-count test. |
| 4    | 0.7, 0.8, 0.10     | 0.3 (0.7 also 0.6) | 0.7 moves the base environment; 0.8 the disk checks; 0.10 port discovery.     |
| 5    | 0.9                | 0.3–0.8, 0.10      | The remaining `HostProcess` reads and their lint disables. Last.              |
| any  | 0.11               | —                  | The contract split touches no workspace code; it must land before 1.16.       |

Then the [M0 integrated pass](#m0-integrated-pass) proves nothing changed.

Every row here is a refactor or a lint rule. A row that changes behavior or performance on a local
thread is a bug in that row. New code goes in `apps/server/src/workspaceHost/` (decision 14);
upstream files get mechanical edits (`spawner` becomes `host.spawner`).

0.12 and 0.13 are dropped: settings gate Cloud (08 §2 rule 3), and `cloudAvailability` lands with
its first consumer in 1.37.

## PR-list changes and corrections

- **Interface fields land with their first user.** 0.1 fixes the routing model (`forPath`, the
  reserved root, fail closed) and the fields every routing PR needs: `id`, `kind`, `info`,
  `spawner`, `fileSystem`, `pty`, `agentScope`. The rest of the M0 interface lands in the PR that
  first calls it: `files` in 0.4, `spawnProcessGroup` in 0.6, `processes.signalGroup` (with
  `WorkspaceHostError`) in 0.10. Later rows own the rest: `processes.table` and
  `ports.listeners` (with the per-host port discovery map) in 1.10, `invoke` in 1.10/1.11,
  `register` in 1.11, `exposeServerEndpoint` in 1.13 (it is the identity on the local host; 0.6
  explains), `ports.connect` in M2. The whole M0 shape is written out in 0.1 so nothing is
  redesigned later. Reason: knip fails unused exports, and a field with no caller is machinery.
- **The recording test host (`WorkspaceHostTesting.makeRecording`, 02's `layerRecording`) moves
  from 0.1 to 0.3**, its first consumer (knip). It records at the spawner and file system, not on
  a host wrapper, so the same op-count assertion runs on `main` and after routing (0.3).
- **`forThread` lands with its first consumer**, and M0 has none: every M0 call site already has a
  path. It stays a helper outside the service (layer cycle, README P6).
- **Tests need a wiring line, not new assertions.** 02 says existing tests "need no edits". That
  holds for assertions, not for layer wiring: once `VcsProcess`, `GitVcsDriverCore`, the terminal
  manager or `WorkspaceFileSystem` yield `WorkspaceHosts`, every test that builds them needs
  `WorkspaceHostTesting.layerFromContext` provided. Each routing PR lists those files. The rule:
  a test's expectations, fakes and inputs do not change; only its `Layer.provide` list does.
- **`WorkspaceHostInfo` drops `shell` and `tmpDirectory` (proposed).** Nothing reads them: the
  terminal derives its shell from the environment (`defaultShellResolver`, `Manager.ts:511`), and
  `ClaudeTaskOutputTail.ts:25-33` derives its temp dir from the environment. Both already follow
  `info.environment` once routed.
- **`WorkspaceHost.info` is an `Effect`, not a value (proposed).** Today some code reads
  `HostProcess` per call and tests override it around single calls (0.1 explains). An effect that
  reads the references keeps that exactly; the sandbox host returns a constant.
- **`WorkspaceHostUnavailableError` carries only `sandboxId` (README P6).** 02 §2 also puts the
  sandbox state on it; P6 drops that to avoid a cycle with orchestration.
- **0.8 is wider than 07 §10 #1.** It adds restore safety at admission (`Orchestrator.ts`), the
  storage cleanup walk and worktree removal. `KnownWorkspaces.assertContains` goes in 0.4.
  VCS detection's disk checks (`VcsDriverRegistry`, `VcsProjectConfig`) and `GitManager`'s path
  canonicalization go in 0.3, as 10 §2 now says.
- **Needs columns tighten.** 10 §2 says 0.3–0.8 and 0.10 need only 0.2. In code, 0.7 also needs
  0.3 (`VcsProcess` resolves the host) and 0.6 (sessions hold a host); 0.8 and 0.10 need 0.3
  (`removeLinkedWorktree` takes a host; `ProcessRunInput.host`). 0.4, 0.5 and 0.6 stay
  independent of each other.
- **0.6 reaches the ACP package through `ProviderHost` (proposed).** `packages/provider-acp`
  cannot import `apps/server`, so the session spawn gets the host's spawner and agent scope from a
  new optional `ProviderHost.sessionProcesses(cwd)`. Optional keeps every package fake unchanged.
- **0.10 does not add the per-host `LayerMap`.** It makes port discovery take one host value;
  1.10 adds the map with `ports.listeners`, when there is a second host.

---

### 0.1 `refactor(server): add WorkspaceHost, WorkspaceHosts and LocalWorkspaceHost`

Adds the seam with one implementation and wires it at the server root. Nothing calls it yet, so
the diff in upstream files is three lines in `server.ts`. Its own PR because every M0 routing PR
and three M1 tracks build on these types.

- **Needs:** none. **Unblocks:** 0.2, then 0.3–0.10; M1's 1.1, 1.2, 1.4, 1.36 (fixed interfaces).
- **Files:**
  - add `apps/server/src/workspaceHost/WorkspaceHost.ts`: `WorkspaceHostId`, `WorkspaceHostInfo`,
    `WorkspaceHost` (the lines above the "added by later M0 PRs" marker below),
    `WorkspaceHostUnavailableError`, `SANDBOX_ROOT`, `LOCAL_WORKSPACE_HOST_ID`.
  - add `apps/server/src/workspaceHost/LocalWorkspaceHost.ts`: `make`, built from context.
  - add `apps/server/src/workspaceHost/WorkspaceHosts.ts`: the `WorkspaceHosts` service, `layer`.
  - add `apps/server/src/workspaceHost/WorkspaceHostTesting.ts`: `layerFromContext`.
  - add `apps/server/src/workspaceHost/WorkspaceHosts.test.ts`.
  - change `apps/server/src/server.ts`: one `Layer.provideMerge` in the root pipe (below).

**Types, services and RPCs.**

```ts
// workspaceHost/WorkspaceHost.ts
import type * as Brand from "effect/Brand";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";

export type WorkspaceHostId = string & Brand.Brand<"WorkspaceHostId">; // "local" or a sandbox id
export const LOCAL_WORKSPACE_HOST_ID = "local" as WorkspaceHostId;
/** Sandbox files live here at the same absolute path on the server's side and in the sandbox. */
export const SANDBOX_ROOT = "/t3-sandbox";

export interface WorkspaceHostInfo {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly homeDirectory: string;
  /** Base env of every process this host starts. Local: the same `process.env` object, not a copy. */
  readonly environment: NodeJS.ProcessEnv;
  readonly userId: number | undefined;
  readonly executablePath: string;
}

export interface WorkspaceHost {
  readonly id: WorkspaceHostId;
  readonly kind: "local" | "sandbox";
  /** Read per use, never captured: local code and tests override HostProcess per call today. */
  readonly info: Effect.Effect<WorkspaceHostInfo>;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem; // an interface plus a tag, not a Service class
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly agentScope: AgentScopeShape; // AgentScope is a Context.Reference
  // ---- added by later M0 PRs (the full M0 shape, fixed here) ----
  readonly files: {
    // 0.4: native realPath, lstat, readDirectory, nonblocking readFile, writeNoFollow
    // signatures in 0.4; errors are WorkspaceHostFileError carrying the errno `code`
  };
  readonly processes: {
    // 0.10
    readonly signalGroup: (
      pid: number,
      signal: NodeJS.Signals | 0,
    ) => Effect.Effect<void, WorkspaceHostError>;
    // table: Effect<ReadonlyArray<ProcessTableEntry>, WorkspaceHostError> lands in 1.10
  };
  readonly spawnProcessGroup: (
    input: ProcessGroupSpawnInput,
    hooks: ProcessGroupHooks,
  ) => ProcessGroupProcess; // 0.6, sync
  // exposeServerEndpoint (endpoint) => Effect<string, WorkspaceHostError, Scope>: 1.13
  // ports.listeners: Effect<ReadonlyArray<PortListener>, WorkspaceHostError>: 1.10
}

// Lands with 0.10, its first user (knip).
export class WorkspaceHostError extends Schema.TaggedError<WorkspaceHostError>()(
  "WorkspaceHostError",
  {
    hostId: Schema.String,
    operation: Schema.String, // "processes.table", "processes.signalGroup", ...
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Workspace host operation ${this.operation} failed.`;
  }
}

export class WorkspaceHostUnavailableError extends Schema.TaggedError<WorkspaceHostUnavailableError>()(
  "WorkspaceHostUnavailableError",
  { sandboxId: Schema.String }, // narrowed to SandboxId when 1.2 lands
) {
  override get message() {
    return "This thread's machine is not connected.";
  }
}
```

```ts
// workspaceHost/LocalWorkspaceHost.ts — no I/O, no state: today's behavior bit for bit
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pty = yield* PtyAdapter.PtyAdapter;
  const agentScope = yield* AgentScope; // the systemd scope on Linux, the identity wrap elsewhere
  // Reads the references when `info` runs, so a per-call override still applies.
  const info: Effect.Effect<WorkspaceHostInfo> = Effect.gen(function* () {
    return {
      platform: yield* HostProcess.Platform,
      architecture: yield* HostProcess.Architecture,
      homeDirectory: yield* HostProcess.HomeDirectory,
      environment: yield* HostProcess.Environment,
      userId: yield* HostProcess.UserId,
      executablePath: yield* HostProcess.ExecutablePath,
    };
  });
  return {
    id: LOCAL_WORKSPACE_HOST_ID,
    kind: "local",
    info,
    spawner,
    fileSystem,
    pty,
    agentScope,
  } satisfies WorkspaceHost;
});

// workspaceHost/WorkspaceHosts.ts
export class WorkspaceHosts extends Context.Service<
  WorkspaceHosts,
  {
    readonly local: WorkspaceHost;
    readonly forPath: (path: string) => Effect.Effect<WorkspaceHost, WorkspaceHostUnavailableError>;
    // register (root, host) => Effect<void, never, Scope>: added by 1.11
  }
>()("t3/workspaceHost/WorkspaceHosts") {}

const make = Effect.gen(function* () {
  const local = yield* LocalWorkspaceHost.make;
  const succeedLocal = Effect.succeed(local); // built once: the local path allocates nothing
  const forPath = (path: string) => {
    // Fail closed: a path under the reserved root never falls back to local disk.
    if (path !== SANDBOX_ROOT && !path.startsWith(`${SANDBOX_ROOT}/`)) return succeedLocal;
    return Effect.fail(new WorkspaceHostUnavailableError({ sandboxId: path.split("/")[2] ?? "" }));
  };
  return WorkspaceHosts.of({ local, forPath });
});
export const layer = Layer.effect(WorkspaceHosts, make);
```

Why `info` is an effect, not a value: `GitVcsDriverCore.ts:979` and `GitVcsDriver.ts:918` read
`HostProcess.Environment` per call, and tests override it around single calls
(`withGitFileProtocol` in `GitVcsDriverCore.test.ts:270-275`, `:4067`; `GitVcsDriver.test.ts:281`;
`HostProcess.HomeDirectory` in `WorkspaceFileSystem.test.ts:266`). A value captured at layer build
would break those tests and change semantics. The sandbox host returns `Effect.succeed(info)`.
Code that captures a fact at construction today keeps doing so by reading `hosts.local.info` once
only where it is truly server-scoped; thread-scoped code reads `host.info` at the call.

`forPath` is deliberately untraced and allocation-free on the local path: one prefix test. It
does not normalize: every caller passes an absolute path it got from a cwd, a `worktreePath` or a
project root, and `/x/../t3-sandbox/...` is not one of those. (1.11 adds the `Map` get.)

```ts
// workspaceHost/WorkspaceHostTesting.ts
/** A WorkspaceHosts whose local host is built from the test's own services. */
export const layerFromContext: Layer.Layer<WorkspaceHosts>
// Spawner, FileSystem and PtyAdapter each come from the context when present (Effect.serviceOption);
// a missing one is a stub that dies with "no <service> in this test". So a test adds this one
// layer whatever it fakes (PortScanner.test.ts fakes only FileSystem and ProcessRunner).
```

`server.ts` wiring, in the root pipe of `layerMakeServer` (today `server.ts:1214-1216`).
`PtyAdapter` is not provided at the root (only to `layerTerminal` at :497 and the runtime core at
:710), so `WorkspaceHosts.layer` takes `layerPtyAdapter` (`server.ts:261`) itself. It is the same
layer value, so the build's memo map shares one node-pty instance with the terminal:

```ts
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(WorkspaceHosts.layer.pipe(Layer.provide(layerPtyAdapter))),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
```

It sits after `VcsProcess.layer` (which needs it from 0.3) and before `AgentScopeLive.layer` and
`layerPlatformServices` (which it needs: the systemd `AgentScope`, `NodeServices`' spawner and
file system, the `HostProcess` references). `provideMerge` keeps it in the output context, so
per-connection layers built in `ws.ts` (for example `GitVcsDriver.layer` at `ws.ts:3743`) see the
same instance. That matters in M1, when `register` must be visible everywhere.

**Tests.** New `workspaceHost/WorkspaceHosts.test.ts`, the `WorkspaceHosts` unit layer (no
existing file covers a new service). `it.effect` cases, built with `layerFromContext` over
`NodeServices.layer`:

- `forPath` returns `hosts.local` (same object) for `/repo`, `/t3-sandboxes/x` and `C:\\repo`.
- `forPath("/t3-sandbox/sbx_0123/worktrees/a")` and `forPath("/t3-sandbox")` fail with
  `WorkspaceHostUnavailableError`, the first with `sandboxId: "sbx_0123"`.
- `(yield* local.info).environment` is the `HostProcess.Environment` value itself (`toBe`), and
  `Effect.provideService(HostProcess.Platform, "darwin")` around `local.info` shows `"darwin"`:
  the override is honored per call, as today's per-call reads are.

**Verify.** `vp test run apps/server/src/workspaceHost/WorkspaceHosts.test.ts`,
`vp run typecheck` (server), `vp run check:changed`. Start `vp run dev` once and confirm the server
boots and a terminal opens (node-pty now builds at the root; it is the same instance).

**Reviewer checks.**

- `LocalWorkspaceHost.make` does no I/O and holds no state; `environment` is the live
  `process.env` object, not a copy; `info` reads the references at each use.
- `forPath` cannot return `local` for any string under `/t3-sandbox/`.
- `layerPtyAdapter` is the same value the terminal layer uses, so node-pty loads once.
- Only `server.ts` and the test import `workspaceHost/` yet; no unused export (knip).

### 0.2 `chore(lint): keep workspace access behind WorkspaceHost`

Adds `t3code/workspace-host-boundary` and a reasoned file-level disable on every current
violation, so nothing new reaches the thread's machine around the seam while 0.3–0.10 land. Each
routing PR then deletes its disables; the diff of disables is the review checklist.

- **Needs:** 0.1 (the messages name `WorkspaceHosts`). **Unblocks:** 0.3–0.10.
- **Files:**
  - add `oxlint-plugin-t3code/rules/workspace-host-boundary.ts`, modeled on
    `no-global-process-runtime.ts` (import tracking, `MemberExpression` and `CallExpression`
    visitors, `createOnce` with a `before` reset).
  - add `oxlint-plugin-t3code/rules/workspace-host-boundary.test.ts` with
    `createOxlintRuleHarness("t3code/workspace-host-boundary")` (`oxlint-plugin-t3code/test/utils.ts`).
  - change `oxlint-plugin-t3code/utils.ts`: move `isGlobalProcessObject` here from
    `no-global-process-runtime.ts` and import it in both rules.
  - change `oxlint-plugin-t3code/index.ts`: import and register `"workspace-host-boundary"`.
  - change `vite.config.ts`: one `overrides` entry (below).
  - change about 92 source files: one file-level disable each (listed by folder below).

**The rule.** No options (`schema: []`, as `no-hookless-use-function`); the config's `files`
set the scope. It reports:

| Pattern                                                                                                                                             | Message (short)                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a value import from `node:child_process`, `child_process`, `node:fs`, `fs`, `node:fs/promises`, `fs/promises`, `node-pty` (`importKind !== "type"`) | "Reach the thread's machine through `WorkspaceHosts.forPath(cwd)`."          |
| `yield* <ns>.ChildProcessSpawner`, `yield* <ns>.PtyAdapter` (member expression whose object and property name match)                                | "Use `host.spawner` / `host.pty` from `WorkspaceHosts.forPath(cwd)`."        |
| `yield* HostProcess.Platform`, `.HomeDirectory`, `.Environment`, `.isWindows`                                                                       | "Read host facts from `host.info` in thread-scoped code."                    |
| `process.env`, `globalThis.process.env` (via `isGlobalProcessObject`)                                                                               | "Take the base environment from `host.info.environment`."                    |
| `yield* FileSystem.FileSystem`                                                                                                                      | "Use `host.fileSystem`, or disable with a reason starting `server-scoped:`." |

Disable reasons start with one of these prefixes, so a reader knows if the disable is permanent:

- `server-scoped:` the code touches the server's own disk or processes on purpose (terminal history
  logs, attachments, provider status caches, the server's provider install).
- `not routed yet (0.N):` removed by M0 row 0.N.
- `routed in M1 (1.N):` a known gap a named M1 row closes (for example `removeEmptyDirectory`'s
  `rmdir`, Claude's in-process history calls).
- `not supported in cloud:` or `routed in M3:` the adapters 10 §2 keeps disabled (OpenCode, Pi,
  Antigravity, Muse, Cursor, and the ACP runtime's client files and terminals).

The rule enforces the prefix in its `Program` visitor: it walks
`sourceCode.getDisableDirectives().directives` and reports a directive that names this rule
without one of the prefixes. **Proposed fallback:** if the rule's test shows oxlint suppresses that
report under the directive itself, drop the check and keep the prefixes a review convention;
`require-suppression-reason` already forces a reason. Do not add a second rule for it.

Config entry in `vite.config.ts` `lint.overrides`, after the `HostProcess.ts` entry (line ~361):

```ts
{
  files: [
    "apps/server/src/{vcs,workspace,terminal,checkpointing,git,orchestration-v2}/**",
    "apps/server/src/storageCleanup.ts",
    "apps/server/src/preview/PortScanner.ts",
    "apps/server/src/provider/Drivers/ClaudeHome.ts",
    "apps/server/src/provider/codexLaunchArgs.ts",
    "apps/server/src/provider/userInputAttachments.ts",
    "apps/server/src/textGeneration/{Claude,Codex}TextGeneration.ts",
    "packages/provider-core/src/server/instanceEnvironment.ts",
    "packages/provider-*/src/server/**",
  ],
  excludeFiles: [
    "**/*.{test,spec,testkit}.ts",
    "**/{test,tests,testkit,testing,fixtures,integration}/**",
    "**/*Testing.ts",
  ],
  rules: { "t3code/workspace-host-boundary": "error" },
},
```

`PortScanner.ts` (0.10), `userInputAttachments.ts` and the two text generation files (0.7) are
added to 02's list because M0 rows route them.

Current violations, by a grep of the five patterns over that scope (the rule run is the source of
truth; the PR lists the exact set): 34 files in `apps/server/src`, 58 in `packages/provider-*`.

| Where                                                                                                                                                                                                                      | Files | Disable reason                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `vcs/` (8: `VcsProcess`, `GitVcsDriver`, `GitVcsDriverCore`, `VcsDriverRegistry`, `VcsProjectConfig`, `VcsStatusBroadcaster`, `worktreeRemoval`, `removeEmptyDirectory`), `git/GitManager.ts`, `git/GitWorkflowService.ts` | 10    | `not routed yet (0.3)` (`checkpointing/` has none: it reaches disk through `vcs/`)                                               |
| `workspace/` (4)                                                                                                                                                                                                           | 4     | `not routed yet (0.4)`                                                                                                           |
| `terminal/Manager.ts`                                                                                                                                                                                                      | 1     | `not routed yet (0.5)`                                                                                                           |
| `terminal/NodePtyAdapter.ts`                                                                                                                                                                                               | 1     | `server-scoped: the local PTY implementation behind LocalWorkspaceHost`                                                          |
| `Adapters/ClaudeAdapterV2.ts`, `Adapters/CodexAdapterV2.ts`, `packages/provider-acp/src/server/{AcpSessionRuntime,adapter}.ts`                                                                                             | 4     | `not routed yet (0.6)`                                                                                                           |
| `ClaudeHome.ts`, `codexLaunchArgs.ts`, `instanceEnvironment.ts`, `ProviderSessionManager.ts`, `ClaudeTaskOutputTail.ts`, `workflowFileRead.ts`                                                                             | 6     | `not routed yet (0.7)`                                                                                                           |
| `CheckpointRollbackService.ts`, `ThreadPullRequestService.ts`, `Orchestrator.ts`, `storageCleanup.ts`                                                                                                                      | 4     | `not routed yet (0.8)`                                                                                                           |
| `preview/PortScanner.ts`                                                                                                                                                                                                   | 1     | `not routed yet (0.10)`                                                                                                          |
| `AttachmentClaims.ts`, `ProviderTurnStartService.ts`, `ResourceCleanupService.ts`, `ThreadSettlementService.ts`, `ThreadTitleRegenerationService.ts`                                                                       | 5     | decided per file in this PR: `server-scoped:` where the reads are attachments or the server's state, else `not routed yet (0.7)` |
| `Adapters/AntigravityAdapterV2.ts`, provider-opencode, -pi, -muse, -cursor; the ACP runtime's `clientTerminals.ts`, `clientPolicy.ts`                                                                                      | ~30   | `not supported in cloud:` or `routed in M3:`                                                                                     |
| provider `status.ts`, `driver.ts`, probes, home and auth readers in fx, grok, kiro, acp-registry, provider-core                                                                                                            | ~30   | `server-scoped: probes the server's own CLI install` (or the matching reason)                                                    |

**Tests.** `workspace-host-boundary.test.ts`, one `rule.valid`/`rule.invalid` per row of the
pattern table, plus: a type-only `import type * as NodeFs from "node:fs"` is valid; `process.envx`
and `env.process` are valid; a `/* oxlint-disable t3code/workspace-host-boundary -- server-scoped:
logs */` file passes; the same directive with `-- because` fails (the prefix check). The harness
runs oxlint on a fixture file, as for every other rule; use `filename` only if a case needs a
path.

**Verify.** `vp test run oxlint-plugin-t3code/rules/workspace-host-boundary.test.ts`,
`vp run check:changed` (runs lint over the touched files; every disabled file must pass). No
runtime change, so no transcript.

**Reviewer checks.**

- Every disable carries one of the prefixes, and every `not routed yet (0.N)` names a row that
  really routes that file.
- `server-scoped:` is used only where the code must stay on the server's machine; a thread cwd under
  it is a bug.
- Test files and `workspaceHost/` are outside the rule.
- The rule matches `yield*` of the services, not their type imports, so `import type` stays legal.

### 0.3 `refactor(server): route git and checkpoint capture through WorkspaceHost`

Every `git` process, checkpoint temp-index file op, trace2 watch, VCS detection disk check and
`GitManager` path canonicalization resolves `WorkspaceHosts.forPath(cwd)` per call. It is the
largest routing PR and the one with the op-count proof, so it lands alone.

- **Needs:** 0.2. **Unblocks:** 0.9; M1 1.10 (`checkpoint.capture` runs this code in the runner)
  and 1.11.
- **Files and call sites** (all under `apps/server/src/` unless named):
  - `processRunner.ts`: `ProcessRunInput` gains `host?: WorkspaceHost`; `make`'s `run` uses
    `input.host?.spawner ?? spawner` (`runProcessCore(spawner, input)` at :266 already takes one).
    `ProcessRunner` stays a server-scoped service; this only lets a caller run on a named host.
    (0.9 also feeds `input.host.info` to `resolveSpawnCommand`.)
  - `vcs/VcsProcess.ts` `make` (:184): yield `WorkspaceHosts`; in `spawn` (:200) resolve
    `host = yield* hosts.forPath(input.cwd)` and pass `host` to `processRunner.run`; `hostPlatform`
    (:186, used at :214 and :283) becomes `(yield* host.info).platform`. The two global semaphores
    (:187-188) stay one instance: concurrency limits do not change. The `process.env` read at :214
    keeps a `not routed yet (0.7)` next-line disable.
  - `vcs/GitVcsDriverCore.ts` `makeGitVcsDriverCore` (:943): yield `WorkspaceHosts` in place of
    `ChildProcessSpawner` (:946); keep `FileSystem` (:944) only for `worktreesDir` server paths.
    - `executeRaw` (:955): `host = forPath(input.cwd)`; `createTrace2Monitor` (:667, watch at
      :789, temp file at :684) gets `host.fileSystem` (today provided at :966-967);
      `HostProcess.Environment` (:979) and `hostPlatform` (:950) become `host.info`; spawn with
      `host.spawner` (:990). `resolveSpawnCommand` (:987) stays (it reads `HostProcess` per call
      in `packages/shared/src/shell.ts`; 0.9 and 1.11 own it).
    - file ops on the repository, each through `forPath(cwd)`: `readGitCommonDir` (:1430),
      `resolveRepositoryPathsUncached` (:1482), `readStatusDetailsLocal` lock check (:2131),
      `stageCommitChanges` (:2450), `prepareCommitContext` temp index (:2501-2518),
      `prepareReviewIndex` temp index (:3056-3067), `readEmptyTreeHash` (:3112, platform),
      `readWorkingTreeReviewFile` (:3690-3691), `readGitRefsSnapshot` (:3976),
      `createWorktree` (:4226 home dir, :4320 project file read), `removeLeftoverLinks`
      (:4738-4744), `removeWorktree` (:4776-4797). Temp files must sit on the host that runs git.
  - `vcs/GitVcsDriver.ts` `makeVcsDriverShape` (:568): `fileSystem` (:569) and `hostPlatform`
    (:573) resolve per call; `captureCheckpoint` (:902) takes `host = forPath(input.cwd)` once and
    uses it for `stat`/`copyFile`/`utimes` (:960-973, :1073), cleanup `remove` (:930) and the
    commit env (`HostProcess.Environment` at :918 becomes `host.info`). Restore's
    `makeDirectory`/`readDirectory` (:1336, :1360) the same.
  - `vcs/worktreeRemoval.ts` `removeLinkedWorktree` (:17): input gains `host: WorkspaceHost`;
    use `host.fileSystem` (:29) and `host.info` for `isWindows` (:37). Callers:
    `GitVcsDriverCore.ts:4758` here, `storageCleanup.ts:1193` in 0.8 (until then it passes
    `hosts.local`).
  - `vcs/removeEmptyDirectory.ts`: `node:fs/promises` `rmdir`, which Effect's `FileSystem` lacks.
    Keeps a disable: `routed in M1 (1.11): needs a host rmdir`. Its one caller
    (`GitVcsDriverCore.ts:4748`) is local-only in M0.
  - `vcs/VcsDriverRegistry.ts` `readDiskState` (:122-133): `forPath(cwd)` once, then
    `host.fileSystem.exists` for both lists. `vcs/VcsProjectConfig.ts` `findConfigPath` (:72):
    resolve the host once from the starting `cwd` and walk with it (do not re-resolve per
    ancestor: in M1 the walk climbs out of `/t3-sandbox/<id>/` and must stay on that host).
    `readConfiguredKind` (:106) uses the same host.
  - `vcs/VcsStatusBroadcaster.ts` `normalizeCwd` (:231) and `withFileSystem` (:338): realPath
    through `forPath(cwd)`; drop the `fs` capture (:243).
  - `git/GitManager.ts` `make` (:702): yield `WorkspaceHosts`. `canonicalizeExistingPath` and
    `normalizeStatusCacheKey` (:1193-1195) realPath through `forPath(value)`;
    `readRepositoryInstructions` (:860-875) through `forPath(cwd)`. The PR body temp file
    (:2450-2473) stays on the server: next-line disable `server-scoped: PR body for the
    server-side forge call`.
  - `git/GitWorkflowService.ts` `withCheckoutLease` (:181-185): realPath through `forPath`.
  - `checkpointing/CheckpointStore.ts`: no direct machine access; it is covered through the
    registry and driver.
  - add to `workspaceHost/WorkspaceHostTesting.ts`: `makeRecording` (below).
- **Lint disables removed:** `vcs/{VcsProcess,GitVcsDriver,GitVcsDriverCore,VcsDriverRegistry,
  VcsProjectConfig,VcsStatusBroadcaster,worktreeRemoval}.ts`, `git/GitManager.ts`,
  `git/GitWorkflowService.ts`. Kept with a new reason: `VcsProcess.ts:214` (0.7),
  `removeEmptyDirectory.ts` (1.11), `GitManager.ts` body file (`server-scoped:`),
  `GitVcsDriverCore.ts:944` `FileSystem` for `worktreesDir` (`server-scoped:` only if a use
  remains after routing; otherwise drop the capture).

**Types, services and RPCs.**

```ts
// processRunner.ts
export interface ProcessRunInput {
  // ...existing fields
  /** Run on this workspace host (its spawner; from 0.9 its facts); the server's when absent. */
  readonly host?: WorkspaceHost | undefined;
}

// workspaceHost/WorkspaceHostTesting.ts
export interface RecordedOps {
  readonly spawns: Array<string>; // "git rev-parse", first argument only
  readonly files: Array<string>;  // FileSystem method names: "exists", "stat", "copyFile", ...
}
/**
 * Wraps the context's spawner and FileSystem and builds WorkspaceHosts from the wrapped pair.
 * It also provides the wrapped pair itself, so code not yet routed (main) records the same ops.
 */
export const makeRecording: () => {
  readonly ops: RecordedOps;
  readonly layer: Layer.Layer<WorkspaceHosts | ChildProcessSpawner | FileSystem, never, ChildProcessSpawner | FileSystem>;
};
```

`makeRecording` records at the spawner and file system the host is built from, not on a host
wrapper, so the same assertion passes on `main` before routing and after. That is the proof.

**Tests.** Commit 1 adds the op-count assertions and must pass on `main`'s code; commit 2 routes.
Literal counts are captured on `main` and written into the tests.

- `vcs/GitVcsDriver.test.ts`, extend "checkpoint capture meters every git process it starts,
  including streamed ones" (:1353): provide `recording.layer` to `captureDriver`'s
  `makeVcsDriverShape()`; assert `started` and `recording.ops.files` equal the literals from
  `main` (driver-level capture: the `stat`, `copyFile`, `utimes` and cleanup `remove` calls).
- `checkpointing/CheckpointStore.test.ts`, new `it.effect` in `"CheckpointStore.layer"`: "runs
  the same processes and disk checks for a turn's baseline and capture". No existing case isolates
  store-level capture with detection. Build the store, registry and `VcsProcess` over
  `recording.layer`; run `isGitRepository`, `hasCheckpointRef`, `captureCheckpoint`; assert the
  `exists` count (detection: 3 plus one per ancestor for `.t3code/vcs.json`) and spawn list.
- `git/GitManager.test.ts`: `makeManager` (:623) gains `recording?: RecordedOps` beside
  `gitCommands`, swapping in `makeRecording().layer` where `layerGitDriverSpawner` goes. New
  `it.effect` "local status runs the same git commands and disk checks" (no case calls
  `localStatus` today): one call on a fresh repo, assert sorted spawns and file ops.

Wiring edits (assertions unchanged): every test that builds a routed service adds
`WorkspaceHostTesting.layerFromContext` **at the same level as its spawner or FileSystem
override**, so the host captures the wrapped service. Example: `GitManager.test.ts`
`layerGitDriverSpawner` (:659-692) wraps the spawner only for the driver; the hosts layer must sit
inside that wrapper or `gitCommands` stops recording. Files: `vcs/{VcsProcess,GitVcsDriver,
GitVcsDriverCore}.test.ts`, `checkpointing/{CheckpointStore,CheckpointDiffQuery}.test.ts`,
`git/{GitManager,GitWorkflowService}.test.ts`, `pullRequest/PullRequestReviewGuideService.test.ts`,
`sourceControl/SourceControlRepositoryService.test.ts`, `storageCleanup.test.ts`,
`project/ManagedProjectFolders.test.ts`, `triage/TriageService.test.ts`,
`mcp/{WorktreeMcpService,toolkits/project/handlers}.test.ts`, `workspace/WorkspaceEntries.test.ts`,
`workspace/WorkspaceFileSystem.test.ts`, and the shared kits
`orchestration-v2/{runtimeLayer.test,ProviderTurnStartService.testkit,testkit/ProviderReplayHarness,
ThreadLaunchService.test,ProviderEventIngestor.test,DelegatedCompletionDelivery.test,
ProjectSettingsUpgrade.integration.test}.ts`. `VcsProcess.test.ts`'s `ProcessRunner` fakes keep
working: they ignore `host`.

**Verify.** `vp test run apps/server/src/vcs apps/server/src/git apps/server/src/checkpointing`,
then the wiring files above, `vp run typecheck` (server), `vp run check:changed`. Metrics: ten
Replay turns before and after, `t3_git_command_duration` and `t3_git_commands_total` (M0
integrated pass); attach the table.

**Reviewer checks.**

- No `forPath` result is cached across calls in a service, and no service holds a host captured
  at construction for thread work.
- A temp index or trace file is created on the same host that runs the `git` that reads it.
- `VcsProcess`'s semaphores and retry policy are untouched; `withMetrics` wraps the same span.
- `findConfigPath` resolves its host once from the starting cwd.
- The op-count literals in the tests equal what `main` produced (commit 1 ran green alone).

### 0.4 `refactor(server): route workspace files and known workspaces through WorkspaceHost`

Client file reads, writes, browse and listing, and the known-workspace check, resolve the host
from `input.cwd`. The `node:fs/promises` calls that keep the safety properties (`O_NOFOLLOW`,
`O_NONBLOCK`, native `realpath`, `lstat` with errno codes) become a small `host.files`
extension, implemented locally by the same calls. Its own PR: one folder, one extension.

- **Needs:** 0.2 (0.3 only for `WorkspaceEntries`' `git check-ignore`, which already goes
  through `VcsProcess`; no hard ordering). **Unblocks:** 1.10, 1.11 (the sandbox host implements
  `files`; `KnownWorkspaces` already asks `WorkspaceHosts`).
- **Files and call sites** (`apps/server/src/`):
  - `workspaceHost/WorkspaceHost.ts`: add `files` and `WorkspaceHostFileError` (below).
  - `workspaceHost/LocalWorkspaceHost.ts`: implement `files` with today's `NodeFSP` calls, moved
    verbatim (this file carries `// @effect-diagnostics nodeBuiltinImport:off -- the local host is
    the one place thread-scoped node:fs is allowed`).
  - `workspace/WorkspaceFileSystem.ts` `make` (:137): yield `WorkspaceHosts`; drop the `NodeFS`
    and `NodeFSP` imports (:2-3). Sites: `getMetadata` `stat` (:150) and the 512-byte header read
    (:158-170); `isInGitFolder` `lstat` loop (:203-215); target resolution `realpath`
    (:248, :274, :292) and `lstat` (:303); `readFile` open, `stat`, `read` (:363-420); the write
    path's `realpath` (:471, :490), `lstat` (:493), `makeDirectory` (:553) and `writeFile`
    with `O_NOFOLLOW` (:569). `HostProcess.HomeDirectory` (:146, :231) becomes `host.info`
    (home expansion is the thread machine's home).
  - `workspace/WorkspaceEntries.ts` `make` (:156): yield `WorkspaceHosts`; `readdir` (:216,
    :327), `realpath` (:315-316, :344, :351), `stat` (:361), `lstat` (:389, :513) through
    `forPath(normalizedCwd)`; `HostProcess.Platform` (:131) and `HomeDirectory` (:141, :150)
    through `host.info`. `list`, `search` and `searchContents` call `forPath(cwd)` before the
    search index, so a sandbox path fails closed instead of the native index scanning a missing
    local folder. `WorkspaceSearchIndex` itself is unchanged (it becomes `search.*` coarse ops in
    1.10; its `LayerMap` key stays cwd and variant).
  - `workspace/KnownWorkspaces.ts` `make` (:50): yield `WorkspaceHosts`. `resolveRoot` (:60-69)
    realPaths through `forPath(value)`, mapping `WorkspaceHostUnavailableError` to `null` (grants
    nothing). `assertContains` (:139-144) realPaths through `forPath(cwd)`, mapping it to
    `UnknownWorkspaceError { cwd, cause }`. `HostProcess.HomeDirectory` (:77) is the server's
    managed worktree home: `(yield* hosts.local.info).homeDirectory`.
  - `workspace/WorkspacePaths.ts` `statWorkspaceRoot` (:110) and `normalizeWorkspaceRoot` (:133):
    project roots are on the server. Next-line disables `server-scoped: project roots live on the
    server`.
- **Lint disables removed:** `WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, `KnownWorkspaces.ts`.
  `WorkspacePaths.ts` keeps targeted `server-scoped:` ones.

**Types, services and RPCs.**

```ts
// workspaceHost/WorkspaceHost.ts
export type WorkspaceFileKind = "File" | "Directory" | "SymbolicLink" | "Other";

export class WorkspaceHostFileError extends Schema.TaggedError<WorkspaceHostFileError>()(
  "WorkspaceHostFileError",
  {
    operation: Schema.Literals(["realpath", "lstat", "open", "read", "write", "readdir"]),
    // The errno code ("ENOENT", "ENOTDIR", "ELOOP"); callers branch on it today via `cause.code`.
    code: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Workspace file ${this.operation} failed.`;
  }
}

export interface WorkspaceHost {
  // ...
  readonly files: {
    /** Native realpath (`fs.promises.realpath`): Windows `\\?\` and POSIX `link/..` as today. */
    readonly realPath: (path: string) => Effect.Effect<string, WorkspaceHostFileError>;
    readonly lstat: (
      path: string,
    ) => Effect.Effect<{ readonly kind: WorkspaceFileKind }, WorkspaceHostFileError>;
    readonly readDirectory: (
      path: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly kind: WorkspaceFileKind }>,
      WorkspaceHostFileError
    >;
    /** Opens O_RDONLY|O_NONBLOCK (no FIFO hang), checks it is a file, reads at most `maxBytes`. */
    readonly readFile: (
      path: string,
      maxBytes: number,
    ) => Effect.Effect<
      | { readonly kind: "file"; readonly size: number; readonly bytes: Uint8Array }
      | { readonly kind: "not-file" },
      WorkspaceHostFileError
    >;
    /** O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW: a symlink swapped in after the check is not followed. */
    readonly writeNoFollow: (
      path: string,
      bytes: Uint8Array | string,
    ) => Effect.Effect<void, WorkspaceHostFileError>;
  };
}
```

This replaces 02's sketch (`readNoFollow`, `writeNoFollow`, `realPathNative`): the code also
needs `lstat` with errno codes and `readdir` with types, and reads are nonblocking, not
no-follow. `WorkspaceHostFileError.code` keeps every existing `catchIf(cause.code === "ENOENT")`
correct: `WorkspaceFileSystemOperationError`'s `cause` becomes the host error, which still has
`.code`. Every user-visible error tag and message stays as it is.

**Tests.** No new behavior; the existing suites are the proof:
`workspace/WorkspaceFileSystem.test.ts` (`getMetadata`, `readFile`, `writeFile`, including the
symlink-swap, FIFO and `HostProcess.HomeDirectory` override at :266 cases),
`workspace/WorkspaceEntries.test.ts` (`list`, `listIgnoredFiles`, `search`, `searchContents`,
`browse`), `workspace/WorkspacePaths.test.ts`, `assets/AssetAccess.test.ts` and
`review/ReviewService.test.ts` (both build `KnownWorkspaces`). Wiring only: add
`WorkspaceHostTesting.layerFromContext` to those layers. One case is new because no existing case
covers it, in `WorkspaceFileSystem.test.ts` `readFile`: "refuses a path under the sandbox root
without touching local disk" (a `/t3-sandbox/sbx_x/a.txt` read fails with the mapped
`UnknownWorkspaceError` before any `FileSystem` call; the recording host shows zero file ops).

**Verify.** `vp test run apps/server/src/workspace apps/server/src/assets/AssetAccess.test.ts
apps/server/src/review/ReviewService.test.ts`, `vp run typecheck` (server), `vp run check:changed`.

**Reviewer checks.**

- The `files` local implementation is the old code moved, flags and all (`O_NOFOLLOW ?? 0` and
  `O_NONBLOCK ?? 0` on Windows).
- `realPath` stays native, not Effect's `FileSystem.realPath`; containment results do not change.
- Each method resolves the host once per request and uses it for every step (resolve, check,
  open), so a check and its use never land on different machines.
- `KnownWorkspaces` never answers `true` for a path whose host is unavailable.

### 0.5 `refactor(server): route terminal PTYs and the process table through WorkspaceHost`

A terminal session resolves its host from `session.cwd` when it spawns. The PTY, the agent scope
wrap, the cwd check, the shell and env facts, and the `ps` fallback come from that host. History
logs stay on the server. The subprocess poll keys its table by host id, which is one host in M0.

- **Needs:** 0.2. **Unblocks:** 1.10 (`processes.table` coarse op), 1.11.
- **Files and call sites** (`apps/server/src/terminal/Manager.ts` unless named):
  - `TerminalManagerOptions` (:1400): drop `ptyAdapter` (:1401); the PTY comes from the host.
  - `make` (:1474): yield `WorkspaceHosts` in place of `PtyAdapter` (:1476); stop passing
    `ptyAdapter` (:1493).
  - `makeWithOptions` (:1507): yield `WorkspaceHosts`. `fileSystem` (:1510) stays for logs
    (:1622-2107): next-line disable `server-scoped: terminal history logs`.
    `platform`, `architecture` (:1518-1519) and `baseEnv = options.env ?? process.env` (:1522)
    become per-spawn reads of `host.info` (`options.env ?? info.environment`); `agentScope`
    (:1520) becomes `host.agentScope`; `processRunner` (:1524) stays, and the `ps` and
    PowerShell table spawns pass `host` (`posixProcessTableSnapshot` :786,
    `windowsProcessTableSnapshot` :826, via 0.3's `ProcessRunInput.host`).
  - `resolvePosixPsCommand` (:777): `exists` on `host.fileSystem`; cache per host id (today it is
    resolved once at :1545; keep it resolved once for the local host).
  - `fetchProcessTableSnapshot` (:1561-1585): takes the host. Local: today's code (native
    telemetry, `ps` fallback), unchanged. The poll groups sessions by `host.id` and fetches one
    table per host, so M0 still makes one call per tick. The sandbox branch is 1.10's
    `processes.table` coarse op.
  - spawn path (`:2365-2380`): `host.agentScope.wrap`, then `host.pty.spawn` with `cwd:
    session.cwd`. Shell candidates and `createTerminalSpawnEnv` (:2439-2444) use `host.info`
    (`HostProcess.HomeDirectory` :2444 goes).
  - `assertValidCwd` (:2119): `stat` through `forPath(cwd)`; `WorkspaceHostUnavailableError`
    maps to the existing invalid-cwd error, so a sandbox path is refused, never stat'ed locally.
  - `registerTerminalProcesses` (:2696) is unchanged here (port discovery per host is 0.10).
  - `apps/server/src/server.ts` `layerTerminal` (:495-499): drop `Layer.provide(layerPtyAdapter)`;
    `WorkspaceHosts` carries the PTY now. Drop the runtime core's `provideMerge(layerPtyAdapter)`
    (:710) too if typecheck shows nothing else reads `PtyAdapter`.
  - `apps/server/src/project/ProjectSetupScriptRunner.ts`: no change; it follows the manager.
- **Lint disables removed:** `terminal/Manager.ts` (file-level). Kept: the `server-scoped:` one
  for logs; `terminal/NodePtyAdapter.ts` stays `server-scoped:` (it is the local PTY).

**Types, services and RPCs.** No new host field in M0: the poll keeps today's table code for the
local host, so `processes.table` is not needed until a second host exists (1.10). Sessions gain
one in-memory field:

```ts
interface TerminalSessionState {
  // ...
  readonly hostId: WorkspaceHostId; // set at spawn from forPath(session.cwd); the poll groups by it
}
```

**Tests.** `terminal/Manager.test.ts` passes unchanged in its assertions. Wiring: `createManager`
(:252-320) stops passing `ptyAdapter` in options and provides
`Effect.provideService(PtyAdapter.PtyAdapter, ptyAdapter)` plus
`WorkspaceHostTesting.layerFromContext` to `makeWithOptions`; its `FakePtyAdapter` and
`spawnInputs` assertions keep working because the local host's `pty` is that fake. The cases that
pin behavior this PR could break: the shell fallback cases, the `env` option cases, the
`processTable` and `subprocessInspector` cases, restart (`:3002` path) and the agent-scope wrap.
No new case: there is no new behavior on a local host.

**Verify.** `vp test run apps/server/src/terminal/Manager.test.ts
apps/server/src/project/ProjectSetupScriptRunner.test.ts`, `vp run typecheck` (server),
`vp run check:changed`. Runtime: `vp run dev`, open a terminal on a local and a worktree thread,
run `sleep 5` and see the busy indicator clear (the process table still works).

**Reviewer checks.**

- Logs, history and the inactive-session cache stay on the server's `FileSystem`.
- The poll still runs one table query per tick with one host; no per-session query appeared.
- `options.env` (tests) still overrides the base env; otherwise it is the live `process.env`.
- A session's host is resolved at each spawn (open and restart), never cached past the session.

### 0.6 `refactor(server): resolve ACP (Replay), Codex and Claude sessions through WorkspaceHost`

Each of the three adapters resolves its host once, when a provider session opens, from the
session's cwd, and spawns its agent with that host's spawner and agent scope. Replay (dev) is an
ACP agent (`apps/server/scripts/dev-replay-agent.ts` on the `acpRegistry` driver, seeded only
when `config.devUrl` is set, `ProviderInstanceRegistryHydration.ts:84-121`), so the ACP runtime's
session spawn moves; its client files and terminals do not. One PR, three commits in this order:
ACP, Codex, Claude.

- **Needs:** 0.2. **Unblocks:** 1.12 (sandbox sessions; Replay first), 1.13.
- **Files and call sites:**
  - ACP (`packages/provider-acp` cannot import `apps/server`, so it reaches the host through
    `ProviderHost`, the existing port packages use for server facilities):
    - `packages/provider-core/src/server/ProviderHost.ts`: add optional `sessionProcesses` (below).
      Optional, like `resolveExtractedTextPath`, so every package test's `ProviderHost` fake keeps
      compiling and keeps today's behavior (absent = the adapter's own spawner and scope).
    - `packages/provider-core/src/server/errors.ts`: add `ProviderSessionHostUnavailableError`.
    - `apps/server/src/provider/ProviderHostLive.ts`: implement it with `WorkspaceHosts.forPath`.
    - `packages/provider-acp/src/server/adapter.ts` `makeAcpAdapterV2` (:1697): keep the captured
      `childProcessSpawner` (:1701) and `agentScope` (:1702) as the fallback. In the session open,
      resolve once from `input.runtimePolicy.cwd ?? process.cwd()` (the value already used at
      :1811 and :2382). `spawnAcpRuntime` (:6879-6880) and the replacement runtime (:6960-6961)
      provide the session's `spawner` and `agentScope` in place of the captured ones: the
      one-identifier swap. Client terminals (:1832) and `rewriteUserText` (:7907) keep the
      captured spawner (client terminals are M3).
    - The cgroup lease (`AcpSessionRuntime.ts:1381-1400`, `makeLinuxCgroupController` :441)
      only runs when a flavor sets `ownDescendantProcessGroups` and `processGroupPlatform:
      "linux"`, which only Grok does (`provider-grok/src/server/acpSupport.ts:91`). Replay's
      `acpRegistry` flavor never takes a lease, so its containment is already just `agentScope`,
      which now comes from the host. The lease stays as is for Grok and moves in M3, when a
      sandbox host passes `linuxCgroupController: null`. Say this in the PR body.
  - Codex (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`):
    `layerAppServerClientFactory` (:1577) requires `WorkspaceHosts` in place of
    `ChildProcessSpawner`; drop `spawner` (:1586) and `agentScope` (:1588) captures. In `open`
    (:1592): `host = runtimePolicy.cwd === undefined ? hosts.local : yield* forPath(cwd)`
    (`WorkspaceHostUnavailableError` maps to `ProviderAdapterOpenSessionError { cause }`);
    `makeCodexAppServerSpawnCommand(...).pipe(Effect.provideService(AgentScope, host.agentScope))`
    and `host.spawner.spawn(command)`. The shadow `CODEX_HOME` (`materializeCodexShadowHome`,
    :1665) stays at instance creation on the server; a sandbox needs a home per session (1.12).
  - Claude (`Adapters/ClaudeAdapterV2.ts`):
    - `spawnClaudeProcessGroup` (:369-394), with the watch script (:355-362) and its
      `signalProcessGroup` (:390), moves verbatim into `LocalWorkspaceHost.spawnProcessGroup`,
      together with the Windows branch of the default spawn (:1240-1253).
    - `layerQueryRunner` (:1148): requires `WorkspaceHosts` in place of `ChildProcessSpawner`
      (:1160); drop the `agentScope` (:1163) and `platform` (:1164) captures. In `open`, resolve
      `host` from `input.options.cwd` (local when absent). `agentScope.wrap` and `agentScope.stop`
      (:1209-1225) use `host.agentScope`; the default `spawnProcess` (:1232-1254) becomes
      `options.spawnClaudeCodeProcess ?? ((o) => host.spawnProcessGroup(o, hooks))`. The SDK
      override stays, so tests and M1's bridge both plug in there.
    - fork history worker (`runClaudeWorker` :1097, provided at :1592): spawn with
      `forPath(input.options.dir)`'s spawner. The in-process SDK calls (`forkSession`,
      `getSessionMessages`, `getSubagentMessages`, `resolveSettings`) stay in process for the
      local host; 1.12 sends them to the worker on a sandbox host.
    - settings and skill reads keyed by cwd (`readDirectory` :4797, settings files :4879-4960,
      `userInvocableSkills` :5013): `forPath(cwd)`'s `fileSystem`.
    - attachment text extraction (`spawner` :4852, provided at :11114 and :11563): next-line
      disable `server-scoped: attachments and their extracted text live on the server`.
  - `apps/server/src/provider/ProviderOrchestrationAdapterInfrastructure.ts` (:21-22): no change;
    `WorkspaceHosts` reaches both layers from the root.
- **Not in this PR (PR-list change):** `exposeServerEndpoint`. On the local host it returns its
  input, so 0.6 would add identity calls at the MCP URL (`CodexAdapterV2.ts:1413`,
  `mcpSession.endpoint`), the Codex managed `auth.command` socket
  (`CodexManagedRuntime.ts:87-93`) and the ACP MCP bridge. 1.13 adds it where forwards make it
  real. Same for `processes.signalGroup`: Claude's group signal moves inside
  `spawnProcessGroup`, ACP's only runs for Grok, so the first caller is 0.10 (`PortScanner.ts:1049`).
- **Lint disables removed:** `packages/provider-acp/src/server/adapter.ts` loses its
  `not routed yet (0.6)` for the session spawn, keeping `routed in M3:` for client fs and
  terminals. `ClaudeAdapterV2.ts` and `CodexAdapterV2.ts` keep file-level disables with new
  reasons (`not routed yet (0.7)` for base env, `not routed yet (0.9)` for remaining host facts,
  `routed in M1 (1.12):` for in-process history), each now naming fewer lines.

**Types, services and RPCs.**

```ts
// packages/provider-core/src/server/ProviderHost.ts
export interface ProviderSessionProcesses {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly agentScope: AgentScopeShape;
}
// in ProviderHost's interface:
/** The thread machine's spawner and agent scope for a session cwd. Absent: the adapter's own. */
readonly sessionProcesses?: (cwd: string) => Effect.Effect<ProviderSessionProcesses, ProviderSessionHostUnavailableError>;

// packages/provider-core/src/server/errors.ts
export class ProviderSessionHostUnavailableError extends Schema.TaggedError<ProviderSessionHostUnavailableError>()(
  "ProviderSessionHostUnavailableError",
  { sandboxId: Schema.String },
) {
  override get message() { return "This thread's machine is not connected."; }
}

// apps/server/src/workspaceHost/WorkspaceHost.ts
/** The members the Claude Agent SDK's `spawnClaudeCodeProcess` hook reads, plus stderr and pid. */
export interface ProcessGroupProcess { /* stdin, stdout, stderr, pid, killed, exitCode, signalCode, kill, on, once, off */ }
export interface WorkspaceHost {
  // ...
  /** Spawns detached with a watcher that kills the whole group when the server's pipe closes. */
  readonly spawnProcessGroup: (
    input: { readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd?: string;
             readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal },
    hooks: { readonly onExit?: () => void; readonly onStderr: (text: string) => void; readonly onStderrClose: () => void },
  ) => ProcessGroupProcess; // synchronous: the SDK hook is synchronous
}
```

`spawnProcessGroup` is the one host method that is not an `Effect`, because the SDK calls it
synchronously. The local host reads `HostProcess.Platform` once at construction for its Windows
branch (the server's own platform; correct for the local host by definition).

**Tests.** Assertions unchanged; wiring only:
`Adapters/ClaudeAdapterV2.test.ts` (`layerQueryRunner` at :2708, `makeFakeClaudeCli` at :2630),
`Adapters/ClaudeAgentSdkQueryRunner.test.ts` (:73, :205, :663; its SDK-hook cases pass plain
objects, :340-352), `Adapters/CodexAdapterV2.test.ts` (`factoryLayer` :899) add
`WorkspaceHostTesting.layerFromContext` beside their fake spawner. The process-group cases that
pin the moved code (stderr drained before exit, group kill on exit) must pass byte for byte;
`spawnClaudeProcessGroup`'s direct test (`ClaudeAgentSdkQueryRunner.test.ts:631`, imported at :34)
imports the moved function from `workspaceHost/LocalWorkspaceHost.ts` (exported there as
`spawnProcessGroup`) with its assertions unchanged. ACP: `packages/provider-acp` and `provider-acp-registry` tests pass untouched (their
`ProviderHost` fakes omit `sessionProcesses`). One new case, in `ProviderHostLive`'s test file if
one exists or `WorkspaceHosts.test.ts` otherwise: `sessionProcesses` for a `/t3-sandbox/...` cwd
fails with `ProviderSessionHostUnavailableError` (the only new branch).

**Verify.** `vp test run apps/server/src/orchestration-v2/Adapters packages/provider-acp
packages/provider-acp-registry`, `vp run typecheck` (server, provider-core, provider-acp),
`vp run check:changed`. Runtime: `vp run dev`, one Replay (dev) turn and one Haiku Claude turn on
a local thread; attach the transcript. Metrics comparison before and after (M0 integrated pass).

**Reviewer checks.**

- The host is resolved once per session open and held by the session, never per message.
- `spawnClaudeProcessGroup`'s body moved without edits (diff it); the SDK override still wins.
- Codex's AgentScope for the spawn command is the host's; no other `AgentScope` capture remains in
  the factory.
- No `ProviderHost` fake had to change; ACP behavior with the field absent is today's.
- Codex app-servers are reused per instance; note in the PR that 1.12 must key reuse by host.

### 0.7 `refactor(server): take provider base environment from the workspace host`

Every thread-scoped process gets its base environment from a named host, never from an implicit
`process.env`. The three env helpers lose their `process.env` default, so a forgotten base is a
type error instead of a leak (06 §3, "the one seam change credentials need from M0"). The small
thread-scoped reads 02 PR 7 lists move too. `LocalWorkspaceHost` passes the server's environment
through unchanged (06 §11 M0).

- **Needs:** 0.2; 0.3 (the host is already resolved in `VcsProcess.spawn`), 0.6 (sessions hold a
  host). **Unblocks:** 1.12, 1.24-1.26 (allowlisted sandbox env).
- **Files and call sites:**
  - `apps/server/src/vcs/VcsProcess.ts:214`: `explicitBareRepositoryEnv({ ...process.env,
    ...input.env }, ...)` reads `(yield* host.info).environment`. Same object locally.
  - `packages/provider-core/src/server/instanceEnvironment.ts` `mergeProviderInstanceEnvironment`
    (:7-10): `baseEnv` becomes required. `HostProcess.HomeDirectory`/`Platform` (:15-16) stay:
    they expand `CODEX_HOME`/`CLAUDE_CONFIG_DIR` for the machine the base came from, which is the
    server for every M0 caller; 1.12 passes the host's facts with the host's base.
  - `apps/server/src/provider/Drivers/ClaudeHome.ts` `makeClaudeEnvironment` (:33-37): `baseEnv`
    required.
  - `apps/server/src/provider/codexLaunchArgs.ts` `resolveCodexLaunchArgs` (:5-8): `environment`
    required.
  - Callers that run on the server (probes, installs, usage, imports) pass
    `yield* HostProcess.Environment`, which is what the default read: `CodexProvider.ts:780`,
    `providerInstallation.ts:144`, `Drivers/{AntigravityDriver:130, ClaudeDriver:114 (today
    passes process.env), CodexDriver:157/294/326, CodexManagedProvider:48}`, `ClaudeProvider.ts:360,
    459`, `usage/UsageService.ts:318`, `project/AgentSessionScanner.ts:1425`, and the package
    drivers `provider-{grok,fx,acp-registry,muse,cursor}/src/server/driver.ts`, `provider-muse/
    src/server/usage.ts:128`. Each keeps or gains a `server-scoped:` reason.
  - Callers that build a thread process's env pass the session host's base:
    `terminal/Manager.ts:1449, :1462` (already `input.env`; unchanged), `Adapters/CodexAdapterV2.ts`
    (`hostEnvironment` :1660 and the merge at :1687; `resolveCodexLaunchArgs` at :1601 gets
    `input.environment`), `Adapters/ClaudeAdapterV2.ts` (`hostEnvironment` :1166 for the SDK's
    default env, :4872, and driver create :12287-12297). The instance environment of Codex and
    Claude is built once per instance today; for M0 it is built from `hosts.local.info` with the
    comment "instance env is the local host's; 1.12 rebuilds it per session on a sandbox host".
    Rebuilding per session now would add a settings read to every open, a performance change.
  - `provider-{grok,fx,acp-registry}/src/server/adapter.ts` (:388, :230, :338) pass their
    captured `hostEnvironment` as today; they keep `routed in M3:` reasons.
  - `orchestration-v2/ProviderSessionManager.ts:2128`: the session-open `stat(cwd)` goes through
    `forPath(cwd)`; `WorkspaceHostUnavailableError` maps to the existing missing-workspace error.
  - `orchestration-v2/Adapters/ClaudeTaskOutputTail.ts` (:42-87): takes the session's
    `WorkspaceHost` (the Claude session holds it from 0.6) and uses `host.fileSystem` and
    `host.info` (temp root from its environment, :25-33). The 250 ms poll is unchanged; 1.12
    replaces it with `fileSystem.watch` on sandbox hosts.
  - `orchestration-v2/workflowFileRead.ts:39`: home from the session host's `info`.
  - `textGeneration/ClaudeTextGeneration.ts` (`commandSpawner` :89, investigate `cwd` :195-236)
    and `textGeneration/CodexTextGeneration.ts` (`environment ?? process.env` :65, `stat` :146,
    home :266): investigate mode resolves `forPath(cwd)` and spawns with its spawner and base;
    titles stay on the server (`hosts.local`).
  - `provider/userInputAttachments.ts:26`: attachments live on the server. `server-scoped:` reason;
    staging into a sandbox is 1.12 (07 §10 #8).
- **Lint disables removed:** `provider/Drivers/ClaudeHome.ts`, `provider/codexLaunchArgs.ts`,
  `packages/provider-core/src/server/instanceEnvironment.ts`, `ProviderSessionManager.ts`,
  `ClaudeTaskOutputTail.ts`, `workflowFileRead.ts`, both text generation files, and the
  `VcsProcess.ts:214` next-line disable. `ClaudeAdapterV2.ts`/`CodexAdapterV2.ts` drop their
  `(0.7)` lines.

**Types, services and RPCs.** Signatures only change from optional to required:

```ts
export const mergeProviderInstanceEnvironment: (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv, // was `= process.env`
) => Effect.Effect<NodeJS.ProcessEnv>;
export const makeClaudeEnvironment: (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv, // was optional, `?? process.env`
) => Effect.Effect<NodeJS.ProcessEnv, never, Path.Path>;
export const resolveCodexLaunchArgs: (launchArgs: string | undefined, environment: NodeJS.ProcessEnv) => string;
```

The spawner side of "the host owns the base": `LocalWorkspaceHost.spawner` is the context's
`NodeChildProcessSpawner`, whose `extendEnv` extends `process.env`, the same object as
`info.environment`. Nothing changes locally. 1.11's sandbox spawner must extend
`info.environment`, never the server's; that test lives in 1.11.

**Tests.** Assertions unchanged. `provider-core/src/server/instanceEnvironment.test.ts`,
`provider/Drivers/ClaudeHome.test.ts` and `provider/ProviderRegistry.test.ts` pass `process.env`
(or their fixture env) where they relied on the default. Then `orchestration-v2/
ProviderSessionManager.test.ts`, `Adapters/ClaudeTaskOutputTail.test.ts` (if present; otherwise
the Claude adapter cases that drive background tasks), `textGeneration/*TextGeneration.test.ts`,
`vcs/VcsProcess.test.ts` ("keeps git from opening a folder laid out as a bare repository", :375,
pins the `:214` env). No new case: no new behavior.

**Verify.** `vp test run packages/provider-core apps/server/src/provider
apps/server/src/textGeneration apps/server/src/orchestration-v2/ProviderSessionManager.test.ts
apps/server/src/vcs/VcsProcess.test.ts`, `vp run typecheck` (server, provider-core and the
provider packages), `vp run check:changed`. Runtime: one Replay turn and one terminal on
`vp run dev`; `env | grep T3CODE` in the terminal shows the same variables as on `main`.

**Reviewer checks.**

- No env helper has a `process.env` default left; `grep -n "= process.env" ` over the three files
  is empty.
- Every caller's base is either `HostProcess.Environment` with a `server-scoped:` reason or a
  host's `info.environment`; none mixes the two.
- Codex and Claude instance envs are byte-identical to `main` (same keys, same order of merge).
- The `stat` at session open fails closed for a sandbox path, with the existing user-visible error.

### 0.8 `refactor(server): route restore, rollback, PR discovery and cleanup disk checks through WorkspaceHost`

The direct local-disk checks on a thread's paths (07 §10 #1, wider than its row): restore safety
(both at rollback and at command admission in the orchestrator), the rollback's missing-worktree
check, PR discovery's `.git` check, and the storage cleanup functions that look at a thread's
worktree. VCS detection checks and `GitManager` canonicalization are 0.3's; `KnownWorkspaces` is
0.4's.

- **Needs:** 0.2; 0.3 (`removeLinkedWorktree` takes a host). **Unblocks:** M1 rows that compare
  sandboxes in restore safety and rollback (07 §10 #5, 1.32 onward), 2.x discovery that never
  wakes.
- **Files and call sites** (`apps/server/src/`):
  - `orchestration-v2/CheckpointRestoreSafety.ts` `isCheckpointRestoreIsolated` (:13):
    `dependencies.fileSystem` becomes `dependencies.hosts: WorkspaceHosts["Service"]`. `resolve`
    (:35-41) and the other-thread loop (:89-94) realPath through `forPath(candidate)`.
    `WorkspaceHostUnavailableError` falls back exactly as `NotFound` does at each site: the
    thread's own target keeps its lexical `path.resolve(target)`; another thread's path keeps its
    lexical form too (not `null`), so the containment test stays conservative. A path under
    another sandbox's root never contains a local cwd lexically, so M0 results are unchanged.
  - `orchestration-v2/Orchestrator.ts`: admission check at :12704-12708 passes `hosts`; the
    `fileSystem` capture at :1122 becomes `yield* WorkspaceHosts.WorkspaceHosts` if :12707 was
    its only use (it is the only `fileSystem` reference after :1122). This is a mechanical
    dependency swap in an upstream file: the orchestrator keeps doing this one read at admission,
    as today; moving it out of the decide path is not M0's job.
  - `orchestration-v2/CheckpointRollbackService.ts`: `exists(worktreePath)` (:223) through
    `forPath(worktreePath)`; an unavailable host is "exists" (do not recreate a sandbox
    checkout on the server's disk; 07 §2). The `isCheckpointRestoreIsolated` call (:239-240)
    passes `hosts`. The `fileSystem` capture (:133) goes.
  - `orchestration-v2/ThreadPullRequestService.ts` discovery (:184-190): `exists(<worktree>/.git)`
    through `forPath(worktreePath)`. Unavailable maps to `true` (keep the worktree as cwd), like
    the existing `orElseSucceed(() => true)`; never silently fall back to the project root for a
    sandbox path. Capture at :104 goes.
  - `storageCleanup.ts`: functions that take a thread's worktree or cwd route per path:
    `measureWorktree` (:376-409), `branchChanged` (:582-619), `submoduleRemoval` (:671-777) and
    the per-thread part of `cleanWorktrees` (:906-928) plus its `removeLinkedWorktree` call
    (:1193, now `host: yield* hosts.forPath(worktreePath)`). Functions that walk the server's
    managed worktree root or its files stay local with a `server-scoped:` reason:
    `reportOrphanWorktrees` (:459-567), the managed-directory loop in `cleanWorktrees`
    (:815-826), `sharedPnpmVirtualStore` (:351-370), `cleanFiles` (:1232-1241). `isWindows`
    (:319) and `HostProcess.HomeDirectory` (:822) are server facts for those walks:
    `hosts.local.info`. A worktree whose host is unavailable is skipped, never removed.
- **Lint disables removed:** `CheckpointRollbackService.ts`, `ThreadPullRequestService.ts`,
  `Orchestrator.ts` (file-level `not routed yet (0.8)`). `storageCleanup.ts` keeps targeted
  `server-scoped:` lines only. `CheckpointRestoreSafety.ts` never had one (it takes `fileSystem`
  as a parameter); its signature change is the routing.

**Types, services and RPCs.**

```ts
export const isCheckpointRestoreIsolated: (
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
  scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
  dependencies: {
    readonly hosts: WorkspaceHosts["Service"]; // was: fileSystem: FileSystem.FileSystem
    readonly projections: ProjectionStoreV2["Service"];
    readonly projects: ProjectStore.ProjectStoreV2["Service"];
    readonly path: Path.Path;
  },
) => Effect.Effect<boolean, ...>; // error channel unchanged
```

**Tests.** Assertions unchanged; wiring passes `hosts` from
`WorkspaceHostTesting.layerFromContext`:
`orchestration-v2/CheckpointRestoreSafety.test.ts`,
`orchestration-v2/CheckpointRollbackService.test.ts` ("lets rollback recreate a worktree storage
cleanup removed", :185, pins the `exists` path), `orchestration-v2/ThreadPullRequestService.test.ts`
("ThreadPullRequestServiceV2 reads"), `storageCleanup.test.ts` (the `it.live` submodule cases,
:628-763, pin `submoduleRemoval`), and the orchestrator admission cases for `checkpoint.restore`
in the orchestrator's existing test files (they reach `:12704` through the runtime test kit, which
gained the hosts layer in 0.3). One new case, because no existing case covers it, in
`CheckpointRestoreSafety.test.ts`: another thread whose worktree is `/t3-sandbox/sbx_x/w` does
not make a local restore shared, and resolving it touches no local disk (recording host: zero ops
for that path).

**Verify.** `vp test run apps/server/src/orchestration-v2/CheckpointRestoreSafety.test.ts
apps/server/src/orchestration-v2/CheckpointRollbackService.test.ts
apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts
apps/server/src/storageCleanup.test.ts`, then the orchestrator test files that dispatch
`checkpoint.restore`, `vp run typecheck` (server), `vp run check:changed`. Runtime: restore a
checkpoint on a worktree thread with `vp run dev`.

**Reviewer checks.**

- Every unavailable-host fallback errs toward "shared" or "keep", never toward deleting or
  restoring on the server's disk.
- The orchestrator edit is a dependency swap at :1122 and :12707 only.
- `storageCleanup` never resolves a managed-root walk through `forPath` (those are the server's
  folders) and never removes a worktree it could not stat.
- No user-visible message changed (`SHARED_WORKSPACE_RESTORE_MESSAGE` and friends).

### 0.9 `refactor(server): read host facts from host.info in thread-scoped code`

After 0.3–0.8 route their folders, a tail of `HostProcess` reads in thread-scoped code remains,
plus `resolveSpawnCommand`, which every spawn calls and which keys `git`/shell resolution on the
server's platform and environment. This PR moves the thread-scoped tail to `host.info`, marks
every remaining read in the rule's scope `server-scoped:` with a reason, and deletes the last
`not routed yet (0.9)` disables. It is last because it touches files the other rows edit.

- **Needs:** 0.3–0.8 (and 0.10 if it has landed; otherwise 0.10 keeps its own disable).
  **Unblocks:** M1's sandbox host on a macOS team server (no macOS `git` resolution, `F_FULLFSYNC`
  retries or `/tmp` defaults applied to a Linux sandbox; 02 §2).
- **Counts.** Over the rule's scope plus `provider/` and `preview/`, `HostProcess.{Platform,
  HomeDirectory,Environment,isWindows,Architecture,UserId}` appears 140 times today (a grep; 02
  says about 140). 0.3–0.8 route most thread reads; most of the rest are server facts
  (installations, probes, usage, the server browser, `NodePtyAdapter`).
- **Files and call sites:**
  - `packages/shared/src/shell.ts` `resolveSpawnCommand` (:830): optional
    `facts?: { readonly platform: NodeJS.Platform; readonly environment: NodeJS.ProcessEnv }`;
    absent means today's per-call `HostProcess.Platform` (:835) and `Environment` (:841) reads.
    Thread callers pass their host's facts: `processRunner.ts` `runProcessCore` (:275) when
    `input.host` is set; `vcs/GitVcsDriverCore.ts` `executeRaw` (:987);
    `Adapters/CodexAdapterV2.ts` `makeCodexAppServerSpawnCommand` (:1488) with the session host's
    facts.
  - `Adapters/ClaudeAdapterV2.ts`: `hostPlatform` (:4873) and `localSettingsDirectory`
    (:4970-4985, platform and home for the session cwd) read the session host's `info`; the
    transcript scan's home (:11669) reads the session host's `info`. `binaryPath` expansion at
    driver create (:12301) is the server's install: `server-scoped:`.
  - `Adapters/CodexAdapterV2.ts` `binaryPath` expansion at instance create (:1680):
    `server-scoped:` (the image's CLI is 05's).
  - `provider/Drivers/ClaudeSkills.ts` (:247, :322, :423, :455): the cwd-relative skill lookups
    take `{ platform, homeDirectory }` from their caller (`userInvocableSkills` in the Claude
    adapter, which has the session host); the server-wide skill listing keeps `HostProcess`
    (`server-scoped:`).
  - `packages/provider-acp/src/server/AcpSessionRuntime.ts` (:1275 home, :1620 platform):
    unchanged; `routed in M3:` (ACP flavors other than Replay; Replay reads no host facts there).
  - Every other in-scope read gets a one-line `server-scoped:` reason, then the file-level
    `not routed yet (0.9)` disables go.
- **Lint disables removed:** every remaining `not routed yet (0.9)`. After this PR, the only
  file-level disables of `t3code/workspace-host-boundary` say `server-scoped:`,
  `not supported in cloud:`, `routed in M3:` or `routed in M1 (1.x):`.

**Types, services and RPCs.**

```ts
// packages/shared/src/shell.ts
export const resolveSpawnCommand: (
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly extendEnv?: boolean;
    /** The machine the command runs on. Absent: this server's HostProcess references. */
    readonly facts?: { readonly platform: NodeJS.Platform; readonly environment: NodeJS.ProcessEnv };
  },
) => Effect.Effect<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly shell: boolean }>;
```

`facts` is structural so `packages/shared` does not import the server's `WorkspaceHost`.
Resolution stays where it is in M0; whether the sandbox host resolves commands in the runner
instead (02 §1) is 1.11's call, and this option is what lets it pass the sandbox's facts if not.

**Tests.** No new behavior. `packages/shared` shell tests for `resolveSpawnCommand` gain one row
in their existing table: with `facts: { platform: "linux", ... }` on a `win32` reference, the
Linux resolution applies (the only new branch). Everything else: the suites 0.3–0.8 named, plus
`Adapters/ClaudeAdapterV2.test.ts` cases for local settings and skills, pass unchanged.

**Verify.** `vp test run packages/shared apps/server/src/orchestration-v2/Adapters
apps/server/src/provider`, `vp run typecheck` (shared, server), `vp run check:changed`. Then grep
the rule's disables and attach the list of remaining reasons to the PR.

**Reviewer checks.**

- Each remaining `HostProcess` read in scope has a `server-scoped:` reason that is true: the value
  describes the server's own install, cache or UI, not a thread's machine.
- `resolveSpawnCommand` without `facts` is byte-identical to `main`.
- No thread-scoped call site passes `hosts.local.info` where it has a session or cwd host.

### 0.10 `refactor(server): run port discovery per workspace host`

Port discovery takes every machine access from one host value: the `lsof` and PowerShell probes
run through its spawner, the `/proc` reads through its `fileSystem`, the platform from its `info`,
and the group stop through a new `host.processes.signalGroup`. In M0 that host is
`hosts.local`, built once. The per-host `LayerMap` waits for a second host. May slip to M1.

- **Needs:** 0.2; 0.3 (`ProcessRunInput.host`). **Unblocks:** 1.10 (`ports.listeners` coarse op),
  2.10–2.11 (previews).
- **PR-list change:** 02 PR 8 puts `PortDiscovery` behind a `LayerMap` keyed by host id now.
  With one host, every caller (`terminal/Manager.ts`, the Claude and Codex adapters, `ws.ts`,
  `ProviderInstanceRegistryHydration.ts`) would go through a map with one entry. This PR makes the
  scanner host-parameterized; 1.10 adds the map with `ports.listeners`, when a sandbox host exists
  and callers start passing a host id. Nothing here blocks that.
- **Files and call sites** (`apps/server/src/preview/PortScanner.ts` unless named):
  - `make` (:454): yield `WorkspaceHosts`; `const host = hosts.local`. `processRunner` (:455)
    stays and passes `host` on the `lsof` (:833-858) and Windows listener runs
    (`process/windowsTcpListeners.ts` is called from here; it takes the runner input as today).
    `fileSystem` (:456) becomes `host.fileSystem` for `/proc/<pid>/environ` (:497), `/proc`
    walks (:547-568) and `/proc/net/tcp{,6}` (:581). `hostPlatform` (:457) becomes
    `(yield* host.info).platform` at scan time.
  - `PORT_DISCOVERY_ENV` read (:458) is a server knob: `server-scoped:` reason.
  - `stopServer`'s `signalGroup` (:1046-1055): `host.processes.signalGroup(group, signal)` in
    place of `signalProcessGroup` from `provider-core/server/processGroup.ts`.
  - `workspaceHost/WorkspaceHost.ts`: add `processes.signalGroup` and `WorkspaceHostError`;
    `LocalWorkspaceHost.ts` implements it with `signalProcessGroup` (same `try`).
  - `layerTest` (:1091) unchanged.
- **Lint disables removed:** `preview/PortScanner.ts` (file-level `not routed yet (0.10)`).

**Types, services and RPCs.**

```ts
// workspaceHost/WorkspaceHost.ts
export interface WorkspaceHost {
  // ...
  readonly processes: {
    /** kill(-pid, signal): the whole group, on the machine that owns the pid. */
    readonly signalGroup: (pid: number, signal: NodeJS.Signals | 0) => Effect.Effect<void, WorkspaceHostError>;
  };
}
// LocalWorkspaceHost
signalGroup: (pid, signal) =>
  Effect.try({ try: () => signalProcessGroup(pid, signal),
               catch: (cause) => new WorkspaceHostError({ hostId: "local", operation: "processes.signalGroup", cause }) }),
```

`stopServer` maps `WorkspaceHostError` to the existing `PreviewStopLocalServerError { reason:
"signal-failed", cause }` (:1046-1055), so its user-visible error is unchanged.

**Tests.** `preview/PortScanner.test.ts` passes unchanged in its assertions. Wiring: its
`layerNoProc` (`FileSystem.layerNoop({})`, :45) and fake `ProcessRunner` (:48-56) stay; add
`WorkspaceHostTesting.layerFromContext`, which builds the local host from the noop file system and
a stub spawner (the scanner never spawns directly; it goes through the fake runner). The stop
cases (group signal, "signal-failed") pin `signalGroup`.

**Verify.** `vp test run apps/server/src/preview/PortScanner.test.ts`, `vp run typecheck`
(server), `vp run check:changed`. Runtime: `vp run dev`, start `python3 -m http.server` in a
thread terminal, see it listed, stop it from the preview list.

**Reviewer checks.**

- The 3-second poll, the retain gate and the web-probe cache are untouched.
- Only `stopServer` signals, and only through `host.processes.signalGroup`.
- `lsof`-missing memoization (`lsofMissingRef`) still works through the runner error path.

### 0.11 `refactor(contracts): split OrchestrationV2RunWorkspacePreparation from the launch strategy`

Runs and `defer_start` get their own schema name with today's three members, so 1.16 can add
`cloud` to the launch inputs without ever putting it in a persisted run that old clients decode
strictly (08 §2, README decision 7). No new literal; encoding, the MCP JSON schema and client
imports do not change. A frozen copy of today's union in the contract tests keeps it that way.

- **Needs:** none. **Unblocks:** 1.16 (cloud launch), 1.2/1.36 contract rows that reference it.
- **Files:**
  - change `packages/contracts/src/orchestrationV2.ts`: the schema edits below.
  - change `packages/contracts/src/orchestrationV2.test.ts`: the frozen-union case.
  - no change: `scheduledTask.ts:235, :274`, `apps/server/src/mcp/toolkits/project/tools.ts:142`,
    `apps/server/src/mcp/OrchestratorMcpService.ts:2440`,
    `apps/web/src/components/settings/ScheduledTasksSettings.tsx:1341` keep the launch name (they
    are inputs). `ThreadLaunchService.ts`'s hand-written `ThreadLaunchWorkspaceStrategy` (:58),
    used for both the launch (:91) and the retry rebuild from a run (:1144), stays; 1.16 splits
    it the same way when the launch union widens.

**Types, services and RPCs.** In `orchestrationV2.ts`, today's union at :670-686 becomes:

```ts
const OrchestrationV2RootWorkspace = Schema.Struct({
  type: Schema.Literal("root"),
  branch: Schema.optional(TrimmedNonEmptyString),
});
const OrchestrationV2ExistingWorktreeWorkspace = Schema.Struct({
  type: Schema.Literal("existing_worktree"),
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});
const OrchestrationV2WorktreeWorkspace = Schema.Struct({
  type: Schema.Literal("worktree"),
  baseRef: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

/** What a run prepared. Persisted in every run, so old clients decode it strictly: never widen. */
export const OrchestrationV2RunWorkspacePreparation = Schema.Union([
  OrchestrationV2RootWorkspace,
  OrchestrationV2ExistingWorktreeWorkspace,
  OrchestrationV2WorktreeWorkspace,
]);
export type OrchestrationV2RunWorkspacePreparation =
  typeof OrchestrationV2RunWorkspacePreparation.Type;

/** How a launch asks for its workspace. M1 adds `cloud` here only. */
export const OrchestrationV2ThreadLaunchWorkspaceStrategy = OrchestrationV2RunWorkspacePreparation;
export type OrchestrationV2ThreadLaunchWorkspaceStrategy =
  typeof OrchestrationV2ThreadLaunchWorkspaceStrategy.Type;
```

and two references switch to the run name:

- `OrchestrationV2Run.workspacePreparation` (:723): `Schema.optional(OrchestrationV2RunWorkspacePreparation)`.
- `message.dispatch` `dispatchMode` `defer_start.workspaceStrategy` (:3326):
  `Schema.optional(OrchestrationV2RunWorkspacePreparation)`. The orchestrator copies it into the
  run as is, and delegation feeds it directly, so it is run-side.

`delegated_task.request` (:3488), the launch input (:3803) and `ScheduledTask`/
`ScheduledTaskUpsertInput` keep `OrchestrationV2ThreadLaunchWorkspaceStrategy`. In M0 the two
names are the same schema object, so nothing can change on the wire; the alias exists so 1.16's
edit is one line and every place that copies a launch into a run then fails to typecheck until it
decides what a cloud run records (`{ type: "worktree", baseRef, branch }`, 08 §2).
`orchestrationV2WorktreePending` (:738-750) keeps reading `workspacePreparation?.type`.

**Tests.** Extend `packages/contracts/src/orchestrationV2.test.ts`, describe "orchestration V2
contracts" (:40), following `auth.test.ts:26-48` (a frozen copy of the old vocabulary, decoded
against everything the new schema can produce):

```ts
// Keep the run vocabulary old clients decode frozen; a cloud launch must still record one of these.
const oldRunWorkspacePreparation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root"), branch: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: Schema.String,
    branch: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.String,
    branch: Schema.optional(Schema.String),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);
// A sample per member: adding a member is a type error here until it has one, and then it must decode below.
const runPreparationSamples: {
  readonly [
    K in OrchestrationV2RunWorkspacePreparation["type"]
  ]: OrchestrationV2RunWorkspacePreparation;
} = {
  root: { type: "root", branch: "main" },
  existing_worktree: { type: "existing_worktree", worktreePath: "/w", branch: "b" },
  worktree: { type: "worktree", baseRef: "main", branch: "b", startFromOrigin: true },
};
it.each(Object.values(runPreparationSamples))(
  "keeps run preparation %o decodable by old clients",
  (sample) => {
    const encoded = Schema.encodeSync(OrchestrationV2RunWorkspacePreparation)(sample);
    expect(Schema.decodeUnknownSync(oldRunWorkspacePreparation)(encoded)).toEqual(sample);
  },
);
```

The case passes on `main`'s union too (run it there first). 1.16 adds the M1 half: a cloud
launch's run decodes with `oldRunWorkspacePreparation`.

**Verify.** `vp test run packages/contracts/src/orchestrationV2.test.ts`, `vp run typecheck`
(contracts and dependents: server, web, mobile, client-runtime), `vp run check:changed` (knip:
the new export has an importer in the test; the three member structs are module-private).
`vp run test:perf:v2-wire` is unaffected (nothing on the wire changes).

**Reviewer checks.**

- No literal was added; the encoded form of every run and `defer_start` is byte-identical.
- Only the run field and `defer_start` use the run name; every input keeps the launch name.
- The frozen union in the test is written out, not derived from the live schema.

## M0 integrated pass

M0 is done when 0.1–0.11 have merged (0.10 may slip into 1.10), every routing PR's existing
suites passed unchanged in their assertions, and the two checks below are attached to the
tracking item. No captures: nothing is visible.

### Metrics comparison (attached to 0.3 and 0.6)

Replay (dev) edits no files and runs no git itself, but every Replay turn still runs the server's
git work around it: the turn-start baseline check, checkpoint capture, the files-changed summary
and run finalization's local status (02 §5). So it exercises exactly what 0.3 and 0.6 touch, for
free.

1. Start a local OTLP receiver as in [observability](../../../operations/observability.md)
   (Grafana LGTM), and export `T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics` in the
   shell that runs the dev server. Do not set `VITE_HTTP_URL` or `VITE_WS_URL`.
2. In the PR's worktree, check out the PR's merge base. `vp run dev` (seeded from real data as
   AGENTS.md describes). On one local thread and one worktree thread of the same project, run ten
   Replay turns each: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider
   devReplay --model showcase <project> "go"` for the first, then follow-ups in that thread.
3. Stop the server by the PID you started. Check out the PR head, restart, and repeat step 2 on
   the same threads' project (fresh threads, same scenario).
4. From the receiver, take `t3_git_commands_total` grouped by `operation` and `outcome`, and
   `t3_git_command_duration` p50 and p95 grouped by `operation`, for each run.

Attach a table like this to the PR:

| operation                                       | commands before | commands after | p50 before | p50 after | p95 before | p95 after |
| ----------------------------------------------- | --------------: | -------------: | ---------: | --------: | ---------: | --------: |
| `GitVcsDriver.checkpoints.captureCheckpoint`    |                 |                |            |           |            |           |
| `GitVcsDriver.checkpoints.deleteCheckpointRefs` |                 |                |            |           |            |           |
| `other`                                         |                 |                |            |           |            |           |

Pass criteria: command counts per operation and outcome are equal (they are deterministic for a
fixed scenario; the op-count tests already prove it in CI); durations are within run-to-run noise,
judged by running the "before" pass twice and using that spread as the band. A count difference is
a bug in the routing PR, not noise. `vp run test:perf:v2-wire` stays as on `main` (no wire change).

### `test-t3-app` run (after the last row)

One pass with [test-t3-app](../../../../.agents/skills/test-t3-app/SKILL.md) on web, against
`vp run dev` with seeded data, on a local thread and on a worktree thread:

- a Replay `showcase` turn streams, its approval works, and the diff panel shows the turn's files;
- a terminal opens in the thread's cwd, runs a command, and its busy state clears when it ends;
- the file browser lists, opens and saves a file; search finds it;
- restoring the previous checkpoint works on the worktree thread, and is refused as shared on a
  thread whose cwd overlaps another's (today's message);
- a preview server started in the terminal is listed and can be stopped (if 0.10 landed).

Record the transcript (commands and outcomes) in the tracking item. Any difference from `main` is a
bug in the row that touched that path.
